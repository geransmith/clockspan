/**
 * Single delivery point for every user-facing alert: sound, browser Notification, and
 * the in-app banner queue. Nothing else in the app plays audio or calls Notification.
 */

import type { ClipId, SoundId, SynthId } from '../../../shared/sounds.js';
import { clipUrl } from './sounds';

export type Tone = 'info' | 'warn' | 'danger' | 'success';

export interface Banner {
  id: number;
  /** Small line above the title naming the source, e.g. "Clock-out alarm · 15 min warning". */
  kicker?: string;
  title: string;
  body?: string;
  tone: Tone;
  /** When it was raised, so a sticky banner seen later still says when it fired. */
  at: number;
  /** Sticky banners stay until dismissed; others auto-dismiss. */
  sticky: boolean;
  /** Groups banners so a newer one replaces an older one of the same tag. */
  tag: string;
  /** One optional button, e.g. "Overtime approved" on the clock-out alarm. */
  action?: BannerAction;
}

export interface BannerAction {
  label: string;
  run: () => void;
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

function beep(ctx: AudioContext, at: number, freq: number, dur: number, gain = 0.18): void {
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

/** The synthesized patterns: one per `kind: 'synth'` entry in the catalog (the type enforces it). */
const SYNTH: Record<SynthId, (ctx: AudioContext, t: number) => void> = {
  triad: (ctx, t) => {
    // rising major triad: done, and it's good news
    beep(ctx, t, 523, 0.18);
    beep(ctx, t + 0.18, 659, 0.18);
    beep(ctx, t + 0.36, 784, 0.35);
  },
  taps: (ctx, t) => {
    // two soft taps
    beep(ctx, t, 660, 0.12, 0.12);
    beep(ctx, t + 0.2, 660, 0.12, 0.12);
  },
  notes: (ctx, t) => {
    // three firm notes
    beep(ctx, t, 880, 0.15);
    beep(ctx, t + 0.22, 880, 0.15);
    beep(ctx, t + 0.44, 1100, 0.3);
  },
  double: (ctx, t) => {
    // insistent low double
    beep(ctx, t, 440, 0.25, 0.22);
    beep(ctx, t + 0.35, 440, 0.25, 0.22);
  },
};

function isSynth(id: SoundId): id is SynthId {
  return id in SYNTH;
}

/** The clips come from different recordings; one knob keeps them in line with the beeps. */
const CLIP_GAIN = 0.8;

const clips = new Map<ClipId, Promise<AudioBuffer | null>>();

/**
 * Fetch and decode a clip once per page load. A failed fetch or decode resolves null (the
 * event goes on without its sound) and is forgotten, so the next play tries again.
 */
function loadClip(ctx: AudioContext, id: ClipId): Promise<AudioBuffer | null> {
  let loading = clips.get(id);
  if (!loading) {
    loading = fetch(clipUrl(id))
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.arrayBuffer();
      })
      .then((bytes) => ctx.decodeAudioData(bytes))
      .catch(() => {
        clips.delete(id);
        return null;
      });
    clips.set(id, loading);
  }
  return loading;
}

function playClip(ctx: AudioContext, id: ClipId): void {
  void loadClip(ctx, id).then((buffer) => {
    if (!buffer) return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.value = CLIP_GAIN;
    src.connect(g).connect(ctx.destination);
    src.start();
  });
}

/** Play a catalog sound now; `none` is silence. Unlocks and resumes the context on the way. */
export function playSound(id: SoundId): void {
  if (id === 'none') return;
  if (!ctx) unlockAudio();
  if (!ctx) return;
  if (ctx.state === 'suspended') void ctx.resume();
  if (isSynth(id)) SYNTH[id](ctx, ctx.currentTime + 0.02);
  else playClip(ctx, id);
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
  const options: NotificationOptions = { body, tag, silent: true };
  try {
    const n = new Notification(title, options);
    n.onclick = () => {
      window.focus();
      n.close();
    };
  } catch {
    // Chrome on Android (and, it seems, installed iOS web apps) refuse the constructor and
    // only show a notification through the service worker; its `notificationclick` handler
    // in public/sw.js brings the app forward.
    void notifyFromWorker(title, options);
  }
}

async function notifyFromWorker(title: string, options: NotificationOptions): Promise<void> {
  try {
    // `serviceWorker` is missing outside a secure context (plain http on the LAN), and a dev
    // build registers no worker; the banner is still there either way.
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.showNotification(title, options);
  } catch {
    // The browser refused; the banner is still there.
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

function pushBanner(b: Omit<Banner, 'id' | 'at'>): void {
  // One banner per tag so "clock out in 5" replaces "clock out in 15".
  const banner: Banner = { ...b, id: nextId++, at: Date.now() };
  banners = [...banners.filter((x) => x.tag !== b.tag), banner];
  emit();
  if (!b.sticky) setTimeout(() => dismissBanner(banner.id), 8000);
}

// ----- the one entry point -----
export interface AlertOptions {
  kicker?: string;
  title: string;
  body?: string;
  tone: Tone;
  sticky?: boolean;
  /** What to play, gated by `sound`; `none` (or nothing) is silent. */
  chime?: SoundId;
  /** Groups banners so a newer one replaces an older one of the same tag. */
  tag: string;
  action?: BannerAction;
  sound: boolean;
  notifications: boolean;
}

export function alert(o: AlertOptions): void {
  if (o.sound && o.chime) playSound(o.chime);
  if (o.notifications) notify(o.title, o.body, o.tag);
  pushBanner({ kicker: o.kicker, title: o.title, body: o.body, tone: o.tone, sticky: o.sticky ?? false, tag: o.tag, action: o.action });
}

/** A request failed: a danger banner with no chime and no notification, one per tag. */
export function warnQuietly(o: { title: string; body?: string; tag: string }): void {
  alert({ ...o, tone: 'danger', sound: false, notifications: false });
}
