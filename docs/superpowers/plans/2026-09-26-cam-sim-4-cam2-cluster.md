# cam-sim Plan 4: cam2 in the cluster

**Goal:** a permanent simulated camera `cam2.skylar.technology` in the k3s
cluster, with a valid Let's Encrypt certificate pushed the way cam1's is, and
cams showing it as a second camera next to Den.

**Spec:** `docs/superpowers/specs/2026-09-26-cam-sim-design.md` §14.3.

**Ownership:** kube-setup owns every manifest (namespace, workloads,
certificates, CronJobs, runner, monitoring). This repo owns the image, the
deploy workflow and the secrets script. cams owns its camera list.

## Decisions

- One Deployment `cam2` (1 replica, `Recreate`), image
  `ghcr.io/klaushofrichter/cam-sim`, non-root (uid/gid 1000, `fsGroup: 1000`),
  PVC `cam2-data` (1 Gi) on `/data`.
- Environment:
  - `CAMSIM_NAME=cam2`, `CAMSIM_TZ=America/Chicago`;
  - `CAMSIM_SPEED=real`, so cams sees the camera's timings;
  - `CAMSIM_SEED_CLIPS=demo`;
  - `CAMSIM_AUTO_EVENTS=motion:6/h,person:2/h,vehicle:1/h,pet:1/h`;
  - `CAMSIM_CONTROL_TLS=on`, so the bearer token never crosses the network in
    clear text;
  - `envFrom` Secret `cam-sim-secrets`.
- Service `cam2` (ClusterIP): 443→8443, 80→8080, 9443→9443. cams reaches
  `cam2.cam-sim.svc.cluster.local` with TLS name `cam2.skylar.technology`,
  like cam1 by IP.
- Certificate `cam2-skylar-technology`: the same as cam1's (HTTP-01,
  letsencrypt-prod, RSA 2048 PKCS#1, standalone, not on the shared Ingress).
- CronJob `cam2-cert-push`: cam1's `push_cert.py` with
  `CAMERA_HOST=cam2.cam-sim.svc.cluster.local` and Secret
  `cam2-camera-credentials` (`username`, `password`: cam2's `admin`). This
  also tests the push job against the simulator.
- Probes: `/healthz` on 9443, HTTPS.
- No public route: as for cam1, the public name serves only the ACME
  challenge. The control API is reached with `kubectl port-forward`; LAN
  access is decided with the web UI (Plan 3).
- Deploys: `release.yml` on `production` gets a deploy job on the self-hosted
  runner in `cam-sim-runner` (like cams): it pins the image by digest in
  kube-setup's manifest, applies it, waits for rollout, and checks `/healthz`.

## Steps

1. **cam-sim:** the secrets script syncs `KUBE_SETUP_DEPLOY_TOKEN` (GitHub
   refuses `GITHUB_*` names), creates `cam2-camera-credentials`, and gains
   `--gh-login`. Done in this branch.
2. **kube-setup:**
   - namespaces `cam-sim` and `cam-sim-runner`, with the runner's RBAC scoped
     to the `cam2` Deployment;
   - the Certificate, Deployment, Service, PVC, CronJob and ConfigMap;
   - the version-exporter entry and an alert rule like cam1's.
3. **cam-sim (after the namespace exists):**
   `KUBECONFIG=~/.kube/k3s-config scripts/sync-secrets.sh --only kube`.
4. **kube-setup:** apply; first certificate issue; a real fire of the push job;
   verify that cam2 serves the Let's Encrypt certificate.
5. **cams:** add cam2 to the `cams-cameras` Secret (`cameras.json`:
   `{"id":"cam2","name":"cam2","host":"cam2.cam-sim.svc.cluster.local","protocol":"https","tlsServername":"cam2.skylar.technology","user":"cams","password":<from cam-sim .env>}`),
   and roll a new cams revision. Verify in the browser that the picker shows
   Den and cam2, and that cam2's live view, recordings, settings and about
   pages work.
6. **cam-sim:** add the deploy job to `release.yml`, then release through it
   once to prove it.
