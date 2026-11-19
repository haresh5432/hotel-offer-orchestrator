# ---- build ----
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
# (Debian-based image: Temporal's native worker core needs glibc, so avoid alpine.)
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
# Default: API (+ mock suppliers). The worker service overrides CMD in docker-compose.yml.
CMD ["node", "dist/api/server.js"]
