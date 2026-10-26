import { describe, it, expect, vi } from 'vitest';
import { coalesced } from '../web/src/lib/coalesce';

describe('web UI: coalesced state reloads', () => {
  it('runs one at a time; calls during a run queue one more, started after the last call', async () => {
    const pending: Array<() => void> = [];
    const run = vi.fn(() => new Promise<void>((r) => pending.push(r)));
    const settle = async () => {
      while (pending.length) {
        pending.shift()!();
        await new Promise((r) => setTimeout(r, 0));
      }
    };
    const go = coalesced(run);
    go();
    expect(run).toHaveBeenCalledTimes(1);
    go();
    go();
    go();
    expect(run).toHaveBeenCalledTimes(1);
    await settle();
    expect(run).toHaveBeenCalledTimes(2);
    go();
    expect(run).toHaveBeenCalledTimes(3);
    await settle();
    expect(run).toHaveBeenCalledTimes(3);
  });
});
