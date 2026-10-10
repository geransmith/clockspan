import { describe, expect, it } from 'vitest';
import { deferred } from '../test/fixtures';
import { addPending, confirm, fetched, serial, settle, settleWith, shown, untracked, whenIdle, whileUnsettled, type Tracked } from './optimistic';

type Row = { text: string; n: number };
const loaded = (value: Row, revision = 0): Tracked<Row> => ({ confirmed: value, pending: [], revision });
const setText = (text: string) => (r: Row) => ({ ...r, text });
const inc = (r: Row) => ({ ...r, n: r.n + 1 });

describe('shown', () => {
  it('is nothing until the first answer, then the confirmed value with the pending changes in order', () => {
    expect(shown(untracked<Row>())).toBeUndefined();
    expect(shown(addPending(untracked<Row>(), 1, inc))).toBeUndefined();
    const t = addPending(addPending(loaded({ text: 'a', n: 0 }), 1, setText('b')), 2, setText('c'));
    expect(shown(t)).toEqual({ text: 'c', n: 0 });
  });

  it('hands back the confirmed value itself while nothing is pending', () => {
    const value = { text: 'a', n: 0 };
    expect(shown(loaded(value))).toBe(value);
  });
});

describe('settle', () => {
  it('drops the changes it is given, back on the confirmed value with the others on top, revision kept', () => {
    let t = addPending(loaded({ text: 'a', n: 0 }, 3), 1, setText('b'));
    t = addPending(t, 2, inc);
    t = settle(t, [1]);
    expect(t.revision).toBe(3);
    expect(shown(t)).toEqual({ text: 'a', n: 1 });
  });

  it('two failures in a row leave the confirmed value, not either guess', () => {
    let t = addPending(addPending(loaded({ text: 'a', n: 0 }), 1, setText('b')), 2, setText('c'));
    t = settle(settle(t, [1]), [2]);
    expect(shown(t)).toEqual({ text: 'a', n: 0 });
  });

  it('drops several at once (a list saved once for several edits)', () => {
    const t = settle(addPending(addPending(loaded({ text: 'a', n: 0 }), 1, setText('b')), 2, setText('c')), [1, 2]);
    expect(t).toEqual(loaded({ text: 'a', n: 0 }));
  });
});

describe('settleWith', () => {
  it('takes a whole answer as the confirmed value, loaded or not, keeping the other changes on top', () => {
    let t = addPending(addPending(untracked<Row>(), 1, setText('b')), 2, inc);
    t = settleWith(t, [1], { text: 'B', n: 0 }, 1);
    expect(t).toMatchObject({ confirmed: { text: 'B', n: 0 }, revision: 1 });
    expect(shown(t)).toEqual({ text: 'B', n: 1 });
    // An answer at the revision held is as new as the value shown.
    expect(settleWith(addPending(loaded({ text: 'a', n: 0 }, 2), 1, setText('b')), [1], { text: 'B', n: 0 }, 2)).toEqual(loaded({ text: 'B', n: 0 }, 2));
  });

  it('keeps the confirmed value and drops only the changes when the answer is older than it', () => {
    const t = addPending(addPending(loaded({ text: 'a', n: 0 }, 5), 1, setText('b')), 2, inc);
    const next = settleWith(t, [1], { text: 'old', n: 0 }, 4);
    expect(next).toMatchObject({ confirmed: { text: 'a', n: 0 }, revision: 5 });
    expect(shown(next)).toEqual({ text: 'a', n: 1 });
  });
});

describe('confirm', () => {
  it('lays a change the server made on the confirmed value and takes its revision', () => {
    expect(confirm(loaded({ text: 'a', n: 0 }, 3), inc, 4)).toEqual(loaded({ text: 'a', n: 1 }, 4));
  });

  it('lays a change older than the confirmed value on all the same, keeping the higher revision', () => {
    expect(confirm(loaded({ text: 'a', n: 0 }, 5), inc, 4)).toEqual(loaded({ text: 'a', n: 1 }, 5));
  });

  it('keeps a value never loaded unloaded, raising its revision', () => {
    expect(confirm(untracked<Row>(), inc, 2)).toEqual({ confirmed: undefined, pending: [], revision: 2 });
  });

  it('raises only the revision with (d) => d (a refusal)', () => {
    const value = { text: 'a', n: 0 };
    const t = confirm(loaded(value, 1), (d) => d, 3);
    expect(t.confirmed).toBe(value);
    expect(t.revision).toBe(3);
  });

  it('commits a save: confirm(settle(t, ids), commit, revision)', () => {
    const t = confirm(settle(addPending(loaded({ text: 'a', n: 0 }), 1, setText('b')), [1]), setText('B'), 1);
    expect(t).toEqual(loaded({ text: 'B', n: 0 }, 1));
  });
});

describe('fetched', () => {
  it("replaces the confirmed value and never a pending change, taking the answer's revision", () => {
    const t = addPending(loaded({ text: 'a', n: 0 }, 1), 1, setText('mine'));
    const { next, stale } = fetched(t, { text: 'server', n: 5 }, 2);
    expect(stale).toBe(false);
    expect(next).toMatchObject({ confirmed: { text: 'server', n: 5 }, revision: 2 });
    expect(shown(next)).toEqual({ text: 'mine', n: 5 });
  });

  it('drops an answer below the revision held', () => {
    const t = loaded({ text: 'saved', n: 0 }, 2);
    expect(fetched(t, { text: 'old', n: 0 }, 1)).toEqual({ next: t, stale: true });
  });

  it('keeps the tracked value itself when the answer is the same as the confirmed one, whatever its revision', () => {
    const row = { text: 'a', n: 0 };
    const t = addPending(loaded(row, 1), 1, inc);
    const { next, stale } = fetched(t, { ...row }, 3);
    expect(next).toBe(t);
    expect(stale).toBe(false);
  });

  it('takes an older answer for a value never loaded, says it is stale, and keeps the higher revision', () => {
    const t = confirm(untracked<Row>(), inc, 2);
    const { next, stale } = fetched(t, { text: 'first', n: 0 }, 1);
    expect(next).toMatchObject({ confirmed: { text: 'first', n: 0 }, revision: 2 });
    expect(stale).toBe(true);
  });
});

describe('serial', () => {
  /** A job that waits for the test to answer it, and says when it starts. */
  function job(name: string, started: string[]) {
    const d = deferred<string>();
    const run = () => {
      started.push(name);
      return d.promise;
    };
    return { run, answer: () => d };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('starts each job on a key once the one before it has answered, failed or not', async () => {
    const queue = serial();
    const started: string[] = [];
    const a = job('a', started);
    const b = job('b', started);
    const c = job('c', started);
    const first = queue(a.run);
    const second = queue(b.run);
    const third = queue(c.run);
    // Nothing starts in the same turn: a caller can show its change before the send.
    expect(started).toEqual([]);
    await flush();
    expect(started).toEqual(['a']);
    a.answer().reject(new Error('offline'));
    await expect(first).rejects.toThrow('offline');
    await flush();
    expect(started).toEqual(['a', 'b']);
    b.answer().resolve('B');
    expect(await second).toBe('B');
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    c.answer().resolve('C');
    expect(await third).toBe('C');
  });

  it('keeps keys apart, and still runs a job on a key left idle', async () => {
    const queue = serial();
    const started: string[] = [];
    const a = job('a', started);
    const b = job('b', started);
    const first = queue(a.run, 'day:1');
    void queue(b.run, 'day:2');
    await flush();
    // The other key doesn't wait for the one out on the first.
    expect(started).toEqual(['a', 'b']);
    a.answer().resolve('A');
    await first;
    await flush();
    const c = job('c', started);
    void queue(c.run, 'day:1');
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);
    // Answered, so no write is left on its way for whenIdle's cases.
    b.answer().resolve('B');
    c.answer().resolve('C');
  });
});

describe('whenIdle', () => {
  it('waits for every queued job and counted write, failed or not, those added while it waits included', async () => {
    const queue = serial();
    const a = deferred<string>();
    const b = deferred<string>();
    const c = deferred<string>();
    void queue(() => a.promise, 'day:1').catch(() => {});
    void whileUnsettled(b.promise);
    let idle = false;
    void whenIdle().then(() => (idle = true));
    a.reject(new Error('offline'));
    await Promise.resolve();
    // A job queued while it waits counts too.
    void queue(() => c.promise, 'day:2');
    b.resolve('B');
    await new Promise((r) => setTimeout(r, 0));
    expect(idle).toBe(false);
    c.resolve('C');
    await new Promise((r) => setTimeout(r, 0));
    expect(idle).toBe(true);
  });

  it('resolves at once with nothing on its way', async () => {
    await expect(whenIdle()).resolves.toBeUndefined();
  });
});
