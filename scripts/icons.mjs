#!/usr/bin/env node
/**
 * Renders the PNG app icons from client/public/icons/icon.svg, their one source:
 *
 *   npm run icons
 *
 * icon-192.png and icon-512.png are the SVG as drawn, transparent outside its rounded square.
 * The other two fill the whole square with the icon's background colour, because the platform
 * cuts its own shape out of them: iOS paints a transparent pixel of a Home Screen icon black,
 * and Android may mask away everything outside the middle 80% of a maskable icon, so that
 * one's glyph is drawn smaller. The browser comes from scripts/browser.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openBrowser } from './browser.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'client', 'public', 'icons');
const log = (msg) => console.log(`[icons] ${msg}`);

// The tomato reaches furthest from the centre; it stays inside the maskable safe circle up to
// a scale of about 0.8.
const OUTPUTS = [
  { file: 'icon-192.png', size: 192, scale: 1, bleed: false },
  { file: 'icon-512.png', size: 512, scale: 1, bleed: false },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.76, bleed: true },
  { file: 'apple-touch-icon.png', size: 180, scale: 1, bleed: true },
];

const svg = fs.readFileSync(path.join(DIR, 'icon.svg'), 'utf8');
// A full-bleed render paints the page in the colour of the SVG's background square, so the
// square's rounded corners disappear into it.
const background = /<rect\b(?=[^>]*\bwidth="512")[^>]*\bfill="([^"]+)"/.exec(svg)?.[1];

function pageFor({ size, scale, bleed }) {
  // Whole pixels: a fractional offset would resample the glyph and soften its edges.
  const width = Math.round(size * scale);
  const offset = Math.floor((size - width) / 2);
  return `<!doctype html><style>
    html, body { margin: 0; height: 100%; background: ${bleed ? background : 'transparent'}; }
    img { position: absolute; left: ${offset}px; top: ${offset}px; width: ${width}px; height: ${width}px; }
  </style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`;
}

function nextEvent(cdp, method, sessionId) {
  return new Promise((resolve) => {
    const listener = (msg) => {
      if (msg.method !== method || msg.sessionId !== sessionId) return;
      cdp.listeners.delete(listener);
      resolve(msg.params);
    };
    cdp.listeners.add(listener);
  });
}

async function main() {
  if (!background) throw new Error('icon.svg needs a width="512" background <rect> with a fill; the full-bleed icons take their colour from it');
  const browser = await openBrowser(log);
  try {
    const { cdp } = browser;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    await send('Page.enable');
    await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    for (const output of OUTPUTS) {
      await send('Emulation.setDeviceMetricsOverride', { width: output.size, height: output.size, deviceScaleFactor: 1, mobile: false });
      const loaded = nextEvent(cdp, 'Page.loadEventFired', sessionId);
      await send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(pageFor(output)).toString('base64')}` });
      await loaded;
      await send('Runtime.evaluate', { expression: 'document.images[0].decode()', awaitPromise: true });
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(DIR, output.file);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
      log(`wrote ${path.relative(ROOT, file)} (${output.size}×${output.size})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`[icons] ${err.message}`);
  process.exit(1);
});
