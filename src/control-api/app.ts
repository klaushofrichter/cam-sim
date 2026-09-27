import express, { type NextFunction, type Request, type Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import type { Engine } from '../engine/engine';
import { FAULT_NAMES, ACTION_NAMES, FaultError, type FaultName } from '../engine/faults';
import { TRIGGERS, type Trigger } from '../engine/types';
import { DEMO_CLIPS, type SeedClip } from '../engine/sdcard';
import { sse } from './sse';
import { streamFlv } from '../camera-api/media-routes';
import { devInfo, ENC, AI_TYPES } from '../profile/rlc1224a';
import { createReadStream, existsSync } from 'fs';
import { join } from 'path';
import { createSessionSigner, readCookie, sessionCookieName, SESSION_MS } from './session';
import { rateLimit } from 'express-rate-limit';

const digest = (s: string) => createHash('sha256').update(s).digest();

// The simulator's control surface: bearer token only, never reachable from
// the camera ports. Without a configured token it is switched off (404).
// dist/web next to the compiled server (dist/src/control-api → dist/web), or,
// when running from source, the repository's dist/web. The source web/
// folder (with vite.config.mts) is never served.
function findWebDir(): string | undefined {
  for (const dir of [process.env.CAMSIM_WEB_DIR, join(__dirname, '..', '..', 'web'), join(__dirname, '..', '..', 'dist', 'web')]) {
    if (dir && existsSync(join(dir, 'index.html')) && !existsSync(join(dir, 'vite.config.mts'))) return dir;
  }
  return undefined;
}

export function createControlApp(engine: Engine): express.Express {
  const e = engine;
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  // Web UI sessions: the control token, pasted once, is exchanged for a
  // signed HttpOnly cookie. Writes with the cookie need X-CamSim-UI (a header
  // a cross-site form can't send).
  const sessions = createSessionSigner();
  const tokenMatches = (t: unknown) => typeof t === 'string' && !!e.config.controlToken && timingSafeEqual(digest(t), digest(e.config.controlToken));
  const SESSION_COOKIE = sessionCookieName(e.config.name);
  const cookieOf = (req: Request) => readCookie(req.get('cookie'), SESSION_COOKIE);
  const cookieFlags = (req: Request) => `Path=/; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`;
  const session = express.Router();
  session.use((_req, res, next) => (e.config.controlToken ? next() : void res.status(404).json({ error: 'not_found' })));
  // Guessing tokens: 20 login attempts per 15 minutes per address.
  const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'too_many_attempts' } });
  session.post('/login', loginLimit, express.json({ limit: '4kb' }), (req, res) => {
    if (!tokenMatches(req.body?.token)) return void res.status(401).json({ error: 'unauthorized' });
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessions.issue()}; Max-Age=${SESSION_MS / 1000}; ${cookieFlags(req)}`);
    res.status(204).end();
  });
  session.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; ${cookieFlags(req)}`);
    res.status(204).end();
  });
  session.get('/session', (req, res) => void res.json({ loggedIn: sessions.verify(cookieOf(req)) }));
  app.use('/sim', session);

  // A generous ceiling for everything else on the control port (the UI polls
  // little; SSE and live video are single long requests).
  app.use(rateLimit({ windowMs: 60_000, limit: 1200, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'rate_limited' } }));
  const api = express.Router();
  api.use((req: Request, res: Response, next: NextFunction) => {
    if (!e.config.controlToken) return void res.status(404).json({ error: 'not_found' });
    if (req.query.token !== undefined || req.query.access_token !== undefined) return void res.status(400).json({ error: 'token_in_url' });
    const m = /^Bearer (.+)$/.exec(req.get('authorization') ?? '');
    if (m) return tokenMatches(m[1]) ? next() : void res.status(401).json({ error: 'unauthorized' });
    if (!sessions.verify(cookieOf(req))) return void res.status(401).json({ error: 'unauthorized' });
    if (!['GET', 'HEAD'].includes(req.method) && req.get('x-camsim-ui') !== '1') return void res.status(403).json({ error: 'csrf' });
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
    if (e.power !== 'on') return void res.status(409).json({ error: 'powered_off' });
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
    const ms = req.body?.ms;
    if ((name === 'reboot' || name === 'power-on') && ms !== undefined && !(Number.isInteger(ms) && ms >= 0 && ms <= 600_000)) {
      return bad(res, 'ms must be an integer from 0 to 600000');
    }
    if (name === 'reboot') {
      if (e.power !== 'on') return void res.status(409).json({ error: 'powered_off' });
      void e.reboot({ ms, dropsConnection: req.body?.dropsConnection === true });
      return void res.status(202).end();
    }
    if (name === 'power-off') {
      if (!e.powerOff()) return void res.status(409).json({ error: e.power === 'off' ? 'already_off' : 'busy' });
      return void res.status(204).end();
    }
    if (name === 'power-on') {
      if (e.power !== 'off') return void res.status(409).json({ error: 'already_on' });
      void e.powerOn(ms);
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

  // For the web UI: what a person looks at on a camera, without being a
  // camera client (no sessions, no counters).
  api.get('/media/snapshot', async (_req, res) => void res.type('image/jpeg').send(await e.media.snapshot()));
  api.get('/media/live/:stream', (req, res) => {
    const stream = req.params.stream;
    if (stream !== 'sub' && stream !== 'main') return void res.status(404).json({ error: 'not_found' });
    streamFlv(e, res, stream, { count: false });
  });

  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  api.get('/recordings', (req, res) => {
    const date = String(req.query.date ?? '');
    if (!DATE.test(date)) return bad(res, 'date must be YYYY-MM-DD');
    res.json(e.sd.all().filter((r) => r.date === date));
  });
  api.get('/recordings/days', (req, res) => {
    const year = Number(req.query.year), mon = Number(req.query.mon);
    if (!Number.isInteger(year) || !Number.isInteger(mon) || mon < 1 || mon > 12) return bad(res, 'year and mon (1-12) are required');
    res.json(e.sd.status('sub', year, mon));
  });
  api.get('/recordings/:id/:stream', (req, res) => {
    const stream = req.params.stream;
    const rec = e.sd.byId(req.params.id);
    if (!rec || (stream !== 'sub' && stream !== 'main')) return void res.status(404).json({ error: 'not_found' });
    const size = e.media.clipSize(stream);
    res.status(200).type('video/mp4').setHeader('Content-Length', String(size));
    if (req.query.download === '1') {
      const name = rec.files[stream].name.slice(rec.files[stream].name.lastIndexOf('/') + 1);
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    const file = createReadStream(e.media.clipPath(stream));
    res.on('close', () => file.destroy());
    file.pipe(res);
  });

  api.get('/settings', (_req, res) => void res.json({
    settings: e.settings.running,
    devInfo: devInfo(e.config.name, e.serial, e.config.firmVer),
    hddInfo: e.sd.hddInfo(),
    enc: ENC,
    certificate: { source: e.certificate.source, enable: e.certificate.enable },
  }));
  // Whole-object writes through the camera's own validation.
  const SET_FOR: Record<string, string> = { Rec: 'SetRecV20', MdAlarm: 'SetMdAlarm', Isp: 'SetIsp', IrLights: 'SetIrLights', WhiteLed: 'SetWhiteLed', Osd: 'SetOsd', NetPort: 'SetNetPort', Ftp: 'SetFtpV20' };
  const writeSetting = (res: Response, cmd: string, key: string, body: unknown) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return bad(res, 'the body must be the whole settings object');
    const r = e.settings.set(cmd, { [key]: body }, { strictPartial: true });
    if (r) return void res.status(400).json({ error: 'invalid', rspCode: r.rspCode });
    res.json(key === 'AiAlarm' ? e.settings.get('AiAlarm', (body as { ai_type: 'people' }).ai_type) : e.settings.get(key as 'Isp'));
  };
  api.put('/settings/AiAlarm/:type', (req, res) => {
    const type = req.params.type;
    if (!(AI_TYPES as readonly string[]).includes(type)) return void res.status(404).json({ error: 'not_found' });
    writeSetting(res, 'SetAiAlarm', 'AiAlarm', { ...(req.body ?? {}), ai_type: type });
  });
  api.put('/settings/:key', (req, res) => {
    const key = req.params.key;
    if (!Object.hasOwn(SET_FOR, key)) return void res.status(404).json({ error: 'not_found' });
    writeSetting(res, SET_FOR[key], key, req.body);
  });
  api.get('/users', (_req, res) => void res.json(e.sessions.users()));

  api.get('/requests', (req, res) => void res.json(e.requests.recent(Math.min(500, Number(req.query.limit) || 100))));
  api.get('/stream', (req, res) => sse(e, req, res));

  app.use('/sim/api', api);

  // The web UI (CAMSIM_WEB_UI=true): the built app from dist/web. Its pages
  // need a session for every API call; the files themselves are public.
  const webDir = findWebDir();
  if (e.config.webUi && e.config.controlToken) {
    if (!webDir) e.log.warn('web_ui_not_built');
    else {
      // A missing asset is a 404, not the app page (stale chunks after an upgrade).
      app.use('/assets', express.static(join(webDir, 'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false }));
      app.get(/^\/(?!sim\/|healthz).*/, (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        // The UI has reset and power buttons: never inside another page's frame.
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        res.sendFile(join(webDir, 'index.html'));
      });
    }
  }
  app.use((err: Error & { type?: string }, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid', detail: 'body is not JSON' });
    if (err.type === 'entity.too.large') return void res.status(413).json({ error: 'too_large' });
    const status = (err as { status?: number }).status;
    if (status === 404) return void res.status(404).json({ error: 'not_found' });
    e.log.error({ err: err.message }, 'control_api_error');
    res.status(500).json({ error: 'internal' });
  });
  return app;
}
