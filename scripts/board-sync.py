# 看板确定性回写：新研报出现 → 翻转对应主题行状态为「已产出」（不依赖 agent 自觉）
import re, glob, os
board = "/opt/data/outputs/研究看板.md"
reports = sorted(glob.glob("/opt/data/outputs/20*.md"))
if not (os.path.exists(board) and reports):
    raise SystemExit
newest = reports[-1]
m = re.search(r"看板[第\s]*#?\s*(\d+)", open(newest, encoding="utf-8").read(400))
if not m:
    raise SystemExit
n = m.group(1)
lines = open(board, encoding="utf-8").read().split("\n")
out = []
for l in lines:
    if l.startswith("|") and l.split("|")[1].strip() == n and "已产出" not in l:
        parts = l.split("|")
        parts[4] = f" 已产出 → {os.path.basename(newest)} "
        l = "|".join(parts)
    out.append(l)
open(board, "w", encoding="utf-8").write("\n".join(out))
