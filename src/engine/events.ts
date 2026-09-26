import { EventEmitter } from 'events';
import { localParts, isDstOn, type Clock } from './clock';
import type { Rng } from './rng';
import type { SdCard, Recording } from './sdcard';
import type { SettingsStore } from './settings';
import type { Trigger } from './types';

// "15 Seconds", "1 Minute", "2 Minutes" → seconds.
export function postRecSeconds(v: unknown): number {
  const m = /^(\d+)\s*(Second|Minute)/i.exec(String(v));
  if (!m) return 15;
  return Number(m[1]) * (m[2].toLowerCase() === 'minute' ? 60 : 1);
}

// Schedule table key per trigger type (GetRecV20 schedule.table).
const SCHEDULE_KEY: Record<Trigger, string> = { motion: 'MD', person: 'AI_PEOPLE', vehicle: 'AI_VEHICLE', pet: 'AI_DOG_CAT' };
// Firmware example: sub ends 065224, main 065226 for the same event.
const MAIN_EXTRA_S = 2;

export interface SimEvent {
  at: string; // ISO time
  type: Trigger;
  durationS: number;
  recordingId: string | null;
}

const addSeconds = (hms: string, s: number) => {
  const t = (Number(hms.slice(0, 2)) * 3600 + Number(hms.slice(2, 4)) * 60 + Number(hms.slice(4, 6)) + s) % 86400;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(t / 3600))}${p(Math.floor((t % 3600) / 60))}${p(t % 60)}`;
};

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
    for (const t of types) {
      this.active.set(t, (this.active.get(t) ?? 0) + 1);
      setTimeout(() => this.active.set(t, Math.max(0, (this.active.get(t) ?? 1) - 1)), durationS * 1000);
    }

    let recording: Recording | null = null;
    const rec = this.o.settings.running.Rec;
    const p = localParts(this.o.clock, this.o.tz, now);
    const slot = p.weekday * 24 + p.hour;
    const scheduled = types.filter((t) => String(rec.schedule?.table?.[SCHEDULE_KEY[t]] ?? '')[slot] === '1');
    if (rec.enable === 1 && scheduled.length) {
      const endsAt = now.getTime() + (durationS + postRecSeconds(rec.postRec)) * 1000;
      if (this.current) {
        this.o.sd.extend(this.current.id, scheduled);
        if (endsAt > this.current.endsAt) this.scheduleEnd(this.current.id, this.current.startMs, endsAt);
        recording = this.o.sd.byId(this.current.id) ?? null;
      } else {
        recording = this.o.sd.add({ date: p.date, start: p.hms, triggers: scheduled, dst: isDstOn(this.o.tz, p.date) });
        this.scheduleEnd(recording.id, now.getTime(), endsAt);
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

  stop(): void {
    this.stopAuto();
    if (this.current) clearTimeout(this.current.timer);
  }
}

