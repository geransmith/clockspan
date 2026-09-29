import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { PASSWORD_LENGTH, USERNAME } from '../../shared/api.js';

// Format: scrypt$<log2 N>$<salt b64>$<hash b64>. N is stored so it can be raised later
// without invalidating existing hashes.
const LOG2_N = 15;
const KEYLEN = 64;
const R = 8;
// scrypt's working set is 128 * r * N bytes, and Node's default maxmem (32 MB) is exactly
// that for N=2^15, so it throws. Deriving the limit from N (with 2x headroom) means a hash
// at any cost verifyPassword accepts can be checked, and LOG2_N can be raised on its own.
const SCRYPT_OPTS = (log2N: number) => ({ N: 2 ** log2N, r: R, maxmem: 2 * 128 * R * 2 ** log2N });

// The async form runs on the libuv pool: ~60 ms of key stretching per attempt must not
// stall every other request while the login limiter is doing its job.
const scryptAsync = promisify<string, Buffer, number, ReturnType<typeof SCRYPT_OPTS>, Buffer>(scrypt);

/** `log2N` is only overridable so tests can cover verifying at another cost. */
export async function hashPassword(password: string, log2N: number = LOG2_N): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, SCRYPT_OPTS(log2N));
  return `scrypt$${log2N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const log2N = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, 'base64');
  const expected = Buffer.from(parts[3]!, 'base64');
  if (!Number.isInteger(log2N) || log2N < 10 || log2N > 20 || salt.length === 0 || expected.length === 0) return false;
  const actual = await scryptAsync(password, salt, expected.length, SCRYPT_OPTS(log2N));
  return timingSafeEqual(actual, expected);
}

/**
 * A real hash of a throwaway password. Login verifies against it when the username is
 * unknown so a wrong name costs the same time as a wrong password.
 */
export const DUMMY_HASH = await hashPassword(randomBytes(16).toString('base64url'));

// The sign-in forms' bodies arrive as `any`. These hand back a checked value or the message to
// show, so a route never touches a field it hasn't validated (the no-unsafe-* lint holds it).

export function parsePassword(raw: unknown): { password: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'Password is required.' };
  if (raw.length < PASSWORD_LENGTH.min) return { error: `Password must be at least ${PASSWORD_LENGTH.min} characters.` };
  if (raw.length > PASSWORD_LENGTH.max) return { error: 'Password is too long.' };
  return { password: raw };
}

const USERNAME_RE = new RegExp(`^(?:${USERNAME.pattern})$`);

/** The username comes back trimmed, which is how it is stored and looked up. */
export function parseUsername(raw: unknown): { username: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'Username is required.' };
  const username = raw.trim();
  if (username.length < USERNAME.min) return { error: `Username must be at least ${USERNAME.min} characters.` };
  if (username.length > USERNAME.max) return { error: `Username must be ${USERNAME.max} characters or fewer.` };
  if (!USERNAME_RE.test(username)) return { error: `Username may contain ${USERNAME.chars}` };
  return { username };
}

/** `{ username, password }` for a new account (first-run setup, an admin adding a user). */
export function parseCredentials(body: unknown): { username: string; password: string } | { error: string } {
  const { username, password } = (body ?? {}) as { username?: unknown; password?: unknown };
  const u = parseUsername(username);
  if ('error' in u) return u;
  const p = parsePassword(password);
  if ('error' in p) return p;
  return { username: u.username, password: p.password };
}
