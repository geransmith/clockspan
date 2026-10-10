import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CATEGORY_COLORS } from '../../../shared/api.js';
import { BOARD_COLUMNS_QUERY, SPLIT_QUERY } from './layout';

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
/** A token's colour, following a `var(--x)` within the same block. */
const resolve = (selector: string, name: string): string => {
  const value = token(selector, name)!;
  const ref = /^var\(--(.+)\)$/.exec(value)?.[1];
  return ref ? resolve(selector, ref) : value;
};
const THEMES = [':root', ":root[data-theme='dark']"];
const TONES = ['accent', 'ok', 'warn', 'danger'];

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

  // A token only the dark theme sets would be unset in the light one, and the rules using it dropped.
  it('sets every dark token in the light theme too', () => {
    const names = (selector: string) => tokens(selector).map((l) => l.slice(0, l.indexOf(':')));
    const light = names(':root');
    expect(names(":root[data-theme='dark']").filter((n) => !light.includes(n))).toEqual([]);
  });

  // WCAG's 4.5:1 for text (--text-2 and each tone's -ink, on the cards and on its own -soft) and
  // 3:1 for --text-3's icons, placeholders and marks, on everything they sit on.
  it('keeps the text tokens readable on what they sit on, in each theme', () => {
    for (const theme of THEMES) {
      const expectRatio = (fg: string, on: string, min: number) =>
        expect(contrast(resolve(theme, fg), resolve(theme, on)), `${theme} --${fg} on --${on}`).toBeGreaterThanOrEqual(min);
      for (const surface of ['surface', 'surface-2']) {
        expectRatio('text-2', surface, 4.5);
        for (const tone of TONES) expectRatio(`${tone}-ink`, surface, 4.5);
      }
      for (const tone of TONES) expectRatio(`${tone}-ink`, `${tone}-soft`, 4.5);
      for (const on of ['bg', 'surface', 'surface-2', 'surface-3', ...TONES.map((t) => `${t}-soft`)]) expectRatio('text-3', on, 3);
      expectRatio('accent-text', 'accent', 4.5);
    }
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
    for (const theme of THEMES) {
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

  // In Progress and Done drag only while the board's matchMedia(BOARD_COLUMNS_QUERY) says the four
  // columns sit side by side; a width changed on one side only would let them drag where one shows.
  it("lays the board's columns side by side under the query the board asks", () => {
    expect(css).toContain(`@media ${BOARD_COLUMNS_QUERY} {`);
  });

  // Every view sits in the one frame, so a page switch leaves the header and the running bar where they were.
  it("sets the page width once, for every view, and keeps the scrollbar's room", () => {
    expect(css.match(/--page-w: .+;/g)).toEqual(['--page-w: 1240px;']);
    expect(css).toContain('scrollbar-gutter: stable;');
  });

  // The coarse block's one ::after rule takes its inset from --hit-inset, which each control sets in
  // a rule of its own (or in a rule for the only parent it sits in, as the note button's); one left
  // without it has an inset that resolves to nothing, and no touch area.
  it('gives every touch area its inset', () => {
    const start = css.indexOf('@media (pointer: coarse) {');
    const block = css.slice(start, css.indexOf('\n}\n', start)).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selectors, body]) => ({
      selectors: selectors!.split(',').map((s) => s.trim()),
      body: body!,
    }));
    const areas = rules.find((r) => r.body.includes('var(--hit-inset)'))!.selectors.map((s) => s.replace(/::after$/, ''));
    const inset = rules.filter((r) => r.body.includes('--hit-inset:')).flatMap((r) => r.selectors);
    expect(areas.length).toBeGreaterThan(10);
    expect(areas.filter((area) => !inset.some((s) => s === area || s.endsWith(` ${area}`)))).toEqual([]);
  });

  // A toggle's on state is styled from its ARIA attribute, never a class kept beside it.
  it('styles no on state from a class', () => {
    expect(css).not.toMatch(/\.is-(on|active)\b/);
  });
});
