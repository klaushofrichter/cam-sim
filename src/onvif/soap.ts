import { createHash, timingSafeEqual } from 'crypto';
import type { User } from '../config';

// Namespaces as the RLC-1224A declares them on its ONVIF envelopes (the ones
// its bodies use; captured 2026-09-27).
export const NS = {
  env: 'http://www.w3.org/2003/05/soap-envelope',
  tt: 'http://www.onvif.org/ver10/schema',
  tds: 'http://www.onvif.org/ver10/device/wsdl',
  tev: 'http://www.onvif.org/ver10/events/wsdl',
  wsnt: 'http://docs.oasis-open.org/wsn/b-2',
  wstop: 'http://docs.oasis-open.org/wsn/t-1',
  tns1: 'http://www.onvif.org/ver10/topics',
  wsa5: 'http://www.w3.org/2005/08/addressing',
  ter: 'http://www.onvif.org/ver10/error',
};

const XMLNS = Object.entries({ 'SOAP-ENV': NS.env, tt: NS.tt, tds: NS.tds, tev: NS.tev, wsnt: NS.wsnt, wstop: NS.wstop, tns1: NS.tns1, wsa5: NS.wsa5, ter: NS.ter })
  .map(([p, u]) => `xmlns:${p}="${u}"`)
  .join(' ');

export const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);

export function envelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<SOAP-ENV:Envelope ${XMLNS}><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

export function fault(subcode: string, reason: string): string {
  return envelope(
    `<SOAP-ENV:Fault><SOAP-ENV:Code><SOAP-ENV:Value>SOAP-ENV:Sender</SOAP-ENV:Value><SOAP-ENV:Subcode><SOAP-ENV:Value>${subcode}</SOAP-ENV:Value></SOAP-ENV:Subcode></SOAP-ENV:Code><SOAP-ENV:Reason><SOAP-ENV:Text xml:lang="en">${esc(reason)}</SOAP-ENV:Text></SOAP-ENV:Reason></SOAP-ENV:Fault>`,
  );
}

// The first element in the SOAP Body: the operation's local name.
export function operation(xml: string): string | undefined {
  const body = /<(?:[\w-]+:)?Body[^>]*>\s*<(?:[\w-]+:)?([A-Za-z]+)[\s/>]/.exec(xml);
  return body?.[1];
}

// The text of the first element with this local name.
export function field(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([^<]*)</(?:[\\w-]+:)?${name}>`).exec(xml);
  return m?.[1].trim();
}

// "PT60S", "PT1M30S", "PT2H" → ms. An absolute xsd:dateTime → ms from now.
export function durationMs(v: string | undefined, fallback: number): number {
  if (!v) return fallback;
  const m = /^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)$/.exec(v);
  if (m) return ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
  const t = Date.parse(v);
  return Number.isNaN(t) ? fallback : Math.max(0, t - Date.now());
}

const MAX_SKEW_MS = 5 * 60_000;

// WS-UsernameToken: PasswordDigest = base64(sha1(nonce + created + password)),
// or PasswordText. Created must be within 5 minutes (replay protection).
export function authenticate(xml: string, users: User[], now = Date.now()): User | undefined {
  const name = field(xml, 'Username');
  const pw = /<(?:[\w-]+:)?Password(?:\s+Type="([^"]*)")?[^>]*>([^<]*)</.exec(xml);
  const user = users.find((u) => u.name === name);
  if (!user || !pw) return undefined;
  const digestType = (pw[1] ?? '').endsWith('#PasswordDigest');
  const created = field(xml, 'Created');
  if (digestType) {
    const nonce = field(xml, 'Nonce');
    if (!nonce || !created) return undefined;
    const t = Date.parse(created);
    if (Number.isNaN(t) || Math.abs(now - t) > MAX_SKEW_MS) return undefined;
    const want = createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(user.password)])).digest();
    const got = Buffer.from(pw[2], 'base64');
    return got.length === want.length && timingSafeEqual(got, want) ? user : undefined;
  }
  const a = createHash('sha256').update(pw[2]).digest();
  const b = createHash('sha256').update(user.password).digest();
  return timingSafeEqual(a, b) ? user : undefined;
}
