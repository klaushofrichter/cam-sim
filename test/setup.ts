// Every test server listens on 127.0.0.1, not on all addresses (issue #57: the
// intermittent, unrelated 401/403/404/empty reply in a different test each run).
// supertest starts each app with listen(0), which binds all addresses, and then
// connects to 127.0.0.1. On macOS a listener on 127.0.0.1 can share a port with
// one on all addresses and wins every 127.0.0.1 connection to it, so a request
// can reach another test's server (a simulator started by cli.test.ts, a probed
// port bound a moment later, MediaMTX): a login answered by another app's limiter
// (401, not 429), a 404 from an app without the route, an empty reply. A port
// bound to 127.0.0.1 itself can't be shared that way.
// listen(port[, backlog][, cb]) without a host binds at once, as before, through
// the step Node's own listen() ends in (_listen2). A host can't simply be added
// to each call: with a host, listen() resolves it via dns.lookup and binds a tick
// later, but supertest's implicit listen(0) reads address() at once. _listen2
// exists on Node 24 and 26. Calls that name a host or a path are unchanged.
// Patched once per worker (this setup file runs per test file).
import net from 'net';

type Listen2 = (address: string, port: number, addressType: number, backlog: number) => void;
const PATCHED = Symbol.for('camsim.test.listenOnLoopback');
const proto = net.Server.prototype as net.Server & { [PATCHED]?: true; _listen2?: Listen2 };
if (!proto[PATCHED]) {
  const listen = proto.listen;
  const listen2 = proto._listen2;
  if (typeof listen2 !== 'function') throw new Error('test/setup.ts: net.Server#_listen2 is gone; bind test servers to 127.0.0.1 another way');
  proto.listen = function (this: net.Server, ...args: unknown[]) {
    const [port, ...rest] = args;
    if (typeof port !== 'number' || !rest.every((a) => typeof a === 'function' || typeof a === 'number')) return listen.apply(this, args as Parameters<typeof listen>);
    if (this.listening) throw new Error('already listening');
    const cb = rest.find((a) => typeof a === 'function') as (() => void) | undefined;
    if (cb) this.once('listening', cb);
    listen2.call(this, '127.0.0.1', port, 4, (rest.find((a) => typeof a === 'number') as number | undefined) ?? 511);
    return this;
  } as typeof listen;
  proto[PATCHED] = true;
}
