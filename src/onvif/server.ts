import express, { type Request, type Response } from 'express';
import type { Engine } from '../engine/engine';
import { devInfo } from '../profile/rlc1224a';
import { localParts } from '../engine/clock';
import { envelope, fault, operation, field, durationMs, authenticate, esc, NS } from './soap';
import { TOPICS, topicsFor, notification, currentState, EVENT_PROPERTIES } from './events';

const MAX_SUBSCRIPTIONS = 16;
const MAX_PULL_WAIT_MS = 60_000;
const utc = (ms: number) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');

interface Subscription {
  expiresAt: number;
  queue: string[];
  wake: Array<() => void>;
}

// The camera's ONVIF service on its ONVIF port (8000): the device and event
// services a gateway uses for events. Media and PTZ are out of scope.
export function createOnvifApp(engine: Engine): express.Express {
  const e = engine;
  const app = express();
  app.disable('x-powered-by');
  const subs = new Map<number, Subscription>();
  let nextIdx = 1000 + Math.floor(e.rng.next() * 1_000_000);

  const expire = () => {
    const now = Date.now();
    for (const [idx, s] of subs) if (s.expiresAt <= now) {
      subs.delete(idx);
      for (const w of s.wake.splice(0)) w();
    }
  };
  const sweeper = setInterval(expire, 5000);
  sweeper.unref();

  // Detection changes become Changed notifications in every subscription.
  e.events.on('detect', ({ type, state }: { type: 'motion' | 'person' | 'vehicle' | 'pet'; state: boolean }) => {
    const msgs = topicsFor(type).map((t) => notification(t, state, 'Changed'));
    for (const s of subs.values()) {
      s.queue.push(...msgs);
      for (const w of s.wake.splice(0)) w();
    }
  });

  // A camera that is off, offline or has ONVIF switched off drops the connection.
  app.use((req, _res, next) => (e.offline() || e.settings.running.NetPort.onvifEnable !== 1 ? req.socket.destroy() : next()));
  app.use(express.text({ type: () => true, limit: '64kb' }));

  const send = (res: Response, body: string) => res.status(200).type('application/soap+xml; charset=utf-8').send(envelope(body));
  const sendFault = (res: Response, sub: string, reason: string) => res.status(400).type('application/soap+xml; charset=utf-8').send(fault(sub, reason));
  const base = (req: Request) => `http://${req.get('host') ?? `127.0.0.1:${e.config.ports.onvif}`}`;

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
    const b = base(req);
    switch (op) {
      case 'GetDeviceInformation': {
        const d = devInfo(e.config.name, e.serial, e.config.firmVer);
        return send(res, `<tds:GetDeviceInformationResponse><tds:Manufacturer>Reolink</tds:Manufacturer><tds:Model>${esc(d.model)}</tds:Model><tds:FirmwareVersion>${esc(d.firmVer)}</tds:FirmwareVersion><tds:SerialNumber>${esc(d.serial)}</tds:SerialNumber><tds:HardwareId>${esc(d.hardVer)}</tds:HardwareId></tds:GetDeviceInformationResponse>`);
      }
      case 'GetCapabilities':
        return send(res, `<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Device><tt:XAddr>${b}/onvif/device_service</tt:XAddr></tt:Device><tt:Events><tt:XAddr>${b}/onvif/event_service</tt:XAddr><tt:WSSubscriptionPolicySupport>false</tt:WSSubscriptionPolicySupport><tt:WSPullPointSupport>true</tt:WSPullPointSupport><tt:WSPausableSubscriptionManagerInterfaceSupport>false</tt:WSPausableSubscriptionManagerInterfaceSupport></tt:Events></tds:Capabilities></tds:GetCapabilitiesResponse>`);
      case 'GetServices': {
        const svc = (ns: string, path: string) => `<tds:Service><tds:Namespace>${ns}</tds:Namespace><tds:XAddr>${b}${path}</tds:XAddr><tds:Version><tt:Major>2</tt:Major><tt:Minor>0</tt:Minor></tds:Version></tds:Service>`;
        return send(res, `<tds:GetServicesResponse>${svc(NS.tds, '/onvif/device_service')}${svc(NS.tev, '/onvif/event_service')}</tds:GetServicesResponse>`);
      }
      default:
        return sendFault(res, 'ter:ActionNotSupported', 'Optional Action Not Implemented');
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
        const ttl = Math.min(durationMs(field(xml, 'InitialTerminationTime'), 60_000), 24 * 3600_000);
        const idx = nextIdx++;
        const now = Date.now();
        subs.set(idx, { expiresAt: now + ttl, queue: TOPICS.map((t) => notification(t.topic, currentState(e, t.topic), 'Initialized')), wake: [] });
        return send(res, `<tev:CreatePullPointSubscriptionResponse><tev:SubscriptionReference><wsa5:Address>${base(req)}/onvif/PullSubManager?Idx=${idx}</wsa5:Address></tev:SubscriptionReference><wsnt:CurrentTime>${utc(now)}</wsnt:CurrentTime><wsnt:TerminationTime>${utc(now + ttl)}</wsnt:TerminationTime></tev:CreatePullPointSubscriptionResponse>`);
      }
      default:
        return sendFault(res, 'ter:ActionNotSupported', 'Optional Action Not Implemented');
    }
  });

  app.post('/onvif/PullSubManager', async (req, res) => {
    if (!authed(req, res)) return;
    expire();
    const s = subs.get(Number(req.query.Idx));
    if (!s) return sendFault(res, 'ter:InvalidArgVal', 'Unknown or expired subscription');
    const xml = String(req.body ?? '');
    const idx = Number(req.query.Idx);
    switch (operation(xml)) {
      case 'PullMessages': {
        const limit = Math.max(1, Math.min(1000, Number(field(xml, 'MessageLimit')) || 100));
        if (!s.queue.length) {
          const wait = Math.min(durationMs(field(xml, 'Timeout'), 5000), MAX_PULL_WAIT_MS);
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, wait);
            s.wake.push(() => {
              clearTimeout(t);
              resolve();
            });
            req.on('close', () => clearTimeout(t));
          });
        }
        if (!subs.has(idx)) return sendFault(res, 'ter:InvalidArgVal', 'Unknown or expired subscription');
        const msgs = s.queue.splice(0, limit);
        return send(res, `<tev:PullMessagesResponse><tev:CurrentTime>${utc(Date.now())}</tev:CurrentTime><tev:TerminationTime>${utc(s.expiresAt)}</tev:TerminationTime>${msgs.join('')}</tev:PullMessagesResponse>`);
      }
      case 'Renew': {
        s.expiresAt = Date.now() + Math.min(durationMs(field(xml, 'TerminationTime'), 60_000), 24 * 3600_000);
        return send(res, `<wsnt:RenewResponse><wsnt:TerminationTime>${utc(s.expiresAt)}</wsnt:TerminationTime><wsnt:CurrentTime>${utc(Date.now())}</wsnt:CurrentTime></wsnt:RenewResponse>`);
      }
      case 'Unsubscribe':
        subs.delete(idx);
        for (const w of s.wake.splice(0)) w();
        return send(res, '<wsnt:UnsubscribeResponse/>');
      default:
        return sendFault(res, 'ter:ActionNotSupported', 'Optional Action Not Implemented');
    }
  });

  return app;
}
