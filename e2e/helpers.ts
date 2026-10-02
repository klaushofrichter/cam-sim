import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { TOKEN, CAM_PORT, CAM_USER, CAM_PASSWORD } from './env';

// The session comes from storageState (auth.setup.ts); this opens the app and
// checks it is signed in. login.spec.ts signs in through the form itself.
export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('shell')).toBeVisible();
}

// The camera API on the simulator's HTTP port, as a camera client would use it.
export async function camLogin(request: APIRequestContext): Promise<string> {
  const r = await request.post(`http://127.0.0.1:${CAM_PORT}/cgi-bin/api.cgi?cmd=Login`, {
    data: [{ cmd: 'Login', action: 0, param: { User: { userName: CAM_USER, password: CAM_PASSWORD } } }],
  });
  return (await r.json())[0].value.Token.name;
}

export async function camCmd(request: APIRequestContext, token: string, cmd: string, param: unknown = {}) {
  const r = await request.post(`http://127.0.0.1:${CAM_PORT}/cgi-bin/api.cgi?cmd=${cmd}&token=${token}`, { data: [{ cmd, action: 0, param }] });
  return (await r.json())[0];
}

// Back to a known state through the control API (bearer), between specs.
export async function resetSim(request: APIRequestContext): Promise<void> {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  const state = await (await request.get(`http://127.0.0.1:19443/sim/api/state`, { headers })).json();
  if (state.power === 'off') await request.post('http://127.0.0.1:19443/sim/api/actions/power-on', { headers, data: { ms: 10 } });
  await expect.poll(async () => (await (await request.get('http://127.0.0.1:19443/sim/api/state', { headers })).json()).power).toBe('on');
  await request.post('http://127.0.0.1:19443/sim/api/reset', { headers, data: { settings: true, faults: true } });
}
