import { describe, it, expect, vi, afterEach } from 'vitest';
import { makeEngine } from './helpers';

afterEach(() => vi.useRealTimers());

describe('SD pipeline switch', () => {
  it('is off at start; on sets until; the timer switches it off; each change is a bus event', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const e = await makeEngine();
    const seen: unknown[] = [];
    e.bus.on('pipeline', (s) => seen.push(s));
    expect(e.state().pipeline).toEqual({ on: false });
    e.pipelineOn(15);
    expect(e.pipelineState()).toEqual({ on: true, until: 1_000_000 + 15 * 60_000, running: false });
    e.pipelineOn(60); // on again: a new end time
    expect((e.pipelineState() as { until: number }).until).toBe(1_000_000 + 60 * 60_000);
    vi.advanceTimersByTime(60 * 60_000);
    expect(e.pipelineState()).toEqual({ on: false });
    expect(seen).toHaveLength(3);
  });

  it('keeps an error after switching off for a failure, until the next switch-on', async () => {
    const e = await makeEngine();
    e.pipelineOn(5);
    e.pipelineOff('drawtext: font not found');
    expect(e.pipelineState()).toEqual({ on: false, error: 'drawtext: font not found' });
    e.pipelineOn(5);
    expect(e.pipelineState()).not.toHaveProperty('error');
    e.pipelineOff();
  });

  it('is off after reset() and stop()', async () => {
    const e = await makeEngine();
    e.pipelineOn(5);
    e.reset();
    expect(e.pipelineState()).toEqual({ on: false });
    e.pipelineOn(5);
    e.stop();
    expect(e.pipelineState()).toEqual({ on: false });
  });
});
