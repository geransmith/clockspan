import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

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

export function validatePassword(password: unknown): string | null {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

export function validateUsername(username: unknown): string | null {
  if (typeof username !== 'string') return 'Username is required.';
  const u = username.trim();
  if (u.length < 2) return 'Username must be at least 2 characters.';
  if (u.length > 40) return 'Username must be 40 characters or fewer.';
  if (!/^[a-zA-Z0-9._-]+$/.test(u)) return 'Username may contain letters, numbers, . _ and -';
  return null;
}
