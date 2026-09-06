# node:26-alpine, pinned by manifest digest (multi-arch index)
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ARG BUILD_DATE
ENV BUILD_DATE=$BUILD_DATE
# Collector cache and the scan-history series live here; mount a volume to keep
# both warm across restarts — losing /cache resets the recorded trend history.
ENV GH_CACHE_FILE=/cache/github.json
ENV GH_HISTORY_FILE=/cache/history.json
RUN mkdir -p /cache && chown node:node /cache
USER node
EXPOSE 3002
CMD ["node", "server.js"]
