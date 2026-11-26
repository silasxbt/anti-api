ARG BUN_IMAGE=oven/bun:1.3.5
FROM ${BUN_IMAGE}

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY . .

RUN set -eux; \
    arch="$(uname -m)"; \
    if [ "$arch" = "x86_64" ]; then ngrok_arch="amd64"; \
    elif [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then ngrok_arch="arm64"; \
    else echo "Unsupported arch: $arch" >&2; exit 1; fi; \
    curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${ngrok_arch}.tgz" -o /tmp/ngrok.tgz; \
    tar -xzf /tmp/ngrok.tgz -C /usr/local/bin; \
    rm /tmp/ngrok.tgz

ENV NODE_ENV=production
ENV HOME=/app/data
ENV ANTI_API_DATA_DIR=/app/data
ENV ANTI_API_HOST=0.0.0.0
ENV ANTI_API_CONTAINER_CONTROL_PLANE=1
ENV ANTI_API_NO_OPEN=1
ENV ANTI_API_OAUTH_NO_OPEN=1
ENV ANTI_API_DOCKER_OAUTH_CALLBACK=1
ENV ANTI_API_PACKAGE_MANAGER=docker
ENV ANTI_API_NO_SELF_UPDATE=1

RUN mkdir -p /app/data

EXPOSE 8964 1455-1465 51121-51131

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD test -n "$ANTI_API_CONTROL_TOKEN" && curl -fsS -H "x-api-key: $ANTI_API_CONTROL_TOKEN" http://127.0.0.1:8964/auth/status >/dev/null || exit 1

CMD ["bun", "run", "src/main.ts", "start"]
