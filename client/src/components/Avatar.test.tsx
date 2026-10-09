// @vitest-environment happy-dom
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

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
