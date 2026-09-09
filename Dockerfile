FROM oven/bun:1.3.14 AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts

RUN bun run build

FROM oven/bun:1.3.14

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY signal-forge.example.json ./signal-forge.json

RUN mkdir -p /app/data && chown -R bun:bun /app
USER bun

ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["bun", "dist/src/index.js"]
