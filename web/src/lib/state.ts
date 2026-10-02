import { writable } from 'svelte/store';

// The simulator's /sim/api/state, kept current by the SSE feed.
export interface SimState {
  name: string;
  serial: string;
  model: string;
  firmVer: string;
  tz: string;
  offline: boolean;
  power: 'on' | 'off' | 'booting';
  rebooting: boolean;
  faults: Array<{ name: string; count?: number; ms?: number; cmds?: string[]; rspCode?: number; max?: number }>;
  events: Array<{ at: string; type: string; durationS: number; recordingId: string | null }>;
  sd: { usedMb: number; capacityMb: number; recordings: number };
  counters: Record<string, number | string[]>;
  certificate: { source: string; enable: number };
  video: string;
  pipeline: { on: false; error?: string } | { on: true; until: number; running: boolean };
  pipelineMaxMin: number;
}

export interface RequestRecord {
  at: string;
  port: string;
  method: string;
  path: string;
  cmd: string;
  status: number;
  ms: number;
}

export const simState = writable<SimState | null>(null);
// Everything the feed delivered, newest first, capped.
export const feed = writable<Array<{ kind: 'request' | 'event' | 'fault' | 'state' | 'video' | 'pipeline'; at: string; data: unknown }>>([]);

let source: EventSource | null = null;
let refresh: (() => void) | null = null;

export function connectFeed(reload: () => void): void {
  refresh = reload;
  if (source) return;
  source = new EventSource('/sim/api/stream', { withCredentials: true });
  const push = (kind: 'request' | 'event' | 'fault' | 'state' | 'video' | 'pipeline') => (ev: MessageEvent) => {
    const data = JSON.parse(ev.data);
    if (kind === 'state' && data && typeof data === 'object' && 'serial' in data) simState.set(data as SimState);
    feed.update((list) => [{ kind, at: new Date().toISOString(), data }, ...list].slice(0, 200));
    if (kind !== 'request') refresh?.();
  };
  for (const k of ['request', 'event', 'fault', 'state', 'video', 'pipeline'] as const) source.addEventListener(k, push(k));
}

export function disconnectFeed(): void {
  source?.close();
  source = null;
}
