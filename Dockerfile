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
# ffmpeg builds the test-pattern fixtures (and the video pipeline in Plan 2).
RUN apk add --no-cache ffmpeg
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
EXPOSE 8443 8080 9443
# The control port serves plain HTTP unless a TLS certificate is configured.
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:9443/healthz >/dev/null 2>&1 || wget --no-check-certificate -qO- https://127.0.0.1:9443/healthz >/dev/null 2>&1 || exit 1
CMD ["node", "dist/src/cli.js"]
