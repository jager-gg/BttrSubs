FROM node:26-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json vitest.config.ts ./
COPY src ./src
COPY test ./test
# The tests import scripts/score-metrics.ts (the score's line measures) and scripts/cross-pairs.ts
# (the cross check's pairs), so scripts/ is copied for them; nothing in it ships.
COPY scripts ./scripts
# The logo routes are tested too. (Logo drafts are left out by .dockerignore.)
COPY assets ./assets
# The dashboard's What's new reads it, and its tests with it.
COPY CHANGELOG.md ./
# The release workflow runs the tests natively before it builds the images (RUN_TESTS=false there, since
# the arm64 image builds under emulation); a build from source runs them here, so a broken one never starts.
ARG RUN_TESTS=true
RUN if [ "$RUN_TESTS" = "true" ]; then npx vitest run test; fi && npm run build && npm prune --omit=dev
# ONNX Runtime ships its native library for every platform; only this image's own is kept.
RUN arch="$(node -p process.arch)" && cd node_modules/onnxruntime-node/bin/napi-v6 \
  && find . -mindepth 1 -maxdepth 1 -type d ! -name linux -exec rm -rf {} + \
  && find linux -mindepth 1 -maxdepth 1 -type d ! -name "$arch" -exec rm -rf {} +

FROM node:26-bookworm-slim
# ffmpeg/ffprobe read the anchor windows of the playing file. The header probe's bounded range requests
# (-initial_request_size) need FFmpeg 8, which Debian doesn't package, so a static build is copied in;
# its HTTPS reads check certificates against the system's store.
COPY --from=mwader/static-ffmpeg:8.1.2 /ffmpeg /ffprobe /usr/local/bin/
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production PORT=7000 CACHE_DIR=cache
# glibc keeps freed memory per thread; these hand it back after the speech model's batches.
# Calibration (4-core ARM server, 57 stored 40 s samples): program memory after the run 100-104 MB with them,
# 153-161 MB without; time 24.3-24.6 s against 23.1-23.8 s.
ENV MALLOC_TRIM_THRESHOLD_=131072 MALLOC_ARENA_MAX=2
# ONNX Runtime sends usage events to Microsoft unless told not to (src/vad.ts sets it too).
ENV ORT_DISABLE_TELEMETRY=1
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets ./assets
# The bundled model and fonts ship with their licenses (licenses/, named in THIRD_PARTY_NOTICES.md). REVISION, when the build context has one (a
# deploy can write the commit it built from there), names the build in the dashboard's diagnostics.
COPY LICENSE THIRD_PARTY_NOTICES.md CHANGELOG.md REVISION* ./
COPY licenses ./licenses
# The cache (and the edited links in it) belongs to the unprivileged node user; a new named volume
# takes this ownership. A bind mount needs `chown 1000:1000` on the host, or compose's `user:`.
RUN mkdir -p cache && chown node:node cache
USER node
VOLUME ["/app/cache"]
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 7000) + '/manifest.json').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server.js"]
