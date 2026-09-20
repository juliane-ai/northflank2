#!/bin/sh
# 单轮研究：pi 非交互执行 round-prompt，session-dir 内自动续接积累上下文。
# 单轮失败只记日志不退出非零，避免拖垮主循环。
set -u

PROMPT_FILE="${PROMPT_FILE:-/opt/agent/round-prompt.md}"
ROUND_TIMEOUT="${ROUND_TIMEOUT_SECONDS:-1800}"
OUT_DIR="${RESEARCH_OUTPUT_DIR:-/opt/data/outputs}"
LOG_DIR="$OUT_DIR/logs"
SESS_DIR="${PI_SESSION_DIR:-/opt/data/pi-sessions}"

mkdir -p "$LOG_DIR" "$SESS_DIR"
# 看板自播（entrypoint 未跑时如冒烟/灾后冷启动；恢复的数据优先）
if [ ! -f "$OUT_DIR/研究看板.md" ] && [ -f /opt/agent/研究看板-seed.md ]; then
    mkdir -p "$OUT_DIR"
    cp /opt/agent/研究看板-seed.md "$OUT_DIR/研究看板.md"
fi
ts=$(date +%Y%m%d-%H%M%S)
log="$LOG_DIR/round-$ts.log"

# provider 配置自足：entrypoint 播种过则跳过（幂等）
PI_HOME="${PI_HOME:-/root/.pi/agent}"
if [ ! -f "$PI_HOME/models.json" ] && [ -n "${NEW_API_BASE:-}" ]; then
    mkdir -p "$PI_HOME"
    # shellcheck disable=SC2086
    python3 - "$PI_HOME/models.json" "$NEW_API_BASE" "$RESEARCH_MODELS" <<'PY'
import json, sys
_, path, base, models_csv = sys.argv
models = [m.strip() for m in models_csv.split(",") if m.strip()]
cfg = {"providers": {"newapi": {
    "baseUrl": base.rstrip("/") + "/v1",
    "api": "openai-completions",
    "apiKey": "newapi",  # 占位，运行时由 --api-key 传入真实 key
    "compat": {"supportsDeveloperRole": False, "supportsReasoningEffort": False},
    "models": [{"id": m} for m in models],
}}}
with open(path, "w") as f:
    json.dump(cfg, f, indent=2, ensure_ascii=False)
PY
fi

# 已有会话则续接，否则新开
if [ -n "$(ls -A "$SESS_DIR" 2>/dev/null)" ]; then
    set -- --continue
else
    set --
fi

echo "[research-round] start $(date '+%F %T')" >> "$log"
# shellcheck disable=SC2046
timeout "$ROUND_TIMEOUT" pi -p "$@" \
    --session-dir "$SESS_DIR" \
    --provider newapi \
    --model "$RESEARCH_MODEL" \
    --api-key "$NEW_API_KEY" \
    "$(cat "$PROMPT_FILE")" >> "$log" 2>&1
rc=$?
echo "[research-round] exit=$rc $(date '+%F %T')" >> "$log"

# 轮次结果摘要（研报数 + 最新看板更新时间）
ls -1t "$OUT_DIR"/20*.md 2>/dev/null | head -3 >> "$log" || true
exit 0
