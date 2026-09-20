#!/bin/sh
set -eu

log() {
  printf '[backup-all] %s\n' "$*"
}

BACKUP_ALL_STRICT="${BACKUP_ALL_STRICT:-false}"
SEARXNG_ENABLED="${SEARXNG_ENABLED:-true}"
SEARXNG_BACKUP_PASSWORD="${SEARXNG_BACKUP_PASSWORD:-}"

run_optional() {
  name="$1"
  shift

  log "starting optional backup: $name"
  if "$@"; then
    log "completed optional backup: $name"
  else
    log "FAILED optional backup: $name"
    if [ "$BACKUP_ALL_STRICT" = "true" ]; then
      exit 1
    fi
    log "continuing because BACKUP_ALL_STRICT is not true"
  fi
}

log "backup sequence started"

if [ -n "${BACKUP_PASSWORD:-}" ]; then
  run_optional "northflank1 data" backup-data
else
  log "skipping northflank1 data backup because BACKUP_PASSWORD is not set"
fi

if [ "$SEARXNG_ENABLED" != "true" ]; then
  log "skipping searxng backup because SEARXNG_ENABLED is not true"
elif [ -z "$SEARXNG_BACKUP_PASSWORD" ]; then
  log "skipping searxng backup because SEARXNG_BACKUP_PASSWORD is not set"
  if [ "$BACKUP_ALL_STRICT" = "true" ]; then
    log "BACKUP_ALL_STRICT=true; missing SEARXNG_BACKUP_PASSWORD is an error"
    exit 1
  fi
else
  run_optional "searxng" backup-searxng
fi

log "backup sequence completed"
