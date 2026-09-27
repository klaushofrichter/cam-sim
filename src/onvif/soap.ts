import { createHash, timingSafeEqual } from 'crypto';
import { safeEqual } from '../util/safe-equal';
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

// A small linear scanner instead of regular expressions: request bodies are
// untrusted, and backtracking regexes over them can stall the event loop.
interface Element {
  local: string; // name without prefix
  attrs: string; // raw attribute text of the start tag
  textStart: number; // index after the start tag's '>'
  selfClosing: boolean;
}

const NAME = /[A-Za-z0-9_.-]/;

// Start tags in document order (skipping end tags, comments, PIs, CDATA).
function* elements(xml: string): Generator<Element> {
  let i = 0;
  for (;;) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) return;
    const next = xml[lt + 1];
    if (next === '/' || next === '?' || next === '!') {
      const close = next === '!' && xml.startsWith('<!--', lt) ? xml.indexOf('-->', lt + 4) : next === '!' && xml.startsWith('<![CDATA[', lt) ? xml.indexOf(']]>', lt + 9) : xml.indexOf('>', lt + 1);
      if (close < 0) return;
      i = close + 1;
      continue;
    }
    let j = lt + 1;
    while (j < xml.length && (NAME.test(xml[j]) || xml[j] === ':')) j++;
    const qname = xml.slice(lt + 1, j);
    const gt = xml.indexOf('>', j);
    if (!qname || gt < 0) return;
    const selfClosing = xml[gt - 1] === '/';
    yield { local: qname.slice(qname.lastIndexOf(':') + 1), attrs: xml.slice(j, selfClosing ? gt - 1 : gt), textStart: gt + 1, selfClosing };
    i = gt + 1;
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== '#') return ENTITIES[e];
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function find(xml: string, name: string): Element | undefined {
  for (const el of elements(xml)) if (el.local === name) return el;
  return undefined;
}

function textOf(xml: string, el: Element): string {
  if (el.selfClosing) return '';
  const end = xml.indexOf('<', el.textStart);
  return decode(xml.slice(el.textStart, end < 0 ? xml.length : end)).trim();
}

// The first element in the SOAP Body: the operation's local name.
export function operation(xml: string): string | undefined {
  let inBody = false;
  for (const el of elements(xml)) {
    if (inBody) return el.local;
    if (el.local === 'Body') inBody = true;
  }
  return undefined;
}

// The text of the first element with this local name.
export function field(xml: string, name: string): string | undefined {
  const el = find(xml, name);
  return el ? textOf(xml, el) : undefined;
}

function attr(attrs: string, name: string): string | undefined {
  for (const m of attrs.matchAll(/([A-Za-z0-9_.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    if (m[1].slice(m[1].lastIndexOf(':') + 1) === name) return decode(m[2] ?? m[3] ?? '');
  }
  return undefined;
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
  const el = find(xml, 'Password');
  const user = users.find((u) => u.name === name);
  if (!user || !el) return undefined;
  const pw = textOf(xml, el);
  const digestType = (attr(el.attrs, 'Type') ?? '').endsWith('#PasswordDigest');
  const created = field(xml, 'Created');
  if (digestType) {
    const nonce = field(xml, 'Nonce');
    if (!nonce || !created) return undefined;
    const t = Date.parse(created);
    if (Number.isNaN(t) || Math.abs(now - t) > MAX_SKEW_MS) return undefined;
    const want = createHash('sha1').update(Buffer.concat([Buffer.from(nonce, 'base64'), Buffer.from(created), Buffer.from(user.password)])).digest();
    const got = Buffer.from(pw, 'base64');
    return got.length === want.length && timingSafeEqual(got, want) ? user : undefined;
  }
  return safeEqual(pw, user.password) ? user : undefined;
}
