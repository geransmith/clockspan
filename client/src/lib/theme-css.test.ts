import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('styles.css', () => {
  // The dark palette is written twice: under the system's dark scheme and for a forced dark theme.
  it('has the same dark tokens in both places', () => {
    const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
    const tokens = (selector: string) => {
      const start = css.indexOf(`${selector} {`);
      const body = css.slice(start, css.indexOf('}', start));
      return body
        .split('\n')
        .filter((l) => l.trim().startsWith('--'))
        .map((l) => l.trim());
    };
    const system = tokens(":root:not([data-theme='light'])");
    expect(system.length).toBeGreaterThan(10);
    expect(tokens(":root[data-theme='dark']")).toEqual(system);
  });
});
