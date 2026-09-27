import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { makeEngine } from './helpers';
import { createControlApp } from '../src/control-api/app';

// "METHOD /path/{param}" for every operation in openapi.yaml.
function documented(): string[] {
  const out: string[] = [];
  let path = '';
  for (const line of readFileSync(join(__dirname, '..', 'openapi.yaml'), 'utf8').split('\n')) {
    const p = /^  (\/\S*):\s*$/.exec(line);
    if (p) path = p[1];
    const m = /^    (get|put|post|delete|patch):\s*$/.exec(line);
    if (m && path) out.push(`${m[1].toUpperCase()} ${path}`);
  }
  return out.sort();
}

function registered(app: any): string[] {
  const out: string[] = [];
  const walk = (stack: any[], prefix: string) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${prefix}${layer.route.path.replace(/:(\w+)/g, '{$1}')}`);
      } else if (layer.handle?.stack) {
        // Two mounted routers: the session routes at /sim, the API at /sim/api.
        walk(layer.handle.stack, prefix + (layer.match('/sim/login') ? '/sim' : '/sim/api'));
      }
    }
  };
  walk(app.router.stack, '');
  return out.sort();
}

describe('openapi.yaml', () => {
  it('documents exactly the registered routes', async () => {
    const app = createControlApp(await makeEngine({ CAMSIM_CONTROL_TOKEN: 't' }));
    const routes = registered(app);
    expect(routes.length).toBeGreaterThan(15);
    expect(documented()).toEqual(routes);
  });
});
