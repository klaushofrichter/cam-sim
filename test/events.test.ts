import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SdCard } from '../src/engine/sdcard';
import { Events, postRecSeconds } from '../src/engine/events';
import { SettingsStore } from '../src/engine/settings';
import { systemClock } from '../src/engine/clock';
import { createLogger } from '../src/log';
import { createRng } from '../src/engine/rng';

const TZ = 'America/Chicago';
const log = createLogger('silent');

function setup(at: string) {
  vi.useFakeTimers({ now: new Date(at), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const settings = new SettingsStore({ name: 'Den', log });
  const sd = new SdCard({ capacityMb: 1000, clock: systemClock, tz: TZ, log, fixtureSizes: { sub: 1000, main: 2000 } });
  const events = new Events({ clock: systemClock, tz: TZ, sd, settings, rng: createRng(1) });
  return { settings, sd, events };
}
const day = (y: number, m: number, d: number) => ({ year: y, mon: m, day: d });

afterEach(() => vi.useRealTimers());

describe('postRecSeconds', () => {
  it('parses the firmware strings', () => {
    expect(postRecSeconds('15 Seconds')).toBe(15);
    expect(postRecSeconds('1 Minute')).toBe(60);
    expect(postRecSeconds('2 Minutes')).toBe(120);
  });
});

describe('Events', () => {
  it('records a motion event, in progress and then finished', () => {
    const { sd, events } = setup('2026-09-26T11:52:21Z'); // 06:52:21 CDT
    const { recording } = events.trigger('motion', 5);
    expect(recording).not.toBeNull();
    expect(events.mdState()).toEqual({ state: 1 });
    expect(sd.search('sub', day(2026, 9, 26), day(2026, 9, 26))[0].name).toContain('RecS0A_DST20260926_065221_000000_0_55148080000000_');
    vi.advanceTimersByTime(5_000);
    expect(events.mdState()).toEqual({ state: 0 });
    vi.advanceTimersByTime(15_000);
    expect(sd.search('sub', day(2026, 9, 26), day(2026, 9, 26))[0].name).toContain('_065221_065241_');
    expect(sd.search('main', day(2026, 9, 26), day(2026, 9, 26))[0].name).toContain('_065221_065243_');
  });

  it('AI events also set motion, and show in GetAiState', () => {
    const { sd, events } = setup('2026-09-26T11:52:21Z');
    events.trigger('person', 3);
    expect(events.aiState()).toMatchObject({ channel: 0, people: { alarm_state: 1, support: 1 }, vehicle: { alarm_state: 0 }, face: { alarm_state: 0, support: 0 } });
    expect(sd.all()[0].triggers.sort()).toEqual(['motion', 'person']);
  });

  it('a second event during a recording extends it', () => {
    const { sd, events } = setup('2026-09-26T11:52:21Z');
    events.trigger('motion', 5);
    vi.advanceTimersByTime(10_000);
    events.trigger('vehicle', 5);
    expect(sd.all()).toHaveLength(1);
    vi.advanceTimersByTime(19_000);
    expect(sd.all()[0].end).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(sd.all()[0].end).toBe('065251');
    expect(sd.all()[0].triggers.sort()).toEqual(['motion', 'vehicle']);
  });

  it('does not record when recording is off', () => {
    const { settings, events, sd } = setup('2026-09-26T11:52:21Z');
    const rec = settings.get('Rec');
    settings.set('SetRecV20', { Rec: { ...rec, enable: 0 } }, { strictPartial: false });
    expect(events.trigger('motion', 5).recording).toBeNull();
    expect(sd.all()).toEqual([]);
    expect(events.mdState()).toEqual({ state: 1 });
  });

  it('records only the scheduled trigger types', () => {
    const { settings, events, sd } = setup('2026-09-26T11:52:21Z');
    const rec = settings.get('Rec');
    rec.schedule.table.AI_PEOPLE = '0'.repeat(168);
    settings.set('SetRecV20', { Rec: rec }, { strictPartial: false });
    events.trigger('person', 3);
    expect(sd.all()[0].triggers).toEqual(['motion']);
    rec.schedule.table.MD = '0'.repeat(168);
    settings.set('SetRecV20', { Rec: rec }, { strictPartial: false });
    vi.advanceTimersByTime(60_000);
    expect(events.trigger('person', 3).recording).toBeNull();
  });

  it('uses the schedule slot of the local weekday and hour', () => {
    const { settings, events } = setup('2026-09-26T11:52:21Z'); // Saturday 06:xx CDT → slot 6*24+6
    const rec = settings.get('Rec');
    rec.schedule.table.MD = '1'.repeat(150) + '0' + '1'.repeat(17);
    settings.set('SetRecV20', { Rec: rec }, { strictPartial: false });
    expect(events.trigger('motion', 1).recording).toBeNull();
  });

  it('names a clip that runs past midnight by its start date', () => {
    const { sd, events } = setup('2026-09-27T04:59:50Z'); // 23:59:50 CDT on the 26th
    events.trigger('motion', 5);
    vi.advanceTimersByTime(30_000);
    const [r] = sd.all();
    expect(r.date).toBe('2026-09-26');
    expect(r.files.sub.name).toContain('RecS0A_DST20260926_235950_000010_');
  });

  it('has no DST marker on the fall-back day', () => {
    const { sd, events } = setup('2026-11-01T18:00:00Z');
    events.trigger('motion', 1);
    expect(sd.all()[0].files.sub.name).toContain('RecS0A_20261101_');
  });

  it('stop() finishes the recording in progress', () => {
    const { sd, events } = setup('2026-09-26T11:52:21Z');
    events.trigger('motion', 30);
    vi.advanceTimersByTime(4_000);
    events.stop();
    expect(sd.all()[0].end).toBe('065225');
  });

  it('keeps recent events', () => {
    const { events } = setup('2026-09-26T11:52:21Z');
    events.trigger('motion', 1);
    events.trigger('pet', 1);
    expect(events.recent(10).map((e) => e.type)).toEqual(['pet', 'motion']);
  });

  it('fires automatic events', () => {
    const { events, sd } = setup('2026-09-26T11:52:21Z');
    events.startAuto([{ type: 'motion', perHour: 60 }]);
    vi.advanceTimersByTime(3 * 3600_000);
    events.stopAuto();
    expect(events.recent(1000).length).toBeGreaterThan(20);
    expect(sd.all().length).toBeGreaterThan(0);
  });
});
