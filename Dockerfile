# syntax=docker/dockerfile:1

# ---------- Build stage ----------
FROM node:24-bookworm-slim AS build
# Build tools for better-sqlite3 native compilation
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Install all workspace deps (dev included) using the lockfile
COPY package.json package-lock.json* tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install

# Build web (vite) then server (tsc)
COPY . .
RUN npm run build

# Prune to production dependencies for the runtime image
RUN npm prune --omit=dev

# ---------- Dev stage (hot reload) ----------
FROM node:24-bookworm-slim AS dev
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Install deps into the image; source is bind-mounted at runtime while these
# node_modules are preserved via anonymous volumes (see docker-compose.dev.yml).
COPY package.json package-lock.json* tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm install
EXPOSE 5173 3001
CMD ["npm", "run", "dev"]

# ---------- Runtime stage ----------
FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV DATA_DIR=/data
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/web/dist ./web/dist

VOLUME ["/data"]
EXPOSE 3000
ENV PORT=3000
CMD ["node", "server/dist/index.js"]
