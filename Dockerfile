FROM node:22-alpine
ENV NODE_ENV=production PORT=8000 HOST=0.0.0.0 SUBMISSIONS_DIR=/data
WORKDIR /app
COPY --chown=node:node index.html judges.html server.mjs README.md ./
COPY --chown=node:node src ./src
COPY --chown=node:node assets ./assets
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8000
CMD ["node", "server.mjs"]
