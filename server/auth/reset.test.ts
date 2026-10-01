import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { openDatabase, type DB, type UserRow } from '../db.js';
import { countRows } from '../dev/harness.js';
import { ensureLocalUsers, LOCAL_USERS } from '../dev/seed.js';
import { PASSWORD_LENGTH } from '../../shared/api.js';
import { verifyPassword } from './password.js';
import { resetPassword } from './reset.js';
import { insertSession } from './session.js';

describe('resetPassword', () => {
  let db: DB;
  let admin: UserRow;
  let sam: UserRow;
  beforeEach(async () => {
    db = openDatabase(':memory:');
    ({ admin, member: sam } = await ensureLocalUsers(db));
    // sam is signed in on two devices, admin on one.
    const config = loadConfig({});
    insertSession(db, config, sam.id);
    insertSession(db, config, sam.id);
    insertSession(db, config, admin.id);
  });
  afterEach(() => db.close());

  const stored = (user: UserRow) =>
    db.prepare(`SELECT password_hash AS hash, must_change_password AS mustChange FROM users WHERE id = ?`).get(user.id) as { hash: string; mustChange: number };
  const sessions = (user: UserRow) => countRows(db, 'auth_sessions', 'user_id = ?', user.id);

  it('sets a given password for good and signs that user out everywhere, and no one else', async () => {
    expect(await resetPassword(db, LOCAL_USERS.member, 'a new password')).toEqual({ password: 'a new password', temporary: false });
    expect(stored(sam).mustChange).toBe(0);
    expect(await verifyPassword('a new password', stored(sam).hash)).toBe(true);
    expect(await verifyPassword(LOCAL_USERS.password, stored(sam).hash)).toBe(false);
    expect(sessions(sam)).toBe(0);
    expect(sessions(admin)).toBe(1);
    expect(await verifyPassword(LOCAL_USERS.password, stored(admin).hash)).toBe(true);
  });

  it('makes up a temporary password when none is given, which the user must replace at the next sign-in', async () => {
    const result = await resetPassword(db, LOCAL_USERS.member);
    expect(result).toEqual({ password: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), temporary: true });
    const { password } = result as { password: string };
    expect(stored(sam).mustChange).toBe(1);
    expect(await verifyPassword(password, stored(sam).hash)).toBe(true);
    expect(sessions(sam)).toBe(0);
    // A new one each time.
    expect(await resetPassword(db, LOCAL_USERS.member)).not.toEqual(result);
  });

  it('finds the user whatever the case of the name, as sign-in does', async () => {
    expect(await resetPassword(db, 'SAM', 'a new password')).toMatchObject({ temporary: false });
    expect(await verifyPassword('a new password', stored(sam).hash)).toBe(true);
    expect(sessions(sam)).toBe(0);
  });

  it('refuses a password the sign-in form would refuse, and changes nothing', async () => {
    const before = stored(sam);
    expect(await resetPassword(db, LOCAL_USERS.member, 'short')).toEqual({ error: `Password must be at least ${PASSWORD_LENGTH.min} characters.` });
    expect(await resetPassword(db, LOCAL_USERS.member, '')).toEqual({ error: `Password must be at least ${PASSWORD_LENGTH.min} characters.` });
    expect(stored(sam)).toEqual(before);
    expect(sessions(sam)).toBe(2);
  });

  it('refuses a name that is no local user', async () => {
    expect(await resetPassword(db, 'nobody', 'a new password')).toEqual({ error: 'No local user named "nobody".' });
    expect(sessions(sam)).toBe(2);
    expect(sessions(admin)).toBe(1);
  });
});
