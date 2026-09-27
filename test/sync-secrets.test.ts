import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, '..', 'scripts', 'sync-secrets.sh');

// Stub gh and kubectl: record argv and stdin, so the test can check that
// values travel on stdin/files and never on the command line.
function stubs(dir: string) {
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  const stub = (name: string) => {
    const p = join(bin, name);
    writeFileSync(p, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/${name}.argv"
printf 'GH_TOKEN=%s\\n' "\${GH_TOKEN:-}" >> "${dir}/${name}.env"
for a in "$@"; do case "$a" in --from-env-file=*) cat "\${a#--from-env-file=}" >> "${dir}/${name}.files";; esac; done
if [ ! -t 0 ]; then cat >> "${dir}/${name}.stdin"; fi
if [ "$1" = create ] || printf '%s' "$*" | grep -q 'create secret'; then echo "apiVersion: v1"; fi
`);
    chmodSync(p, 0o755);
  };
  stub('gh');
  stub('kubectl');
  return bin;
}

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'camsim-sync-'));
  env = { PATH: `${stubs(dir)}:${process.env.PATH}`, HOME: dir };
});

const write = (text: string, mode = 0o600) => {
  writeFileSync(join(dir, '.env'), text);
  chmodSync(join(dir, '.env'), mode);
};
const run = (...args: string[]) => spawnSync('bash', [SCRIPT, '--env-file', join(dir, '.env'), ...args], { env, encoding: 'utf8' });
const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
const envValue = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(read('.env'))?.[1] ?? '';

const BASE = 'REOLINK_PASSWORD=real-cam-pw\nCAMSIM_GITHUB_PAT=ghp_camsim\nGITHUB_KUBE_SETUP_PAT=ghp_kube\nCAMSIM_CONTROL_TOKEN=put the token here\nKUBE_CONTEXT=test-ctx\n';

describe('sync-secrets.sh', () => {
  it('refuses a group- or world-readable .env', () => {
    write(BASE, 0o644);
    const r = run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/chmod 600/);
  });

  it('generates missing values and placeholders in place, printing only names', () => {
    write(BASE);
    const r = run();
    expect(r.status).toBe(0);
    const token = envValue('CAMSIM_CONTROL_TOKEN');
    expect(token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const users = envValue('CAMSIM_USERS');
    expect(users).toMatch(/^admin:admin:[A-Za-z0-9]{24};cams:admin:[A-Za-z0-9]{24}$/);
    expect(envValue('REOLINK_PASSWORD')).toBe('real-cam-pw');
    for (const secret of [token, ...users.split(';').map((u) => u.split(':')[2]), 'ghp_kube', 'ghp_camsim', 'real-cam-pw']) {
      expect(r.stdout + r.stderr).not.toContain(secret);
      expect(read('gh.argv') + read('kubectl.argv')).not.toContain(secret);
    }
    expect(r.stdout).toContain('generated CAMSIM_CONTROL_TOKEN');
  });

  it('sets GitHub secrets on stdin, with the cam-sim PAT', () => {
    write(BASE);
    run();
    const argv = read('gh.argv');
    expect(argv).toContain('secret set CAMSIM_CONTROL_TOKEN --repo klaushofrichter/cam-sim');
    expect(argv).toContain('secret set CAMSIM_USERS --repo klaushofrichter/cam-sim');
    // GitHub refuses names starting with GITHUB_; cams' workflows read KUBE_SETUP_DEPLOY_TOKEN.
    expect(argv).toContain('secret set KUBE_SETUP_DEPLOY_TOKEN --repo klaushofrichter/cam-sim');
    expect(argv).not.toContain('GITHUB_KUBE_SETUP_PAT');
    expect(argv).not.toContain('REOLINK_PASSWORD');
    expect(argv).not.toContain('CAMSIM_GITHUB_PAT');
    expect(read('gh.stdin')).toContain(envValue('CAMSIM_CONTROL_TOKEN'));
    expect(read('gh.stdin')).toContain('ghp_kube');
    expect(read('gh.env')).toContain('GH_TOKEN=ghp_camsim');
  });

  it('applies the Kubernetes Secret with only CAMSIM_ keys, against the given context', () => {
    write(BASE);
    run();
    const argv = read('kubectl.argv');
    expect(argv).toMatch(/--context test-ctx -n cam-sim create secret generic cam-sim-secrets/);
    expect(argv).toMatch(/--context test-ctx apply -f -/);
    const file = read('kubectl.files');
    expect(file).toContain('CAMSIM_CONTROL_TOKEN=');
    expect(file).toContain('CAMSIM_USERS=');
    expect(file).not.toContain('REOLINK_PASSWORD');
    expect(file).not.toContain('PAT');
  });

  it('--gh-login ignores CAMSIM_GITHUB_PAT', () => {
    write(BASE);
    expect(run('--only', 'github', '--gh-login').status).toBe(0);
    expect(read('gh.argv')).toContain('secret set CAMSIM_CONTROL_TOKEN');
    expect(read('gh.env')).not.toContain('ghp_camsim');
  });

  it('creates the camera-credentials Secret for the certificate push job', () => {
    write(BASE + 'CAMSIM_USERS=admin:admin:aaaaaaaaaaaaaaaaaaaaaaaa;cams:admin:bbbbbbbbbbbbbbbbbbbbbbbb\n');
    const r = run('--only', 'kube');
    expect(r.status).toBe(0);
    expect(read('kubectl.argv')).toMatch(/create secret generic cam2-camera-credentials/);
    expect(read('kubectl.files')).toContain('username=admin\npassword=aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(r.stdout + r.stderr).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(read('kubectl.argv')).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('ignores inline comments after a value', () => {
    write(BASE.replace('GITHUB_KUBE_SETUP_PAT=ghp_kube', 'GITHUB_KUBE_SETUP_PAT=ghp_kube   # for kube-setup'));
    expect(run('--only', 'github').status).toBe(0);
    expect(read('gh.stdin')).toContain('ghp_kube');
    expect(read('gh.stdin')).not.toContain('kube-setup');
  });

  it('requires KUBE_CONTEXT for the Kubernetes part', () => {
    write(BASE.replace('KUBE_CONTEXT=test-ctx\n', ''));
    const r = run('--only', 'kube');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/KUBE_CONTEXT/);
  });

  it('--dry-run changes nothing and calls nothing', () => {
    write(BASE);
    const before = read('.env');
    const r = run('--dry-run');
    expect(r.status).toBe(0);
    expect(read('.env')).toBe(before);
    expect(read('gh.argv') + read('kubectl.argv')).toBe('');
    expect(r.stdout).toContain('would generate CAMSIM_CONTROL_TOKEN');
    expect(r.stdout).toContain('would set github secret CAMSIM_USERS');
  });

  it('--only github skips Kubernetes; existing values are kept', () => {
    write(BASE.replace('put the token here', 'existing-Token_123') + 'CAMSIM_USERS=admin:admin:aaaaaaaaaaaaaaaaaaaaaaaa\n');
    run('--only', 'github');
    expect(envValue('CAMSIM_CONTROL_TOKEN')).toBe('existing-Token_123');
    expect(envValue('CAMSIM_USERS')).toBe('admin:admin:aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(read('kubectl.argv')).toBe('');
  });

  it('--rotate replaces one value, or one user password', () => {
    write(BASE.replace('put the token here', 'existing-Token_123') + 'CAMSIM_USERS=admin:admin:aaaaaaaaaaaaaaaaaaaaaaaa;cams:admin:bbbbbbbbbbbbbbbbbbbbbbbb\n');
    run('--rotate', 'CAMSIM_USERS:cams', '--only', 'github');
    expect(envValue('CAMSIM_USERS')).toMatch(/^admin:admin:a{24};cams:admin:(?!b{24})[A-Za-z0-9]{24}$/);
    expect(envValue('CAMSIM_CONTROL_TOKEN')).toBe('existing-Token_123');
    run('--rotate', 'CAMSIM_CONTROL_TOKEN', '--only', 'github');
    expect(envValue('CAMSIM_CONTROL_TOKEN')).not.toBe('existing-Token_123');
  });
});
