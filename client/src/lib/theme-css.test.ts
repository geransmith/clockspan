import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS } from '../../../shared/api.js';
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

/** A token's value in the block that opens with `selector {`. */
const token = (selector: string, name: string) => new RegExp(`^--${name}: (.+);$`, 'm').exec(tokens(selector).join('\n'))?.[1];
const bg = (selector: string) => token(selector, 'bg');

/** WCAG's contrast ratio between two `#rrggbb` colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('styles.css', () => {
  // The dark palette is written twice: under the system's dark scheme and for a forced dark theme.
  it('has the same dark tokens in both places', () => {
    const system = tokens(":root:not([data-theme='light'])");
    expect(system.length).toBeGreaterThan(10);
    expect(tokens(":root[data-theme='dark']")).toEqual(system);
  });

  // The browser bar and the install splash can't read a CSS variable, so index.html and the
  // manifest repeat --bg (the manifest the light one, for both its colours).
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

    const manifest = JSON.parse(read('../../public/manifest.webmanifest')) as { background_color?: unknown; theme_color?: unknown };
    expect(manifest.background_color).toBe(light);
    expect(manifest.theme_color).toBe(light);
  });

  // A dot and Review's By category bars are the only places a category's colour shows, so it has
  // to stand out from the cards and columns they sit on, in both themes (WCAG's 3:1 for graphics).
  it('gives every category colour a token in each theme, at 3:1 or more on both surfaces', () => {
    for (const theme of [':root', ":root[data-theme='dark']"]) {
      for (const color of CATEGORY_COLORS) {
        const fill = token(theme, `cat-${color}`);
        expect(fill, `${theme} --cat-${color}`).toMatch(/^#[0-9a-f]{6}$/);
        for (const surface of ['surface', 'surface-2']) {
          expect(contrast(fill!, token(theme, surface)!), `${theme} --cat-${color} on --${surface}`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });

  it('picks each category colour by its data-color', () => {
    for (const color of CATEGORY_COLORS) expect(css).toContain(`[data-color='${color}'] {\n  --cat: var(--cat-${color});\n}`);
  });

  // The sheet picks two columns with matchMedia(SPLIT_QUERY), and the stylesheet lays them out
  // under the same query; a width changed on one side only would leave a split laid out as one list.
  it('lays the two-column sheet out under the query the sheet picks it with', () => {
    expect(css).toContain(`@media ${SPLIT_QUERY} {`);
  });
});
