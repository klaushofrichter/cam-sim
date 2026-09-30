import { join } from 'path';
import type pino from 'pino';
import { localParts, isDstOn, type Clock } from './clock';
import type { Trigger } from './types';
import { readJson, writeJsonAtomic } from '../util/json-file';

export type { Trigger } from './types';
export type Stream = 'sub' | 'main';

export interface Recording {
  id: string;
  date: string; // YYYY-MM-DD, camera-local start date
  start: string; // HHMMSS
  end: string | null; // null while recording
  mainEnd: string | null;
  triggers: Trigger[];
  dst: boolean;
  // Camera-local YYYYMMDDHHMMSS of the event that started it: the FTP
  // picture's name (the clip's own name is its start, up to 4 s earlier
  // with pre-record; measured on cam1 2026-09-30). Unset for seeded clips.
  picture?: string;
  // The library video it was recorded from ('test-pattern' when unset).
  video?: string;
  files: Record<Stream, { name: string; size: number }>;
}

export interface SeedClip {
  daysAgo: number;
  start: string;
  end: string;
  triggers: Trigger[];
  mainEnd?: string;
}

// The cams mock camera's default clips: one per trigger today, two yesterday.
export const DEMO_CLIPS: SeedClip[] = [
  { daysAgo: 0, start: '081510', end: '081535', triggers: ['person'] },
  { daysAgo: 0, start: '093000', end: '093020', triggers: ['vehicle'] },
  { daysAgo: 0, start: '120505', end: '120530', triggers: ['motion'] },
  { daysAgo: 0, start: '174540', end: '174605', triggers: ['pet'] },
  { daysAgo: 1, start: '070000', end: '070030', triggers: ['motion'] },
  { daysAgo: 1, start: '221510', end: '221540', triggers: ['person'] },
];

const ROOT = '/mnt/sda/Mp4Record';
// Trigger bit positions (reolink_aio layout, name versions 9 and 10): bit 55 − pos.
const TRIGGER_POS: Record<Trigger, number> = { person: 17, vehicle: 19, pet: 20, motion: 24 };
// Flags of a real clip without trigger bits.
const BASE_FLAGS: Record<Stream, bigint> = { sub: 0x55148000000000n, main: 0x7b288200000000n };

export function flagsHex(stream: Stream, triggers: Trigger[]): string {
  let v = BASE_FLAGS[stream];
  for (const t of triggers) v |= 1n << BigInt(55 - TRIGGER_POS[t]);
  return v.toString(16).toUpperCase().padStart(14, '0');
}

export function fileName(stream: Stream, date: string, dst: boolean, start: string, end: string, triggers: Trigger[], size: number): string {
  const ymd = date.replaceAll('-', '');
  const base = `Rec${stream === 'sub' ? 'S' : 'M'}0A_${dst ? 'DST' : ''}${ymd}_${start}_${end}_0_${flagsHex(stream, triggers)}_${size.toString(16).toUpperCase()}.mp4`;
  return `${ROOT}/${date}/${base}`;
}

// HHMMSS plus `s` seconds, wrapping at midnight.
export const addSeconds = (hms: string, s: number) => {
  const t = (((Number(hms.slice(0, 2)) * 3600 + Number(hms.slice(2, 4)) * 60 + Number(hms.slice(4, 6)) + s) % 86400) + 86400) % 86400;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}${p(Math.floor((t % 3600) / 60))}${p(t % 60)}`;
};

const HMS = /^([01]\d|2[0-3])[0-5]\d[0-5]\d$/;
const TRIGGER_SET = new Set(['motion', 'person', 'vehicle', 'pet']);
function validRecord(r: any): boolean {
  return !!r && typeof r === 'object' && typeof r.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date) && HMS.test(r.start) &&
    (r.end === null || HMS.test(r.end)) && (r.mainEnd === null || HMS.test(r.mainEnd)) && typeof r.dst === 'boolean' &&
    (r.video === undefined || (typeof r.video === 'string' && r.video.length <= 64)) &&
    Array.isArray(r.triggers) && r.triggers.length > 0 && r.triggers.every((t: unknown) => TRIGGER_SET.has(String(t)));
}
// A recording that was still open when the simulator stopped gets the
// default post-record length.
const CLOSE_AFTER_S = 15;

type Day = { year: number; mon: number; day: number; hour?: number; min?: number; sec?: number };
const p2 = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Day) => `${d.year}-${p2(d.mon)}-${p2(d.day)}`;
const timeObj = (date: string, hms: string) => ({
  year: Number(date.slice(0, 4)), mon: Number(date.slice(5, 7)), day: Number(date.slice(8, 10)),
  hour: Number(hms.slice(0, 2)), min: Number(hms.slice(2, 4)), sec: Number(hms.slice(4, 6)),
});

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// Steps back `days` calendar days with UTC-date arithmetic, so DST changes in
// between can't land it a day early or late (as in cams' mock).
function stepBackDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

// `sizes` is kept per recording (the clip sizes when it was made), so names
// don't change when the selected video changes.
type Stored = Omit<Recording, 'files'> & { sizes?: Record<Stream, number> };

// The simulated SD card: an index of recordings, named like the firmware.
// In fixture mode every recording's content is the same fixture clip.
export class SdCard {
  private recs: Stored[] = [];
  private seq = 0;
  private readonly file?: string;

  constructor(private readonly opts: { dir?: string; capacityMb: number; clock: Clock; tz: string; log: pino.Logger; fixtureSizes: Record<Stream, number> | (() => Record<Stream, number>); currentVideo?: () => string }) {
    if (opts.dir) {
      this.file = join(opts.dir, 'index.json');
      try {
        const loaded = readJson(this.file);
        if (loaded !== undefined && !Array.isArray(loaded)) opts.log.warn({ file: this.file }, 'sd_index_invalid');
        if (Array.isArray(loaded)) {
          const good = loaded.filter(validRecord) as Stored[];
          if (good.length !== loaded.length) opts.log.warn({ file: this.file, dropped: loaded.length - good.length }, 'sd_record_dropped');
          for (const r of good) {
            if (r.end === null) {
              r.end = addSeconds(r.start, CLOSE_AFTER_S);
              r.mainEnd = addSeconds(r.end, 2);
              opts.log.warn({ id: r.id }, 'sd_open_recording_closed');
            }
          }
          this.recs = good;
        }
      } catch {
        opts.log.warn({ file: this.file }, 'sd_index_invalid');
      }
      this.seq = this.recs.length;
    }
  }

  private currentSizes(): Record<Stream, number> {
    const f = this.opts.fixtureSizes;
    return typeof f === 'function' ? f() : f;
  }

  private withFiles(r: Stored): Recording {
    const f = (s: Stream) => {
      const end = s === 'main' ? (r.mainEnd ?? r.end) : r.end;
      const size = (r.sizes ?? this.currentSizes())[s];
      return { name: fileName(s, r.date, r.dst, r.start, end ?? '000000', r.triggers, size), size };
    };
    const { sizes: _sizes, ...rest } = r;
    void _sizes;
    return { ...rest, triggers: [...r.triggers], files: { sub: f('sub'), main: f('main') } };
  }

  all(): Recording[] {
    return this.recs.map((r) => this.withFiles(r));
  }

  byId(id: string): Recording | undefined {
    const r = this.recs.find((x) => x.id === id);
    return r && this.withFiles(r);
  }

  add(rec: { date: string; start: string; triggers: Trigger[]; dst: boolean; end?: string; mainEnd?: string; picture?: string }): Recording {
    const r: Stored = {
      id: `r${++this.seq}-${rec.date}-${rec.start}`,
      date: rec.date, start: rec.start, end: rec.end ?? null, mainEnd: rec.mainEnd ?? rec.end ?? null,
      triggers: [...new Set(rec.triggers)], dst: rec.dst,
      sizes: { ...this.currentSizes() },
      video: this.opts.currentVideo?.() ?? 'test-pattern',
      ...(rec.picture ? { picture: rec.picture } : {}),
    };
    this.recs.push(r);
    this.recs.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
    this.persist();
    return this.withFiles(r);
  }

  finish(id: string, end: string, mainEnd: string): void {
    const r = this.recs.find((x) => x.id === id);
    if (!r) return;
    r.end = end;
    r.mainEnd = mainEnd;
    this.persist();
  }

  extend(id: string, triggers: Trigger[]): void {
    const r = this.recs.find((x) => x.id === id);
    if (!r) return;
    r.triggers = [...new Set([...r.triggers, ...triggers])];
    this.persist();
  }

  // Like the firmware (measured 2026-09-29): only the start day is searched,
  // from the start's time of day to the end's; the end's date is ignored, so
  // a window across midnight or with reversed times finds nothing after it.
  search(stream: Stream, from: Day, to: Day) {
    const date = dayKey(from);
    const lo = `${p2(from.hour ?? 0)}${p2(from.min ?? 0)}${p2(from.sec ?? 0)}`;
    const hi = `${p2(to.hour ?? 23)}${p2(to.min ?? 59)}${p2(to.sec ?? 59)}`;
    return this.all()
      .filter((r) => r.date === date && r.start >= lo && r.start <= hi)
      .map((r) => {
        const end = stream === 'main' ? (r.mainEnd ?? r.end) : r.end;
        return {
          name: r.files[stream].name,
          size: String(r.files[stream].size),
          type: stream,
          StartTime: timeObj(r.date, r.start),
          // A clip that crosses midnight ends on the next day.
          EndTime: end ? timeObj(end < r.start ? nextDay(r.date) : r.date, end) : timeObj(r.date, r.start),
          frameRate: 0,
          width: 0,
          height: 0,
        };
      });
  }

  // The month tables from one month to another, only for months with
  // recordings, like the firmware (measured 2026-09-29).
  statuses(stream: Stream, from: { year: number; mon: number }, to: { year: number; mon: number }) {
    const out: { year: number; mon: number; table: string }[] = [];
    for (let y = from.year, m = from.mon; y * 12 + m <= to.year * 12 + to.mon; m === 12 ? (y++, (m = 1)) : m++) {
      const st = this.status(stream, y, m);
      if (st.table.includes('1')) out.push(st);
    }
    return out;
  }

  status(stream: Stream, year: number, mon: number): { year: number; mon: number; table: string } {
    const days = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const prefix = `${year}-${p2(mon)}-`;
    const have = new Set(this.recs.filter((r) => r.date.startsWith(prefix)).map((r) => Number(r.date.slice(8, 10))));
    void stream; // every recording exists on both streams
    return { year, mon, table: Array.from({ length: days }, (_, i) => (have.has(i + 1) ? '1' : '0')).join('') };
  }

  // Exact match on a current file name only; anything else is unknown.
  byName(name: string): { rec: Recording; stream: Stream } | undefined {
    for (const rec of this.all()) {
      if (rec.files.sub.name === name) return { rec, stream: 'sub' };
      if (rec.files.main.name === name) return { rec, stream: 'main' };
    }
    return undefined;
  }

  private usedBytes(): number {
    return this.recs.reduce((n, r) => {
      const z = r.sizes ?? this.currentSizes();
      return n + z.sub + z.main;
    }, 0);
  }

  // Firmware: capacity is the card size in MB, `size` is the FREE space in MB.
  hddInfo() {
    const usedMb = Math.ceil(this.usedBytes() / 1048576);
    return [{ capacity: this.opts.capacityMb, format: 1, mount: 1, number: 0, size: Math.max(0, this.opts.capacityMb - usedMb), storageType: 2 }];
  }

  usedMb(): number {
    return Math.ceil(this.usedBytes() / 1048576);
  }

  // Keeps `saveDay` days (today included), then drops the oldest day while
  // the card is over capacity. A recording still in progress is never dropped.
  retention(saveDay: number): void {
    const today = localParts(this.opts.clock, this.opts.tz).date;
    const oldest = stepBackDate(today, Math.max(1, saveDay) - 1);
    const before = this.recs.length;
    this.recs = this.recs.filter((r) => r.date >= oldest || r.end === null);
    while (this.usedBytes() > this.opts.capacityMb * 1048576) {
      const first = this.recs.find((r) => r.end !== null);
      if (!first) break;
      this.recs = this.recs.filter((r) => r.date !== first.date || r.end === null);
    }
    if (this.recs.length !== before) this.persist();
  }

  seed(clips: SeedClip[]): void {
    const today = localParts(this.opts.clock, this.opts.tz).date;
    for (const c of clips) {
      const date = stepBackDate(today, c.daysAgo);
      this.add({ date, start: c.start, end: c.end, mainEnd: c.mainEnd ?? c.end, triggers: c.triggers, dst: isDstOn(this.opts.tz, date) });
    }
  }

  clear(): void {
    this.recs = [];
    this.persist();
  }

  private persist(): void {
    if (this.file) writeJsonAtomic(this.file, this.recs);
  }
}
