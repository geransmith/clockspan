import type { InputHTMLAttributes } from 'react';
import { USERNAME } from '../types';

/**
 * A username field with the server's rules (`USERNAME` in shared/api.ts): the browser refuses
 * what the server would, with the characters it takes in the tooltip. The setup page and
 * Settings → Account both use it.
 */
export function UsernameInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'minLength' | 'maxLength' | 'pattern' | 'title' | 'required'>) {
  return (
    <input
      className="input"
      minLength={USERNAME.min}
      maxLength={USERNAME.max}
      pattern={USERNAME.pattern}
      title={`Only ${USERNAME.chars}`}
      required
      {...props}
    />
  );
}
