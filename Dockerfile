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
COPY shared shared
COPY tools tools
COPY design design
COPY tests tests
RUN npm run build

# ---------- The server ----------
FROM rust:1-trixie AS build
WORKDIR /app
# The dependencies first, on their own, so changing the server's code doesn't rebuild them all.
COPY server/Cargo.toml server/Cargo.lock server/
RUN mkdir -p server/src \
 && echo 'fn main() {}' > server/src/main.rs \
 && touch server/src/lib.rs \
 && cargo build --release --locked --manifest-path server/Cargo.toml --bin yggdrasil-server \
 && rm -rf server/src
COPY shared shared
COPY server server
# COPY keeps the files' old timestamps; make sure cargo sees the real code as newer than the stub.
RUN touch server/src/main.rs server/src/lib.rs \
 && cargo build --release --locked --manifest-path server/Cargo.toml --bin yggdrasil-server

FROM debian:trixie-slim AS server
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/server/target/release/yggdrasil-server /usr/local/bin/yggdrasil-server
ENV PORT=7777
# In a container the port is passed on from outside, so the server takes connections at every
# address; run natively it listens on the machine itself only (server/src/main.rs).
ENV LISTEN=all
EXPOSE 7777
# No battlefield by default: it simulates thousands of fighters around the clock. Drop --battle off for one.
CMD ["yggdrasil-server", "--battle", "off"]

# ---------- What Railway runs: the server plus the built game ----------
FROM server AS app
COPY --from=client /app/dist /app/dist
ENV STATIC_DIR=/app/dist
