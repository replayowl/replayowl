# syntax=docker/dockerfile:1

FROM node:24-slim AS build
WORKDIR /app
RUN npm install -g pnpm@11.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:24-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8790 DATA_DIR=/data
WORKDIR /app
RUN npm install -g pnpm@11.18.0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts && pnpm store prune
COPY src ./src
COPY --from=build /app/dist/public ./dist/public
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8790
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8790)+'/api/auth/status').then(r=>process.exit(r.status<500?0:1),()=>process.exit(1))"
CMD ["node", "src/server/index.ts"]
