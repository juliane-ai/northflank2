#!/usr/bin/env python3
"""研究资料与会话记忆 → 私有 GitHub 仓库（issue + PR 流程）。主持久化通道。

publish（默认）：/opt/data 全量同步到仓库 data/（排除 .env 等密钥），新研报各开
  issue（按标题去重），research/<ts> 分支提交 + 开 PR（Closes #N）。
restore：启动时用 —— 本地 /opt/data 缺看板且仓库有 data/ 时，把仓库数据补回本地
  （只补缺失文件，不覆盖本地已有）。
环境变量：GITHUB_REPO=owner/name，GITHUB_PAT=token，GITHUB_BASE=main，DATA_DIR=/opt/data
"""
import json
import os
import re
import shutil
import subprocess
import time
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

REPO = os.environ["GITHUB_REPO"]
PAT = os.environ["GITHUB_PAT"]
BASE = os.environ.get("GITHUB_BASE", "main")
DATA = os.environ.get("DATA_DIR", "/opt/data")
API = f"https://api.github.com/repos/{REPO}"
TZ = timezone(timedelta(hours=8))
REPORT_RE = re.compile(r"^20\d{2}-\d{2}-\d{2}-.+\.md$")
# 密钥绝不上仓库：.env 与 config.yaml*（含 api_key，及 hermes 的 config.yaml.good.* 备份）都不同步；
# backups/bin/cache 是 hermes 运行时产物（含 33MB tirith 二进制），同步上去是纯膨胀
IGNORE = shutil.ignore_patterns(".env", "*.key", "*.pem", "config.yaml*", "backups/", "bin/", "cache/", "*.sock", "__pycache__/", "*.pyc")


def _ignore_nonregular(dir, names):
    """跳过 socket/fifo 等非普通文件：gateway 运行时会在 DATA_DIR 放 unix socket，
    copytree 拷它们直接 Errno 6 崩掉（Northflank 完整启动后 publish 失败的元凶）。"""
    skip = list(IGNORE(dir, names))
    for n in names:
        p = os.path.join(dir, n)
        if n in skip:
            continue
        if os.path.exists(p) and not os.path.isfile(p) and not os.path.isdir(p):
            skip.append(n)
    return skip


def api(method, path, body=None):
    req = urllib.request.Request(
        API + path, method=method,
        headers={"Authorization": f"Bearer {PAT}", "Accept": "application/vnd.github+json"},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r) if r.status != 204 else {}


def git(*args, cwd, check=True):
    return subprocess.run(("git", *args), cwd=cwd, check=check,
                          capture_output=True, text=True)


def git_push_retry(branch, cwd, attempts=3):
    """push 对瞬断（代理 TLS 掐断、网络抖动）重试；大 postBuffer 缓解 rpc rewind 报错。"""
    git("config", "http.postBuffer", "524288000", cwd=cwd)
    last = None
    for i in range(attempts):
        r = git("push", "-u", "origin", branch, cwd=cwd, check=False)
        if r.returncode == 0:
            return r
        last = r
        if i < attempts - 1:
            time.sleep(5 * (i + 1))
    raise subprocess.CalledProcessError(last.returncode, last.args,
                                        stdout=last.stdout, stderr=last.stderr)


def clone_to(work):
    url = f"https://x-access-token:{PAT}@github.com/{REPO}.git"
    git("clone", "--depth", "1", url, work, cwd="/tmp")
    git("config", "user.name", "quant-research-bot", cwd=work)
    git("config", "user.email", "quant-research-bot@users.noreply.github.com", cwd=work)


def topic_of(name):
    """YYYY-MM-DD-主题.md → 主题"""
    return re.sub(r"^20\d{2}-\d{2}-\d{2}-", "", name[:-3])


def publish():
    ts = datetime.now(TZ)
    stamp = ts.strftime("%Y%m%d-%H%M%S")
    work = f"/tmp/publish-{stamp}"
    clone_to(work)
    empty = git("rev-parse", "--verify", "HEAD", cwd=work, check=False).returncode != 0

    shutil.copytree(DATA, os.path.join(work, "data"), dirs_exist_ok=True, ignore=_ignore_nonregular)
    if not git("status", "--porcelain", cwd=work).stdout.strip():
        print("[publish] 无新产出，跳过")
        return

    out_reports = os.path.join(DATA, "outputs")
    new_reports = []
    if os.path.isdir(out_reports):
        for f in sorted(os.listdir(out_reports)):
            if REPORT_RE.match(f) and git(
                    "status", "--porcelain", "--", f"data/outputs/{f}", cwd=work).stdout.strip():
                new_reports.append(f)

    # 新研报 → issue（按主题标题去重，含已关闭的）
    known = {i["title"] for i in api("GET", "/issues?state=all&per_page=100")}
    issue_nums = {}
    for f in new_reports:
        title = topic_of(f)
        if title in known:
            continue
        num = api("POST", "/issues", {
            "title": title,
            "body": f"研报已产出：`data/outputs/{f}`（{ts:%Y-%m-%d %H:%M}）\n待 PR 审核合并后归档。",
        })["number"]
        issue_nums[title] = num
        print(f"[publish] issue #{num}: {title}")

    git("add", "-A", cwd=work)
    msg = f"research: {ts:%Y-%m-%d %H:%M} " + ", ".join(topic_of(f) for f in new_reports[:3])
    if empty:
        git("checkout", "-B", BASE, cwd=work)
        git("commit", "-m", msg, cwd=work)
        git_push_retry(BASE, cwd=work)
        print(f"[publish] 空仓库已引导 {BASE} 分支（首轮不开发 PR）")
        return

    branch = f"research/{stamp}"
    git("checkout", "-B", branch, cwd=work)
    git("commit", "-m", msg, cwd=work)
    git_push_retry(branch, cwd=work)

    closes = "\n".join(f"Closes #{n}" for n in issue_nums.values())
    pr = api("POST", "/pulls", {
        "title": f"研究归档 {ts:%Y-%m-%d %H:%M}",
        "head": branch, "base": BASE,
        "body": f"本轮研究产出自动归档：{len(new_reports)} 篇新研报；含会话记忆同步。\n\n{closes}".strip(),
    })
    print(f"[publish] PR: {pr['html_url']}")


def latest_research_branch():
    """最新的 research/* 分支名（名字含时间戳可直接排序）；无则 None"""
    r = subprocess.run(("git", "ls-remote", f"https://x-access-token:{PAT}@github.com/{REPO}.git",
                        "refs/heads/research/*"), capture_output=True, text=True, check=True)
    refs = [ln.split()[1] for ln in r.stdout.splitlines() if ln.strip()]
    return refs[-1].removeprefix("refs/heads/") if refs else None


def restore():
    work = "/tmp/restore"
    shutil.rmtree(work, ignore_errors=True)
    branch = latest_research_branch()
    if branch:
        url = f"https://x-access-token:{PAT}@github.com/{REPO}.git"
        git("clone", "--depth", "1", "--branch", branch, url, work, cwd="/tmp")
        print(f"[restore] 从最新研究分支 {branch} 恢复（可能含未合并 PR 的内容）")
    else:
        clone_to(work)
    src = os.path.join(work, "data")
    if not os.path.isdir(src):
        print("[restore] 仓库无 data/，跳过")
        return
    n = 0
    for root, _, files in os.walk(src):
        dst_dir = os.path.join(DATA, os.path.relpath(root, src))
        os.makedirs(dst_dir, exist_ok=True)
        for f in files:
            dst = os.path.join(dst_dir, f)
            if not os.path.exists(dst):  # 只补缺失，不覆盖本地
                shutil.copy2(os.path.join(root, f), dst)
                n += 1
    print(f"[restore] 补回 {n} 个文件到 {DATA}")


if __name__ == "__main__":
    try:
        restore() if len(sys.argv) > 1 and sys.argv[1] == "restore" else publish()
    except Exception as e:  # noqa: BLE001 — 失败必须可见，由 entrypoint 记日志
        err = getattr(e, "stderr", None)
        print(f"[publish] FAILED: {e}" + (f"\n{str(err)[-500:]}" if err else ""), file=sys.stderr)
        sys.exit(1)
