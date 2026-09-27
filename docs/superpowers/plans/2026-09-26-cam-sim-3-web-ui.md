# cam-sim Plan 3: Web UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a browser UI on the control port that shows the simulated camera the way a person would inspect a real one (live, playback, settings), plus a Simulator panel to trigger events, switch faults and power, and watch requests as they happen. It is protected by the control token and optional (`CAMSIM_WEB_UI=true`).

**Architecture:** a Svelte 5 single-page app (Vite, like cams) built to `dist/web` and served by the control app at `/`. It only talks to the control API. For that, the API accepts a session cookie besides the bearer token and gains media, recordings and settings routes. Writes made with the cookie need a custom header, so a cross-site form can't forge them.

**Tech Stack:** Svelte 5, Vite, mpegts.js (as cams), vitest with jsdom for components, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-09-26-cam-sim-design.md` §10 (Web UI), §9 (Control API), §13.3.

## Global Constraints

- Off by default. `CAMSIM_WEB_UI=true` serves the UI; the control token is required either way (no token = no control surface, UI included).
- **Login:** the user pastes the control token once. `POST /sim/login {token}` answers a signed session cookie:
  - `camsim_session`: HMAC-SHA256 with a per-process secret, 12 h;
  - `HttpOnly`, `SameSite=Strict`, `Path=/`, and `Secure` on TLS.

  The token is never stored in the browser. `POST /sim/logout` clears the cookie.
- **Cookie-authenticated writes** (POST, PUT, DELETE) also need the header `X-CamSim-UI: 1`, or they get 403 `{"error":"csrf"}`. Bearer-token requests are unchanged.
- **Separate from the camera surface:** the UI never uses the camera API, so browsing creates no camera sessions and changes no camera counters.
- **Look:** cams' theme tokens (dark and light, `prefers-color-scheme` plus an explicit toggle), cams' plain-English wording, and no external assets.
- **No media in git:** there are no screenshots or videos in the repo; e2e artifacts are not uploaded.

## Review Focus

1. A cross-site POST with the session cookie but no `X-CamSim-UI` header must not change anything. → Task 1 test.
2. A forged or expired `camsim_session` cookie, or a cookie from a restarted process, must get 401 and send the UI back to the login page. → Task 1 test, Task 3 e2e.
3. The token must appear neither in the page, local storage, URLs nor logs after login. → Task 3 e2e checks `localStorage`, `sessionStorage` and the URL.
4. A live view left open, or a stalled viewer, must not grow memory. The UI's FLV uses the same backpressure drop as the camera route. → Task 2 test.
5. A settings save through the UI must go through the same validation and whole-object semantics as the camera API. For example, `sensDef: 99` answers 400 with the camera's code, and nothing changes. → Task 2 test.

---

### Task 1: Session login, cookie auth, CSRF header

**Files:** `src/control-api/session.ts` (new), `src/control-api/app.ts`, `src/config.ts` (accept `CAMSIM_WEB_UI=true`), `test/control-session.test.ts`

- `createSessionSigner(secret?: Buffer)` → `{ issue(): string; verify(cookie: string): boolean }` with value `v1.<expiresMs>.<hmac>`.
- `POST /sim/login` (JSON `{token}`; constant-time compare; 204 plus `Set-Cookie`, or 401), `POST /sim/logout` (204, cookie cleared), `GET /sim/session` → `{ loggedIn: boolean }`.
- The `/sim/api` auth middleware accepts bearer **or** a valid cookie. With the cookie, non-GET needs `X-CamSim-UI: 1` (403 `csrf` otherwise). The `?token=` refusal stays.
- **Tests:** login with the right and wrong token; cookie flags; state readable with the cookie; a PUT fault with the cookie but no header → 403, and the fault list stays empty; with the header → 200; a forged, tampered or expired cookie → 401; logout; a token in the URL is still refused; without a control token the login is 404.

### Task 2: Control API routes for the UI

**Files:** `src/control-api/app.ts`, `src/camera-api/media-routes.ts` (factor the FLV pump into `streamFlv(engine, res, stream, { count: boolean })`), `openapi.yaml`, `test/control-ui-routes.test.ts`

- `GET /sim/api/media/snapshot` → `image/jpeg`.
- `GET /sim/api/media/live/:stream(sub|main)` → endless `video/x-flv`. It isn't counted in the camera counters, and it has the same backpressure drop.
- `GET /sim/api/recordings?date=YYYY-MM-DD` → the list for that day: `{id, date, start, end, mainEnd, triggers, files}`.
- `GET /sim/api/recordings/days?year&mon` → the days with recordings (the `status` table).
- `GET /sim/api/recordings/:id/:stream(sub|main)` → `video/mp4` with Content-Length, full speed, and `Content-Disposition: attachment` when `?download=1`.
- `GET /sim/api/settings` → the running settings plus `devInfo`, `hddInfo`, `enc` and `certificate: {source, enable}`.
- `PUT /sim/api/settings/:key` (`Rec`, `MdAlarm`, `Isp`, `IrLights`, `WhiteLed`, `Osd`, `NetPort`, `Ftp`) and `PUT /sim/api/settings/AiAlarm/:type`:
  - the body is the **whole object**, applied through `SettingsStore.set` as a whole-object write, so the running and saved values are equal;
  - invalid values → 400 `{error:'invalid', rspCode}`.
- `GET /sim/api/users` → `[{userName, level}]` (no passwords).
- **Tests:** each route with the bearer token; the snapshot is a JPEG; live has the FLV magic, doesn't change `streamsOpened`, and drops a stalled reader; the recordings list after an event; the day table; mp4 `ftypmp42` and Content-Length; a settings round trip; `sensDef 99` → 400 with `rspCode -56` and nothing changed; `openapi.test` stays green.

### Task 3: Web app scaffold, login, shell, e2e harness

**Files:** `web/` (`index.html`, `vite.config.mts`, `src/main.ts`, `src/App.svelte`, `src/lib/api.ts`, `src/lib/router.ts`, `src/styles/theme.css` from cams, `src/components/{Icon,ThemeToggle,Sidebar,TopBar}.svelte`), `src/control-api/app.ts` (static serving and SPA fallback when `webUi`), `package.json` (scripts `build:web`, `dev:web`, `check`, `test:e2e`; devDependencies `svelte`, `@sveltejs/vite-plugin-svelte`, `vite`, `mpegts.js`, `@playwright/test`, `jsdom`), `vitest.config.mts` (a components project), `playwright.config.ts`, `e2e/login.spec.ts`

- `api.ts`:
  - `fetch` with `credentials: 'same-origin'`, adding `X-CamSim-UI: 1` on writes;
  - a 401 sets the `loggedIn` store to false, which shows the login page.
- Login page: one password-type field ("Control token"), submit, and an error message. Nothing is kept after submit.
- Shell:
  - a top bar with the camera name, power state and theme toggle;
  - a sidebar: Live, Playback, Settings, Simulator;
  - a hash router.
- Serving: `express.static(dist/web)` for `/assets` etc., and `index.html` for `/` and unknown non-API GETs. `Cache-Control: no-store` on `index.html`.
- **e2e** (the Playwright `webServer` runs `node dist/src/cli.js` with `CAMSIM_WEB_UI=true` and a test token):
  - a wrong token shows an error, the right one shows the shell;
  - after a reload the session is still there;
  - `localStorage`, `sessionStorage` and the URL don't contain the token;
  - logout goes back to the login page;
  - a tampered cookie goes back to the login page.
- CI: an `e2e` job in `pr-checks.yml` (Chrome, like cams). There are no artifact uploads.

### Task 4: Live and Playback pages

**Files:** `web/src/pages/Live.svelte`, `web/src/pages/Playback.svelte`, `web/src/lib/mpegtsPlayer.ts` (from cams), `web/src/components/TriggerBar.svelte`, e2e `live.spec.ts`, `playback.spec.ts`

- **Live:**
  - sub/main switch (main shows "needs a browser with HEVC in MSE" when unsupported);
  - an mpegts.js player on `/sim/api/media/live/:stream`;
  - a snapshot button that downloads the JPEG;
  - a trigger bar: motion, person, vehicle, pet, with a duration of 5/15/30/60 s, which posts `/sim/api/events` and shows the answer (the recording it started, or "not recorded: recording off / not scheduled").
- **Playback:**
  - a month day-picker from `/recordings/days`;
  - the day's recordings with times and trigger chips, updating from SSE `event` messages;
  - selecting one plays the sub copy in `<video>`, with main as an option;
  - a download link for each copy.
- **e2e:**
  - live reaches "playing" (`video.readyState ≥ 2`, `currentTime` advancing);
  - a person trigger → Playback lists a new recording with the person chip;
  - the clip plays;
  - the download link answers mp4.

### Task 5: Settings page

**Files:** `web/src/pages/Settings.svelte`, `web/src/components/SettingsCard.svelte`, e2e `settings.spec.ts`

- Cards, each saving its whole object through `PUT /sim/api/settings/...`, with a per-card save state and error text:
  - **Recording:** on/off, and on/off per trigger type from the schedule tables (a mixed schedule shows as "custom" and is kept unless changed);
  - **Detection:** motion sensitivity shown as 1–50 (`51 − sensDef`, as cams does), and AI sensitivity per type;
  - **Image and lights:** day/night, IR, spotlight mode and brightness;
  - **On-screen text:** name and positions;
  - **Network:** HTTP, HTTPS and RTMP switches, with a warning that HTTPS off cuts the camera API;
  - **Storage:** capacity and free space;
  - **Device:** model, firmware, serial;
  - **Certificate:** source and enabled;
  - **Users:** read-only list.
- **e2e:** changing day/night to Colour and saving shows it; the camera API's `GetIsp` then reports `Color` with `rotation` unchanged (a whole-object write); an invalid OSD name (32 bytes) shows the error and nothing changes.

### Task 6: Simulator page

**Files:** `web/src/pages/Simulator.svelte`, `web/src/components/{FaultList,EventLog,PowerPanel}.svelte`, e2e `simulator.spec.ts`

- **Power:**
  - the state (on, off, booting, rebooting);
  - Power off, Power on and Reboot buttons, with a boot time for power-on and reboot. Power-off asks for confirmation;
  - the state updates from SSE.
- **Events:** the same trigger bar as Live, plus the auto-events setting shown read-only.
- **Faults:** every fault from `FAULT_NAMES`, with a switch, its parameter fields (`ms`, `count`, `cmds`, `rspCode`), current status, and "clear all".
- **Actions:** revoke sessions, drop live streams, drop downloads.
- **Video:** "Test pattern" is shown as the only choice, with the note "The video library arrives with Plan 2".
- **Reset:** buttons for settings, recordings, counters, faults, and "everything" (with a confirmation).
- **Log:** a live table of camera requests and events from `/sim/api/stream`: time, port, command, status. It keeps the last 200 and has a pause button.
- **Counters:** the counters from `/sim/api/state`, refreshed by SSE.
- **e2e:**
  - switching on `snap.fail` makes the camera API's Snap answer 500, and switching it off restores 200;
  - power off → the state shows off, and the camera port refuses; power on → back on;
  - a camera API Login shows up in the log.

### Task 7: Packaging, docs, deploy

**Files:** `Dockerfile` (build and copy `dist/web`), `package.json` `files` (+ `dist/web`), `compose.yaml` (`CAMSIM_WEB_UI: "true"`), `README.md` (a "Web UI" section), `CHANGELOG.md`, `scripts/cam-ui.sh` (already opens the UI when `/` answers 200), spec §10 "done"

- Container smoke test: `GET /` with the web UI on → 200 HTML; off → 404.
- Ask kube-setup to add `CAMSIM_WEB_UI=true` to cam2's Deployment.
- Release; `scripts/cam-ui.sh` opens cam2's UI through the port-forward.
- cams' link for cam2 stays the note until cam2 has a home-network address (decided with kube-setup later).
