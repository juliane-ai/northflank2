#!/bin/sh

cleanup() {
    echo "Received shutdown signal, stopping services..."
    kill "$CLIPROXY_PID" 2>/dev/null
    wait "$CLIPROXY_PID" 2>/dev/null
}
trap cleanup SIGTERM SIGINT

# 1. Start CLI Proxy API. Add future aggregated services below as background processes.
cd /CLIProxyAPI
./CLIProxyAPI &
CLIPROXY_PID=$!

wait "$CLIPROXY_PID"
EXIT_CODE=$?

cleanup
exit "$EXIT_CODE"
