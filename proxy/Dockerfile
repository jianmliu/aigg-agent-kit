# Minimal, build-free image for node1 staging (old Docker 18.09, low mem).
FROM node:20-alpine
WORKDIR /app
COPY server.mjs ./
ENV PORT=8090
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://localhost:8090/healthz || exit 1
CMD ["node", "server.mjs"]
