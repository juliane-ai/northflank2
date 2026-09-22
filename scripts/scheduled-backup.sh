#!/bin/sh
set -eu

log() {
  printf '[scheduled-backup] %s\n' "$*"
}

SCHEDULED_BACKUP_ENABLED="${SCHEDULED_BACKUP_ENABLED:-false}"
SCHEDULED_BACKUP_TIME="${SCHEDULED_BACKUP_TIME:-03:30}"
SCHEDULED_BACKUP_RUN_ON_START="${SCHEDULED_BACKUP_RUN_ON_START:-false}"
SCHEDULED_BACKUP_INTERVAL_SECONDS="${SCHEDULED_BACKUP_INTERVAL_SECONDS:-60}"

case "$SCHEDULED_BACKUP_TIME" in
  [0-2][0-9]:[0-5][0-9]) : ;;
  *)
    log "invalid SCHEDULED_BACKUP_TIME=$SCHEDULED_BACKUP_TIME, expected HH:MM; scheduler disabled"
    exit 0
    ;;
esac

hour=${SCHEDULED_BACKUP_TIME%:*}
if [ "$hour" -gt 23 ]; then
  log "invalid SCHEDULED_BACKUP_TIME=$SCHEDULED_BACKUP_TIME, hour must be 00-23; scheduler disabled"
  exit 0
fi

case "$SCHEDULED_BACKUP_INTERVAL_SECONDS" in
  ''|*[!0-9]*)
    log "invalid SCHEDULED_BACKUP_INTERVAL_SECONDS=$SCHEDULED_BACKUP_INTERVAL_SECONDS, using 60"
    SCHEDULED_BACKUP_INTERVAL_SECONDS=60
    ;;
esac

if [ "$SCHEDULED_BACKUP_INTERVAL_SECONDS" -lt 10 ]; then
  log "SCHEDULED_BACKUP_INTERVAL_SECONDS too small, using 10"
  SCHEDULED_BACKUP_INTERVAL_SECONDS=10
fi

run_backup() {
  reason="$1"
  log "starting backup-data ($reason)"
  if /opt/scripts/backup-data.sh; then
    log "backup-data completed ($reason)"
  else
    code=$?
    log "backup-data failed with exit code $code ($reason); scheduler will continue"
  fi
}

if [ "$SCHEDULED_BACKUP_ENABLED" != "true" ]; then
  log "disabled; set SCHEDULED_BACKUP_ENABLED=true to enable"
  exit 0
fi

if [ -z "${BACKUP_PASSWORD:-}" ]; then
  log "disabled; SCHEDULED_BACKUP_ENABLED=true but BACKUP_PASSWORD is empty"
  exit 0
fi
if [ "${BACKUP_UPLOAD:-true}" = "true" ] && [ -z "${BACKUP_WORKER_API_KEY:-}" ]; then
  log "disabled; upload enabled but BACKUP_WORKER_API_KEY is empty"
  exit 0
fi

log "enabled; daily backup-data time=$SCHEDULED_BACKUP_TIME, interval=${SCHEDULED_BACKUP_INTERVAL_SECONDS}s"
[ -n "${TZ:-}" ] && log "timezone TZ=$TZ"

last_run_date=""

if [ "$SCHEDULED_BACKUP_RUN_ON_START" = "true" ]; then
  run_backup "startup"
  last_run_date=$(date +%Y-%m-%d)
fi

while true; do
  now_time=$(date +%H:%M)
  today=$(date +%Y-%m-%d)

  if [ "$now_time" = "$SCHEDULED_BACKUP_TIME" ] && [ "$last_run_date" != "$today" ]; then
    run_backup "scheduled $today $now_time"
    last_run_date="$today"
  fi

  sleep "$SCHEDULED_BACKUP_INTERVAL_SECONDS"
done
