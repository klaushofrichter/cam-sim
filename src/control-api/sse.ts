import type { Request, Response } from 'express';
import type { Engine } from '../engine/engine';

const TOPICS: Array<[string, string]> = [['event', 'event'], ['request', 'request'], ['fault', 'fault'], ['state', 'state'], ['cert', 'state'], ['ftp', 'ftp'], ['video', 'video'], ['pipeline', 'pipeline']];

// Server-Sent Events: state changes, events, requests and faults as they
// happen, for the web UI and for tests that wait for something.
export function sse(engine: Engine, req: Request, res: Response): void {
  res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let id = 0;
  const send = (event: string, data: unknown) => res.write(`id: ${++id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const handlers = TOPICS.map(([topic, event]) => {
    const h = (data: unknown) => send(event, topic === 'cert' ? { certificate: true } : data);
    engine.bus.on(topic, h);
    return [topic, h] as const;
  });
  // A new camera name (SetDevName, SetOsd, the Settings page, a settings
  // reset) is part of the state: send it again when the name changed.
  let name = engine.settings.name;
  const onName = () => {
    if (engine.settings.name === name) return;
    name = engine.settings.name;
    send('state', engine.state());
  };
  engine.bus.on('settings', onName);
  engine.bus.on('state', onName);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  send('state', engine.state());
  req.on('close', () => {
    clearInterval(heartbeat);
    engine.bus.off('settings', onName);
    engine.bus.off('state', onName);
    for (const [topic, h] of handlers) engine.bus.off(topic, h);
  });
}
