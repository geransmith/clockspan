// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { useFollowedDraft } from './useFollowedDraft';

it('keeps what is typed until the stored name changes, then shows the new name', () => {
  const { result, rerender } = renderHook((stored: string) => useFollowedDraft(stored), { initialProps: 'Admin' });
  expect(result.current[0]).toBe('Admin');
  act(() => result.current[1]('Adm'));
  expect(result.current[0]).toBe('Adm');
  // A render with the same stored name leaves the draft alone.
  rerender('Admin');
  expect(result.current[0]).toBe('Adm');
  rerender('Admin work');
  expect(result.current[0]).toBe('Admin work');
});
