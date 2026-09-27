# Changelog

## Unreleased

- cam2 runs in the cluster (Plan 4): `cam2.skylar.technology` with a Let's
  Encrypt certificate pushed daily like cam1's, and cams shows it next to Den.
  The release workflow now deploys it (pinned by digest in kube-setup) before
  tagging.
- `scripts/sync-secrets.sh`: syncs `KUBE_SETUP_DEPLOY_TOKEN` (GitHub refuses
  `GITHUB_*` names), creates `cam2-camera-credentials`, and has `--gh-login`.

## v2026.09.26.3

- Control API actions `power-off` and `power-on`: the camera goes dark
  (connections drop, sessions end, the recording in progress closes, events
  are refused) until power-on boots it like a reboot. `state.power` reports
  `on`, `off` or `booting`.
- README: API reference for the simulated camera API and the control API.

## v2026.09.26.2

- Fixture clips are 12 s (players skip 10 s), built with fast presets under a
  cross-process lock; `ensureFixtures` and `defaultFixtureDir` are exported so
  test runners can build them once in a global setup.

## v2026.09.26.1

First release: the headless core (Plan 1).

- A simulated Reolink RLC-1224A (firmware v3.2.0.6011_2607012059) on HTTP and
  HTTPS: login and sessions, device info, settings with the firmware's
  whole-object write semantics, Search, Download, Snap and FLV live (H.264 sub,
  H.265 main with the legacy codec id 12), certificates, Reboot.
- The firmware's quirks are always on: the four token-rejection shapes, one
  Search and one Download at a time, raw Download source, text/html JSON
  replies, partial writes that reset omitted keys after a reboot.
- Faults to switch on: refused, dropped or slow downloads, FLV resets, failing
  or ignored settings, offline, latency, Snap errors; one-shot token revoke,
  reboot and connection drops.
- Control API (bearer token, SSE, openapi.yaml): events that create
  recordings, seeded recordings, faults, actions, reset, request log, state.
- Fixture media from ffmpeg test patterns; no camera footage anywhere.
- Container image (amd64, arm64), compose file for three cameras, in-process
  `createCamSim()` for tests, secrets sync script.
- cams' unit and e2e suites pass against cam-sim (checked in CI).
