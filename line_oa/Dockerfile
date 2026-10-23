FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY app/package.json app/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app/tsconfig.json ./
COPY app/src ./src
COPY app/tests ./tests
COPY app/scripts ./scripts
COPY app/web ./web
RUN npm test

FROM node:24-bookworm-slim AS runtime
ARG BUILD_VERSION=0.3.0-dev.3
ARG TARGETARCH
ARG BUILD_ARCH=amd64
# Docker uses arm64; Home Assistant uses aarch64. Reject a mislabeled image.
RUN case "${TARGETARCH}:${BUILD_ARCH}" in amd64:amd64|arm64:aarch64) ;; *) echo "BUILD_ARCH must match TARGETARCH (amd64 or aarch64)" >&2; exit 1 ;; esac
LABEL org.opencontainers.image.licenses="MIT" \
      io.hass.name="LINE OA" \
      io.hass.description="LINE OA Gateway with Ingress and secure Home Assistant pairing" \
      io.hass.type="app" \
      io.hass.version="${BUILD_VERSION}" \
      io.hass.arch="${BUILD_ARCH}"
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
# No production dependencies: Gateway uses only Node.js built-ins.
COPY --from=build /build/dist/src ./dist/src
COPY --from=build /build/dist/scripts ./dist/scripts
COPY app/web ./web
COPY app/package.json ./package.json
COPY LICENSE ./LICENSE
# Runtime has one Node process; npm/compiler are not needed.
RUN rm -rf /usr/local/lib/node_modules /opt/yarn-* /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
EXPOSE 8099 8787
CMD ["node", "dist/scripts/controlled-start.js"]
