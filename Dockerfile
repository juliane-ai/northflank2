# Stage 1: fetch CLI Proxy API binary from the official image
FROM eceasy/cli-proxy-api:latest AS cliproxy-src

# Stage 2: fetch GPT-Load binary from the official image
FROM ghcr.io/tbphp/gpt-load:latest AS gptload-src

# Stage 3: aggregation runtime, ready for more services later
FROM alpine:3.23

ENV DEPLOY=cloud \
    TZ=Asia/Shanghai

RUN apk add --no-cache tzdata ca-certificates wget \
    && cp /usr/share/zoneinfo/${TZ} /etc/localtime \
    && echo "${TZ}" > /etc/timezone \
    && mkdir -p /CLIProxyAPI /root/.cli-proxy-api /CLIProxyAPI/logs /app/data

COPY --from=cliproxy-src /CLIProxyAPI/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
COPY --from=cliproxy-src /CLIProxyAPI/config.example.yaml /CLIProxyAPI/config.example.yaml
COPY --from=gptload-src /app/gpt-load /app/gpt-load
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh /CLIProxyAPI/CLIProxyAPI /app/gpt-load

EXPOSE 3001
EXPOSE 8317
EXPOSE 8085
EXPOSE 1455
EXPOSE 54545
EXPOSE 51121
EXPOSE 11451

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:8317/ >/dev/null && wget -qO- http://localhost:3001/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
