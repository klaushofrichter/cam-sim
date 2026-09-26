import { describe, it, expect } from 'vitest';
import * as camSim from '../src/index';

describe('package', () => {
  it('exports createCamSim', () => expect(typeof camSim.createCamSim).toBe('function'));
});
