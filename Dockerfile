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
# Dates a page writes without a zone are parsed as UTC in code; this keeps anything else honest too.
ENV TZ=UTC
ENV BIND_HOST=0.0.0.0
ENV PORT=8080

EXPOSE 8080

# `--smol` tells JSC to collect sooner and grow the heap less, which is the trade this process wants:
# it spends its time waiting on sockets, and the memory it holds is mostly garbage from parsing one
# large body. Measured on a copy of production -- boot rebuild, HOT_QUERIES 200 times, then every
# stored body over 500 KB parsed -- peak RSS was 619-738 MB across three runs without it and
# 627-630 MB with it, and the heap left at the end fell from 115-203 MB to 115-124 MB: the same
# peak, reached predictably, and nothing kept afterwards. Boot cost 3% more (1,920 ms to 2,000 ms),
# which the healthcheck's start_period already covers many times over.
CMD ["bun", "--smol", "dist/src/index.js"]
