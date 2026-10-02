import { describe, it, expect } from 'vitest';
import { Faults, FAULT_NAMES } from '../src/engine/faults';
import { Counters } from '../src/engine/counters';

describe('Faults', () => {
  it('counts down next-N faults', () => {
    const f = new Faults();
    f.set({ name: 'downloads.dropFirst', count: 2 });
    expect(f.consume('downloads.dropFirst')).toMatchObject({ name: 'downloads.dropFirst' });
    expect(f.consume('downloads.dropFirst')).toBeDefined();
    expect(f.consume('downloads.dropFirst')).toBeUndefined();
    expect(f.list()).toEqual([]);
  });

  it('keeps on-faults until cleared', () => {
    const f = new Faults();
    f.set({ name: 'downloads.refuse' });
    for (let i = 0; i < 5; i++) expect(f.consume('downloads.refuse')).toBeDefined();
    f.clear('downloads.refuse');
    expect(f.active('downloads.refuse')).toBeUndefined();
  });

  it('matches settings faults by command', () => {
    const f = new Faults();
    f.set({ name: 'settings.fail', cmds: ['SetWhiteLed'] });
    expect(f.activeFor('settings.fail', 'SetWhiteLed')).toMatchObject({ rspCode: -67 });
    expect(f.activeFor('settings.fail', 'SetIsp')).toBeUndefined();
  });

  it('validates specs', () => {
    const f = new Faults();
    expect(() => f.set({ name: 'nope' as any })).toThrow(/unknown fault/);
    expect(() => f.set({ name: 'downloads.dropFirst' })).toThrow(/count/);
    expect(() => f.set({ name: 'latencyMs' })).toThrow(/ms/);
    expect(() => f.set({ name: 'settings.fail' })).toThrow(/cmds/);
    expect(() => f.set({ name: 'downloads.refuse', count: 0 })).toThrow(/count/);
  });

  it('emits change and clears all', () => {
    const f = new Faults();
    let n = 0;
    f.on('change', () => n++);
    f.set({ name: 'offline' });
    f.set({ name: 'flv.reset' });
    f.clearAll();
    expect(n).toBe(3);
    expect(f.list()).toEqual([]);
  });

  it('knows every fault of the spec', () => {
    expect([...FAULT_NAMES].sort()).toEqual([
      'baichuan.delayMs', 'baichuan.dropMidway', 'baichuan.loginFail', 'baichuan.refuse', 'baichuan.sessionLimit',
      'downloads.delayMs', 'downloads.dropFirst', 'downloads.dropMidway', 'downloads.refuse',
      'flv.delayMs', 'flv.reset', 'ftp.delayMs', 'ftp.fail', 'latencyMs', 'offline', 'rtsp.refuse', 'rtsp.reset', 'search.delayMs',
      'settings.fail', 'settings.ignore', 'settings.strictPartial', 'snap.fail',
    ]);
  });

  it('knows the Baichuan faults: sessionLimit needs a positive max, delayMs needs ms', () => {
    const f = new Faults();
    for (const n of ['baichuan.refuse', 'baichuan.dropMidway', 'baichuan.delayMs', 'baichuan.loginFail', 'baichuan.sessionLimit']) expect(FAULT_NAMES).toContain(n);
    expect(() => f.set({ name: 'baichuan.sessionLimit' })).toThrow(/max/);
    expect(() => f.set({ name: 'baichuan.sessionLimit', max: 0 })).toThrow(/max/);
    expect(() => f.set({ name: 'baichuan.sessionLimit', max: 1.5 })).toThrow(/max/);
    expect(() => f.set({ name: 'baichuan.delayMs' })).toThrow(/ms/);
    f.set({ name: 'baichuan.sessionLimit', max: 3 });
    expect(f.active('baichuan.sessionLimit')).toEqual({ name: 'baichuan.sessionLimit', max: 3 });
    f.set({ name: 'baichuan.refuse', max: 3 }); // max belongs to sessionLimit only
    expect(f.active('baichuan.refuse')).toEqual({ name: 'baichuan.refuse' });
    f.set({ name: 'baichuan.loginFail', count: 2 });
    f.consume('baichuan.loginFail');
    f.consume('baichuan.loginFail');
    expect(f.active('baichuan.loginFail')).toBeUndefined();
  });
});

describe('Counters', () => {
  it('keeps only the most recent entries of its lists', () => {
    const c = new Counters();
    for (let i = 0; i < 1500; i++) {
      c.noteDownload(String(i));
      c.noteSet(`Set${i}`);
    }
    expect(c.downloadOrder).toHaveLength(1000);
    expect(c.downloadOrder[999]).toBe('1499');
    expect(c.setCalls).toHaveLength(1000);
  });

  it('resets', () => {
    const c = new Counters();
    c.logins = 3;
    c.downloadOrder.push('081510');
    c.reset();
    expect(c.snapshot()).toMatchObject({ logins: 0, downloadOrder: [] });
  });

  it('resets the Baichuan history but not the open Baichuan sessions', () => {
    const c = new Counters();
    Object.assign(c, { baichuanSessions: 2, baichuanLogins: 3, baichuanDownloads: 4, droppedBaichuanDownloads: 1 });
    c.reset();
    expect(c.snapshot()).toMatchObject({ baichuanSessions: 2, baichuanLogins: 0, baichuanDownloads: 0, droppedBaichuanDownloads: 0 });
  });
});
