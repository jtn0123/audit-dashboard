FROM node:22-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY . .
ENV DATA_DIR=/data
EXPOSE 3002
CMD ["node", "server.js"]
