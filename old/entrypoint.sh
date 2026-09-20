#!/bin/sh
set -e

cleanup() {
    echo "Received shutdown signal, stopping services..."

    if [ -n "${SCHEDULED_BACKUP_PID:-}" ]; then
        kill "$SCHEDULED_BACKUP_PID" 2>/dev/null || true
        wait "$SCHEDULED_BACKUP_PID" 2>/dev/null || true
    fi

    if [ -n "${SEARXNG_PID:-}" ]; then
        kill "$SEARXNG_PID" 2>/dev/null || true
        wait "$SEARXNG_PID" 2>/dev/null || true
    fi

    if [ -n "${GPTLOAD_PID:-}" ]; then
        kill "$GPTLOAD_PID" 2>/dev/null || true
        wait "$GPTLOAD_PID" 2>/dev/null || true
    fi

    if [ -n "${CLIPROXY_PID:-}" ]; then
        kill "$CLIPROXY_PID" 2>/dev/null || true
        wait "$CLIPROXY_PID" 2>/dev/null || true
    fi
}

start_searxng() {
    if [ "${SEARXNG_ENABLED:-true}" != "true" ]; then
        echo "SearXNG disabled; set SEARXNG_ENABLED=true to enable"
        return 0
    fi

    export SEARXNG_PORT="${SEARXNG_PORT:-8080}"
    export SEARXNG_CONFIG_DIR="${SEARXNG_CONFIG_DIR:-/etc/searxng}"
    export SEARXNG_SETTINGS_PATH="${SEARXNG_SETTINGS_PATH:-$SEARXNG_CONFIG_DIR/settings.yml}"
    export SEARXNG_ENABLE_BACKUP="${SEARXNG_ENABLE_BACKUP:-false}"

    mkdir -p "$SEARXNG_CONFIG_DIR"

    if [ "$SEARXNG_ENABLE_BACKUP" = "true" ]; then
        restore-searxng || echo "searxng restore failed; continuing startup"
    else
        echo "SearXNG backup restore disabled; set SEARXNG_ENABLE_BACKUP=true to enable"
    fi

    if [ -n "${SEARXNG_SECRET_KEY:-}" ]; then
        sed -i "s|secret_key: .*|secret_key: \"${SEARXNG_SECRET_KEY}\"|" "$SEARXNG_SETTINGS_PATH"
    else
        echo "WARNING: SEARXNG_SECRET_KEY is not set; using settings.yml fallback secret_key"
    fi

    echo "Starting SearXNG on 0.0.0.0:${SEARXNG_PORT}..."
    /usr/local/searxng/entrypoint.sh &
    SEARXNG_PID=$!
}

trap cleanup TERM INT

export DATA_DIR="${DATA_DIR:-/app/data}"
export SCHEDULED_BACKUP_ENABLED="${SCHEDULED_BACKUP_ENABLED:-false}"
export SCHEDULED_BACKUP_TIME="${SCHEDULED_BACKUP_TIME:-03:30}"
export SCHEDULED_BACKUP_RUN_ON_START="${SCHEDULED_BACKUP_RUN_ON_START:-false}"
export SCHEDULED_BACKUP_INTERVAL_SECONDS="${SCHEDULED_BACKUP_INTERVAL_SECONDS:-60}"

mkdir -p "$DATA_DIR"
restore-data || echo "northflank2 data restore failed; continuing startup"

start_searxng

scheduled-backup &
SCHEDULED_BACKUP_PID=$!

cd /app
PORT="${GPTLOAD_PORT:-3001}" HOST="${GPTLOAD_HOST:-0.0.0.0}" /app/gpt-load &
GPTLOAD_PID=$!

cd /CLIProxyAPI
./CLIProxyAPI &
CLIPROXY_PID=$!

wait "$CLIPROXY_PID"
EXIT_CODE=$?

cleanup
exit "$EXIT_CODE"
