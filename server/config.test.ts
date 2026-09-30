import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
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

  it('ignores spaces around the value, which started the server before values were checked', () => {
    expect(load({ TRUST_PROXY: '1 ' }).trustProxy).toBe(1);
    expect(load({ TRUST_PROXY: ' 1' }).trustProxy).toBe(1);
    expect(load({ TRUST_PROXY: '2 ' }).trustProxy).toBe(2);
    expect(load({ TRUST_PROXY: ' 0 ' }).trustProxy).toBe(false);
    expect(load({ TRUST_PROXY: '   ' }).trustProxy).toBe(false);
    expect(load({ TRUST_PROXY: ' loopback, 10.0.0.0/8 ' }).trustProxy).toBe('loopback, 10.0.0.0/8');
  });

  it('passes Express string forms through instead of widening them to true', () => {
    expect(load({ TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    expect(load({ TRUST_PROXY: '10.0.0.0/8, 172.16.0.0/12' }).trustProxy).toBe('10.0.0.0/8, 172.16.0.0/12');
    expect(load({ TRUST_PROXY: 'loopback, 192.168.1.2, fd00::/8, 10.0.0.0/255.0.0.0' }).trustProxy).toBe('loopback, 192.168.1.2, fd00::/8, 10.0.0.0/255.0.0.0');
    expect(load({ TRUST_PROXY: 'true' }).trustProxy).toBe(true);
  });

  it('refuses what Express would misread or crash on, naming the variable', () => {
    // 1.5 would trust two hops; the rest would fail at start with a bare "invalid IP address".
    for (const value of ['1.5', '-1', 'yes', 'on', 'TRUE', 'loopback,', '10.0.0.0/33', 'fd00::/129', '10.0.0.0/8/8', '10.0.0.0/fd00::', 'proxy.lan']) {
      expect(() => load({ TRUST_PROXY: value }), value).toThrow(/^TRUST_PROXY must be the number of proxies/);
    }
    // 1.0 started the server before values were checked, but a hop count is a whole number, spaces or not.
    for (const value of ['1.0', ' 1.5 ']) expect(() => load({ TRUST_PROXY: value }), value).toThrow(/^TRUST_PROXY must be the number of proxies/);
  });
});

describe('ALLOWED_HOSTS', () => {
  it('is empty unless set', () => {
    expect(load().allowedHosts).toEqual([]);
    expect(load({ ALLOWED_HOSTS: '' }).allowedHosts).toEqual([]);
  });

  it('takes names and leading-dot domains, trimmed and lowercased', () => {
    expect(load({ ALLOWED_HOSTS: 'Focus.Example.com, .lan ,nas_1.home-net.example,' }).allowedHosts).toEqual([
      'focus.example.com',
      '.lan',
      'nas_1.home-net.example',
    ]);
  });

  it('refuses a URL, a port or a wildcard, which would never match a name', () => {
    for (const bad of ['https://focus.example.com', 'focus.example.com:8443', 'focus.example.com/app', '*.example.com', 'a..b', '[::1]']) {
      expect(() => load({ ALLOWED_HOSTS: `ok.example, ${bad}` })).toThrow(`ALLOWED_HOSTS must be host names separated by commas`);
      expect(() => load({ ALLOWED_HOSTS: bad })).toThrow(`(got "${bad}")`);
    }
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

describe('DATA_DIR', () => {
  it('is the folder that holds the database file', () => {
    expect(load({ DATA_DIR: '/srv/clockspan' }).dbPath).toBe('/srv/clockspan/focus.db');
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

describe('RETENTION_DAYS', () => {
  it('is optional, bounded, and a whole number', () => {
    expect(load().retentionDays).toBeNull();
    expect(load({ RETENTION_DAYS: '' }).retentionDays).toBeNull();
    expect(load({ RETENTION_DAYS: '90' }).retentionDays).toBe(90);
    expect(() => load({ RETENTION_DAYS: '10' })).toThrow(/RETENTION_DAYS/);
    expect(() => load({ RETENTION_DAYS: '4000' })).toThrow(/RETENTION_DAYS/);
    expect(() => load({ RETENTION_DAYS: 'abc' })).toThrow(/RETENTION_DAYS/);
    expect(() => load({ RETENTION_DAYS: '1.5' })).toThrow(/RETENTION_DAYS/);
  });

  it('takes both ends of the range and names it when refusing', () => {
    expect(load({ RETENTION_DAYS: '30' }).retentionDays).toBe(30);
    expect(load({ RETENTION_DAYS: '3650' }).retentionDays).toBe(3650);
    expect(() => load({ RETENTION_DAYS: '29' })).toThrow(
      'RETENTION_DAYS must be a whole number of days from 30 to 3650, or unset to keep everything (got "29")',
    );
    expect(() => load({ RETENTION_DAYS: '3651' })).toThrow(/from 30 to 3650/);
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
      dbPath: path.resolve('./data', 'focus.db'),
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

describe('APP_URL and OIDC_ISSUER', () => {
  const oidc = (env: NodeJS.ProcessEnv) =>
    loadConfig({
      AUTH_MODE: 'oidc',
      APP_URL: 'https://focus.example.com',
      OIDC_ISSUER: 'https://auth.example.com/',
      OIDC_CLIENT_ID: 'c',
      OIDC_CLIENT_SECRET: 's',
      ...env,
    });

  it('refuse a value that is not an http(s) URL, naming the variable', () => {
    // Without a scheme this used to pass, then crash createApp with a bare "Invalid URL".
    expect(() => load({ APP_URL: 'focus.example.com' })).toThrow(
      /^APP_URL must be the scheme and host the app is served at, starting with https:\/\/ or http:\/\/ \(got "focus.example.com"\)$/,
    );
    expect(() => load({ APP_URL: 'ftp://focus.example.com' })).toThrow(/APP_URL must be/);
    expect(() => oidc({ OIDC_ISSUER: 'auth.example.com' })).toThrow(
      /^OIDC_ISSUER must be your provider's issuer URL, starting with https:\/\/ \(got "auth.example.com"\)$/,
    );
  });

  it('refuse an http issuer, which openid-client would never contact, while APP_URL may be http', () => {
    expect(() => oidc({ OIDC_ISSUER: 'http://localhost:9000/application/o/clockspan/' })).toThrow(
      /^OIDC_ISSUER must be your provider's issuer URL, starting with https:\/\/ \(got "http:\/\/localhost:9000\/application\/o\/clockspan\/"\)$/,
    );
    expect(() => oidc({ OIDC_ISSUER: 'HTTP://auth.lan/' })).toThrow(/OIDC_ISSUER must be/);
    expect(oidc({ APP_URL: 'http://focus.lan' }).appUrl).toBe('http://focus.lan');
  });

  it('keep the issuer as given, trailing slash included', () => {
    // The issuer is an identifier the provider's tokens must match exactly; APP_URL is a base to append to.
    expect(oidc({}).oidc?.issuer).toBe('https://auth.example.com/');
    expect(oidc({ OIDC_ISSUER: 'https://auth.example.com/application/o/clockspan/' }).oidc?.issuer).toBe('https://auth.example.com/application/o/clockspan/');
  });

  it('keep only the scheme and host of APP_URL, and say so when there was more', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(load({ APP_URL: 'Https://FOCUS.example.com/Clockspan/' }).appUrl).toBe('https://focus.example.com');
    expect(warn).toHaveBeenCalledWith(
      '[config] APP_URL should be only the scheme and host the app is served at; "Https://FOCUS.example.com/Clockspan/" has more, so https://focus.example.com is used (the app runs at the root of its host)',
    );
    // A query with no path is more than the host too, so the check reads the whole href, not the pathname.
    expect(load({ APP_URL: 'https://focus.example.com/?x=1' }).appUrl).toBe('https://focus.example.com');
    expect(warn).toHaveBeenLastCalledWith(
      '[config] APP_URL should be only the scheme and host the app is served at; "https://focus.example.com/?x=1" has more, so https://focus.example.com is used (the app runs at the root of its host)',
    );
    expect(load({ APP_URL: 'https://focus.example.com/' }).appUrl).toBe('https://focus.example.com');
    // A port is part of the host the app is served at (Unraid's usual form).
    expect(load({ APP_URL: 'http://tower:8080' }).appUrl).toBe('http://tower:8080');
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});

describe('COOKIE_SECURE', () => {
  it('follows the APP_URL scheme unless set explicitly', () => {
    expect(load().cookieSecure).toBe(false);
    expect(load({ APP_URL: 'https://focus.example.com/' }).cookieSecure).toBe(true);
    expect(load({ APP_URL: 'https://focus.example.com/' }).appUrl).toBe('https://focus.example.com');
    expect(load({ APP_URL: 'http://focus.lan' }).cookieSecure).toBe(false);
    // The scheme and host are case-insensitive; the Secure default and the OIDC redirect URI read the lowercase form.
    expect(load({ APP_URL: 'HTTPS://Focus.Example.com/' })).toMatchObject({ appUrl: 'https://focus.example.com', cookieSecure: true });
    expect(load({ APP_URL: 'HTTP://Focus.lan' })).toMatchObject({ appUrl: 'http://focus.lan', cookieSecure: false });
    // Explicit wins both ways: TLS terminated at a proxy, or a plain-http test of an https URL.
    expect(load({ APP_URL: 'http://focus.lan', COOKIE_SECURE: 'true' }).cookieSecure).toBe(true);
    expect(load({ APP_URL: 'https://focus.example.com', COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
  });

  it('reads the usual spellings of on and off, in any case', () => {
    for (const on of ['TRUE', 'True', '1', 'yes', 'On', ' true ']) expect(load({ COOKIE_SECURE: on }).cookieSecure, on).toBe(true);
    for (const off of ['FALSE', '0', 'no', 'off']) expect(load({ APP_URL: 'https://focus.example.com', COOKIE_SECURE: off }).cookieSecure, off).toBe(false);
  });

  it('keeps the default for a value that is neither, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(load({ APP_URL: 'https://focus.example.com', COOKIE_SECURE: 'secure' }).cookieSecure).toBe(true);
    expect(load({ APP_URL: 'http://focus.lan', COOKIE_SECURE: 'maybe' }).cookieSecure).toBe(false);
    expect(warn).toHaveBeenCalledWith('[config] COOKIE_SECURE should be true or false; "secure" is neither, so the default applies');
    warn.mockRestore();
  });
});

describe('Unraid template', () => {
  // unraid/clockspan.xml is the form Unraid users configure the container with, so a variable
  // .env.example documents but the template lacks is one they cannot set.
  const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const fields = [...read('unraid/clockspan.xml').matchAll(/<Config\b[^>]*>/g)].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/(\w+)="([^"]*)"/g)].map(([, name, value]) => [name, value])),
  );
  const targets = (type: string) => fields.filter((field) => field.Type === type).map((field) => field.Target);

  it('has a field for every variable in .env.example, and no others', () => {
    // DATA_PATH is Compose's name for the host folder; in the template that is the /data path.
    const documented = [...read('.env.example').matchAll(/^#?([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name).filter((name) => name !== 'DATA_PATH');
    expect(targets('Variable').sort()).toEqual([...new Set(documented)].sort());
  });

  it('maps the folder and the port the image uses', () => {
    expect(targets('Path')).toEqual(['/data']);
    expect(targets('Port')).toEqual(['8080']);
  });
});
