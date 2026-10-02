import { describe, it, expect } from 'vitest';
import { Sessions } from '../src/engine/sessions';
import { fixedClock } from '../src/engine/clock';

const users = [
  { name: 'admin', level: 'admin' as const, password: 'a' },
  { name: 'cams', level: 'admin' as const, password: 'c' },
];

function make() {
  const clock = fixedClock(new Date('2026-09-26T12:00:00Z'));
  return { clock, s: new Sessions(users, clock) };
}

describe('Sessions', () => {
  it('rejects a wrong password with -7', () => {
    expect(make().s.login('admin', 'x', '10.0.0.1')).toEqual({ ok: false, rspCode: -7 });
    expect(make().s.login('nobody', 'a', '10.0.0.1')).toEqual({ ok: false, rspCode: -7 });
  });

  it('issues 16-hex tokens with a 3600 s lease', () => {
    const r = make().s.login('admin', 'a', '10.0.0.1');
    expect(r).toMatchObject({ ok: true, leaseTime: 3600 });
    if (r.ok) expect(r.token).toMatch(/^[0-9a-f]{16}$/);
  });

  it('accumulates sessions that are never logged out', () => {
    const { s } = make();
    for (let i = 0; i < 3; i++) s.login('admin', 'a', '10.0.0.1');
    const online = s.online();
    expect(online).toHaveLength(3);
    expect(online[0]).toEqual({ canbeDisconn: 0, ip: '10.0.0.1', level: 'admin', sessionId: 10, userName: 'admin' });
    expect(online.map((o) => o.sessionId)).toEqual([10, 11, 12]);
  });

  it('expires leases', () => {
    const { s, clock } = make();
    const r = s.login('admin', 'a', 'ip');
    if (!r.ok) throw new Error();
    expect(s.validate(r.token)?.user.name).toBe('admin');
    clock.advance(3601_000);
    expect(s.validate(r.token)).toBeUndefined();
    expect(s.online()).toEqual([]);
  });

  it('logs out and revokes', () => {
    const { s } = make();
    const a = s.login('admin', 'a', 'ip'), b = s.login('cams', 'c', 'ip');
    if (!a.ok || !b.ok) throw new Error();
    s.logout(a.token);
    expect(s.validate(a.token)).toBeUndefined();
    s.revokeAll();
    expect(s.validate(b.token)).toBeUndefined();
    expect(s.validate(undefined)).toBeUndefined();
  });

  it('a password change invalidates only that user\'s tokens', () => {
    const { s } = make();
    const a = s.login('admin', 'a', 'ip'), c = s.login('cams', 'c', 'ip');
    if (!a.ok || !c.ok) throw new Error();
    expect(s.modifyUser('cams', { password: 'n' })).toBeNull();
    expect(s.validate(c.token)).toBeUndefined();
    expect(s.validate(a.token)).toBeDefined();
    expect(s.login('cams', 'n', 'ip').ok).toBe(true);
  });

  it('manages users', () => {
    const { s } = make();
    expect(s.users()).toEqual([{ level: 'admin', userName: 'admin' }, { level: 'admin', userName: 'cams' }]);
    expect(s.addUser({ name: 'g', level: 'guest', password: 'p' })).toBeNull();
    expect(s.addUser({ name: 'g', level: 'guest', password: 'p' })).toBe(-4);
    expect(s.addUser({ name: '', level: 'guest', password: 'p' })).toBe(-4);
    const g = s.login('g', 'p', 'ip');
    if (!g.ok) throw new Error();
    expect(s.delUser('g')).toBeNull();
    expect(s.validate(g.token)).toBeUndefined();
    expect(s.delUser('g')).toBe(-4);
    expect(s.modifyUser('nobody', { password: 'x' })).toBe(-4);
  });

  it('lists Baichuan sessions in online() with the shared ids, not in count(); a revoke leaves them', () => {
    const { s } = make();
    s.login('admin', 'a', '10.0.0.1');
    const id = s.openBaichuan({ name: 'cams', level: 'admin', password: 'c' }, '10.0.0.2');
    expect(id).toBe(11);
    expect(s.online()).toEqual([
      { canbeDisconn: 0, ip: '10.0.0.1', level: 'admin', sessionId: 10, userName: 'admin' },
      { canbeDisconn: 0, ip: '10.0.0.2', level: 'admin', sessionId: 11, userName: 'cams' },
    ]);
    expect(s.count()).toBe(1);
    s.revokeAll();
    expect(s.online().map((o) => o.sessionId)).toEqual([11]);
    s.closeBaichuan(id);
    expect(s.online()).toEqual([]);
  });

  it('findUser answers a copy of the current user', () => {
    const { s } = make();
    expect(s.modifyUser('cams', { password: 'new' })).toBeNull();
    const u = s.findUser((x) => x.name === 'cams')!;
    expect(u.password).toBe('new');
    u.password = 'changed';
    expect(s.findUser((x) => x.name === 'cams')!.password).toBe('new');
    expect(s.findUser(() => false)).toBeUndefined();
  });
});
