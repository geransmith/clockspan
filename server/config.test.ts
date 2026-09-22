import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const load = (env: Record<string, string> = {}) => loadConfig({ AUTH_MODE: 'none', ...env });

describe('TRUST_PROXY', () => {
  it('is off unless set', () => {
    expect(load().trustProxy).toBe(false);
    expect(load({ TRUST_PROXY: '' }).trustProxy).toBe(false);
    expect(load({ TRUST_PROXY: '0' }).trustProxy).toBe(false);
    expect(load({ TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('takes a hop count', () => {
    expect(load({ TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(load({ TRUST_PROXY: '2' }).trustProxy).toBe(2);
  });

  it('passes Express string forms through instead of widening them to true', () => {
    expect(load({ TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(load({ TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).trustProxy).toBe('10.0.0.0/8, 172.16.0.0/12');
    expect(load({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });
});

describe('PORT', () => {
  it('defaults to 3000 and accepts 0 (ephemeral) through 65535', () => {
    expect(load().port).toBe(3000);
    expect(load({ PORT: '0' }).port).toBe(0);
    expect(load({ PORT: '8080' }).port).toBe(8080);
  });

  it('refuses anything that is not a port with a config error, not a listen() crash', () => {
    for (const bad of ['abc', '-1', '65536', '80.5']) expect(() => load({ PORT: bad })).toThrow(/PORT must be a whole number/);
  });
});

describe('SESSION_TTL_DAYS', () => {
  it('defaults to 30 days', () => {
    expect(load().sessionTtlMs).toBe(30 * 86_400_000);
    expect(load({ SESSION_TTL_DAYS: '' }).sessionTtlMs).toBe(30 * 86_400_000);
  });

  it('takes a positive number of days', () => {
    expect(load({ SESSION_TTL_DAYS: '7' }).sessionTtlMs).toBe(7 * 86_400_000);
    expect(load({ SESSION_TTL_DAYS: '0.5' }).sessionTtlMs).toBe(0.5 * 86_400_000);
  });

  it('refuses junk instead of silently falling back', () => {
    for (const bad of ['abc', '0', '-3']) expect(() => load({ SESSION_TTL_DAYS: bad })).toThrow(/SESSION_TTL_DAYS must be/);
  });
});

describe('AUTH_MODE', () => {
  it('rejects unknown modes and requires the OIDC settings for oidc', () => {
    expect(() => loadConfig({ AUTH_MODE: 'basic' })).toThrow(/AUTH_MODE must be one of/);
    expect(() => loadConfig({ AUTH_MODE: 'oidc' })).toThrow(/OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, APP_URL/);
  });
});

describe('blank values', () => {
  it('count as unset, so the defaults apply', () => {
    expect(loadConfig({ AUTH_MODE: '' }).authMode).toBe('none');
    expect(load({ APP_URL: 'https://focus.example.com', COOKIE_SECURE: '' }).cookieSecure).toBe(true);
    expect(load({ PORT: '', DATA_DIR: '', APP_URL: '', RETENTION_DAYS: '' })).toMatchObject({
      port: 3000,
      dataDir: path.resolve('./data'),
      appUrl: null,
      retentionDays: null,
    });
    const oidc = loadConfig({
      AUTH_MODE: 'oidc',
      APP_URL: 'https://focus.example.com',
      OIDC_ISSUER: 'https://auth.example.com/',
      OIDC_CLIENT_ID: 'clockspan',
      OIDC_CLIENT_SECRET: 'secret',
      OIDC_SCOPES: '',
    });
    expect(oidc.oidc?.scopes).toBe('openid profile email');
  });

  it('still leave a required OIDC setting missing', () => {
    expect(() =>
      loadConfig({ AUTH_MODE: 'oidc', APP_URL: 'https://focus.example.com', OIDC_ISSUER: '', OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's' }),
    ).toThrow(/requires OIDC_ISSUER\./);
  });
});

describe('COOKIE_SECURE', () => {
  it('follows the APP_URL scheme unless set explicitly', () => {
    expect(load().cookieSecure).toBe(false);
    expect(load({ APP_URL: 'https://focus.example.com/' }).cookieSecure).toBe(true);
    expect(load({ APP_URL: 'https://focus.example.com/' }).appUrl).toBe('https://focus.example.com');
    expect(load({ APP_URL: 'http://focus.lan' }).cookieSecure).toBe(false);
    // Explicit wins both ways: TLS terminated at a proxy, or a plain-http test of an https URL.
    expect(load({ APP_URL: 'http://focus.lan', COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(load({ APP_URL: 'https://focus.example.com', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });
});
