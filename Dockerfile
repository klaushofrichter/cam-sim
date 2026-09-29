FROM node:26-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: `prepare` builds dist/, which needs the sources copied below.
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY web ./web
RUN npm run build

FROM node:26-alpine
WORKDIR /app
# ffmpeg builds the test-pattern fixtures and publishes the RTSP streams; the
# fonts are for the optional SD pipeline's on-screen text.
RUN apk add --no-cache ffmpeg font-dejavu
# MediaMTX serves RTSP (the camera's port 554), checksum-verified.
ARG TARGETARCH
ARG MEDIAMTX_VERSION=v1.21.1
RUN set -eu; \
    case "${TARGETARCH:-amd64}" in amd64) a=amd64 ;; arm64) a=arm64 ;; *) echo "unsupported arch ${TARGETARCH}"; exit 1 ;; esac; \
    f="mediamtx_${MEDIAMTX_VERSION}_linux_${a}.tar.gz"; u="https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX_VERSION}"; \
    cd /tmp && wget -q "$u/$f" "$u/checksums.sha256" && grep "[ *]$f\$" checksums.sha256 | sed "s/ \*/  /" | sha256sum -c - \
    && tar -xzf "$f" -C /usr/local/bin mediamtx && rm -f "$f" checksums.sha256 && mediamtx --help >/dev/null
ENV NODE_ENV=production \
    CAMSIM_DATA_DIR=/data \
    CAMSIM_FIXTURE_DIR=/opt/cam-sim/fixtures
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
COPY openapi.yaml CHANGELOG.md ./
# Test-pattern fixtures, generated here so containers start without ffmpeg work.
RUN node dist/src/cli.js --make-fixtures \
 && mkdir -p /data && chown 1000:1000 /data
# Stamped by the release workflow; declared late so a new version doesn't
# rebuild the dependency layers.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ARG BUILD_DATE=
ENV BUILD_DATE=$BUILD_DATE
# Numeric, so Kubernetes' runAsNonRoot can verify it.
USER 1000:1000
VOLUME /data
EXPOSE 8443 8080 9443 8554 8000
# The control port serves plain HTTP unless a TLS certificate is configured.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:9443/healthz >/dev/null 2>&1 || wget --no-check-certificate -qO- https://127.0.0.1:9443/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "dist/src/cli.js"]
