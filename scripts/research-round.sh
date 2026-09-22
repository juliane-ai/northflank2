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
query_file="$PROMPT_FILE"
if [ -n "${RESEARCH_TOPIC_IDS:-}" ]; then
    case "$RESEARCH_TOPIC_IDS" in
        *[!0-9,]*|,*|*,,*|,*) echo "[research-round] invalid RESEARCH_TOPIC_IDS=$RESEARCH_TOPIC_IDS" >> "$log"; exit 0 ;;
    esac
    query_file="$LOG_DIR/round-$ts.prompt.md"
    cat "$PROMPT_FILE" > "$query_file"
    cat >> "$query_file" <<EOF

## 主题分区硬约束

本 agent 只允许研究看板编号属于 { $RESEARCH_TOPIC_IDS } 的「待研究」项；更高优先级但不属于该集合的主题也必须跳过。若集合内没有可研究主题，不要新建研报，不要改看板状态，只输出「本轮无分配主题」。
EOF
    chmod 600 "$query_file"
fi

PI_HOME="${PI_HOME:-/root/.pi/agent}"
if [ ! -f "$PI_HOME/models.json" ] && [ -n "${NEW_API_BASE:-}" ]; then
    mkdir -p "$PI_HOME"
    # shellcheck disable=SC2086
    python3 - "$PI_HOME/models.json" "$NEW_API_BASE" "$RESEARCH_MODELS" "$RESEARCH_MODEL" <<'PY'
import json, os, sys
_, path, base, models_csv, default_model = sys.argv
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
settings = os.path.join(os.path.dirname(path), "settings.json")
open(settings, "w").write('{"defaultModel": "newapi/%s"}\n' % default_model)
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
    --thinking high \
    --api-key "$NEW_API_KEY" \
    "$(cat "$query_file")" >> "$log" 2>&1
rc=$?
echo "[research-round] exit=$rc $(date '+%F %T')" >> "$log"

# 看板回写（agent 常在报告写完后被超时掐掉，看板更新不靠自觉）
python3 /opt/scripts/board-sync.py >> "$log" 2>&1 || true

# 轮次结果摘要（研报数 + 最新看板更新时间）
ls -1t "$OUT_DIR"/20*.md 2>/dev/null | head -3 >> "$log" || true
exit 0
