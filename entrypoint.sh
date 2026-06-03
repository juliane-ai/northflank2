#!/bin/sh

cleanup() {
    echo "Received shutdown signal, stopping services..."
    kill "$CLIPROXY_PID" 2>/dev/null
    kill "$GPTLOAD_PID" 2>/dev/null
    wait "$CLIPROXY_PID" 2>/dev/null
    wait "$GPTLOAD_PID" 2>/dev/null
}
trap cleanup SIGTERM SIGINT

# 1. Start GPT-Load in the background.
cd /app
PORT="${GPTLOAD_PORT:-3001}" HOST="${GPTLOAD_HOST:-0.0.0.0}" /app/gpt-load &
GPTLOAD_PID=$!

# 2. Start CLI Proxy API as the primary service.
cd /CLIProxyAPI
./CLIProxyAPI &
CLIPROXY_PID=$!

wait "$CLIPROXY_PID"
EXIT_CODE=$?

cleanup
exit "$EXIT_CODE"
