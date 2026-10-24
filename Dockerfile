FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node . .
ENV NODE_ENV=production ORBIT_DB=/app/data/orbit.db PORT=3000
# Data lives in a volume; the app runs as the unprivileged "node" user.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME /app/data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
