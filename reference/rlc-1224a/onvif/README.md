# ONVIF capture (RLC-1224A, 2026-09-27)

Requests and replies of one read-only session against the real camera:
`GetServices`, `GetCapabilities`, `GetEventProperties`,
`CreatePullPointSubscription`, two `PullMessages` and `Unsubscribe`.

Redacted:

- the camera's address, replaced by `192.0.2.10` (a documentation address);
- each request's WS-Security `PasswordDigest` and `Nonce`, replaced by
  `REDACTED`, because together with `Created` they allow an offline guess of
  the camera password.

Everything else is as the camera sent it. `src/onvif/` follows these shapes.
