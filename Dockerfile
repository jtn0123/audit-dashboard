# node:26-alpine, pinned by manifest digest (multi-arch index)
FROM node:26-alpine@sha256:aadf416b2cdce311a8811ba3f0608a61b77dbf997500e2eafe781b51f6a0b019
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ARG BUILD_DATE
ENV BUILD_DATE=$BUILD_DATE
ENV DATA_DIR=/data
# Collector cache lives here; mount a volume to keep it warm across restarts
ENV GH_CACHE_FILE=/cache/github.json
RUN mkdir -p /cache && chown node:node /cache
USER node
EXPOSE 3002
CMD ["node", "server.js"]
