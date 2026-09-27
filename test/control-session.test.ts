import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { makeEngine } from './helpers';
import { createControlApp } from '../src/control-api/app';
import { createSessionSigner } from '../src/control-api/session';

const TOKEN = 'ui-token-for-tests';

async function setup(env: Record<string, string> = {}) {
  const engine = await makeEngine({ CAMSIM_CONTROL_TOKEN: TOKEN, ...env });
  return { engine, ctl: createControlApp(engine) };
}

async function loginCookie(ctl: Parameters<typeof request>[0]): Promise<string> {
  const res = await request(ctl).post('/sim/login').send({ token: TOKEN });
  expect(res.status).toBe(204);
  const set = res.headers['set-cookie'] as unknown as string[];
  return set[0].split(';')[0];
}

describe('session signer', () => {
  it('issues and verifies, and rejects tampering and expiry', () => {
    const s = createSessionSigner(Buffer.alloc(32, 1), 1000);
    const v = s.issue();
    expect(s.verify(v)).toBe(true);
    expect(s.verify(v.replace(/.$/, (c) => (c === 'a' ? 'b' : 'a')))).toBe(false);
    expect(s.verify('v1.9999999999999.00')).toBe(false);
    expect(createSessionSigner(Buffer.alloc(32, 2)).verify(v)).toBe(false);
    const expired = createSessionSigner(Buffer.alloc(32, 1), -1).issue();
    expect(s.verify(expired)).toBe(false);
  });
});

describe('UI login', () => {
  it('accepts the control token and sets a strict, http-only cookie', async () => {
    const { ctl } = await setup();
    const res = await request(ctl).post('/sim/login').send({ token: TOKEN });
    expect(res.status).toBe(204);
    const cookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(cookie).toMatch(/^camsim_session=v1\./);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toContain(TOKEN);
  });

  it('refuses a wrong token', async () => {
    const { ctl } = await setup();
    expect((await request(ctl).post('/sim/login').send({ token: 'nope' })).status).toBe(401);
    expect((await request(ctl).post('/sim/login').send({})).status).toBe(401);
  });

  it('reads with the cookie; writes need the X-CamSim-UI header', async () => {
    const { ctl, engine } = await setup();
    const c = await loginCookie(ctl);
    expect((await request(ctl).get('/sim/api/state').set('Cookie', c)).status).toBe(200);
    expect((await request(ctl).get('/sim/session').set('Cookie', c)).body).toEqual({ loggedIn: true });
    const forged = await request(ctl).put('/sim/api/faults/offline').set('Cookie', c).send({});
    expect(forged.status).toBe(403);
    expect(forged.body).toEqual({ error: 'csrf' });
    expect(engine.faults.list()).toEqual([]);
    const ok = await request(ctl).put('/sim/api/faults/offline').set('Cookie', c).set('X-CamSim-UI', '1').send({});
    expect(ok.status).toBe(200);
  });

  it('bearer requests need no header', async () => {
    const { ctl } = await setup();
    expect((await request(ctl).put('/sim/api/faults/offline').set('Authorization', `Bearer ${TOKEN}`).send({})).status).toBe(200);
  });

  it('rejects a forged cookie and one from another process', async () => {
    const { ctl } = await setup();
    const other = await setup();
    const foreign = await loginCookie(other.ctl);
    for (const c of ['camsim_session=v1.9999999999999.abcd', foreign]) {
      expect((await request(ctl).get('/sim/api/state').set('Cookie', c)).status).toBe(401);
    }
    expect((await request(ctl).get('/sim/session').set('Cookie', foreign)).body).toEqual({ loggedIn: false });
  });

  it('logs out', async () => {
    const { ctl } = await setup();
    const c = await loginCookie(ctl);
    const res = await request(ctl).post('/sim/logout').set('Cookie', c).set('X-CamSim-UI', '1');
    expect(res.status).toBe(204);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/camsim_session=;/);
  });

  it('still refuses a token in the URL, and has no login without a control token', async () => {
    const { ctl } = await setup();
    const c = await loginCookie(ctl);
    expect((await request(ctl).get(`/sim/api/state?token=${TOKEN}`).set('Cookie', c)).status).toBe(400);
    const bare = createControlApp(await makeEngine());
    expect((await request(bare).post('/sim/login').send({ token: 'x' })).status).toBe(404);
  });
});
