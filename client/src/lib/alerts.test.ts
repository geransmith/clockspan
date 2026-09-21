import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The module keeps its own state (the audio context, the banner list), so every test gets a
 * fresh copy through `vi.resetModules()`. The browser globals it touches are stubbed with the
 * smallest fakes that record what was asked of them.
 */
type Alerts = typeof import('./alerts');

class FakeParam {
  value = 0;
  calls: string[] = [];
  setValueAtTime(v: number, t: number) {
    this.calls.push(`set ${v}@${t}`);
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.calls.push(`lin ${v}@${t}`);
  }
  exponentialRampToValueAtTime(v: number, t: number) {
    this.calls.push(`exp ${v}@${t}`);
  }
}
class FakeNode {
  connect(next: unknown) {
    return next;
  }
}
class FakeOscillator extends FakeNode {
  type = '';
  frequency = new FakeParam();
  started: number[] = [];
  stopped: number[] = [];
  start(at: number) {
    this.started.push(at);
  }
  stop(at: number) {
    this.stopped.push(at);
  }
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static failConstructor = false;
  state: 'suspended' | 'running' = 'running';
  currentTime = 10;
  destination = {};
  oscillators: FakeOscillator[] = [];
  resumed = 0;
  constructor() {
    if (FakeAudioContext.failConstructor) throw new Error('no audio');
    FakeAudioContext.instances.push(this);
  }
  createOscillator() {
    const o = new FakeOscillator();
    this.oscillators.push(o);
    return o;
  }
  createGain() {
    return new FakeGain();
  }
  resume() {
    this.resumed++;
    this.state = 'running';
    return Promise.resolve();
  }
}
class FakeNotification {
  static permission: NotificationPermission = 'granted';
  static requestPermission: () => Promise<NotificationPermission> = () => Promise.resolve('granted');
  static created: FakeNotification[] = [];
  static failConstructor = false;
  onclick: (() => void) | null = null;
  closed = 0;
  constructor(
    public title: string,
    public options: NotificationOptions,
  ) {
    if (FakeNotification.failConstructor) throw new Error('worker only');
    FakeNotification.created.push(this);
  }
  close() {
    this.closed++;
  }
}

let alerts: Alerts;
const focus = vi.fn();

beforeEach(async () => {
  vi.resetModules();
  FakeAudioContext.instances = [];
  FakeAudioContext.failConstructor = false;
  FakeNotification.created = [];
  FakeNotification.failConstructor = false;
  FakeNotification.permission = 'granted';
  FakeNotification.requestPermission = () => Promise.resolve('granted');
  focus.mockReset();
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('Notification', FakeNotification);
  vi.stubGlobal('window', { focus });
  alerts = await import('./alerts');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('audio', () => {
  it('creates one context on unlock, resumes it when suspended, and survives a browser without audio', () => {
    alerts.unlockAudio();
    alerts.unlockAudio();
    expect(FakeAudioContext.instances).toHaveLength(1);
    const ctx = FakeAudioContext.instances[0]!;
    expect(ctx.resumed).toBe(0);
    ctx.state = 'suspended';
    alerts.unlockAudio();
    expect(ctx.resumed).toBe(1);
  });

  it('gives up quietly when the context cannot be created', () => {
    FakeAudioContext.failConstructor = true;
    alerts.unlockAudio();
    alerts.chime('timer');
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('plays a distinct pattern per chime, unlocking and resuming on the way', () => {
    const notes: Record<string, number> = {};
    for (const kind of ['timer', 'lead', 'due', 'overdue', 'test'] as const) {
      const before = FakeAudioContext.instances[0]?.oscillators.length ?? 0;
      alerts.chime(kind);
      notes[kind] = FakeAudioContext.instances[0]!.oscillators.length - before;
    }
    expect(notes).toEqual({ timer: 3, lead: 2, due: 3, overdue: 2, test: 2 });
    const ctx = FakeAudioContext.instances[0]!;
    const first = ctx.oscillators[0]!;
    expect(first.type).toBe('sine');
    expect(first.frequency.value).toBe(523);
    expect(first.started).toEqual([ctx.currentTime + 0.02]);
    expect(first.stopped[0]).toBeGreaterThan(first.started[0]!);
    // A context the browser suspended (tab in the background) is resumed before the chime.
    ctx.state = 'suspended';
    alerts.chime('lead');
    expect(ctx.resumed).toBe(1);
  });
});

describe('notifications', () => {
  it('reports support and permission', async () => {
    expect(alerts.notificationsSupported()).toBe(true);
    expect(alerts.notificationPermission()).toBe('granted');
    FakeNotification.permission = 'default';
    expect(alerts.notificationPermission()).toBe('default');
    expect(await alerts.requestNotificationPermission()).toBe('granted');
    FakeNotification.requestPermission = () => Promise.reject(new Error('gesture required'));
    expect(await alerts.requestNotificationPermission()).toBe('default');
  });

  it('answers unsupported without the Notification global', async () => {
    vi.stubGlobal('Notification', undefined);
    expect(alerts.notificationsSupported()).toBe(false);
    expect(alerts.notificationPermission()).toBe('unsupported');
    expect(await alerts.requestNotificationPermission()).toBe('unsupported');
    // An alert still lands as a banner.
    alerts.alert({ title: 'Lunch', tone: 'warn', tag: 'a', sound: false, notifications: true });
    expect(alerts.getBanners().map((b) => b.title)).toEqual(['Lunch']);
  });

  it('shows a silent notification only when granted, and focuses the window on click', () => {
    alerts.alert({ title: 'Clock out', body: 'now', tone: 'danger', tag: 'co', sound: false, notifications: true });
    expect(FakeNotification.created).toHaveLength(1);
    const n = FakeNotification.created[0]!;
    expect(n.title).toBe('Clock out');
    expect(n.options).toEqual({ body: 'now', tag: 'co', silent: true });
    n.onclick!();
    expect(focus).toHaveBeenCalledOnce();
    expect(n.closed).toBe(1);

    FakeNotification.permission = 'denied';
    alerts.alert({ title: 'Quiet', tone: 'info', tag: 'q', sound: false, notifications: true });
    alerts.alert({ title: 'Off', tone: 'info', tag: 'o', sound: false, notifications: false });
    expect(FakeNotification.created).toHaveLength(1);
  });

  it('swallows a constructor that only works from a service worker', () => {
    FakeNotification.failConstructor = true;
    expect(() => alerts.alert({ title: 'x', tone: 'info', tag: 'x', sound: false, notifications: true })).not.toThrow();
    expect(alerts.getBanners()).toHaveLength(1);
  });
});

describe('banners', () => {
  it('notifies subscribers, replaces a banner with the same tag, and dismisses by id or tag', () => {
    const seen = vi.fn();
    const unsubscribe = alerts.subscribeBanners(seen);
    alerts.alert({ title: 'in 15', tone: 'warn', tag: 'alarm:clockOut', sticky: true, sound: false, notifications: false });
    alerts.alert({ title: 'in 5', tone: 'warn', tag: 'alarm:clockOut', sticky: true, sound: false, notifications: false });
    alerts.alert({ kicker: 'Lunch', title: 'Take lunch', tone: 'danger', tag: 'alarm:lunchBy', sticky: true, sound: false, notifications: false });
    expect(seen).toHaveBeenCalledTimes(3);
    expect(alerts.getBanners().map((b) => b.title)).toEqual(['in 5', 'Take lunch']);
    expect(alerts.getBanners()[0]!.id).not.toBe(alerts.getBanners()[1]!.id);
    expect(alerts.getBanners()[1]).toMatchObject({ kicker: 'Lunch', sticky: true, at: expect.any(Number) });

    alerts.dismissByTag('alarm:nothing');
    expect(seen).toHaveBeenCalledTimes(3);
    alerts.dismissByTag('alarm:lunchBy');
    expect(alerts.getBanners().map((b) => b.title)).toEqual(['in 5']);
    alerts.dismissBanner(alerts.getBanners()[0]!.id);
    expect(alerts.getBanners()).toEqual([]);
    expect(seen).toHaveBeenCalledTimes(5);

    unsubscribe();
    alerts.alert({ title: 'later', tone: 'info', tag: 'l', sound: false, notifications: false });
    expect(seen).toHaveBeenCalledTimes(5);
  });

  it('drops a non-sticky banner after 8 s and keeps a sticky one', () => {
    vi.useFakeTimers();
    alerts.alert({ title: 'done', tone: 'success', tag: 'timer', sound: false, notifications: false });
    alerts.alert({ title: 'stay', tone: 'warn', tag: 'alarm', sticky: true, sound: false, notifications: false });
    vi.advanceTimersByTime(7_999);
    expect(alerts.getBanners()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(alerts.getBanners().map((b) => b.title)).toEqual(['stay']);
  });

  it('chimes only when asked to and sound is on', () => {
    alerts.alert({ title: 'a', tone: 'info', tag: 'a', chime: 'due', sound: true, notifications: false });
    expect(FakeAudioContext.instances[0]!.oscillators).toHaveLength(3);
    alerts.alert({ title: 'b', tone: 'info', tag: 'b', chime: 'due', sound: false, notifications: false });
    alerts.alert({ title: 'c', tone: 'info', tag: 'c', sound: true, notifications: false });
    expect(FakeAudioContext.instances[0]!.oscillators).toHaveLength(3);
  });

  it('raises a failed request as a silent danger banner with an action', () => {
    const run = vi.fn();
    alerts.warnQuietly({ title: 'Change not saved', body: 'The server did not answer.', tag: 'save-failed' });
    alerts.alert({
      title: 'Clock out',
      tone: 'danger',
      tag: 'alarm:clockOut',
      sticky: true,
      action: { label: 'Overtime approved', run },
      sound: false,
      notifications: false,
    });
    expect(FakeAudioContext.instances).toHaveLength(0);
    expect(FakeNotification.created).toHaveLength(0);
    const [quiet, withAction] = alerts.getBanners();
    expect(quiet).toMatchObject({ title: 'Change not saved', tone: 'danger', sticky: false });
    withAction!.action!.run();
    expect(run).toHaveBeenCalledOnce();
  });
});
