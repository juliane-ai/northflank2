# Stage 1: fetch CLI Proxy API binary from the official image
FROM eceasy/cli-proxy-api:latest AS cliproxy-src

# Stage 2: fetch GPT-Load binary from the official image
FROM ghcr.io/tbphp/gpt-load:latest AS gptload-src

# Stage 3: SearXNG-based aggregation runtime
FROM searxng/searxng:latest

ENV DEPLOY=cloud \
    TZ=Asia/Shanghai \
    SEARXNG_ENABLED=true \
    SEARXNG_PORT=8080 \
    SEARXNG_CONFIG_DIR=/etc/searxng \
    SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml \
    INSTANCE_NAME=mcp-search \
    SEARXNG_BASE_URL=http://127.0.0.1:8080 \
    GRANIAN_LOG_LEVEL=warning \
    GRANIAN_BLOCKING_THREADS=2 \
    DATA_DIR=/app/data \
    BACKUP_WORKER_URL=https://cloudflare-docker-storage.564510493.workers.dev \
    RESTORE_IF_DATA_EXISTS=false \
    SHA256_VERIFY=warn \
    SEARXNG_ENABLE_BACKUP=false \
    SEARXNG_RESTORE_IF_DATA_EXISTS=false \
    SCHEDULED_BACKUP_ENABLED=false \
    SCHEDULED_BACKUP_TIME=03:30 \
    SCHEDULED_BACKUP_RUN_ON_START=false \
    SCHEDULED_BACKUP_INTERVAL_SECONDS=60

USER root

RUN if [ -f "/usr/share/zoneinfo/${TZ}" ]; then \
    cp /usr/share/zoneinfo/${TZ} /etc/localtime; \
    fi \
    && echo "${TZ}" > /etc/timezone \
    && mkdir -p /CLIProxyAPI /root/.cli-proxy-api /CLIProxyAPI/logs /app/data /etc/searxng

COPY --from=cliproxy-src /CLIProxyAPI/CLIProxyAPI /CLIProxyAPI/CLIProxyAPI
COPY --from=cliproxy-src /CLIProxyAPI/config.example.yaml /CLIProxyAPI/config.example.yaml
COPY --from=gptload-src /app/gpt-load /app/gpt-load
COPY settings.yml /etc/searxng/settings.yml
COPY entrypoint.sh /entrypoint.sh
COPY scripts/backup-data.sh /usr/local/bin/backup-data
COPY scripts/restore-data.sh /usr/local/bin/restore-data
COPY scripts/backup-searxng.sh /usr/local/bin/backup-searxng
COPY scripts/restore-searxng.sh /usr/local/bin/restore-searxng
COPY scripts/backup-all.sh /usr/local/bin/backup-all
COPY scripts/scheduled-backup.sh /usr/local/bin/scheduled-backup

RUN chmod +x /entrypoint.sh \
    /CLIProxyAPI/CLIProxyAPI \
    /app/gpt-load \
    /usr/local/bin/backup-data \
    /usr/local/bin/restore-data \
    /usr/local/bin/backup-searxng \
    /usr/local/bin/restore-searxng \
    /usr/local/bin/backup-all \
    /usr/local/bin/scheduled-backup

EXPOSE 8080
EXPOSE 3001
EXPOSE 8317
EXPOSE 8085
EXPOSE 1455
EXPOSE 54545
EXPOSE 51121
EXPOSE 11451

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:8317/ >/dev/null && wget -qO- http://localhost:3001/health >/dev/null || exit 1

ENTRYPOINT ["/entrypoint.sh"]
