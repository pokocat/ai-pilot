FROM node:20-slim AS build

WORKDIR /repo
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN sed -i 's#deb.debian.org#mirrors.aliyun.com#g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY shared ./shared
COPY server ./server
WORKDIR /repo/server
RUN npm config set registry "$NPM_REGISTRY" \
    && npm ci \
    && npx prisma generate \
    && npm run build

FROM node:20-slim AS runtime

WORKDIR /app
ENV TZ=Asia/Shanghai
RUN sed -i 's#deb.debian.org#mirrors.aliyun.com#g' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /repo/server/node_modules ./node_modules
COPY --from=build /repo/server/dist ./dist
COPY --from=build /repo/server/prisma ./prisma
COPY --from=build /repo/server/src ./src
COPY --from=build /repo/server/package.json ./package.json

EXPOSE 4000
CMD ["node", "dist/index.js"]
