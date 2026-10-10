// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { createContext, type ReactNode } from 'react';
import { expect, it } from 'vitest';
import { useProvided } from './useProvided';

const Ctx = createContext<number | null>(null);

it('answers the value of its provider, a falsy one included', () => {
  const wrapper = ({ children }: { children: ReactNode }) => <Ctx.Provider value={0}>{children}</Ctx.Provider>;
  expect(renderHook(() => useProvided(Ctx, 'useCount'), { wrapper }).result.current).toBe(0);
});

it('refuses to run outside its provider, naming the hook', () => {
  expect(() => renderHook(() => useProvided(Ctx, 'useCount'))).toThrow('useCount outside its provider');
});
