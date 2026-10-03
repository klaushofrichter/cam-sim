import express, { type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { Engine } from '../engine/engine';
import { devInfo } from '../profile/rlc1224a';
import { localParts } from '../engine/clock';
import type { Trigger } from '../engine/types';
import { envelope, fault, operation, field, durationMs, authenticate, esc, NS } from './soap';
import { TOPICS, topicsFor, notification, currentState, EVENT_PROPERTIES } from './events';

const MAX_SUBSCRIPTIONS = 16;
const MAX_PULL_WAIT_MS = 60_000;
const MAX_TTL_MS = 24 * 3600_000;
// Messages kept for a subscription nobody pulls; the oldest go first.
const MAX_QUEUE = 1000;
// A host header fit to go into an address: name or IPv4, or [IPv6], with a port.
const HOST = /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/;
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

interface Subscription {
  expiresAt: number;
  queue: string[];
  wake: Set<() => void>;
}

export type OnvifApp = express.Express & { stop(): void };

// The camera's ONVIF service on its ONVIF port (8000): the device and event
// services a gateway uses for events. Media and PTZ are out of scope.
export function createOnvifApp(engine: Engine): OnvifApp {
  const e = engine;
  const app = Object.assign(express(), { stop: () => undefined }) as OnvifApp;
  app.disable('x-powered-by');
  const subs = new Map<number, Subscription>();
  let nextIdx = 1000 + Math.floor(e.rng.next() * 1_000_000);

  const expire = () => {
    const now = Date.now();
    for (const [idx, s] of subs) if (s.expiresAt <= now) end(idx, s);
  };
  const end = (idx: number, s: Subscription) => {
    subs.delete(idx);
    for (const w of [...s.wake]) w();
  };
  // Like the camera, subscriptions live in memory: power-off, a reboot or
  // switching ONVIF off ends them all (waiting polls are dropped).
  const endAll = () => {
    for (const [idx, s] of subs) end(idx, s);
  };
  const sweeper = setInterval(expire, 5000);
  sweeper.unref();

  // Detection changes become Changed notifications in every subscription.
  const onDetect = ({ type, state }: { type: Trigger; state: boolean }) => {
    if (e.offline()) return;
    const msgs = topicsFor(type).map((t) => notification(t, state, 'Changed'));
    for (const s of subs.values()) {
      s.queue.push(...msgs);
      if (s.queue.length > MAX_QUEUE) s.queue.splice(0, s.queue.length - MAX_QUEUE);
      for (const w of [...s.wake]) w();
    }
  };
  const onState = (st: { power?: string; rebooting?: boolean }) => {
    if (st.power === 'off' || st.rebooting === true) endAll();
  };
  const onSettings = () => {
    if (e.settings.running.NetPort.onvifEnable !== 1) endAll();
  };
  e.events.on('detect', onDetect);
  e.bus.on('state', onState);
  e.bus.on('settings', onSettings);
  app.stop = () => {
    clearInterval(sweeper);
    e.events.off('detect', onDetect);
    e.bus.off('state', onState);
    e.bus.off('settings', onSettings);
    endAll();
  };

  // A camera that is off, offline or has ONVIF switched off drops the connection.
  app.use((req, _res, next) => (e.offline() || e.settings.running.NetPort.onvifEnable !== 1 ? req.socket.destroy() : next()));
  // Generous for a gateway that long-polls; stops a flood of sign-in attempts.
  app.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: false, legacyHeaders: false }));
  app.use(express.text({ type: () => true, limit: '16kb' }));

  const send = (res: Response, body: string) => res.status(200).type('application/soap+xml; charset=utf-8').send(envelope(body));
  const sendFault = (res: Response, sub: string, reason: string) => res.status(400).type('application/soap+xml; charset=utf-8').send(fault(sub, reason));
  const notSupported = (res: Response) => sendFault(res, 'ter:ActionNotSupported', 'Optional Action Not Implemented');
  const base = (req: Request) => {
    const host = req.get('host') ?? '';
    return `http://${HOST.test(host) ? host : `127.0.0.1:${e.config.ports.onvif}`}`;
  };

  const authed = (req: Request, res: Response): boolean => {
    if (authenticate(String(req.body ?? ''), e.config.users)) return true;
    sendFault(res, 'ter:NotAuthorized', 'Sender not Authorized');
    return false;
  };

  app.post('/onvif/device_service', (req, res) => {
    const xml = String(req.body ?? '');
    const op = operation(xml);
    if (op === 'GetSystemDateAndTime') {
      const d = new Date();
      return send(res, `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>${localParts(e.clock, e.config.tz).dst}</tt:DaylightSavings><tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time><tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime></tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`);
    }
    if (!authed(req, res)) return;
    const b = esc(base(req));
    switch (op) {
      case 'GetDeviceInformation': {
        const d = devInfo(e.config.name, e.serial, e.config.firmVer);
        return send(res, `<tds:GetDeviceInformationResponse><tds:Manufacturer>Reolink</tds:Manufacturer><tds:Model>${esc(d.model)}</tds:Model><tds:FirmwareVersion>${esc(d.firmVer)}</tds:FirmwareVersion><tds:SerialNumber>${esc(d.serial)}</tds:SerialNumber><tds:HardwareId>${esc(d.hardVer)}</tds:HardwareId></tds:GetDeviceInformationResponse>`);
      }
      case 'GetCapabilities':
        return send(res, `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${b}/onvif/device_service</tt:XAddr></tt:Device><tt:Events><tt:XAddr>${b}/onvif/event_service</tt:XAddr><tt:WSSubscriptionPolicySupport>true</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport><tt:WSPausableSubscriptionManagerInterfaceSupport>false</tt:WSPausableSubscriptionManagerInterfaceSupport></tt:Events></tds:Capabilities></tds:GetCapabilitiesResponse>`);
      case 'GetServices': {
        const svc = (ns: string, path: string) => `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>${b}${path}</tds:XAddr><tds:Version><tt:Major>21</tt:Major><tt:Minor>6</tt:Minor></tds:Version></tds:Service>`;
        return send(res, `<tds:GetServicesResponse>${svc(NS.tds, '/onvif/device_service')}${svc(NS.tev, '/onvif/event_service')}</tds:GetServicesResponse>`);
      }
      default:
        return notSupported(res);
    }
  });

  app.post('/onvif/event_service', (req, res) => {
    if (!authed(req, res)) return;
    const xml = String(req.body ?? '');
    switch (operation(xml)) {
      case 'GetEventProperties':
        return send(res, EVENT_PROPERTIES);
      case 'CreatePullPointSubscription': {
        expire();
        if (subs.size >= MAX_SUBSCRIPTIONS) return sendFault(res, 'ter:MaxPullPointsReached', 'Too many subscriptions');
        const ttl = Math.min(durationMs(field(xml, 'InitialTerminationTime'), 60_000), MAX_TTL_MS);
        const idx = nextIdx++;
        const now = Date.now();
        subs.set(idx, { expiresAt: now + ttl, queue: TOPICS.map((t) => notification(t.topic, currentState(e, t.topic), 'Initialized')), wake: new Set() });
        return send(res, `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>${esc(base(req))}/onvif/PullSubManager?Idx=${idx}</wsa5:Address></tev:SubscriptionReference><wsnt:CurrentTime>${utc(now)}</wsnt:CurrentTime><wsnt:TerminationTime>${utc(now + ttl)}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`);
      }
      default:
        return notSupported(res);
    }
  });

  app.post('/onvif/PullSubManager', async (req, res) => {
    if (!authed(req, res)) return;
    expire();
    const raw = typeof req.query.Idx === 'string' ? req.query.Idx : '';
    const idx = /^\d{1,10}$/.test(raw) ? Number(raw) : NaN;
    const s = subs.get(idx);
    if (!s) return sendFault(res, 'ter:InvalidArgVal', 'Unknown or expired subscription');
    const xml = String(req.body ?? '');
    switch (operation(xml)) {
      case 'PullMessages': {
        const limit = Math.max(1, Math.min(1000, Number(field(xml, 'MessageLimit')) || 100));
        if (!s.queue.length) {
          const wait = Math.min(durationMs(field(xml, 'Timeout'), 5000), MAX_PULL_WAIT_MS);
          await new Promise<void>((resolve) => {
            const done = () => {
              clearTimeout(t);
              s.wake.delete(done);
              res.off('close', done);
              resolve();
            };
            const t = setTimeout(done, wait);
            s.wake.add(done);
            // The response's close (not the request's, which fires once the
            // body is read) means the client went away.
            res.on('close', done);
          });
          if (res.destroyed || res.writableEnded) return;
        }
        // Powered off, rebooting or ONVIF switched off while waiting: the
        // camera drops the connection.
        if (e.offline() || e.settings.running.NetPort.onvifEnable !== 1) return void req.socket.destroy();
        if (!subs.has(idx)) return sendFault(res, 'ter:InvalidArgVal', 'Unknown or expired subscription');
        const msgs = s.queue.splice(0, limit);
        return send(res, `<tev:PullMessagesResponse><tev:CurrentTime>${utc(Date.now())}</tev:CurrentTime><tev:TerminationTime>${utc(s.expiresAt)}</tev:TerminationTime>${msgs.join('')}</tev:PullMessagesResponse>`);
      }
      case 'Renew': {
        s.expiresAt = Date.now() + Math.min(durationMs(field(xml, 'TerminationTime'), 60_000), MAX_TTL_MS);
        return send(res, `<wsnt:RenewResponse><wsnt:TerminationTime>${utc(s.expiresAt)}</wsnt:TerminationTime><wsnt:CurrentTime>${utc(Date.now())}</wsnt:CurrentTime></wsnt:RenewResponse>`);
      }
      case 'Unsubscribe':
        end(idx, s);
        return send(res, '<wsnt:UnsubscribeResponse/>');
      default:
        return notSupported(res);
    }
  });

  return app;
}
