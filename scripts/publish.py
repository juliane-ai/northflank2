#!/usr/bin/env python3
"""研究产出 → 私有 GitHub 仓库（issue + PR 流程）。

publish：只同步 DATA_DIR/outputs 中的人类可读研究产物（不同步 logs、数据库、
  会话缓存或运行时二进制），为每篇新研报开 issue，并创建 research/<timestamp> PR。
restore：只从配置的 GITHUB_BASE 分支恢复 outputs；不再读取未合并 research/* 分支。
环境变量：GITHUB_REPO=owner/name，GITHUB_PAT=token，GITHUB_BASE=main，DATA_DIR=/opt/data
"""
import json
import os
import re
import secrets
import shutil
import subprocess
import time
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = os.environ["GITHUB_REPO"]
PAT = os.environ["GITHUB_PAT"]
BASE = os.environ.get("GITHUB_BASE", "main")
DATA = Path(os.environ.get("DATA_DIR", "/opt/data"))
API = f"https://api.github.com/repos/{REPO}"
TZ = timezone(timedelta(hours=8))
REPORT_RE = re.compile(r"^20\d{2}-\d{2}-\d{2}-.+\.md$")
IGNORE = shutil.ignore_patterns(
    ".env", ".env.*", "*.key", "*.pem", "config.yaml*", "logs",
    "backups", "bin", "cache", "lazy-packages", "__pycache__", "*.pyc", "*.sock",
)


def _ignore_nonregular(dir, names):
    """跳过 socket/fifo 等非普通文件。"""
    skip = list(IGNORE(dir, names))
    for name in names:
        path = os.path.join(dir, name)
        if name in skip:
            continue
        if os.path.exists(path) and not os.path.isfile(path) and not os.path.isdir(path):
            skip.append(name)
    return skip


def api(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        method=method,
        headers={"Authorization": f"Bearer {PAT}", "Accept": "application/vnd.github+json"},
        data=json.dumps(body).encode() if body is not None else None,
    )
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response) if response.status != 204 else {}


def _redact_completed(result):
    """避免 Git 错误信息把带 token 的 remote URL 打进容器日志。"""
    result.stdout = result.stdout.replace(PAT, "***")
    result.stderr = result.stderr.replace(PAT, "***")
    return result


def git(*args, cwd, check=True):
    result = subprocess.run(
        ("git", *args), cwd=cwd, check=False, capture_output=True, text=True
    )
    result = _redact_completed(result)
    if check and result.returncode:
        raise subprocess.CalledProcessError(
            result.returncode, result.args, stdout=result.stdout, stderr=result.stderr
        )
    return result


def git_push_retry(branch, cwd, attempts=3):
    """push 对瞬断重试；只输出脱敏后的 Git 错误。"""
    git("config", "http.postBuffer", "524288000", cwd=cwd)
    last = None
    for attempt in range(attempts):
        result = git("push", "-u", "origin", branch, cwd=cwd, check=False)
        if result.returncode == 0:
            return result
        last = result
        if attempt < attempts - 1:
            time.sleep(5 * (attempt + 1))
    raise subprocess.CalledProcessError(
        last.returncode, last.args, stdout=last.stdout, stderr=last.stderr
    )


def _repo_url():
    return f"https://x-access-token:{PAT}@github.com/{REPO}.git"


def clone_to(work):
    """Clone GITHUB_BASE; bootstrap a new base branch from the default branch."""
    url = _repo_url()
    branch_exists = git(
        "ls-remote", "--heads", url, BASE, cwd="/tmp", check=False
    ).stdout.strip()
    if branch_exists:
        git("clone", "--depth", "1", "--branch", BASE, url, work, cwd="/tmp")
    else:
        git("clone", "--depth", "1", url, work, cwd="/tmp")
        git("checkout", "-B", BASE, cwd=work)
    git("config", "user.name", "quant-research-bot", cwd=work)
    git("config", "user.email", "quant-research-bot@users.noreply.github.com", cwd=work)


def topic_of(name):
    return re.sub(r"^20\d{2}-\d{2}-\d{2}-", "", name[:-3])


def _board_id(line):
    """Return the numeric topic ID for a board row, or None."""
    if not line.startswith("|"):
        return None
    cells = [cell.strip() for cell in line.split("|")]
    if len(cells) < 6 or not cells[1].isdigit():
        return None
    return int(cells[1])


def _merge_board(base_text, local_text):
    """Merge externally added board rows without reverting local row updates.

    A long-running volume can hold an older board while an operator adds a new
    topic to GITHUB_BASE.  Local rows win for the same ID; base-only IDs are
    appended in base order so deterministic topic assignment cannot regress.
    """
    base_lines = base_text.splitlines()
    base_rows = {}
    for line in base_lines:
        topic_id = _board_id(line)
        if topic_id is not None:
            base_rows[topic_id] = line

    if not base_rows:
        return local_text

    result = []
    seen = set()
    last_row = -1
    for line in local_text.splitlines():
        result.append(line)
        topic_id = _board_id(line)
        if topic_id is not None:
            seen.add(topic_id)
            last_row = len(result) - 1

    additions = [line for topic_id, line in base_rows.items() if topic_id not in seen]
    if not additions:
        return local_text

    if last_row < 0:
        if result and result[-1].strip():
            result.append("")
        result.extend(additions)
    else:
        result[last_row + 1:last_row + 1] = additions
    return "\n".join(result) + "\n"


def _merge_experience(base_text, local_text):
    """Preserve base-only method notes while retaining the runtime append order."""
    local_lines = local_text.splitlines()
    local_set = set(local_lines)
    additions = [
        line for line in base_text.splitlines()
        if line.strip() and line not in local_set
    ]
    if not additions:
        return local_text
    if local_lines and local_lines[-1].strip():
        local_lines.append("")
    return "\n".join(local_lines + additions) + "\n"


def _merge_shared_output_state(base_path, local_path, state_name=None):
    base_text = base_path.read_text(encoding="utf-8")
    local_text = local_path.read_text(encoding="utf-8")
    if not local_text.strip():
        if not base_text.strip():
            return False
        local_path.write_text(base_text, encoding="utf-8")
        return True
    state_name = state_name or local_path.name
    if state_name == "研究看板.md":
        merged = _merge_board(base_text, local_text)
    elif state_name == "研究经验.md":
        merged = _merge_experience(base_text, local_text)
    else:
        return False
    if merged == local_text:
        return False
    local_path.write_text(merged, encoding="utf-8")
    return True


def _copy_outputs(work):
    src = DATA / "outputs"
    if not src.is_dir():
        print(f"[publish] outputs 目录不存在，跳过同步：{src}")
        return False
    target = Path(work) / "data" / "outputs"
    shared_base = {}
    for name in ("研究看板.md", "研究经验.md"):
        base_path = target / name
        if base_path.is_file():
            shared_base[name] = base_path.read_text(encoding="utf-8")

    shutil.copytree(
        src,
        target,
        dirs_exist_ok=True,
        ignore=_ignore_nonregular,
    )

    # copytree lets a stale runtime board overwrite the newer base board.  Re-add
    # base-only rows/notes after copying so an old volume cannot remove an
    # operator-added topic in the generated research PR.
    for name, base_text in shared_base.items():
        local_path = target / name
        if local_path.is_file():
            base_backup = target.parent / f".{name}.base"
            base_backup.write_text(base_text, encoding="utf-8")
            _merge_shared_output_state(base_backup, local_path, name)
            base_backup.unlink()
    return True


def _known_issue_titles():
    titles = set()
    page = 1
    while True:
        items = api("GET", f"/issues?state=all&per_page=100&page={page}")
        if not items:
            break
        titles.update(item["title"] for item in items if "pull_request" not in item)
        if len(items) < 100:
            break
        page += 1
    return titles


def publish():
    now = datetime.now(TZ)
    stamp = now.strftime("%Y%m%d-%H%M%S")
    suffix = secrets.token_hex(3)
    work = f"/tmp/publish-{stamp}-{suffix}"
    clone_to(work)
    if not _copy_outputs(work):
        return
    if not git("status", "--porcelain", cwd=work).stdout.strip():
        print("[publish] 无新产出，跳过")
        return

    new_reports = []
    for filename in sorted(os.listdir(DATA / "outputs")):
        path = DATA / "outputs" / filename
        if not filename.endswith(".md") or not path.is_file() or not REPORT_RE.match(filename):
            continue
        rel = f"data/outputs/{filename}"
        if git("status", "--porcelain", "--", rel, cwd=work).stdout.strip():
            new_reports.append(filename)

    known = _known_issue_titles()
    issue_nums = {}
    for filename in new_reports:
        title = topic_of(filename)
        if title in known:
            continue
        issue = api("POST", "/issues", {
            "title": title,
            "body": f"研报已产出：`data/outputs/{filename}`（{now:%Y-%m-%d %H:%M}）\n待 PR 审核合并后归档。",
        })
        issue_nums[title] = issue["number"]
        print(f"[publish] issue #{issue['number']}: {title}")

    git("add", "-A", cwd=work)
    title_part = ", ".join(topic_of(filename) for filename in new_reports[:3])
    message = f"research: {now:%Y-%m-%d %H:%M} " + title_part
    branch = f"research/{stamp}-{suffix}"
    git("checkout", "-B", branch, cwd=work)
    git("commit", "-m", message, cwd=work)
    git_push_retry(branch, cwd=work)

    closes = "\n".join(f"Closes #{number}" for number in issue_nums.values())
    pull = api("POST", "/pulls", {
        "title": f"研究归档 {now:%Y-%m-%d %H:%M}",
        "head": branch,
        "base": BASE,
        "body": f"本轮研究产出自动归档：{len(new_reports)} 篇新研报；仅同步 outputs，不同步运行时状态。\n\n{closes}".strip(),
    })
    print(f"[publish] PR: {pull['html_url']}")


def restore():
    work = "/tmp/restore"
    shutil.rmtree(work, ignore_errors=True)
    clone_to(work)
    src = Path(work) / "data" / "outputs"
    if not src.is_dir():
        print(f"[restore] {BASE} 分支无 data/outputs，跳过")
        return

    count = 0
    for source in src.rglob("*"):
        if not source.is_file():
            continue
        relative = source.relative_to(src)
        if "logs" in relative.parts or IGNORE(str(source.parent), [source.name]):
            continue
        destination = DATA / "outputs" / relative
        if destination.exists():
            if destination.name in ("研究看板.md", "研究经验.md"):
                before = destination.read_text(encoding="utf-8")
                _merge_shared_output_state(source, destination)
                if destination.read_text(encoding="utf-8") != before:
                    count += 1
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, destination)
        count += 1
    print(f"[restore] 从 {BASE} 分支补回 {count} 个研究产出文件到 {DATA / 'outputs'}")


if __name__ == "__main__":
    try:
        restore() if len(sys.argv) > 1 and sys.argv[1] == "restore" else publish()
    except Exception as exc:  # noqa: BLE001 — 失败必须可见，由 entrypoint 记日志
        stderr = getattr(exc, "stderr", None)
        detail = f"\n{str(stderr)[-500:]}" if stderr else ""
        print(f"[publish] FAILED: {exc}{detail}", file=sys.stderr)
        sys.exit(1)
