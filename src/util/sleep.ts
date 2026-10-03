// The global setTimeout (not timers/promises), so tests with fake timers
// control it.
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
