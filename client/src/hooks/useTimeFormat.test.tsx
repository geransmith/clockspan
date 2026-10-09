// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../api';
import { makeSettings, settle, T0 } from '../test/hooks';
import { SettingsProvider } from './useSettings';
import { useTimeFormat } from './useTimeFormat';

vi.mock('../api');

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
});

it('follows the time format setting', async () => {
  vi.mocked(api.getSettings).mockResolvedValue(makeSettings({ timeFormat: '24h' }));
  const { result } = renderHook(() => useTimeFormat(), { wrapper: SettingsProvider });
  await settle();
  expect(result.current.hour12).toBe(false);
  expect(result.current.formatTime(new Date(2026, 8, 28, 14, 5).getTime())).toBe('14:05');
});
