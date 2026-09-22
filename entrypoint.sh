#!/bin/sh
# northflank2 主入口：GitHub恢复(主) → R2恢复(可选) → 播种 pi provider/看板 → 研究循环 + 定时备份
# 信号处理：sleep 一律 `& wait`，保证 docker stop 的 TERM 立即触发 cleanup
set -eu

OUT_DIR="${RESEARCH_OUTPUT_DIR:-/opt/data/outputs}"
LOG_DIR="$OUT_DIR/logs"
SESS_DIR="${PI_SESSION_DIR:-/opt/data/pi-sessions}"
PI_HOME="${PI_HOME:-/root/.pi/agent}"
BACKUP_PID=""

cleanup() {
    echo "[entrypoint] stopping..."
    [ -n "$BACKUP_PID" ] && kill "$BACKUP_PID" 2>/dev/null || true
}
trap cleanup TERM INT

sleep_until() { sleep "$1" & _pid=$!; wait "$_pid" || true; }
log() { echo "[entrypoint] $*"; }

if [ -z "${NEW_API_KEY:-}" ]; then
    log "WARNING: NEW_API_KEY 未配置，研究轮会失败；循环仍照常启动"
fi

# --- 播种 pi 自定义 provider（new-api 中转，OpenAI 兼容）---
mkdir -p "$PI_HOME"
if [ ! -f "$PI_HOME/models.json" ]; then
    # shellcheck disable=SC2086
    python3 - "$PI_HOME/models.json" "$NEW_API_BASE" "$RESEARCH_MODELS" <<'PY'
import json, sys
_, path, base, models_csv = sys.argv
models = [m.strip() for m in models_csv.split(",") if m.strip()]
cfg = {"providers": {"newapi": {
    "baseUrl": base.rstrip("/") + "/v1",
    "api": "openai-completions",
    "apiKey": "$NEW_API_KEY",  # 环境变量插值：容器内裸跑 pi 也能带上真实 key（脚本仍显式 --api-key 双保险)
    # nemotron 系思考控制：chat_template_kwargs.enable_thinking（无 low/med/high 档位，开=最高档）
    "thinkingFormat": "chat-template",
    "chatTemplateKwargs": {"enable_thinking": {"$var": "thinking.enabled"}},
    "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
    "models": [{"id": m} for m in models],
}}}
with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
PY
    log "seeded $PI_HOME/models.json"
    # 默认模型由 settings.json defaultModel 控制；无条件写，保证 RESEARCH_MODEL 环境变量优先于镜像烤入的静态值
    printf '{"defaultModel": "newapi/%s"}\n' "$RESEARCH_MODEL" > "$PI_HOME/settings.json"
    log "seeded $PI_HOME/settings.json (defaultModel=$RESEARCH_MODEL)"
fi

# --- GitHub 恢复（主持久化通道：本地缺看板时从仓库补回资料+会话记忆）---
if [ -n "${GITHUB_PAT:-}" ] && [ -n "${GITHUB_REPO:-}" ] && [ ! -f "$OUT_DIR/研究看板.md" ]; then
    mkdir -p "$OUT_DIR" "$LOG_DIR"
    python3 /opt/scripts/publish.py restore >> "$LOG_DIR/publish.log" 2>&1 || log "github restore failed（不影响启动）"
fi

# --- 播种研究看板（仅缺失时，恢复的数据优先）---
mkdir -p "$OUT_DIR" "$LOG_DIR" "$SESS_DIR"
if [ ! -f "$OUT_DIR/研究看板.md" ]; then
    cp /opt/agent/研究看板-seed.md "$OUT_DIR/研究看板.md"
    log "seeded 研究看板.md"
fi

# --- R2 恢复（配置了才生效； Northflank PATH 不含 /opt/scripts，必须全路径）---
/opt/scripts/restore-data.sh || log "restore failed/跳过，继续启动"

# --- 定时备份循环（可选）---
/opt/scripts/scheduled-backup.sh &
BACKUP_PID=$!

# --- 研究循环（前台主进程）---
log "first research round in ${RESEARCH_FIRST_DELAY_SECONDS}s, then every ${RESEARCH_INTERVAL_SECONDS}s"
sleep_until "$RESEARCH_FIRST_DELAY_SECONDS"
while :; do
    /opt/scripts/research-round.sh || log "research round failed（不影响主循环）"
    if [ -n "${GITHUB_PAT:-}" ] && [ -n "${GITHUB_REPO:-}" ]; then
        mkdir -p "$DATA_DIR/logs"
        python3 /opt/scripts/publish.py >> "$DATA_DIR/logs/publish.log" 2>&1 || { tail -15 "$DATA_DIR/logs/publish.log" >&2; log "publish failed（详情见上方 stderr）"; }
    fi
    if [ -n "${BACKUP_PASSWORD:-}" ]; then
        /opt/scripts/backup-data.sh || log "post-round backup failed"
    fi
    sleep_until "$RESEARCH_INTERVAL_SECONDS"
done
