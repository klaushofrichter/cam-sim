import { describe, it, expect } from 'vitest';
import * as camSim from '../src/index';

describe('package', () => {
  it('exports createCamSim', () => expect(typeof camSim.createCamSim).toBe('function'));
  it('exports the fixture warm-up for test runners', () => {
    expect(typeof camSim.ensureFixtures).toBe('function');
    expect(typeof camSim.defaultFixtureDir).toBe('function');
  });
});
