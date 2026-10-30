// GetTime and SetTime against the real E1's answers
// (reference/E1-Outdoor-Pro/time-exchanges.json, measured 2026-10-30), for
// every model: the RLC-1224A and CX820 report the same Time and Dst objects.
import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fixedClock } from '../../src/engine/clock';
import { makeCamera, login } from '../helpers';

const EXCHANGES: Array<{ cmd: string; action: number; param: any; res: any }> = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'reference', 'E1-Outdoor-Pro', 'time-exchanges.json'), 'utf8'),
);
const MODELS = ['RLC-1224A', 'CX820', 'E1-Outdoor-Pro'];

// The capture's moment: 14:45:48 CDT.
async function camera(model: string) {
  const clock = fixedClock(new Date('2026-10-30T19:45:48Z'));
  const cam = await makeCamera({ CAMSIM_MODEL: model, CAMSIM_TZ: 'America/Chicago' }, { clock });
  const t = await login(cam.app);
  const call = async (cmd: string, param: unknown = {}, action = 0) =>
    JSON.parse((await request(cam.app).post(`/cgi-bin/api.cgi?cmd=${cmd}&token=${t}`).send([{ cmd, action, param }])).text)[0];
  return { clock, engine: cam.engine, call };
}

const time = (over: Record<string, unknown> = {}) => ({ ...EXCHANGES[2].param.Time, ...over });
const dst = (over: Record<string, unknown> = {}) => ({ ...EXCHANGES[2].param.Dst, ...over });

describe.each(MODELS)('%s: GetTime and SetTime', (model) => {
  it('replays time-exchanges.json in order with the camera\'s answers', async () => {
    const { call } = await camera(model);
    expect(EXCHANGES.map((x) => x.cmd)).toEqual(['GetTime', 'GetTime', 'SetTime', 'SetTime', 'GetTime']);
    for (const [i, ex] of EXCHANGES.entries()) {
      expect(await call(ex.cmd, ex.param, ex.action), `#${i} ${ex.cmd}`).toEqual(ex.res);
    }
  });

  it('sets the clock to the given date and time, and it runs on from there', async () => {
    const { clock, call } = await camera(model);
    expect((await call('SetTime', { Dst: dst(), Time: time({ year: 2026, mon: 1, day: 15, hour: 8, min: 0, sec: 0, isDst: 0 }) })).code).toBe(0);
    clock.advance(5000);
    const v = (await call('GetTime')).value;
    expect(v.Time).toMatchObject({ year: 2026, mon: 1, day: 15, hour: 8, min: 0, sec: 5, isDst: 0, timeZone: 21600 });
  });

  it('stores the zone and the DST rule and reports the local time in them', async () => {
    const { call } = await camera(model);
    // Berlin: UTC+1, DST from the last Sunday of March 2:00 to the last Sunday of October 3:00.
    const berlin = dst({ startMon: 3, startWeek: 5, startHour: 2, endMon: 10, endWeek: 5, endHour: 3 });
    expect((await call('SetTime', { Dst: berlin, Time: time({ timeZone: -3600, hour: 20, min: 45, sec: 48, isDst: 0 }) })).value).toEqual({ rspCode: 200 });
    const v = (await call('GetTime')).value;
    expect(v.Dst).toEqual(berlin);
    // 2026-10-30 is after the end of DST (October 25).
    expect(v.Time).toMatchObject({ day: 30, hour: 20, min: 45, sec: 48, isDst: 0, timeZone: -3600 });
  });

  it('switches DST off: the same instant, an hour earlier on the wall clock', async () => {
    const { call } = await camera(model);
    // US Central with DST off: CST, an hour behind the CDT the clock showed.
    const r = await call('SetTime', { Dst: dst({ enable: 0 }), Time: time({ hour: 13, isDst: 0 }) });
    expect(r.code).toBe(0);
    const v = (await call('GetTime')).value;
    expect(v.Dst.enable).toBe(0);
    expect(v.Time).toMatchObject({ hour: 13, min: 45, isDst: 0, timeZone: 21600 });
  });

  it.each([
    ['Time.timeZone', { Time: time({ timeZone: 999999 }), Dst: dst() }],
    ['Time.timeZone below the range', { Time: time({ timeZone: -46801 }), Dst: dst() }],
    ['Time.mon', { Time: time({ mon: 13 }), Dst: dst() }],
    ['Time.timeFmt', { Time: time({ timeFmt: 'YYYY-MM-DD' }), Dst: dst() }],
    ['Dst.offset', { Time: time(), Dst: dst({ offset: 3 }) }],
    ['Dst.startWeek', { Time: time(), Dst: dst({ startWeek: 6 }) }],
    ['Dst.enable', { Time: time(), Dst: dst({ enable: 2 }) }],
    ['no Time', { Dst: dst() }],
  ])('refuses %s out of range with -4 and changes nothing', async (_what, param) => {
    const { engine, call } = await camera(model);
    const before = (await call('GetTime')).value;
    expect(await call('SetTime', param)).toEqual({ cmd: 'SetTime', code: 1, error: { detail: 'param error', rspCode: -4 } });
    expect((await call('GetTime')).value).toEqual(before);
    expect(engine.counters.setCalls).toContain('SetTime');
  });

  it('goes back to the configured zone and the real clock on a reset', async () => {
    const { engine, call } = await camera(model);
    const before = (await call('GetTime')).value;
    await call('SetTime', { Dst: dst({ enable: 0 }), Time: time({ year: 2030, timeZone: 0, hourFmt: 0, timeFmt: 'YYYY/MM/DD' }) });
    expect((await call('GetTime')).value.Time).toMatchObject({ year: 2030, hourFmt: 0, timeFmt: 'YYYY/MM/DD' });
    engine.reset();
    expect((await call('GetTime')).value).toEqual(before);
  });
});
