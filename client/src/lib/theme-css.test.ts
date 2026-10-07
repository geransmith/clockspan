import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPLIT_QUERY } from './layout';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../styles.css');

/** The custom property lines of the block that opens with `selector {`. */
const tokens = (selector: string) => {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('}', start));
  return body
    .split('\n')
    .filter((l) => l.trim().startsWith('--'))
    .map((l) => l.trim());
};

const bg = (selector: string) => /^--bg: (.+);$/m.exec(tokens(selector).join('\n'))?.[1];

describe('styles.css', () => {
  // The dark palette is written twice: under the system's dark scheme and for a forced dark theme.
  it('has the same dark tokens in both places', () => {
    const system = tokens(":root:not([data-theme='light'])");
    expect(system.length).toBeGreaterThan(10);
    expect(tokens(":root[data-theme='dark']")).toEqual(system);
  });

  // The browser bar and the install splash can't read a CSS variable, so index.html and the
  // manifest repeat --bg.
  it('gives the theme-color metas and the manifest the page background', () => {
    const light = bg(':root');
    const dark = bg(":root[data-theme='dark']");
    expect(light).toMatch(/^#/);
    expect(dark).toMatch(/^#/);

    const html = read('../../index.html');
    const themeColor = (scheme: string) => {
      const tag = html.match(/<meta [^>]*>/g)?.find((t) => t.includes('name="theme-color"') && t.includes(`media="(prefers-color-scheme: ${scheme})"`));
      return tag && /content="([^"]+)"/.exec(tag)?.[1];
    };
    expect(themeColor('light')).toBe(light);
    expect(themeColor('dark')).toBe(dark);

    const manifest = JSON.parse(read('../../public/manifest.webmanifest')) as { background_color?: unknown };
    expect(manifest.background_color).toBe(light);
  });

  // The sheet picks two columns with matchMedia(SPLIT_QUERY), and the stylesheet lays them out
  // under the same query; a width changed on one side only would leave a split laid out as one list.
  it('lays the two-column sheet out under the query the sheet picks it with', () => {
    expect(css).toContain(`@media ${SPLIT_QUERY} {`);
  });
});
