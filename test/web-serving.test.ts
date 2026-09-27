import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import request from 'supertest';
import { makeEngine } from './helpers';
import { createControlApp } from '../src/control-api/app';

function fakeBuild(): string {
  const dir = mkdtempSync(join(tmpdir(), 'camsim-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="app"></div>');
  writeFileSync(join(dir, 'assets', 'a.js'), 'console.log(1)');
  return dir;
}

afterEach(() => {
  delete process.env.CAMSIM_WEB_DIR;
});

describe('web UI serving', () => {
  it('serves the app for / and client routes, not for the API', async () => {
    process.env.CAMSIM_WEB_DIR = fakeBuild();
    const ctl = createControlApp(await makeEngine({ CAMSIM_CONTROL_TOKEN: 't', CAMSIM_WEB_UI: 'true' }));
    const index = await request(ctl).get('/');
    expect(index.status).toBe(200);
    expect(index.text).toContain('<div id="app">');
    expect(index.headers['cache-control']).toBe('no-store');
    expect((await request(ctl).get('/anything')).text).toContain('<div id="app">');
    expect((await request(ctl).get('/assets/a.js')).status).toBe(200);
    expect((await request(ctl).get('/sim/api/state')).status).toBe(401);
    expect((await request(ctl).get('/healthz')).body).toEqual({ ok: true });
  });

  it('is off without CAMSIM_WEB_UI, and without a control token', async () => {
    process.env.CAMSIM_WEB_DIR = fakeBuild();
    const envs: Array<Record<string, string>> = [{ CAMSIM_CONTROL_TOKEN: 't' }, { CAMSIM_WEB_UI: 'true' }];
    for (const env of envs) {
      const ctl = createControlApp(await makeEngine(env));
      expect((await request(ctl).get('/')).status).toBe(404);
    }
  });
});

describe('web UI serving hardening', () => {
  it('answers 404 for a missing asset instead of the app page', async () => {
    process.env.CAMSIM_WEB_DIR = fakeBuild();
    const ctl = createControlApp(await makeEngine({ CAMSIM_CONTROL_TOKEN: 't', CAMSIM_WEB_UI: 'true' }));
    expect((await request(ctl).get('/assets/missing.js')).status).toBe(404);
  });

  it('may not be framed by another page', async () => {
    process.env.CAMSIM_WEB_DIR = fakeBuild();
    const ctl = createControlApp(await makeEngine({ CAMSIM_CONTROL_TOKEN: 't', CAMSIM_WEB_UI: 'true' }));
    const res = await request(ctl).get('/');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  });
});
