import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Writable } from 'stream';
import { SdCard, flagsHex, fileName, DEMO_CLIPS } from '../src/engine/sdcard';
import { fixedClock } from '../src/engine/clock';
import { createLogger } from '../src/log';

const TZ = 'America/Chicago';
const quiet = () => createLogger('silent');
const sizes = { sub: 700_000, main: 5_000_000 };
const clock = () => fixedClock(new Date('2026-09-26T17:00:00Z')); // 12:00 CDT
const make = (o: Partial<ConstructorParameters<typeof SdCard>[0]> = {}) =>
  new SdCard({ capacityMb: 1000, clock: clock(), tz: TZ, log: quiet(), fixtureSizes: sizes, ...o });

describe('names', () => {
  it('encodes trigger flags like the firmware', () => {
    expect(flagsHex('sub', ['motion'])).toBe('55148080000000');
    expect(flagsHex('sub', ['person', 'vehicle', 'motion'])).toBe('5514D080000000');
    expect(flagsHex('main', ['motion'])).toBe('7B288280000000');
    expect(flagsHex('sub', ['pet'])).toBe('55148800000000');
  });

  it('builds the full path', () => {
    expect(fileName('sub', '2026-09-26', true, '065221', '065224', ['motion'], 0x4ac87)).toBe(
      '/mnt/sda/Mp4Record/2026-09-26/RecS0A_DST20260926_065221_065224_0_55148080000000_4AC87.mp4',
    );
    expect(fileName('main', '2026-11-02', false, '010203', '000000', ['person'], 16)).toBe(
      '/mnt/sda/Mp4Record/2026-11-02/RecM0A_20261102_010203_000000_0_7B28C200000000_10.mp4',
    );
  });
});

describe('SdCard', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'camsim-sd-'))));

  it('lists a recording in progress with end 000000, then its real end', () => {
    const sd = make();
    const r = sd.add({ date: '2026-09-26', start: '065221', triggers: ['motion'], dst: true });
    const day = { year: 2026, mon: 9, day: 26 };
    const [f] = sd.search('sub', day, day);
    expect(f.name).toContain('_065221_000000_');
    expect(f).toMatchObject({ type: 'sub', size: '700000' });
    expect(f.StartTime).toEqual({ year: 2026, mon: 9, day: 26, hour: 6, min: 52, sec: 21 });
    sd.finish(r.id, '065241', '065243');
    expect(sd.search('sub', day, day)[0].name).toContain('_065221_065241_0_55148080000000_AAE60.mp4');
    expect(sd.search('main', day, day)[0].name).toContain('RecM0A_DST20260926_065221_065243_');
    expect(sd.search('main', day, day)[0].EndTime).toMatchObject({ hour: 6, min: 52, sec: 43 });
  });

  it('extends triggers of a running recording', () => {
    const sd = make();
    const r = sd.add({ date: '2026-09-26', start: '065221', triggers: ['motion'], dst: true });
    sd.extend(r.id, ['person', 'motion']);
    expect(sd.byId(r.id)?.triggers.sort()).toEqual(['motion', 'person']);
  });

  it('reports days with recordings', () => {
    const sd = make();
    sd.seed(DEMO_CLIPS);
    const st = sd.status('sub', 2026, 9);
    expect(st.table).toHaveLength(30);
    expect(st.table[25]).toBe('1');
    expect(st.table[24]).toBe('1');
    expect(st.table[23]).toBe('0');
  });

  it('seeds the demo clips: four today, two yesterday', () => {
    const sd = make();
    sd.seed(DEMO_CLIPS);
    const today = { year: 2026, mon: 9, day: 26 }, yesterday = { year: 2026, mon: 9, day: 25 };
    expect(sd.search('sub', today, today)).toHaveLength(4);
    expect(sd.search('sub', yesterday, yesterday)).toHaveLength(2);
  });

  it('finds recordings only by exact name', () => {
    const sd = make();
    const r = sd.add({ date: '2026-09-26', start: '065221', triggers: ['motion'], dst: true });
    sd.finish(r.id, '065241', '065243');
    const name = sd.byId(r.id)!.files.sub.name;
    expect(sd.byName(name)?.stream).toBe('sub');
    expect(sd.byName(sd.byId(r.id)!.files.main.name)?.stream).toBe('main');
    expect(sd.byName('/mnt/sda/Mp4Record/../../etc/passwd')).toBeUndefined();
    expect(sd.byName(name.replace('/mnt/sda/Mp4Record/2026-09-26/', ''))).toBeUndefined();
  });

  it('reports free space as HddInfo size', () => {
    const sd = make({ capacityMb: 100 });
    sd.add({ date: '2026-09-26', start: '065221', triggers: ['motion'], dst: true });
    expect(sd.hddInfo()).toEqual([{ capacity: 100, format: 1, mount: 1, number: 0, size: 94, storageType: 2 }]);
  });

  it('deletes the oldest day when full, and days older than saveDay', () => {
    const sd = make({ capacityMb: 12 });
    sd.seed([
      { daysAgo: 2, start: '010000', end: '010010', triggers: ['motion'] },
      { daysAgo: 1, start: '010000', end: '010010', triggers: ['motion'] },
      { daysAgo: 0, start: '010000', end: '010010', triggers: ['motion'] },
    ]);
    sd.retention(7);
    expect(sd.all().map((r) => r.date)).toEqual(['2026-09-25', '2026-09-26']);
    sd.retention(1);
    expect(sd.all().map((r) => r.date)).toEqual(['2026-09-26']);
  });

  it('persists the index, and survives a corrupt one', () => {
    const sd = make({ dir });
    sd.seed(DEMO_CLIPS);
    expect(make({ dir }).all()).toHaveLength(6);
    writeFileSync(join(dir, 'index.json'), '[{"id":');
    const lines: string[] = [];
    const log = createLogger('info', new Writable({ write(c, _e, cb) { lines.push(String(c)); cb(); } }));
    expect(make({ dir, log }).all()).toEqual([]);
    expect(lines.join('')).toContain('sd_index_invalid');
  });

  it('clears', () => {
    const sd = make();
    sd.seed(DEMO_CLIPS);
    sd.clear();
    expect(sd.all()).toEqual([]);
  });
});
