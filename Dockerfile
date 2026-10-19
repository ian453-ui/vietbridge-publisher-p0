FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
RUN mkdir /data && chown node:node /data
USER node
ENV PUBLISHER_MODE=cloud DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node","src/server.js"]
