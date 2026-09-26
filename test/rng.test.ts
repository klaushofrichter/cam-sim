import { describe, it, expect } from 'vitest';
import { createRng } from '../src/engine/rng';

describe('rng', () => {
  it('is deterministic per seed', () => {
    const a = createRng(7), b = createRng(7);
    expect([a.next(), a.next()]).toEqual([b.next(), b.next()]);
    expect(createRng(7).hex(12)).toMatch(/^[0-9A-F]{12}$/);
  });
});
