# cam-sim

Reolink RLC-1224A simulator: the camera's HTTP API, FLV, RTSP, ONVIF events and FTP upload, plus a control API (`/sim/api/*`) and web UI. It is cams' and cam-proxy's test camera (a release tarball in their package.json) and runs as `cam2` in the cluster. Spec: `docs/superpowers/specs/2026-09-26-cam-sim-design.md`. Plans: `docs/superpowers/plans/`.

## Commands

- `npm test`: vitest (needs ffmpeg for the fixtures; the RTSP tests need MediaMTX, `scripts/install-mediamtx.sh`, and skip without it).
- `npm run build`: tsc plus the web UI (vite). `npm run lint:types` and `npm run check` are the type checks for tests and `web/`.
- `npm run test:e2e`: Playwright for the web UI.
- `scripts/container-smoke.sh`: builds and smoke-tests the image.
- `npm run dev` / `npm run dev:web`: local simulator and Vite dev server.

## Branches and releases

- Work on a feature branch, PR to `main` (required checks `test`, `codeql`). `main` builds `:main` only and is never deployed.
- To release: PR `main` -> `production`, then merge. The release job pins the image digest in kube-setup, deploys `cam2` through `cam-sim-runner`, checks `/healthz`, then tags `vYYYY.MM.DD.N`. Never store a version in the sources.
- After a release, cams and cam-proxy need a PR that bumps their cam-sim tarball. `cams-compat` CI runs cams' suites against this build; nothing does that for cam-proxy.
- Put user-visible changes under `## Unreleased` in CHANGELOG.md.

## Rules that are easy to break

- Behave like the real camera, not like the Reolink docs. Measured behaviour is in the cams repo (`docs/reolink-api.md`) and the Obsidian note *Cameras/Reolink API Behaviour*. When the real camera differs from cam-sim, file an issue here.
- Faults (`src/engine/faults.ts`) are part of the contract with cams' and cam-proxy's tests. Changing what a fault does needs the README fault table, the Simulator page label and the CHANGELOG updated together.
- No camera footage in the repo or in releases: test media is generated. Don't upload clips or media to GitHub before Klaus has reviewed them.
- Never source `.env` in a shell (values can contain shell syntax); `scripts/sync-secrets.sh` reads it. Never print secrets or tokens.
- Cluster manifests live in kube-setup (`manifests/cam-sim/`). Ask the kube-setup session for changes; don't edit that repo from here.
- `.superpowers/` is gitignored scratch space and none of it is committed.
