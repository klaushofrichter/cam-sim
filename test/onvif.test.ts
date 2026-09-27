import { describe, it, expect, afterEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import request from 'supertest';
import { makeEngine } from './helpers';
import { createOnvifApp } from '../src/onvif/server';
import type { Engine } from '../src/engine/engine';

afterEach(() => vi.useRealTimers());

// A WS-UsernameToken PasswordDigest header, as ONVIF clients send it.
function security(user: string, password: string, created = new Date().toISOString().replace(/\.\d+Z$/, 'Z')): string {
  const nonce = randomBytes(16);
  const digest = createHash('sha1').update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(password)])).digest('base64');
  return `<wsse:Security xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd"><wsse:UsernameToken><wsse:Username>${user}</wsse:Username><wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</wsse:Password><wsse:Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-soap-message-security-1.0#Base64Binary">${nonce.toString('base64')}</wsse:Nonce><wsu:Created>${created}</wsu:Created></wsse:UsernameToken></wsse:Security>`;
}

const envelope = (body: string, header = '') =>
  `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"><s:Header>${header}</s:Header><s:Body>${body}</s:Body></s:Envelope>`;

async function soap(app: Parameters<typeof request>[0], path: string, body: string, auth: [string, string] | null = ['admin', 'admin-pw']) {
  const res = await request(app)
    .post(path)
    .set('Content-Type', 'application/soap+xml; charset=utf-8')
    .set('Host', 'cam2.local:8000')
    .send(envelope(body, auth ? security(...auth) : ''));
  return res;
}

async function setup(env: Record<string, string> = {}): Promise<{ engine: Engine; app: ReturnType<typeof createOnvifApp> }> {
  const engine = await makeEngine(env);
  return { engine, app: createOnvifApp(engine) };
}

const EV = '<CreatePullPointSubscription xmlns="http://www.onvif.org/ver10/events/wsdl"><InitialTerminationTime>PT60S</InitialTerminationTime></CreatePullPointSubscription>';
const pull = (limit = 20, timeout = 'PT1S') => `<PullMessages xmlns="http://www.onvif.org/ver10/events/wsdl"><Timeout>${timeout}</Timeout><MessageLimit>${limit}</MessageLimit></PullMessages>`;

async function subscribe(app: ReturnType<typeof createOnvifApp>): Promise<string> {
  const res = await soap(app, '/onvif/event_service', EV);
  expect(res.status).toBe(200);
  const addr = /<wsa5:Address>([^<]+)<\/wsa5:Address>/.exec(res.text)![1];
  expect(addr).toMatch(/^http:\/\/cam2\.local:8000\/onvif\/PullSubManager\?Idx=\d+$/);
  return addr.replace('http://cam2.local:8000', '');
}

const topics = (xml: string) => [...xml.matchAll(/<wsnt:Topic[^>]*>([^<]+)<\/wsnt:Topic>/g)].map((m) => m[1]);
const states = (xml: string) => [...xml.matchAll(/<wsnt:Topic[^>]*>tns1:[^<]*?([A-Za-z]+)<\/wsnt:Topic>.*?PropertyOperation="(\w+)".*?Name="(?:IsMotion|State)" Value="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}:${m[3]}`);

describe('ONVIF device service', () => {
  it('answers GetSystemDateAndTime without authentication', async () => {
    const { app } = await setup();
    const res = await soap(app, '/onvif/device_service', '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>', null);
    expect(res.status).toBe(200);
    expect(res.text).toContain('<tt:UTCDateTime>');
  });

  it('requires a valid UsernameToken for everything else', async () => {
    const { app } = await setup();
    for (const auth of [null, ['admin', 'wrong'] as [string, string], ['nobody', 'x'] as [string, string]]) {
      const res = await soap(app, '/onvif/device_service', '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>', auth);
      expect(res.status).toBe(400);
      expect(res.text).toContain('ter:NotAuthorized');
    }
  });

  it('rejects a stale Created time (replay)', async () => {
    const { app } = await setup();
    const res = await request(app).post('/onvif/device_service').set('Content-Type', 'application/soap+xml')
      .send(envelope('<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>', security('admin', 'admin-pw', '2020-01-01T00:00:00Z')));
    expect(res.status).toBe(400);
  });

  it("lists the camera's services with addresses on the requested host", async () => {
    const { app } = await setup();
    const caps = await soap(app, '/onvif/device_service', '<GetCapabilities xmlns="http://www.onvif.org/ver10/device/wsdl"><Category>All</Category></GetCapabilities>');
    expect(caps.text).toContain('<tt:XAddr>http://cam2.local:8000/onvif/event_service</tt:XAddr>');
    const info = await soap(app, '/onvif/device_service', '<GetDeviceInformation xmlns="http://www.onvif.org/ver10/device/wsdl"/>');
    expect(info.text).toMatch(/<tds:Model>RLC-1224A<\/tds:Model>/);
    expect(info.text).toMatch(/<tds:SerialNumber>SIM[0-9A-F]{12}<\/tds:SerialNumber>/);
    const services = await soap(app, '/onvif/device_service', '<GetServices xmlns="http://www.onvif.org/ver10/device/wsdl"><IncludeCapability>false</IncludeCapability></GetServices>');
    expect(services.text).toContain('http://www.onvif.org/ver10/events/wsdl');
  });

  it('answers an unknown operation with a SOAP fault', async () => {
    const { app } = await setup();
    const res = await soap(app, '/onvif/device_service', '<SetHostname xmlns="http://www.onvif.org/ver10/device/wsdl"><Name>x</Name></SetHostname>');
    expect(res.status).toBe(400);
    expect(res.text).toContain('ter:ActionNotSupported');
  });
});

describe('ONVIF events', () => {
  it("publishes the camera's topic set", async () => {
    const { app } = await setup();
    const res = await soap(app, '/onvif/event_service', '<GetEventProperties xmlns="http://www.onvif.org/ver10/events/wsdl"/>');
    for (const t of ['<tns1:RuleEngine', '<CellMotionDetector', 'Name="IsMotion"', '<MotionAlarm']) expect(res.text).toContain(t);
  });

  it('starts a subscription with Initialized messages for every topic', async () => {
    const { app } = await setup();
    const sub = await subscribe(app);
    const res = await soap(app, sub, pull());
    expect(topics(res.text).sort()).toEqual([
      'tns1:RuleEngine/CellMotionDetector/Motion', 'tns1:RuleEngine/MyRuleDetector/DogCatDetect', 'tns1:RuleEngine/MyRuleDetector/FaceDetect',
      'tns1:RuleEngine/MyRuleDetector/Non_Motor_VehicleDetect', 'tns1:RuleEngine/MyRuleDetector/Package', 'tns1:RuleEngine/MyRuleDetector/PeopleDetect',
      'tns1:RuleEngine/MyRuleDetector/VehicleDetect', 'tns1:RuleEngine/MyRuleDetector/Visitor', 'tns1:VideoSource/MotionAlarm',
    ]);
    expect(res.text).toContain('PropertyOperation="Initialized"');
  });

  it('delivers a person event as Changed messages, on and then off', async () => {
    const { app, engine } = await setup();
    const sub = await subscribe(app);
    await soap(app, sub, pull()); // drain Initialized
    engine.events.trigger('person', 1);
    const on = await soap(app, sub, pull());
    expect(states(on.text).sort()).toEqual(['Motion:Changed:true', 'MotionAlarm:Changed:true', 'PeopleDetect:Changed:true']);
    await new Promise((r) => setTimeout(r, 1100));
    const off = await soap(app, sub, pull());
    expect(states(off.text).sort()).toEqual(['Motion:Changed:false', 'MotionAlarm:Changed:false', 'PeopleDetect:Changed:false']);
    engine.stop();
  });

  it('PullMessages waits for an event up to its timeout', async () => {
    const { app, engine } = await setup();
    const sub = await subscribe(app);
    await soap(app, sub, pull());
    const t0 = Date.now();
    const waiting = soap(app, sub, pull(20, 'PT5S'));
    setTimeout(() => engine.events.trigger('vehicle', 1), 200);
    const res = await waiting;
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(states(res.text)).toContain('VehicleDetect:Changed:true');
    const empty = Date.now();
    await soap(app, sub, pull(20, 'PT1S'));
    expect(Date.now() - empty).toBeGreaterThanOrEqual(900);
    engine.stop();
  });

  it('honours MessageLimit, Renew and Unsubscribe', async () => {
    const { app } = await setup();
    const sub = await subscribe(app);
    expect(topics((await soap(app, sub, pull(4))).text)).toHaveLength(4);
    expect(topics((await soap(app, sub, pull(20))).text)).toHaveLength(5);
    const renew = await soap(app, sub, '<Renew xmlns="http://docs.oasis-open.org/wsn/b-2"><TerminationTime>PT120S</TerminationTime></Renew>');
    expect(renew.text).toContain('<wsnt:TerminationTime>');
    expect((await soap(app, sub, '<Unsubscribe xmlns="http://docs.oasis-open.org/wsn/b-2"/>')).status).toBe(200);
    const gone = await soap(app, sub, pull());
    expect(gone.status).toBe(400);
  });

  it('expires subscriptions that are not renewed', async () => {
    const { app } = await setup();
    const res = await soap(app, '/onvif/event_service', EV.replace('PT60S', 'PT1S'));
    const sub = /<wsa5:Address>([^<]+)</.exec(res.text)![1].replace('http://cam2.local:8000', '');
    await new Promise((r) => setTimeout(r, 1200));
    expect((await soap(app, sub, pull())).status).toBe(400);
  });

  it('follows the ONVIF switch and offline', async () => {
    const { app, engine } = await setup();
    engine.settings.running.NetPort.onvifEnable = 0;
    await expect(soap(app, '/onvif/device_service', '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>', null)).rejects.toThrow();
    engine.settings.running.NetPort.onvifEnable = 1;
    engine.faults.set({ name: 'offline' });
    await expect(soap(app, '/onvif/device_service', '<GetSystemDateAndTime xmlns="http://www.onvif.org/ver10/device/wsdl"/>', null)).rejects.toThrow();
  });
});
