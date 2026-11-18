FROM node:24-alpine AS build

RUN corepack enable && corepack prepare pnpm@11.19.0 --activate
WORKDIR /app

COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/api/package.json services/api/package.json
RUN pnpm install --no-frozen-lockfile

COPY . .
RUN pnpm build

FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

EXPOSE 8787
CMD ["node", "services/api/dist/index.js"]
