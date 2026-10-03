import { EventEmitter } from 'events';
import { localParts, isDstOn, type Clock } from './clock';
import type { Rng } from './rng';
import { addSeconds, type SdCard, type Recording } from './sdcard';
import type { SettingsStore } from './settings';
import { scheduled, type Trigger } from './types';

// Clips follow the sub stream's keyframes, every 4 s (measured on cam1,
// 2026-09-28 to 30, 37 back-to-back clips): a detection lands on that grid,
// a clip starts one step before it (the pre-record) and ends at the first
// step after its post-record, so its length is a multiple of 4 s. A new clip
// may therefore start up to 4 s before the previous one ended. The grid's
// phase here is the epoch's; on the camera it shifts now and then.
const GOP_MS = 4_000;
const PRE_REC_MS = GOP_MS;
const gridFloor = (ms: number) => ms - (((ms % GOP_MS) + GOP_MS) % GOP_MS);
const gridCeil = (ms: number) => gridFloor(ms + GOP_MS - 1);

// "15 Seconds", "1 Minute", "2 Minutes" → seconds.

export function postRecSeconds(v: unknown): number {
  const m = /^(\d+)\s*(Second|Minute)/i.exec(String(v));
  if (!m) return 15;
  return Number(m[1]) * (m[2].toLowerCase() === 'minute' ? 60 : 1);
}

// Firmware example: sub ends 065224, main 065226 for the same event.
const MAIN_EXTRA_S = 2;

export interface SimEvent {
  at: string; // ISO time
  type: Trigger;
  durationS: number;
  recordingId: string | null;
}

// Triggered events. An event sets the detection state for its duration and,
// when the recording schedule allows it, starts or extends a recording that
// ends `postRec` after the last event.
export class Events extends EventEmitter {
  private readonly active = new Map<Trigger, number>(); // type → active count
  private current: { id: string; startMs: number; endsAt: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private readonly log: SimEvent[] = [];
  private readonly autoTimers = new Map<Trigger, ReturnType<typeof setTimeout>>();

  constructor(private readonly o: { clock: Clock; tz: string; sd: SdCard; settings: SettingsStore; rng: Rng }) {
    super();
  }

  trigger(type: Trigger, durationS: number): { recording: Recording | null } {
    const now = this.o.clock.now();
    const types: Trigger[] = type === 'motion' ? ['motion'] : [type, 'motion'];
    // Detection state per type; 'detect' fires on each on/off transition
    // (ONVIF events and GetMdState/GetAiState follow the same state).
    for (const t of types) {
      const n = this.active.get(t) ?? 0;
      this.active.set(t, n + 1);
      if (n === 0) this.emit('detect', { type: t, state: true });
      setTimeout(() => {
        const left = Math.max(0, (this.active.get(t) ?? 1) - 1);
        this.active.set(t, left);
        if (left === 0) this.emit('detect', { type: t, state: false });
      }, durationS * 1000);
    }

    let recording: Recording | null = null;
    const rec = this.o.settings.running.Rec;
    const p = localParts(this.o.clock, this.o.tz, now);
    const allowed = types.filter((t) => scheduled(rec.schedule?.table, t, p.weekday, p.hour));
    if (rec.enable === 1 && allowed.length) {
      const detected = gridFloor(now.getTime());
      const endsAt = gridCeil(now.getTime() + (durationS + postRecSeconds(rec.postRec)) * 1000);
      if (this.current) {
        this.o.sd.extend(this.current.id, allowed);
        if (endsAt > this.current.endsAt) this.scheduleEnd(this.current.id, this.current.startMs, endsAt);
        recording = this.o.sd.byId(this.current.id) ?? null;
      } else {
        // Pre-record (Rec.preRec 1, the firmware's default): the recording,
        // and its file name, start one grid step (4 s) before the detection
        // (cam-sim#25), even when that is before the previous one ended.
        const startMs = rec.preRec === 1 ? detected - PRE_REC_MS : detected;
        const s = localParts(this.o.clock, this.o.tz, new Date(startMs));
        const at = localParts(this.o.clock, this.o.tz, new Date(detected));
        recording = this.o.sd.add({ date: s.date, start: s.hms, triggers: allowed, dst: isDstOn(this.o.tz, s.date), picture: `${at.date.replaceAll('-', '')}${at.hms}` });
        this.scheduleEnd(recording.id, startMs, endsAt);
      }
    }
    const ev: SimEvent = { at: now.toISOString(), type, durationS, recordingId: recording?.id ?? null };
    this.log.unshift(ev);
    this.log.length = Math.min(this.log.length, 500);
    this.emit('event', ev);
    return { recording };
  }

  private scheduleEnd(id: string, startMs: number, endsAt: number): void {
    if (this.current) clearTimeout(this.current.timer);
    const timer = setTimeout(() => {
      const rec = this.o.sd.byId(id);
      if (rec) {
        const end = addSeconds(rec.start, Math.round((endsAt - startMs) / 1000));
        this.o.sd.finish(id, end, addSeconds(end, MAIN_EXTRA_S));
        this.o.sd.retention(Number(this.o.settings.running.Rec.saveDay) || 7);
        this.emit('recording', this.o.sd.byId(id));
      }
      this.current = null;
    }, Math.max(0, endsAt - this.o.clock.now().getTime()));
    this.current = { id, startMs, endsAt, timer };
  }

  mdState(): { state: 0 | 1 } {
    return { state: (this.active.get('motion') ?? 0) > 0 ? 1 : 0 };
  }

  aiState() {
    const s = (t: Trigger) => ({ alarm_state: (this.active.get(t) ?? 0) > 0 ? 1 : 0, support: 1 });
    return { channel: 0, dog_cat: s('pet'), face: { alarm_state: 0, support: 0 }, people: s('person'), vehicle: s('vehicle') };
  }

  clearRecent(): void {
    this.log.length = 0;
  }

  recent(limit: number): SimEvent[] {
    return this.log.slice(0, limit);
  }

  // Background events: exponential intervals per type from the seeded RNG.
  startAuto(spec: Array<{ type: Trigger; perHour: number }>): void {
    this.stopAuto();
    for (const { type, perHour } of spec) {
      if (perHour <= 0) continue;
      const next = () => {
        const waitMs = (-Math.log(1 - this.o.rng.next()) / perHour) * 3600_000;
        this.autoTimers.set(type, setTimeout(() => {
          this.trigger(type, 3 + Math.floor(this.o.rng.next() * 18));
          next();
        }, waitMs));
      };
      next();
    }
  }

  stopAuto(): void {
    for (const t of this.autoTimers.values()) clearTimeout(t);
    this.autoTimers.clear();
  }

  // Stops background events and finishes the recording in progress, so a
  // shutdown doesn't leave it open.
  stop(): void {
    this.stopAuto();
    const cur = this.current;
    if (!cur) return;
    clearTimeout(cur.timer);
    this.current = null;
    const rec = this.o.sd.byId(cur.id);
    if (rec && rec.end === null) {
      const end = addSeconds(rec.start, Math.max(1, Math.round((this.o.clock.now().getTime() - cur.startMs) / 1000)));
      this.o.sd.finish(cur.id, end, addSeconds(end, MAIN_EXTRA_S));
    }
  }
}

