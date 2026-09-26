import { describe, it, expect } from 'vitest';
import { Writable } from 'stream';
import { createLogger } from '../src/log';

describe('logger', () => {
  it('redacts passwords, tokens and URLs', async () => {
    let out = '';
    const dest = new Writable({ write(chunk, _e, cb) { out += chunk; cb(); } });
    const log = createLogger('info', dest);
    log.info({ password: 'pw-123', token: 'tk-456', user: { password: 'pw-789' }, req: { url: '/x?token=tk-000', headers: { authorization: 'Bearer ab-1' } } }, 'hello');
    await new Promise((r) => setImmediate(r));
    expect(out).toContain('hello');
    for (const s of ['pw-123', 'tk-456', 'pw-789', 'tk-000', 'ab-1']) expect(out).not.toContain(s);
  });
});
