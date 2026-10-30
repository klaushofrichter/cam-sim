// The repo is public: the captures under reference/ must not carry a real
// camera's address, MAC, UID, serial or name. Every file, every model.
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const ROOT = join(__dirname, '..', 'reference');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// Every "serial" value in a JSON text, at any depth.
function serials(text: string): string[] {
  return [...text.matchAll(/"serial"\s*:\s*"([^"]*)"/g)].map((m) => m[1]);
}

const E1_FILES = [
  'GetAbility', 'GetDevInfo', 'GetEnc', 'GetAiState', 'GetIrLights', 'GetWhiteLed', 'GetIsp', 'GetMdAlarm', 'GetOsd',
  'GetPtzPreset', 'GetZoomFocus', 'GetPtzGuard', 'GetPtzCheckState', 'GetAutoFocus', 'GetPtzPatrol', 'GetPtzCurPos',
  'GetPtzTattern', 'GetPtzSerial', 'GetPtzTraceSection',
].map((c) => `${c}.json`).concat(['ptz-exchanges.json', 'ptz-zoom-overlap.json', 'README.md']);

describe('reference captures hold no private data', () => {
  const files = walk(ROOT);

  it('finds the captures of every model', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it.each(files.map((f) => [relative(ROOT, f), f]))('%s', (_name, file) => {
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/(?<![\w.])(?!192\.0\.2\.)(\d{1,3}\.){3}\d{1,3}(?![\w.])/); // IPv4 outside 192.0.2.0/24
    expect(text).not.toMatch(/\b([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/); // MAC
    expect(text).not.toMatch(/\b9527\d{4}[A-Z0-9]{6,}\b/); // Reolink UID
    expect(text).not.toMatch(/Backyard/); // real camera names
    for (const s of serials(text)) expect(['SIM000000000000', '<redacted>']).toContain(s);
  });

  it('has the E1 Outdoor Pro captures', () => {
    const dir = join(ROOT, 'E1-Outdoor-Pro');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual([...E1_FILES].sort());
  });
});
