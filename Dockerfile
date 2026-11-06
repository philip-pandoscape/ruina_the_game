# The game in one image: the Rust server serves the built game, the account API and the WebSockets
# on $PORT. Railway builds the last stage (app); Docker Compose builds `server` for development,
# where Vite serves the game instead (docker-compose.yml).

# ---------- The game: TypeScript and Three.js, typechecked and built by Vite ----------
FROM node:24-slim AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts playwright.config.ts index.html ./
COPY src src
# The developer pages and the design, built beside the game (served to admins only).
COPY dev dev
COPY shared shared
COPY tools tools
COPY design design
COPY tests tests
RUN npm run build

# ---------- The server ----------
FROM rust:1-trixie AS build
WORKDIR /app
# The dependencies first, on their own, so changing our code doesn't rebuild them all: the
# workspace's manifests with stand-ins for its crates' code, built once and kept as a layer.
COPY Cargo.toml Cargo.lock ./
COPY crates/engine/Cargo.toml crates/engine/
COPY crates/server/Cargo.toml crates/server/
COPY crates/tools/Cargo.toml crates/tools/
RUN mkdir -p crates/engine/src crates/server/src crates/tools/src/bin \
 && touch crates/engine/src/lib.rs crates/server/src/lib.rs \
 && echo 'fn main() {}' > crates/server/src/main.rs \
 && echo 'fn main() {}' > crates/tools/src/bin/stand_in.rs \
 && cargo build --release --locked --bin ruina-server \
 && rm -rf crates/engine/src crates/server/src crates/tools/src
COPY shared shared
COPY crates crates
# COPY keeps the files' old timestamps; make sure cargo sees the real code as newer than the stand-ins.
RUN touch crates/engine/src/lib.rs crates/server/src/main.rs crates/server/src/lib.rs \
 && cargo build --release --locked --bin ruina-server

FROM debian:trixie-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/ruina-server /usr/local/bin/ruina-server
ENV PORT=7777
# In a container the port is passed on from outside, so the server takes connections at every
# address; run natively it listens on the machine itself only (crates/server/src/main.rs).
ENV LISTEN=all
EXPOSE 7777
CMD ["ruina-server"]

# ---------- What Railway runs: the server plus the built game ----------
FROM server AS app
COPY --from=client /app/dist /app/dist
ENV STATIC_DIR=/app/dist
