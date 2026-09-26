import { ensureFixtures, defaultFixtureDir } from '../src/media/fixtures';
import { createLogger } from '../src/log';

// Builds the test-pattern fixtures once before any worker starts.
export default async function setup() {
  await ensureFixtures(defaultFixtureDir(), createLogger('silent'));
}
