import { describe, it, expect } from 'vitest';
import { fixedClock, localParts, isDstOn, timeValue } from '../src/engine/clock';

describe('clock', () => {
  const clock = fixedClock(new Date('2026-09-26T21:45:27Z'));

  it('gives camera-local parts', () => {
    expect(localParts(clock, 'America/Chicago')).toMatchObject({
      date: '2026-09-26', hms: '164527', year: 2026, mon: 9, day: 26, hour: 16, min: 45, sec: 27, dst: true,
    });
  });

  it('builds the GetTime value like the firmware', () => {
    const v = timeValue(clock, 'America/Chicago');
    expect(v.Time).toMatchObject({ year: 2026, mon: 9, day: 26, hour: 16, min: 45, sec: 27, isDst: 1, timeZone: 21600, hourFmt: 1, timeFmt: 'MM/DD/YYYY' });
    expect(v.Dst).toMatchObject({ enable: 1, offset: 1, startMon: 3, startWeek: 2, endMon: 11, endWeek: 1 });
  });

  it('reports seconds west of UTC for other zones', () => {
    expect(timeValue(clock, 'Europe/Berlin').Time.timeZone).toBe(-3600);
    expect(timeValue(clock, 'UTC').Dst.enable).toBe(0);
  });

  it('decides DST per calendar date at noon UTC', () => {
    expect(isDstOn('America/Chicago', '2026-11-01')).toBe(false);
    expect(isDstOn('America/Chicago', '2026-03-08')).toBe(true);
    expect(isDstOn('America/Chicago', '2026-01-15')).toBe(false);
  });
});
