import express, { type NextFunction, type Request, type Response } from 'express';
import type { Engine } from '../engine/engine';
import { runCommand, fail, ok, type Entry } from './commands';
import { download, snap, flv, NOT_LOGGED_IN_GET_BODY } from './media-routes';
import { sleep } from '../util/sleep';

// Replies are JSON sent as text/html, as the firmware does; a command name
// is only echoed back when it is a plain identifier.
const cmdName = (v: unknown): string => (typeof v === 'string' && /^[A-Za-z0-9]{1,64}$/.test(v) ? v : 'Unknown');

// The Reolink-compatible camera API, as served on the camera's HTTP or HTTPS
// port. Everything the firmware does is on; faults come from engine.faults.
export function createCameraApp(engine: Engine, opts: { port: 'http' | 'https' }): express.Express {
  const e = engine;
  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);

  // Request log: method, path without the query (it carries the token), status.
  app.use((req, res, next) => {
    const t0 = Date.now();
    res.on('close', () => {
      e.recordRequest({
        at: new Date(t0).toISOString(),
        port: opts.port,
        method: req.method,
        path: req.path,
        cmd: typeof req.query.cmd === 'string' ? req.query.cmd.slice(0, 64) : '',
        status: res.headersSent ? res.statusCode : 0,
        ms: Date.now() - t0,
      });
    });
    next();
  });
  // A camera that is down or rebooting drops connections, it doesn't answer.
  app.use((req, _res, next) => (e.offline() ? req.socket.destroy() : next()));
  app.use((req, _res, next) => {
    const enabled = opts.port === 'http' ? e.settings.running.NetPort.httpEnable : e.settings.running.NetPort.httpsEnable;
    return enabled === 1 ? next() : req.socket.destroy();
  });
  app.use(async (_req, _res, next) => {
    const ms = e.faults.active('latencyMs')?.ms;
    if (ms) await sleep(ms);
    next();
  });

  const reply = (res: Response, entries: Entry[]) => res.status(200).type('text/html').send(JSON.stringify(entries));

  // The camera accepts any content type for its JSON commands.
  app.post('/cgi-bin/api.cgi', express.json({ type: () => true, limit: '1mb' }), async (req: Request, res: Response) => {
    const qcmd = typeof req.query.cmd === 'string' ? cmdName(req.query.cmd) : '';
    const body: any[] = Array.isArray(req.body) ? req.body : [];
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const out: Entry[] = [];
    const beforeReply: Array<() => void> = [];
    for (const item of body.length ? body : [{}]) {
      const cmd = item?.cmd !== undefined ? cmdName(item.cmd) : qcmd || 'Unknown';
      const param = item?.param;
      if (cmd === 'Login') {
        e.counters.loginAttempts++;
        if (e.timings.loginMs) await sleep(e.timings.loginMs);
        const u = param?.User ?? {};
        const r = e.sessions.login(String(u.userName ?? ''), String(u.password ?? ''), req.socket.remoteAddress ?? '');
        if (!r.ok) {
          out.push(fail(cmd, r.rspCode));
          continue;
        }
        e.counters.logins++;
        out.push(ok(cmd, { Token: { leaseTime: r.leaseTime, name: r.token } }));
        continue;
      }
      const session = e.sessions.validate(token);
      if (!session) {
        out.push(fail(cmd, -6));
        continue;
      }
      const r = await runCommand({ engine: e, cmd, action: Number(item?.action) || 0, param, session, token, req, res, beforeReply: (fn) => void beforeReply.push(fn) });
      if (r === 'destroyed') return;
      out.push(r);
    }
    if (res.destroyed) return;
    for (const fn of beforeReply) fn();
    reply(res, out);
  });

  app.get('/cgi-bin/api.cgi', async (req: Request, res: Response) => {
    const cmd = String(req.query.cmd ?? '');
    if (cmd === 'Download' || cmd === 'download') return download(e, req, res);
    if (cmd === 'Snap') return snap(e, req, res);
    if (cmd === 'Playback') return void res.status(404).type('text/html').end();
    res.status(200).type('text/html').send(NOT_LOGGED_IN_GET_BODY);
  });

  app.get('/flv', (req, res) => flv(e, req, res));

  // Unparseable JSON bodies.
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    reply(res, [fail(cmdName(req.query.cmd), -4)]);
  });

  return app;
}
