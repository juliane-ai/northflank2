#!/bin/sh
set -eu

log() {
  printf '[restore-data] %s\n' "$*"
}

warn() {
  printf '[restore-data] WARNING: %s\n' "$*"
}

dir_is_empty() {
  [ -z "$(find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]
}

sha256_cmd() {
  if command -v sha256sum >/dev/null 2>&1; then
    echo "sha256sum"
  elif command -v shasum >/dev/null 2>&1; then
    echo "shasum"
  else
    echo ""
  fi
}

compute_sha256() {
  local cmd
  cmd=$(sha256_cmd)
  case "$cmd" in
    sha256sum) sha256sum "$1" | awk '{print $1}' ;;
    shasum)    shasum -a 256 "$1" | awk '{print $1}' ;;
    *)         echo "" ;;
  esac
}

DATA_DIR="${DATA_DIR:-/app/data}"
BACKUP_WORKER_URL="${BACKUP_WORKER_URL:-https://cloudflare-docker-storage.564510493.workers.dev}"
BACKUP_WORKER_API_KEY="${BACKUP_WORKER_API_KEY:-}"
BACKUP_OBJECT_KEY="${BACKUP_OBJECT_KEY:-northflank2/data.tar.gz.enc}"
BACKUP_PASSWORD="${BACKUP_PASSWORD:-}"
BACKUP_INPUT_FILE="${BACKUP_INPUT_FILE:-/tmp/restore-${BACKUP_OBJECT_KEY##*/}}"
RESTORE_IF_DATA_EXISTS="${RESTORE_IF_DATA_EXISTS:-false}"
SHA256_VERIFY="${SHA256_VERIFY:-warn}"

mkdir -p "$DATA_DIR"

if [ "$RESTORE_IF_DATA_EXISTS" != "true" ] && ! dir_is_empty "$DATA_DIR"; then
  log "DATA_DIR is not empty and RESTORE_IF_DATA_EXISTS is not true; skipping restore"
  exit 0
fi

if ! dir_is_empty "$DATA_DIR"; then
  log "clearing existing data in $DATA_DIR"
  rm -rf "${DATA_DIR:?}"/*
fi

if [ -z "$BACKUP_PASSWORD" ]; then
  log "BACKUP_PASSWORD is not set; skipping restore"
  exit 0
fi

# --- download ---
downloaded_sha256=""

if [ ! -f "$BACKUP_INPUT_FILE" ]; then
  if [ -z "$BACKUP_WORKER_URL" ] || [ -z "$BACKUP_WORKER_API_KEY" ]; then
    log "Worker config incomplete; skipping restore"
    exit 0
  fi

  worker_base=${BACKUP_WORKER_URL%/}
  backup_url="$worker_base/backup/$BACKUP_OBJECT_KEY"
  headers_file=$(mktemp)

  log "downloading from Worker: $backup_url"
  if command -v curl >/dev/null 2>&1; then
    if ! curl --fail --show-error --silent \
      -D "$headers_file" \
      -H "Authorization: Bearer $BACKUP_WORKER_API_KEY" \
      -o "$BACKUP_INPUT_FILE" \
      "$backup_url"; then
      log "backup not available; skipping restore"
      rm -f "$BACKUP_INPUT_FILE" "$headers_file"
      exit 0
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget --server-response --quiet \
      --header="Authorization: Bearer $BACKUP_WORKER_API_KEY" \
      --output-document="$BACKUP_INPUT_FILE" \
      "$backup_url" 2>"$headers_file"; then
      log "backup not available; skipping restore"
      rm -f "$BACKUP_INPUT_FILE" "$headers_file"
      exit 0
    fi
  else
    log "curl or wget is required for restore"
    rm -f "$BACKUP_INPUT_FILE" "$headers_file"
    exit 1
  fi

  downloaded_sha256=$(grep -i '^x-backup-sha256:' "$headers_file" | awk '{print $2}' | tr -d '\r' || true)
  downloaded_version=$(grep -i '^x-backup-version:' "$headers_file" | awk '{print $2}' | tr -d '\r' || true)
  rm -f "$headers_file"

  [ -n "$downloaded_version" ] && log "version: $downloaded_version"
  [ -n "$downloaded_sha256" ]  && log "server sha256: $downloaded_sha256"
fi

# --- sha256 verify ---
if [ -n "$downloaded_sha256" ] && [ "$SHA256_VERIFY" != "off" ]; then
  local_sha256=$(compute_sha256 "$BACKUP_INPUT_FILE")
  if [ -z "$local_sha256" ]; then
    warn "sha256 tool not available; cannot verify"
  elif [ "$local_sha256" = "$downloaded_sha256" ]; then
    log "sha256 verified OK"
  else
    warn "sha256 MISMATCH — server: $downloaded_sha256  local: $local_sha256"
    if [ "$SHA256_VERIFY" = "strict" ]; then
      log "SHA256_VERIFY=strict; aborting"
      rm -f "$BACKUP_INPUT_FILE"
      exit 1
    fi
  fi
fi

# --- decrypt → extract (streaming pipe, auto-detect gzip) ---
# Try uncompressed first (new format), fall back to gzip for old backups.
restore_parent=$(dirname "$DATA_DIR")
tar_err=$(mktemp)

log "decrypting + extracting to $restore_parent ..."

if openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass "pass:$BACKUP_PASSWORD" \
    -in "$BACKUP_INPUT_FILE" 2>/dev/null | \
    tar -C "$restore_parent" -xf - 2>"$tar_err"; then
  :
elif grep -qi 'compressed' "$tar_err"; then
  log "archive is gzip-compressed, retrying with -z"
  openssl enc -d -aes-256-cbc -pbkdf2 \
    -pass "pass:$BACKUP_PASSWORD" \
    -in "$BACKUP_INPUT_FILE" | \
    tar -C "$restore_parent" -xzf - || {
      log "decrypt/extract failed; check BACKUP_PASSWORD or file integrity"
      rm -f "$tar_err"
      exit 1
    }
else
  cat "$tar_err" >&2
  log "decrypt/extract failed; check BACKUP_PASSWORD or file integrity"
  rm -f "$tar_err"
  exit 1
fi
rm -f "$tar_err"

log "restore complete"
