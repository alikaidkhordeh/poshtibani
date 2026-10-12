# The chat image. The test stage runs the whole test suite; the image is only built if it passes.
FROM node:22.23.3-alpine3.24 AS test
WORKDIR /app
COPY . .
RUN npm test

FROM node:22.23.3-alpine3.24
ENV NODE_ENV=production DATA_DIR=/data PORT=3000 HOST=0.0.0.0 SOURCE_DIR=/app/source
WORKDIR /app
COPY --from=test /app/package.json ./
COPY --from=test /app/src ./src
COPY --from=test /app/public ./public
# The full source, so the owner's "full backup" download can rebuild the chat anywhere.
COPY --from=test /app /app/source
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/info').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
