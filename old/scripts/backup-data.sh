#!/bin/sh
set -eu

log() {
  printf '[backup-data] %s\n' "$*"
}

DATA_DIR="${DATA_DIR:-/app/data}"
BACKUP_WORKER_URL="${BACKUP_WORKER_URL:-https://cloudflare-docker-storage.564510493.workers.dev}"
BACKUP_WORKER_API_KEY="${BACKUP_WORKER_API_KEY:-}"
BACKUP_OBJECT_KEY="${BACKUP_OBJECT_KEY:-northflank2/data.tar.gz.enc}"
BACKUP_PASSWORD="${BACKUP_PASSWORD:-}"
BACKUP_UPLOAD="${BACKUP_UPLOAD:-true}"

if [ ! -d "$DATA_DIR" ]; then
  log "DATA_DIR does not exist: $DATA_DIR"
  exit 1
fi

if [ -z "$BACKUP_PASSWORD" ]; then
  log "BACKUP_PASSWORD is required"
  exit 1
fi

parent_dir=$(dirname "$DATA_DIR")
base_dir=$(basename "$DATA_DIR")

timestamp=$(date -u +%Y-%m-%dT%H%M%SZ)
object_dir=$(dirname "$BACKUP_OBJECT_KEY")
object_suffix=$(printf '%s' "$BACKUP_OBJECT_KEY" | sed 's/^[^.]*//')
versioned_key="${object_dir}/${timestamp}${object_suffix}"
backup_output="/tmp/${timestamp}${object_suffix}"

log "DATA_DIR       = $DATA_DIR"
log "versioned key  = $versioned_key"
log "timestamp      = $timestamp"

# tar → openssl encrypt → file (all streaming via pipe, no compression to save memory)
log "packing + encrypting ..."
tar -C "$parent_dir" -cf - "$base_dir" | \
  openssl enc -aes-256-cbc -pbkdf2 -salt \
    -pass "pass:$BACKUP_PASSWORD" \
    -out "$backup_output"

log "encrypted backup → $backup_output"

# sha256 of final encrypted file
if command -v sha256sum >/dev/null 2>&1; then
  file_sha256=$(sha256sum "$backup_output" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  file_sha256=$(shasum -a 256 "$backup_output" | awk '{print $1}')
else
  file_sha256=""
fi
[ -n "$file_sha256" ] && log "sha256          = $file_sha256"

if [ "$BACKUP_UPLOAD" != "true" ]; then
  log "BACKUP_UPLOAD is not true; skipping upload"
  exit 0
fi

if [ -z "$BACKUP_WORKER_URL" ] || [ -z "$BACKUP_WORKER_API_KEY" ]; then
  log "BACKUP_WORKER_URL and BACKUP_WORKER_API_KEY are required"
  exit 1
fi

worker_base=${BACKUP_WORKER_URL%/}
upload_url="$worker_base/backup/$versioned_key"

log "uploading → $upload_url"

if command -v curl >/dev/null 2>&1; then
  if [ -n "$file_sha256" ]; then
    curl --fail --show-error --silent \
      -X PUT \
      -H "Authorization: Bearer $BACKUP_WORKER_API_KEY" \
      -H "Content-Type: application/octet-stream" \
      -H "X-Backup-SHA256: $file_sha256" \
      --data-binary "@$backup_output" \
      "$upload_url" >/tmp/backup-upload.json
  else
    curl --fail --show-error --silent \
      -X PUT \
      -H "Authorization: Bearer $BACKUP_WORKER_API_KEY" \
      -H "Content-Type: application/octet-stream" \
      --data-binary "@$backup_output" \
      "$upload_url" >/tmp/backup-upload.json
  fi
elif command -v wget >/dev/null 2>&1; then
  if [ -n "$file_sha256" ]; then
    wget --quiet \
      --method=PUT \
      --header="Authorization: Bearer $BACKUP_WORKER_API_KEY" \
      --header="Content-Type: application/octet-stream" \
      --header="X-Backup-SHA256: $file_sha256" \
      --body-file="$backup_output" \
      --output-document=/tmp/backup-upload.json \
      "$upload_url"
  else
    wget --quiet \
      --method=PUT \
      --header="Authorization: Bearer $BACKUP_WORKER_API_KEY" \
      --header="Content-Type: application/octet-stream" \
      --body-file="$backup_output" \
      --output-document=/tmp/backup-upload.json \
      "$upload_url"
  fi
else
  log "curl or wget is required for upload"
  exit 1
fi

cat /tmp/backup-upload.json
printf '\n'
log "upload complete"
