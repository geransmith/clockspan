import type { Theme } from '../types';
import { readStored, writeStored } from './storage';

const STORAGE_KEY = 'focus:theme';

/**
 * Put a theme on the page: `data-theme` on <html>, which styles.css keys the forced palettes
 * on, and the browser bar colour, which index.html sets per system scheme. A forced theme
 * gives both theme-color tags its own colour; 'auto' puts back what each tag started with.
 * Remembered on this device so the next load can apply it before the settings arrive.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  const metas = [...document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][media]')];
  for (const m of metas) m.dataset.auto ??= m.content;
  const forced = theme === 'auto' ? undefined : metas.find((m) => m.getAttribute('media')!.includes(theme))?.dataset.auto;
  for (const m of metas) m.content = forced ?? m.dataset.auto!;
  writeStored(STORAGE_KEY, theme);
}

/** The theme this device used last, for the first paint; 'auto' when there is none. */
export function storedTheme(): Theme {
  const v = readStored(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : 'auto';
}
