import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'audit-gate.mjs');
const ALLOWLIST = join(ROOT, '.github', 'audit-allowlist.json');

type Json = Record<string, any>;

// The shape `npm audit --json` gave on 2026-10-03: ip's advisory, reached through ftp-srv.
function ipAdvisory(over: Json = {}): Json {
  return {
    source: 1101851,
    name: 'ip',
    dependency: 'ip',
    title: 'ip SSRF improper categorization in isPublic',
    url: 'https://github.com/advisories/GHSA-2p57-rm9w-gvfp',
    severity: 'high',
    range: '<=2.0.1',
    ...over,
  };
}
const MAJOR_FIX = { name: 'ftp-srv', version: '2.16.2', isSemVerMajor: true };
function report(extra: Json = {}, ipOver: Json = {}, ipFix: unknown = MAJOR_FIX): Json {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'ftp-srv': { name: 'ftp-srv', severity: 'high', via: ['ip'], fixAvailable: MAJOR_FIX },
      ip: { name: 'ip', severity: 'high', via: [ipAdvisory(ipOver)], fixAvailable: ipFix },
      ...extra,
    },
  };
}

let dir: string;
let npmLatest: string | null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'audit-gate-'));
  npmLatest = '2.0.1';
});

function run(rep: Json, allowlist?: Json[]) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  // Stub npm: `npm view <pkg> version` prints npmLatest (or fails when null).
  writeFileSync(
    join(bin, 'npm'),
    npmLatest === null ? '#!/bin/sh\necho "npm error 404" >&2; exit 1\n' : `#!/bin/sh\necho "${npmLatest}"\n`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  const repPath = join(dir, 'audit.json');
  writeFileSync(repPath, JSON.stringify(rep));
  const args = [SCRIPT, repPath];
  if (allowlist) {
    writeFileSync(join(dir, 'allow.json'), JSON.stringify(allowlist));
    args.push(join(dir, 'allow.json'));
  }
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe('audit gate', () => {
  it('passes today: the only high advisory is the allowlisted ip one', () => {
    const r = run(report());
    expect(r.out).toContain('allowlisted (high): GHSA-2p57-rm9w-gvfp');
    expect(r.code).toBe(0);
  });

  it('allowlists exactly one advisory, by GHSA id, with the reason and approval recorded', () => {
    const list = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'GHSA-2p57-rm9w-gvfp', package: 'ip', range: '<=2.0.1', latest: '2.0.1' });
    expect(list[0].reason).toBeTruthy();
    expect(list[0].approved).toContain('Klaus');
  });

  it('fails on a new high advisory', () => {
    const r = run(report({
      lodash: { name: 'lodash', severity: 'high', fixAvailable: true, via: [{ source: 1, name: 'lodash', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm', severity: 'high', range: '<4.17.21' }] },
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('::error::high advisory GHSA-35jh-r3h4-6jhm in lodash');
  });

  it('fails on a critical advisory', () => {
    const r = run(report({
      x: { name: 'x', severity: 'critical', via: [{ source: 2, name: 'x', title: 'RCE', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc', severity: 'critical', range: '*' }] },
    }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('critical advisory GHSA-aaaa-bbbb-cccc');
  });

  it('fails on a second, new high advisory in the allowlisted package', () => {
    const rep = report();
    rep.vulnerabilities.ip.via.push(ipAdvisory({ url: 'https://github.com/advisories/GHSA-zzzz-yyyy-xxxx', title: 'another one' }));
    const r = run(rep);
    expect(r.code).toBe(1);
    expect(r.out).toContain('GHSA-zzzz-yyyy-xxxx');
  });

  it('does not block on moderate advisories (threshold high)', () => {
    const r = run(report({
      qs: { name: 'qs', severity: 'moderate', via: [{ source: 3, name: 'qs', title: 'DoS', url: 'https://github.com/advisories/GHSA-6rw7-vpxm-498p', severity: 'moderate', range: '<6.14.1' }] },
    }));
    expect(r.code).toBe(0);
    expect(r.out).toContain('not blocking (moderate)');
  });

  it('fails when the allowlisted advisory is no longer reported', () => {
    const r = run({ auditReportVersion: 2, vulnerabilities: {} });
    expect(r.code).toBe(1);
    expect(r.out).toContain('GHSA-2p57-rm9w-gvfp (ip) is no longer reported: remove it');
  });

  it('fails when the advisory gets a patched version (its range changes)', () => {
    const r = run(report({}, { range: '<2.0.2' }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('vulnerable range is now "<2.0.2"');
  });

  it('fails when npm audit fix can resolve it without a major bump', () => {
    const r = run(report({}, {}, { name: 'ftp-srv', version: '4.6.4', isSemVerMajor: false }));
    expect(r.code).toBe(1);
    expect(r.out).toContain('npm audit fix can now resolve it');
  });

  it('fails when a new release of the allowlisted package appears', () => {
    npmLatest = '2.0.2';
    const r = run(report());
    expect(r.code).toBe(1);
    expect(r.out).toContain('ip 2.0.2 was released');
  });

  it('fails when the newest release cannot be looked up', () => {
    npmLatest = null;
    const r = run(report());
    expect(r.code).toBe(1);
    expect(r.out).toContain('cannot look up the newest ip release');
  });

  it('fails when npm audit produced no report', () => {
    const r = run({ error: { code: 'ENOAUDIT', summary: 'audit endpoint returned an error' } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('npm audit did not produce a report');
  });

  it('with an empty allowlist the ip advisory blocks', () => {
    const r = run(report(), []);
    expect(r.code).toBe(1);
    expect(r.out).toContain('high advisory GHSA-2p57-rm9w-gvfp in ip');
  });
});
