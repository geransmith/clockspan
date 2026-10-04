// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

afterEach(cleanup);

describe('Avatar', () => {
  it('shows the first character of the name in capitals, an emoji whole', () => {
    // `slice(0, 1)` took the first UTF-16 unit: half of the fox's surrogate pair.
    expect(render(<Avatar name="🦊 Fox" />).container.textContent).toBe('🦊');
    expect(render(<Avatar name="sam" />).container.textContent).toBe('S');
  });
});
