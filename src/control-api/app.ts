import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import type { Engine } from '../engine/engine';
import { FAULT_NAMES, ACTION_NAMES, FaultError, type FaultName } from '../engine/faults';
import { TRIGGERS, type Trigger } from '../engine/types';
import { DEMO_CLIPS, type SeedClip } from '../engine/sdcard';
import { sse } from './sse';

const digest = (s: string) => createHash('sha256').update(s).digest();

// The simulator's control surface: bearer token only, never reachable from
// the camera ports. Without a configured token it is switched off (404).
export function createControlApp(engine: Engine): express.Express {
  const e = engine;
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  const api = express.Router();
  api.use((req: Request, res: Response, next: NextFunction) => {
    const expected = e.config.controlToken;
    if (!expected) return void res.status(404).json({ error: 'not_found' });
    if (req.query.token !== undefined || req.query.access_token !== undefined) return void res.status(400).json({ error: 'token_in_url' });
    const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (!m || !timingSafeEqual(digest(m[1]), digest(expected))) return void res.status(401).json({ error: 'unauthorized' });
    next();
  });
  api.use(express.json({ limit: '256kb' }));

  const bad = (res: Response, detail: string) => void res.status(400).json({ error: 'invalid', detail });

  api.get('/state', (_req, res) => void res.json(e.state()));

  api.get('/videos', (_req, res) => void res.status(501).json({ error: 'not_in_this_version' }));
  api.put('/video', (_req, res) => void res.status(501).json({ error: 'not_in_this_version' }));

  api.post('/events', (req, res) => {
    const { type, durationS } = req.body ?? {};
    if (!(TRIGGERS as readonly string[]).includes(type)) return bad(res, `type must be one of ${TRIGGERS.join(', ')}`);
    if (!Number.isInteger(durationS) || durationS < 1 || durationS > 3600) return bad(res, 'durationS must be an integer from 1 to 3600');
    const { recording } = e.events.trigger(type as Trigger, durationS);
    res.status(201).json({ event: e.events.recent(1)[0], recording });
  });
  api.get('/events', (req, res) => void res.json(e.events.recent(Math.min(500, Number(req.query.limit) || 50))));

  const HMS = /^([01]\d|2[0-3])[0-5]\d[0-5]\d$/;
  api.post('/recordings/seed', (req, res) => {
    const clips = req.body?.clips;
    let list: SeedClip[];
    if (clips === 'demo') list = DEMO_CLIPS;
    else if (Array.isArray(clips) && clips.length <= 1000 && clips.every((c: any) =>
      Number.isInteger(c?.daysAgo) && c.daysAgo >= 0 && c.daysAgo <= 365 && HMS.test(c.start) && HMS.test(c.end) &&
      (c.mainEnd === undefined || HMS.test(c.mainEnd)) &&
      Array.isArray(c.triggers) && c.triggers.length > 0 && c.triggers.every((t: string) => (TRIGGERS as readonly string[]).includes(t)))) {
      list = clips.map((c: any) => ({ daysAgo: c.daysAgo, start: c.start, end: c.end, mainEnd: c.mainEnd, triggers: c.triggers }));
    } else return bad(res, "clips must be 'demo' or a list of {daysAgo, start, end, triggers, mainEnd?}");
    e.sd.seed(list);
    res.status(201).json({ added: list.length });
  });
  api.delete('/recordings', (_req, res) => {
    e.sd.clear();
    res.status(204).end();
  });

  api.get('/faults', (_req, res) => void res.json(e.faults.list()));
  api.put('/faults/:name', (req, res) => {
    try {
      e.faults.set({ ...(req.body ?? {}), name: req.params.name as FaultName });
    } catch (err) {
      if (err instanceof FaultError) return bad(res, err.message);
      throw err;
    }
    res.json(e.faults.active(req.params.name as FaultName));
  });
  api.delete('/faults/:name', (req, res) => {
    if (!(FAULT_NAMES as readonly string[]).includes(req.params.name)) return bad(res, 'unknown fault');
    e.faults.clear(req.params.name as FaultName);
    res.status(204).end();
  });
  api.delete('/faults', (_req, res) => {
    e.faults.clearAll();
    res.status(204).end();
  });

  api.post('/actions/:name', (req, res) => {
    const name = req.params.name;
    if (!(ACTION_NAMES as readonly string[]).includes(name)) return bad(res, `action must be one of ${ACTION_NAMES.join(', ')}`);
    if (name === 'tokens.revoke') e.sessions.revokeAll();
    if (name === 'flv.dropActive') e.dropFlv();
    if (name === 'downloads.dropActive') e.dropDownloads();
    if (name === 'reboot') {
      const ms = req.body?.ms;
      if (ms !== undefined && !(Number.isInteger(ms) && ms >= 0 && ms <= 600_000)) return bad(res, 'ms must be an integer from 0 to 600000');
      void e.reboot({ ms, dropsConnection: req.body?.dropsConnection === true });
      return void res.status(202).end();
    }
    res.status(204).end();
  });

  api.post('/reset', (req, res) => {
    const b = req.body ?? {};
    const pick = (k: string) => (typeof b[k] === 'boolean' ? b[k] : undefined);
    e.reset({ settings: pick('settings'), recordings: pick('recordings'), counters: pick('counters'), faults: pick('faults') });
    res.status(204).end();
  });

  api.get('/requests', (req, res) => void res.json(e.requests.recent(Math.min(500, Number(req.query.limit) || 100))));
  api.get('/stream', (req, res) => sse(e, req, res));

  app.use('/sim/api', api);
  app.use((err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid', detail: 'body is not JSON' });
    e.log.error({ err: err.message }, 'control_api_error');
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
