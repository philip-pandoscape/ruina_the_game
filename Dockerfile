# The game in one image: the Rust server serves the built game, the account API and the WebSockets
# on $PORT. Railway builds the last stage (app); Docker Compose builds `server` for development,
# where Vite serves the game instead (docker-compose.yml).

# ---------- The game: TypeScript and Three.js, typechecked and built by Vite ----------
# ---------- The engine for the browser: the rules, compiled to WebAssembly (crates/engine-wasm) ----------
FROM rust:1-trixie AS engine
WORKDIR /app
RUN rustup target add wasm32-unknown-unknown
COPY Cargo.toml Cargo.lock ./
COPY shared shared
COPY crates crates
RUN cargo build --release --locked -p ruina-engine-wasm --target wasm32-unknown-unknown

FROM node:24-slim AS client
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
# The engine the game loads (src/engine/load.ts), where the build looks for it.
COPY --from=engine /app/target/wasm32-unknown-unknown/release/ruina_engine_wasm.wasm target/wasm32-unknown-unknown/release/
COPY tsconfig.json vite.config.ts playwright.config.ts index.html ./
COPY src src
# The developer pages and the design, built beside the game (served to admins only).
COPY dev dev
COPY shared shared
COPY tools tools
COPY design design
COPY tests tests
# The bible (open to everyone), which reads some of its numbers from the engine's and the server's
# source (src/bible/source.ts).
COPY bible bible
COPY crates crates
RUN npx tsc --noEmit && npx vite build

# ---------- The server ----------
FROM rust:1-trixie AS build
WORKDIR /app
# The dependencies first, on their own, so changing our code doesn't rebuild them all: the
# workspace's manifests with stand-ins for its crates' code, built once and kept as a layer.
COPY Cargo.toml Cargo.lock ./
COPY crates/channels/Cargo.toml crates/channels/
COPY crates/engine/Cargo.toml crates/engine/
COPY crates/engine-wasm/Cargo.toml crates/engine-wasm/
COPY crates/link/Cargo.toml crates/link/
COPY crates/server/Cargo.toml crates/server/
COPY crates/tools/Cargo.toml crates/tools/
COPY crates/wire/Cargo.toml crates/wire/
COPY crates/world-api/Cargo.toml crates/world-api/
RUN mkdir -p crates/channels/src crates/engine/src crates/engine-wasm/src crates/link/src crates/server/src crates/tools/src/bin crates/wire/src crates/world-api/src \
 && touch crates/channels/src/lib.rs crates/engine/src/lib.rs crates/engine-wasm/src/lib.rs crates/link/src/lib.rs crates/server/src/lib.rs crates/wire/src/lib.rs crates/world-api/src/lib.rs \
 && echo 'fn main() {}' > crates/server/src/main.rs \
 && echo 'fn main() {}' > crates/tools/src/bin/stand_in.rs \
 && cargo build --release --locked --bin ruina-server \
 && rm -rf crates/channels/src crates/engine/src crates/engine-wasm/src crates/link/src crates/server/src crates/tools/src crates/wire/src crates/world-api/src
COPY shared shared
COPY crates crates
# COPY keeps the files' old timestamps; make sure cargo sees the real code as newer than the stand-ins.
RUN touch crates/channels/src/lib.rs crates/engine/src/lib.rs crates/link/src/lib.rs crates/server/src/main.rs crates/server/src/lib.rs crates/wire/src/lib.rs crates/world-api/src/lib.rs \
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
