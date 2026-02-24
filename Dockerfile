FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
ARG BUILD_DATE
ENV BUILD_DATE=$BUILD_DATE
ENV DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
