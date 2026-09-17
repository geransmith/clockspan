/**
 * Single delivery point for every user-facing alert: chime, browser Notification, and
 * the in-app banner queue. Nothing else in the app plays audio or calls Notification.
 */

export type Tone = 'info' | 'warn' | 'danger' | 'success';
export type ChimeKind = 'timer' | 'lead' | 'due' | 'overdue' | 'test';

export interface Banner {
  id: number;
  title: string;
  body?: string;
  tone: Tone;
  /** Sticky banners stay until dismissed; others auto-dismiss. */
  sticky: boolean;
  /** Groups banners so a newer one replaces an older one of the same tag. */
  tag: string;
}

// ----- audio -----
let ctx: AudioContext | null = null;

/** Must be called from a user gesture at least once so iOS/Safari allow playback later. */
export function unlockAudio(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
  } catch {
    ctx = null;
  }
}

function beep(at: number, freq: number, dur: number, gain = 0.18): void {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  g.gain.setValueAtTime(0, at);
  g.gain.linearRampToValueAtTime(gain, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + dur + 0.05);
}

export function chime(kind: ChimeKind): void {
  if (!ctx) unlockAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  const t = ctx.currentTime + 0.02;
  switch (kind) {
    case 'timer': // rising major triad: done, and it's good news
      beep(t, 523, 0.18);
      beep(t + 0.18, 659, 0.18);
      beep(t + 0.36, 784, 0.35);
      break;
    case 'lead': // two soft taps
      beep(t, 660, 0.12, 0.12);
      beep(t + 0.2, 660, 0.12, 0.12);
      break;
    case 'due': // three firm notes
      beep(t, 880, 0.15);
      beep(t + 0.22, 880, 0.15);
      beep(t + 0.44, 1100, 0.3);
      break;
    case 'overdue': // insistent low double
      beep(t, 440, 0.25, 0.22);
      beep(t + 0.35, 440, 0.25, 0.22);
      break;
    case 'test':
      beep(t, 660, 0.15);
      beep(t + 0.2, 880, 0.25);
      break;
  }
}

// ----- notifications -----
export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return notificationsSupported() ? Notification.permission : 'unsupported';
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!notificationsSupported()) return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

function notify(title: string, body: string | undefined, tag: string): void {
  if (!notificationsSupported() || Notification.permission !== 'granted') return;
  try {
    const n = new Notification(title, { body, tag, silent: true });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Some browsers only allow notifications from a service worker; silently skip.
  }
}

// ----- banners -----
type Listener = () => void;
let banners: Banner[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const l of listeners) l();
}

export function subscribeBanners(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getBanners(): Banner[] {
  return banners;
}

export function dismissBanner(id: number): void {
  banners = banners.filter((b) => b.id !== id);
  emit();
}

/** Remove banners whose condition no longer holds (e.g. lunch was taken). */
export function dismissByTag(tag: string): void {
  if (!banners.some((b) => b.tag === tag)) return;
  banners = banners.filter((b) => b.tag !== tag);
  emit();
}

function pushBanner(b: Omit<Banner, 'id'>): void {
  // One banner per tag so "clock out in 5" replaces "clock out in 15".
  const banner: Banner = { ...b, id: nextId++ };
  banners = [...banners.filter((x) => x.tag !== b.tag), banner];
  emit();
  if (!b.sticky) setTimeout(() => dismissBanner(banner.id), 8000);
}

// ----- the one entry point -----
export interface AlertOptions {
  title: string;
  body?: string;
  tone: Tone;
  sticky?: boolean;
  chime?: ChimeKind;
  /** Groups banners so a newer one replaces an older one of the same tag. */
  tag: string;
  sound: boolean;
  notifications: boolean;
}

export function alert(o: AlertOptions): void {
  if (o.sound && o.chime) chime(o.chime);
  if (o.notifications) notify(o.title, o.body, o.tag);
  pushBanner({ title: o.title, body: o.body, tone: o.tone, sticky: o.sticky ?? false, tag: o.tag });
}
