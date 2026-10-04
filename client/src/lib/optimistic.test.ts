import { describe, expect, it } from 'vitest';
import { addPending, confirm, fetched, serial, settle, settleWith, shown, untracked, type Tracked } from './optimistic';

type Row = { text: string; n: number };
const loaded = (value: Row, version = 0): Tracked<Row> => ({ confirmed: value, pending: [], version });
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
  it('commits what the server saved and moves the version', () => {
    const t = settle(addPending(loaded({ text: 'a', n: 0 }), 1, setText('b')), [1], setText('B'));
    expect(t).toEqual({ confirmed: { text: 'B', n: 0 }, pending: [], version: 1 });
  });

  it('falls back to what the server has when a save fails, keeping the other changes on top', () => {
    let t = addPending(loaded({ text: 'a', n: 0 }), 1, setText('b'));
    t = addPending(t, 2, inc);
    t = settle(t, [1]);
    expect(t.version).toBe(0);
    expect(shown(t)).toEqual({ text: 'a', n: 1 });
  });

  it('two failures in a row leave the confirmed value, not either guess', () => {
    let t = addPending(addPending(loaded({ text: 'a', n: 0 }), 1, setText('b')), 2, setText('c'));
    t = settle(settle(t, [1]), [2]);
    expect(shown(t)).toEqual({ text: 'a', n: 0 });
  });

  it('settles several changes at once (a list saved once for several edits)', () => {
    const t = settle(addPending(addPending(loaded({ text: 'a', n: 0 }), 1, setText('b')), 2, setText('c')), [1, 2], setText('c'));
    expect(t.pending).toEqual([]);
    expect(t.confirmed).toEqual({ text: 'c', n: 0 });
  });

  it('keeps a value never loaded unloaded, while still moving the version', () => {
    const t = settle(addPending(untracked<Row>(), 1, inc), [1], setText('saved'));
    expect(t).toEqual({ confirmed: undefined, pending: [], version: 1 });
  });
});

describe('settleWith', () => {
  it('takes a whole answer as the confirmed value, loaded or not, keeping the other changes on top', () => {
    let t = addPending(addPending(untracked<Row>(), 1, setText('b')), 2, inc);
    t = settleWith(t, [1], { text: 'B', n: 0 });
    expect(t).toMatchObject({ confirmed: { text: 'B', n: 0 }, version: 1 });
    expect(shown(t)).toEqual({ text: 'B', n: 1 });
    expect(settleWith(addPending(loaded({ text: 'a', n: 0 }, 2), 1, setText('b')), [1], { text: 'B', n: 0 })).toEqual({
      confirmed: { text: 'B', n: 0 },
      pending: [],
      version: 3,
    });
  });
});

describe('confirm', () => {
  it('lays a change the server made onto the confirmed value and moves the version', () => {
    expect(confirm(loaded({ text: 'a', n: 0 }, 3), inc)).toEqual({ confirmed: { text: 'a', n: 1 }, pending: [], version: 4 });
    expect(confirm(untracked<Row>(), inc)).toEqual({ confirmed: undefined, pending: [], version: 1 });
  });
});

describe('fetched', () => {
  it('replaces the confirmed value and never a pending change', () => {
    const t = addPending(loaded({ text: 'a', n: 0 }), 1, setText('mine'));
    const { next, stale } = fetched(t, 0, { text: 'server', n: 5 });
    expect(stale).toBe(false);
    expect(next.confirmed).toEqual({ text: 'server', n: 5 });
    expect(shown(next)).toEqual({ text: 'mine', n: 5 });
  });

  it('drops an answer older than a change the server confirmed since it was sent', () => {
    const t = loaded({ text: 'saved', n: 0 }, 1);
    expect(fetched(t, 0, { text: 'old', n: 0 })).toEqual({ next: t, stale: true });
  });

  it('keeps the tracked value itself when the answer is the same as the confirmed one', () => {
    const row = { text: 'a', n: 0 };
    const t = addPending(loaded(row), 1, inc);
    const { next, stale } = fetched(t, 0, { ...row });
    expect(next).toBe(t);
    expect(stale).toBe(false);
  });

  it('takes an older answer for a value never loaded, and says it is stale', () => {
    const t = confirm(untracked<Row>(), inc);
    const { next, stale } = fetched(t, 0, { text: 'first', n: 0 });
    expect(next.confirmed).toEqual({ text: 'first', n: 0 });
    expect(stale).toBe(true);
  });
});

describe('serial', () => {
  /** A job that waits for the test to answer it, and says when it starts. */
  function job(name: string, started: string[]) {
    let answer!: { resolve: (v: string) => void; reject: (e: Error) => void };
    const run = () => {
      started.push(name);
      return new Promise<string>((resolve, reject) => (answer = { resolve, reject }));
    };
    return { run, answer: () => answer };
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
  });
});
