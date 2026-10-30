// The camera's own clock and time zone, as GetTime reports them and SetTime
// changes them (measured on the E1 Outdoor Pro 2026-10-30,
// reference/E1-Outdoor-Pro/time-exchanges.json). Until a SetTime the camera
// runs on the simulator's clock in the configured zone (CAMSIM_TZ). SetTime
// sets the clock to the given date and time (kept as an offset from the
// simulator's clock) and stores the zone (seconds WEST of UTC), the DST rule
// and the display formats. GetTime then reports the local time in them.
// The SD card's file names, Search and the ONVIF events keep using the
// simulator's clock and CAMSIM_TZ.
import { TIME_FORMAT, timeValue, type Clock } from './clock';
import { isObject } from '../util/json-file';

const DST_KEYS = [
  'enable', 'offset',
  'startMon', 'startWeek', 'startWeekday', 'startHour', 'startMin', 'startSec',
  'endMon', 'endWeek', 'endWeekday', 'endHour', 'endMin', 'endSec',
] as const;
export type DstRule = Record<(typeof DST_KEYS)[number], number>;

const TIME_FORMATS = ['MM/DD/YYYY', 'YYYY/MM/DD', 'DD/MM/YYYY'];

// GetTime action 1: the camera's factory values and ranges (measured on the
// E1; the other models were not measured and answer the same).
export const TIME_INITIAL = {
  Dst: {
    enable: 0, endHour: 2, endMin: 0, endMon: 10, endSec: 0, endWeek: 5, endWeekday: 0,
    offset: 1, startHour: 2, startMin: 0, startMon: 3, startSec: 0, startWeek: 2, startWeekday: 0,
  },
  Time: { day: 1, hour: 0, hourFmt: 0, min: 0, mon: 0, sec: 0, timeFmt: 'DD/MM/YYYY', timeZone: 28800, year: 0 },
};
const r = (min: number, max: number) => ({ max, min });
export const TIME_RANGE = {
  Dst: {
    enable: 'boolean',
    endHour: r(0, 23), endMin: r(0, 59), endMon: r(1, 12), endSec: r(0, 59), endWeek: r(1, 5), endWeekday: r(0, 6),
    offset: r(1, 2),
    startHour: r(0, 23), startMin: r(0, 59), startMon: r(1, 12), startSec: r(0, 59), startWeek: r(1, 5), startWeekday: r(0, 6),
  },
  Time: {
    day: r(1, 31), hour: r(0, 23), hourFmt: r(0, 1), min: r(0, 59), mon: r(1, 12), sec: r(0, 59),
    timeFmt: TIME_FORMATS, timeZone: r(-46800, 43200), year: r(1900, 2100),
  },
};

interface Zone {
  timeZone: number;
  dst: DstRule;
  hourFmt: number;
  timeFmt: string;
}

const HOUR = 3_600_000;
const CLOCK_KEYS = ['year', 'mon', 'day', 'hour', 'min', 'sec'] as const;

// Day of the month of the `week`th `weekday` (week 5: the last one).
function nthWeekday(year: number, mon: number, week: number, weekday: number): number {
  const first = new Date(Date.UTC(year, mon - 1, 1)).getUTCDay();
  const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
  let d = 1 + ((weekday - first + 7) % 7) + (week - 1) * 7;
  while (d > days) d -= 7;
  return d;
}

// Whether the rule's DST is in effect at local standard time `std` (ms, as UTC
// fields). The start is given in standard time, the end in DST time.
function dstAt(z: Zone, std: number): boolean {
  const d = z.dst;
  if (!d.enable) return false;
  const year = new Date(std).getUTCFullYear();
  const start = Date.UTC(year, d.startMon - 1, nthWeekday(year, d.startMon, d.startWeek, d.startWeekday), d.startHour, d.startMin, d.startSec);
  const end = Date.UTC(year, d.endMon - 1, nthWeekday(year, d.endMon, d.endWeek, d.endWeekday), d.endHour, d.endMin, d.endSec) - d.offset * HOUR;
  return start < end ? std >= start && std < end : !(std >= end && std < start);
}

const inRange = (v: unknown, [lo, hi]: [number, number]) => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;

// rspCode -4 for anything outside the GetTime ranges (measured for timeZone).
function validate(p: any): number | null {
  if (!isObject(p?.Time)) return -4;
  const t = p.Time;
  for (const [k, spec] of Object.entries(TIME_RANGE.Time)) {
    if (t[k] === undefined) continue;
    const ok = Array.isArray(spec) ? spec.includes(t[k]) : inRange(t[k], [spec.min, spec.max]);
    if (!ok) return -4;
  }
  if (p.Dst !== undefined) {
    if (!isObject(p.Dst)) return -4;
    for (const [k, spec] of Object.entries(TIME_RANGE.Dst)) {
      const v = (p.Dst as any)[k];
      if (v === undefined) continue;
      if (!(typeof spec === 'string' ? v === 0 || v === 1 : inRange(v, [spec.min, spec.max]))) return -4;
    }
  }
  if (CLOCK_KEYS.every((k) => t[k] !== undefined)) {
    const d = new Date(Date.UTC(t.year, t.mon - 1, t.day));
    if (d.getUTCDate() !== t.day) return -4; // not measured: 31 February
  }
  return null;
}

export class CameraTime {
  // Camera clock minus the simulator's clock.
  private offsetMs = 0;
  // Null: the configured zone (CAMSIM_TZ) with the US DST rule.
  private zone: Zone | null = null;

  constructor(private readonly clock: Clock, private readonly tz: string) {}

  now(): Date {
    return new Date(this.clock.now().getTime() + this.offsetMs);
  }

  // The GetTime value.
  value() {
    if (!this.zone) return timeValue({ now: () => this.now() }, this.tz);
    const z = this.zone;
    const std = this.now().getTime() - z.timeZone * 1000;
    const isDst = dstAt(z, std);
    const l = new Date(std + (isDst ? z.dst.offset * HOUR : 0));
    return {
      Dst: { ...z.dst },
      Time: {
        year: l.getUTCFullYear(), mon: l.getUTCMonth() + 1, day: l.getUTCDate(),
        hour: l.getUTCHours(), min: l.getUTCMinutes(), sec: l.getUTCSeconds(),
        hourFmt: z.hourFmt, isDst: isDst ? 1 : 0, timeFmt: z.timeFmt, timeZone: z.timeZone,
      },
    };
  }

  // SetTime: null on success, else the rspCode (nothing changed).
  set(p: any): number | null {
    const bad = validate(p);
    if (bad !== null) return bad;
    const cur = this.value();
    const t = p.Time;
    const dst = { ...cur.Dst } as DstRule;
    for (const k of DST_KEYS) if (p.Dst?.[k] !== undefined) dst[k] = p.Dst[k];
    const zone: Zone = {
      timeZone: t.timeZone ?? cur.Time.timeZone,
      dst,
      hourFmt: t.hourFmt ?? cur.Time.hourFmt ?? TIME_FORMAT.hourFmt,
      timeFmt: t.timeFmt ?? cur.Time.timeFmt ?? TIME_FORMAT.timeFmt,
    };
    this.zone = zone;
    // The wall-clock time given, in the new zone; without all six fields the
    // clock stays (not measured).
    if (CLOCK_KEYS.every((k) => t[k] !== undefined)) {
      const wall = Date.UTC(t.year, t.mon - 1, t.day, t.hour, t.min, t.sec);
      const std = wall + zone.timeZone * 1000;
      const asDst = std - zone.dst.offset * HOUR;
      const utc = zone.dst.enable && dstAt(zone, wall - zone.dst.offset * HOUR) ? asDst : std;
      this.offsetMs = utc - this.clock.now().getTime();
    }
    return null;
  }

  reset(): void {
    this.offsetMs = 0;
    this.zone = null;
  }
}
