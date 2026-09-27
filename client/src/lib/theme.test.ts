// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, storedTheme } from './theme';

const colors = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  // What index.html ships.
  document.head.innerHTML = `
    <meta name="theme-color" content="#f5f6f8" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#0f1216" media="(prefers-color-scheme: dark)" />`;
});

describe('applyTheme', () => {
  it('forces a theme on the page and the browser bar, and remembers it', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(colors()).toEqual(['#0f1216', '#0f1216']);
    expect(storedTheme()).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(colors()).toEqual(['#f5f6f8', '#f5f6f8']);
    expect(storedTheme()).toBe('light');
  });

  it('hands both back to the system on auto', () => {
    applyTheme('dark');
    applyTheme('auto');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(colors()).toEqual(['#f5f6f8', '#0f1216']);
    expect(storedTheme()).toBe('auto');
  });
});

describe('storedTheme', () => {
  it('is auto when nothing usable is stored', () => {
    expect(storedTheme()).toBe('auto');
    localStorage.setItem('focus:theme', 'sepia');
    expect(storedTheme()).toBe('auto');
  });
});
