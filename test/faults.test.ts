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
      'downloads.delayMs', 'downloads.dropFirst', 'downloads.dropMidway', 'downloads.refuse',
      'flv.delayMs', 'flv.reset', 'latencyMs', 'offline', 'search.delayMs',
      'settings.fail', 'settings.ignore', 'settings.strictPartial', 'snap.fail',
    ]);
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
});
