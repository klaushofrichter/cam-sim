# cam-sim

A container that behaves like a Reolink **RLC-1224A** camera (firmware
v3.2.0.6011_2607012059): its HTTP API, its quirks, and the failures we have
seen on the real device. It is for testing software written against the
camera, such as [cams](https://github.com/klaushofrichter/cams) and the
planned camera gateway, in CI and with several simulated cameras at once.
A bearer-token control API selects what the camera plays, triggers events and
switches faults on and off.

**Status:** Plan 1 (headless core) in progress. See the
[design spec](docs/superpowers/specs/2026-09-26-cam-sim-design.md).
