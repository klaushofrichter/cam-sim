// Camera-local time. The camera works in its configured zone: file names,
// Search times and GetTime all use local wall-clock time plus a DST flag.
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(d: Date): Clock & { set(d: Date): void; advance(ms: number): void } {
  let t = d.getTime();
  return {
    now: () => new Date(t),
    set: (n) => (t = n.getTime()),
    advance: (ms) => (t += ms),
  };
}

export interface LocalParts {
  date: string; // YYYY-MM-DD
  hms: string; // HHMMSS
  year: number;
  mon: number;
  day: number;
  hour: number;
  min: number;
  sec: number;
  weekday: number; // 0 = Sunday
  dst: boolean;
}

// Two digits, zero-padded.
export const p2 = (n: number): string => String(n).padStart(2, '0');

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Intl formatters are slow to build, and the SD pipeline's clock asks for
// the local time every second: one formatter of each kind per zone.
function perZone(make: (tz: string) => Intl.DateTimeFormat): (tz: string) => Intl.DateTimeFormat {
  const byZone = new Map<string, Intl.DateTimeFormat>();
  return (tz) => {
    let f = byZone.get(tz);
    if (!f) byZone.set(tz, (f = make(tz)));
    return f;
  };
}
const offsetFormat = perZone((tz) => new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }));
const partsFormat = perZone((tz) => new Intl.DateTimeFormat('en-US', {
  timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
}));

// Offset of `tz` from UTC at instant `d`, in minutes east.
function offsetMinutes(tz: string, d: Date): number {
  const name = offsetFormat(tz)
    .formatToParts(d)
    .find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

// The January and July offsets of a zone's year, computed once per zone and year.
const seasons = new Map<string, { jan: number; jul: number }>();
function seasonOffsets(tz: string, year: number): { jan: number; jul: number } {
  const key = `${tz}|${year}`;
  let o = seasons.get(key);
  if (!o) seasons.set(key, (o = { jan: offsetMinutes(tz, new Date(Date.UTC(year, 0, 15))), jul: offsetMinutes(tz, new Date(Date.UTC(year, 6, 15))) }));
  return o;
}

// Standard-time offset: the smaller of the January and July offsets.
function standardOffset(tz: string, year: number): number {
  const o = seasonOffsets(tz, year);
  return Math.min(o.jan, o.jul);
}

function hasDst(tz: string, year: number): boolean {
  const o = seasonOffsets(tz, year);
  return o.jan !== o.jul;
}

function dstAt(tz: string, d: Date): boolean {
  return offsetMinutes(tz, d) > standardOffset(tz, d.getUTCFullYear());
}

export function localParts(clock: Clock, tz: string, d: Date = clock.now()): LocalParts {
  const parts = Object.fromEntries(partsFormat(tz).formatToParts(d).map((p) => [p.type, p.value]));
  const [year, mon, day, hour, min, sec] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((k) => Number(parts[k]));
  return {
    date: `${year}-${p2(mon)}-${p2(day)}`,
    hms: `${p2(hour)}${p2(min)}${p2(sec)}`,
    year, mon, day, hour, min, sec,
    weekday: WEEKDAYS.indexOf(parts.weekday),
    dst: dstAt(tz, d),
  };
}

// Whether DST is in effect in `tz` on calendar `date`, evaluated at 12:00 UTC
// of that date: a clip's DST marker only has to match its own date, and noon
// UTC is far from the transition hours of the Americas and Europe.
export function isDstOn(tz: string, date: string): boolean {
  return dstAt(tz, new Date(`${date}T12:00:00Z`));
}

// The camera's date and clock format (GetTime timeFmt; hourFmt 1 = 12 h).
export const TIME_FORMAT = { timeFmt: 'MM/DD/YYYY', hourFmt: 1 } as const;

// The GetTime value, in the firmware's shape (reference/rlc-1224a/GetTime.json).
// `timeZone` is seconds WEST of UTC for standard time. The Dst rule block is
// the measured US rule; zones without DST report enable 0.
export function timeValue(clock: Clock, tz: string) {
  const p = localParts(clock, tz);
  return {
    Dst: {
      enable: hasDst(tz, p.year) ? 1 : 0,
      offset: 1,
      startMon: 3, startWeek: 2, startWeekday: 0, startHour: 2, startMin: 0, startSec: 0,
      endMon: 11, endWeek: 1, endWeekday: 0, endHour: 2, endMin: 0, endSec: 0,
    },
    Time: {
      year: p.year, mon: p.mon, day: p.day, hour: p.hour, min: p.min, sec: p.sec,
      hourFmt: TIME_FORMAT.hourFmt,
      isDst: p.dst ? 1 : 0,
      timeFmt: TIME_FORMAT.timeFmt,
      timeZone: -standardOffset(tz, p.year) * 60,
    },
  };
}
