// The web UI's pages, apart from the router so non-DOM code (nav.ts, the unit
// tests) can name them.
export const PAGES = ['live', 'playback', 'settings', 'simulator'] as const;
export type Page = (typeof PAGES)[number];
