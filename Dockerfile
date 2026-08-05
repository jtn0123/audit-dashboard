FROM node:25-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ARG BUILD_DATE
ENV BUILD_DATE=$BUILD_DATE
ENV DATA_DIR=/data
# Collector cache lives here; mount a volume to keep it warm across restarts
ENV GH_CACHE_FILE=/cache/github.json
RUN mkdir -p /cache
EXPOSE 3002
CMD ["node", "server.js"]
