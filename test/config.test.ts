import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config';

const base = { CAMSIM_USERS: 'admin:admin:pw1;cams:admin:pw2' };

describe('loadConfig', () => {
  it('parses users', () => {
    const c = loadConfig(base);
    expect(c.users).toEqual([
      { name: 'admin', level: 'admin', password: 'pw1' },
      { name: 'cams', level: 'admin', password: 'pw2' },
    ]);
  });

  it('keeps colons inside a password', () => {
    expect(loadConfig({ CAMSIM_USERS: 'a:guest:x:y' }).users[0].password).toBe('x:y');
  });

  it('rejects a bad level without echoing the password', () => {
    let err: unknown;
    try {
      loadConfig({ CAMSIM_USERS: 'admin:root:s3cret' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    expect(String((err as Error).message)).toContain('CAMSIM_USERS');
    expect(String((err as Error).message)).not.toContain('s3cret');
  });

  it('requires CAMSIM_USERS', () => {
    expect(() => loadConfig({})).toThrow(/CAMSIM_USERS/);
  });

  it('reads secrets from _FILE, which wins over the plain variable', () => {
    const c = loadConfig({ ...base, CAMSIM_CONTROL_TOKEN: 'plain', CAMSIM_CONTROL_TOKEN_FILE: '/f' }, (p) => (p === '/f' ? 'tok\n' : ''));
    expect(c.controlToken).toBe('tok');
  });

  it('reads users from CAMSIM_USERS_FILE', () => {
    const c = loadConfig({ CAMSIM_USERS_FILE: '/u' }, () => 'x:admin:y\n');
    expect(c.users[0]).toEqual({ name: 'x', level: 'admin', password: 'y' });
  });

  it('has defaults', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      name: 'Cam',
      tz: 'America/Chicago',
      sdMb: 4096,
      speed: 'fast',
      media: 'fixture',
      webUi: false,
      seedClips: 'none',
      faults: [],
      autoEvents: [],
      firmVer: 'v3.2.0.6011_2607012059',
      ports: { https: 8443, http: 8080, control: 9443 },
      logLevel: 'info',
    });
    expect(c.controlToken).toBeUndefined();
    expect(typeof c.seed).toBe('number');
  });

  it('parses CAMSIM_FAULTS and rejects invalid JSON', () => {
    expect(loadConfig({ ...base, CAMSIM_FAULTS: '[{"name":"downloads.refuse"}]' }).faults).toEqual([{ name: 'downloads.refuse' }]);
    expect(() => loadConfig({ ...base, CAMSIM_FAULTS: '[{' })).toThrow(/CAMSIM_FAULTS/);
  });

  it('parses CAMSIM_AUTO_EVENTS', () => {
    expect(loadConfig({ ...base, CAMSIM_AUTO_EVENTS: 'motion:6/h,person:1/h' }).autoEvents).toEqual([
      { type: 'motion', perHour: 6 },
      { type: 'person', perHour: 1 },
    ]);
    expect(loadConfig({ ...base, CAMSIM_AUTO_EVENTS: 'off' }).autoEvents).toEqual([]);
    expect(() => loadConfig({ ...base, CAMSIM_AUTO_EVENTS: 'ghost:1/h' })).toThrow(/CAMSIM_AUTO_EVENTS/);
  });

  it('rejects bad enums and numbers', () => {
    expect(() => loadConfig({ ...base, CAMSIM_SPEED: 'warp' })).toThrow(/CAMSIM_SPEED/);
    expect(() => loadConfig({ ...base, CAMSIM_SD_MB: '-1' })).toThrow(/CAMSIM_SD_MB/);
    expect(() => loadConfig({ ...base, CAMSIM_HTTP_PORT: 'x' })).toThrow(/CAMSIM_HTTP_PORT/);
  });

  it('uses CAMSIM_SEED when set', () => {
    expect(loadConfig({ ...base, CAMSIM_SEED: '42' }).seed).toBe(42);
  });
});
