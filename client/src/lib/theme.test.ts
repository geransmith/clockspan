// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { applyTheme, storedTheme } from './theme';

const colors = () => [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')].map((m) => m.content);

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  document.head.innerHTML = `
    <meta name="theme-color" content="#light" media="(prefers-color-scheme: light)" />
    <meta name="theme-color" content="#dark" media="(prefers-color-scheme: dark)" />`;
});

describe('applyTheme', () => {
  it('forces a theme on the page and the browser bar, and remembers it', () => {
    applyTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(colors()).toEqual(['#dark', '#dark']);
    expect(storedTheme()).toBe('dark');
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(colors()).toEqual(['#light', '#light']);
    expect(storedTheme()).toBe('light');
  });

  it('hands both back to the system on auto', () => {
    applyTheme('dark');
    applyTheme('auto');
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(colors()).toEqual(['#light', '#dark']);
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
