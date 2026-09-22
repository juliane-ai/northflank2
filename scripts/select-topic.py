#!/usr/bin/env python3
"""Select the first waiting board topic assigned to this agent."""
import os
import sys
from pathlib import Path

raw_ids = os.environ.get("RESEARCH_TOPIC_IDS", "").strip()
if not raw_ids:
    print("MISSING_RESEARCH_TOPIC_IDS", file=sys.stderr)
    raise SystemExit(1)
try:
    assigned = {int(item) for item in raw_ids.split(",") if item.strip()}
except ValueError:
    print(f"INVALID_RESEARCH_TOPIC_IDS={raw_ids}", file=sys.stderr)
    raise SystemExit(1)

board = Path(os.environ.get("RESEARCH_OUTPUT_DIR", "/opt/data/outputs")) / "研究看板.md"
if not board.is_file():
    print("MISSING_BOARD", file=sys.stderr)
    raise SystemExit(1)

for line in board.read_text(encoding="utf-8").splitlines():
    if not line.startswith("|"):
        continue
    cells = [cell.strip() for cell in line.split("|")]
    # split('|') yields ['', number, topic, priority, status, ...]
    if len(cells) < 6 or not cells[1].isdigit():
        continue
    topic_id = int(cells[1])
    if topic_id in assigned and cells[4] == "待研究":
        print(f"# {topic_id} {cells[2]}")
        raise SystemExit(0)

print("NO_ASSIGNED_TOPIC")
