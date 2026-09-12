# Production dependencies, resolved once and copied into the runtime image.
# Installing here rather than in the final stage keeps Bun's install cache out
# of the shipped layers.
FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS prod-deps

WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --production --ignore-scripts

FROM oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f AS build

WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
  bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts

# tsconfig.build.json omits tests: the runtime image has no use for them, and
# compiling them shipped their JavaScript inside dist.
RUN bun run build

# Alpine, which puts the whole operating system at 10 MB against Debian's 108.
# What is left is mostly the Bun binary itself, so this is the end of the road
# for shrinking the image rather than one step along it.
#
# Bun on Alpine is the musl build. Nothing here links against a native npm
# package, which is the usual reason to stay on glibc, and the full test suite
# was run under musl before this base was adopted. Adding a dependency with a
# native component means re-checking that.
#
# No ca-certificates package: Bun carries its own root store and verified HTTPS
# against every configured source from this image. Anything added here that
# shells out to curl or git would need the package back.
FROM oven/bun:1.3.14-alpine@sha256:5acc90a93e91ff07bf72aa90a7c9f0fa189765aec90b47bdbf2152d2196383c0

WORKDIR /app

# Ownership is set as each path is copied. A `chown -R` over /app afterwards
# rewrites every inode, and overlayfs then stores a second copy of node_modules
# and dist in that layer: 15.8 MB of the previous image was exactly that.
COPY --chown=bun:bun package.json bun.lock ./
COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=build --chown=bun:bun /app/dist ./dist
COPY --chown=bun:bun signal-forge.example.json ./signal-forge.json

RUN install -d -o bun -g bun /app/data
USER bun

ENV NODE_ENV=production
ENV BIND_HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

CMD ["bun", "dist/src/index.js"]
