import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';
import net from 'net';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

function run(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', CLI], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, ...env } });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
  return { child, exited, out: () => out, err: () => err };
}

describe('cli', () => {
  it('starts, answers /healthz, and exits 0 on SIGTERM', async () => {
    const [http, https, control, rtsp, onvif, baichuan] = [await freePort(), await freePort(), await freePort(), await freePort(), await freePort(), await freePort()];
    const p = run({ CAMSIM_USERS: 'u:admin:p', CAMSIM_HTTP_PORT: String(http), CAMSIM_HTTPS_PORT: String(https), CAMSIM_CONTROL_PORT: String(control), CAMSIM_RTSP_PORT: String(rtsp), CAMSIM_ONVIF_PORT: String(onvif), CAMSIM_BAICHUAN_PORT: String(baichuan) });
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ok = await fetch(`http://127.0.0.1:${control}/healthz`).then((r) => r.status === 200, () => false);
    }
    expect(ok).toBe(true);
    // Logged once every listener is up, RTSP included (a second or two later).
    await expect.poll(() => p.out(), { timeout: 15_000 }).toContain('cam_sim_listening');
    // The Baichuan port (CAMSIM_BAICHUAN_PORT) accepts connections.
    expect(await new Promise<boolean>((resolve) => {
      const s = net.connect(baichuan, '127.0.0.1', () => {
        s.destroy();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    })).toBe(true);
    p.child.kill('SIGTERM');
    expect(await p.exited).toBe(0);
  }, 30_000);

  it('without CAMSIM_BAICHUAN_PORT starts no Baichuan listener, so several run at once', async () => {
    const env = async () => ({ CAMSIM_USERS: 'u:admin:p', CAMSIM_HTTP_PORT: String(await freePort()), CAMSIM_HTTPS_PORT: String(await freePort()), CAMSIM_CONTROL_PORT: String(await freePort()), CAMSIM_RTSP_PORT: String(await freePort()), CAMSIM_ONVIF_PORT: String(await freePort()) });
    const sims = [run(await env()), run(await env())];
    try {
      for (const p of sims) await expect.poll(() => p.out(), { timeout: 40_000 }).toContain('cam_sim_listening');
      for (const p of sims) {
        const line = p.out().split('\n').find((l) => l.includes('cam_sim_listening'))!;
        const ports = JSON.parse(line).ports;
        expect(ports.onvif).toBeGreaterThan(0);
        expect(ports).not.toHaveProperty('baichuan');
      }
    } finally {
      for (const p of sims) p.child.kill('SIGTERM');
    }
    for (const p of sims) expect(await p.exited).toBe(0);
  }, 90_000);

  it('exits 2 on a config error, naming the variable', async () => {
    const p = run({});
    expect(await p.exited).toBe(2);
    expect(p.err()).toContain('CAMSIM_USERS');
  }, 30_000);
});
