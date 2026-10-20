import { ensureFixtures, defaultFixtureDir } from '../src/media/fixtures';
import { createLogger } from '../src/log';
import { MODELS, profileFor } from '../src/profile/profile';

// Builds the test-pattern fixtures once before any worker starts, for every
// model: an encode during the run would slow the timing-sensitive tests.
export default async function setup() {
  for (const model of MODELS) {
    const profile = profileFor(model);
    await ensureFixtures(defaultFixtureDir(profile), createLogger('silent'), profile);
  }
}
