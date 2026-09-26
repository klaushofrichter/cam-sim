import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import request from 'supertest';
import { makeEngine, post } from './helpers';
import { createLogger } from '../src/log';
import { createCameraApp } from '../src/camera-api/app';
import { createControlApp } from '../src/control-api/app';

describe('secrets stay out of logs', () => {
  it('passwords and tokens appear neither in pino output nor in the request log', async () => {
    let out = '';
    const log = createLogger('debug', new Writable({ write(c, _e, cb) { out += c; cb(); } }));
    const engine = await makeEngine({ CAMSIM_USERS: 'cams:admin:S3cret-pw', CAMSIM_CONTROL_TOKEN: 'ctl-Tok-123', CAMSIM_LOG_LEVEL: 'debug' }, { log });
    const cam = createCameraApp(engine, { port: 'http' });
    const { reply } = await post(cam, 'Login', { User: { userName: 'cams', password: 'S3cret-pw' } });
    const token = reply.value.Token.name;
    await request(cam).get(`/cgi-bin/api.cgi?cmd=Snap&token=${token}`);
    await post(cam, 'Login', { User: { userName: 'cams', password: 'wrong-Pw-9' } });
    const ctl = createControlApp(engine);
    const reqs = JSON.stringify((await request(ctl).get('/sim/api/requests').set('Authorization', 'Bearer ctl-Tok-123')).body);
    await request(ctl).get('/sim/api/state').set('Authorization', 'Bearer wrong-ctl-777');
    await new Promise((r) => setImmediate(r));
    expect(out).toContain('camera_request');
    for (const secret of ['S3cret-pw', 'wrong-Pw-9', token, 'ctl-Tok-123', 'wrong-ctl-777']) {
      expect(out).not.toContain(secret);
      expect(reqs).not.toContain(secret);
    }
  });
});
