// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

afterEach(cleanup);

describe('Avatar', () => {
  it('shows the first character of the name in capitals, an emoji whole', () => {
    expect(render(<Avatar name="🦊 Fox" />).container.textContent).toBe('🦊');
    expect(render(<Avatar name="🇺🇸 Sam" />).container.textContent).toBe('🇺🇸');
    expect(render(<Avatar name="👍🏽 Sam" />).container.textContent).toBe('👍🏽');
    expect(render(<Avatar name="sam" />).container.textContent).toBe('S');
  });

  it('shows nothing for an empty name', () => {
    expect(render(<Avatar name="" />).container.textContent).toBe('');
  });
});
