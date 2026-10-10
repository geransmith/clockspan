// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANGED_ELSEWHERE } from '../api';
import { noteOwnWrite } from '../lib/ownWrites';
import { settle, setVisibility, T0 } from '../test/hooks';
import { GATHER_MS, useLiveChanges } from './useLiveChanges';

/** happy-dom has no EventSource: this one records each stream and lets a case send on it. */
class FakeSource {
  static readonly CLOSED = 2;
  static made: FakeSource[] = [];
  readyState = 0;
  onmessage: ((e: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSource.made.push(this);
  }
  close() {
    this.readyState = FakeSource.CLOSED;
  }
  send(revision: number) {
    this.onmessage!({ data: String(revision) } as MessageEvent<string>);
  }
  /** An error: the browser reconnects by itself, or, `closed`, gives up (a 401, a 429, a proxy's page). */
  fail(closed: boolean) {
    if (closed) this.readyState = FakeSource.CLOSED;
    this.onerror!();
  }
}

const open = () => FakeSource.made.filter((s) => s.readyState !== FakeSource.CLOSED);
const latest = () => FakeSource.made.at(-1)!;
const changed = vi.fn();
const raised = () => changed.mock.calls.map(([e]) => (e as CustomEvent<number>).detail);

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  setVisibility('visible');
  FakeSource.made = [];
  vi.stubGlobal('EventSource', FakeSource);
  window.addEventListener(CHANGED_ELSEWHERE, changed);
});
afterEach(() => window.removeEventListener(CHANGED_ELSEWHERE, changed));

// The revisions this page wrote are module state (lib/ownWrites), so each case uses numbers of its own, above the last case's.
describe('useLiveChanges', () => {
  it('holds one stream to /api/changes while the tab is shown, none while hidden, and none once unmounted', () => {
    setVisibility('hidden');
    const { unmount } = renderHook(() => useLiveChanges());
    expect(FakeSource.made).toEqual([]);
    setVisibility('visible');
    expect(open().map((s) => s.url)).toEqual(['/api/changes']);
    setVisibility('hidden');
    expect(open()).toEqual([]);
    setVisibility('visible');
    expect(open()).toHaveLength(1);
    unmount();
    expect(open()).toEqual([]);
    expect(FakeSource.made).toHaveLength(2);
  });

  it('raises CHANGED_ELSEWHERE with the revision heard, 300 ms after the first one past where the stream started, once for a burst, and ignores a stale or repeated revision', async () => {
    renderHook(() => useLiveChanges());
    latest().send(5);
    await settle(GATHER_MS);
    expect(changed).not.toHaveBeenCalled();
    latest().send(6);
    latest().send(7);
    latest().send(6);
    await settle(GATHER_MS - 1);
    expect(changed).not.toHaveBeenCalled();
    await settle(1);
    expect(raised()).toEqual([7]);
    latest().send(7);
    await settle(GATHER_MS);
    expect(raised()).toEqual([7]);
  });

  it("says nothing for this page's own writes noted before it judges, and raises it when one revision in the span is another's", async () => {
    renderHook(() => useLiveChanges());
    latest().send(10);
    noteOwnWrite(11);
    latest().send(11);
    await settle(GATHER_MS);
    expect(changed).not.toHaveBeenCalled();
    noteOwnWrite(12);
    latest().send(12);
    latest().send(13);
    await settle(GATHER_MS);
    expect(raised()).toEqual([13]);
  });

  it('judges a reconnected stream, and one opened as the tab is shown again, from where the last left off', async () => {
    renderHook(() => useLiveChanges());
    latest().send(20);
    // The browser reconnects by itself: the same source, and its first message names 22.
    latest().fail(false);
    latest().send(22);
    await settle(2000);
    expect(raised()).toEqual([22]);
    expect(FakeSource.made).toHaveLength(1);
    // Shown again with nothing new, or only this page's own write while hidden (an automatic finish).
    setVisibility('hidden');
    setVisibility('visible');
    latest().send(22);
    await settle(GATHER_MS);
    setVisibility('hidden');
    noteOwnWrite(23);
    setVisibility('visible');
    latest().send(23);
    await settle(GATHER_MS);
    expect(raised()).toEqual([22]);
    // Another device saved while hidden: a tab back inside useRefreshLoop's throttle reads nothing.
    setVisibility('hidden');
    setVisibility('visible');
    latest().send(24);
    await settle(GATHER_MS);
    expect(raised()).toEqual([22, 24]);
  });

  it('opens a stream the browser gave up on again after nextBackoff waits, and waits for the tab while hidden', async () => {
    renderHook(() => useLiveChanges());
    latest().send(40);
    latest().fail(true);
    await settle(1999);
    expect(FakeSource.made).toHaveLength(1);
    await settle(1);
    expect(FakeSource.made).toHaveLength(2);
    latest().fail(true);
    await settle(3999);
    expect(FakeSource.made).toHaveLength(2);
    await settle(1);
    expect(FakeSource.made).toHaveLength(3);
    // Judged from where the first stream left off; a message starts the waits over.
    latest().send(41);
    await settle(GATHER_MS);
    expect(raised()).toEqual([41]);
    latest().fail(true);
    await settle(2000);
    expect(FakeSource.made).toHaveLength(4);
    latest().fail(true);
    setVisibility('hidden');
    await settle(60_000);
    expect(FakeSource.made).toHaveLength(4);
    setVisibility('visible');
    expect(open()).toHaveLength(1);
  });

  it('puts off a judgement still waiting when the tab is hidden until it is shown again', async () => {
    renderHook(() => useLiveChanges());
    latest().send(50);
    latest().send(51);
    latest().send(52);
    setVisibility('hidden');
    await settle(GATHER_MS);
    expect(changed).not.toHaveBeenCalled();
    setVisibility('visible');
    latest().send(52);
    await settle(GATHER_MS);
    expect(raised()).toEqual([52]);
  });
});
