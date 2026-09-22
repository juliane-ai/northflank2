# northflank2 — 7×24 量化研究员（pi agent 版）

一个部署在 Northflank、全天候运行的量化策略研究 AI。基于 [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
（`pi -p` 非交互 + session 续接），持续研究 `g02-ritup-repo02-mix`（OKX 跟单研究台）的
量化策略与 agent 架构，产出研报到持久化目录。

姊妹项目 `northflank1` 是同一套研究的 **Hermes Agent 内核版**（带 dashboard），两者共用同一份
研究人格与知识库，可作 A/B 对比。

## 架构

```text
northflank2/（本仓库 = Northflank 构建上下文）
├── Dockerfile              node:24-bookworm-slim + pi + python3
├── entrypoint.sh           启动：GitHub outputs 恢复 → R2 恢复 → 播种 → 研究循环 + 备份循环
├── agent/
│   ├── SOUL.md             「量化研究员」人格（与 northflank1 完全一致）
│   ├── round-prompt.md     每轮研究任务指令
│   └── 研究看板-seed.md     初始研究主题队列
├── knowledge/              g02 仓库只读快照，烤进镜像挂 /knowledge
├── scripts/
│   ├── research-round.sh   单轮研究：pi --continue 非交互执行，session 续接积累上下文
│   └── backup-data.sh 等   R2 (Cloudflare Worker) 备份/恢复
└── old/                    旧模板，不参与构建，不要动
```

运行时（无 dashboard，Northflank 用 **Background Worker** 类型部署）：

```text
entrypoint.sh
├── publish.py restore（GITHUB_BASE=pi，仅 outputs，可选）
├── restore-data（R2，可选）→ /opt/data
├── 播种 /root/.pi/agent/models.json 与 outputs/研究看板.md（仅在缺失时）
├── scheduled-backup 循环（可选）
└── 研究循环：首轮延时后开跑，之后每 RESEARCH_INTERVAL_SECONDS 一轮
    每轮 = pi -p --continue --session-dir /opt/data/pi-sessions（上下文跨轮累积）
```

LLM 走 new-api 中转（OpenAI 兼容，`models.json` 声明自定义 provider `newapi`），默认 `z-ai/glm-5.3`。

## 研究搜索

Agent 研究时可调用已部署的 SearXNG JSON API（`SEARCH_API_URL`，默认指向 g02-ritup-repo01-search 服务）检索外部资料；关键结论需附来源 URL。

## Northflank 部署

1. 创建 **Background Worker** Service（无 HTTP 端口），从 Git 仓库 `juliane-ai/northflank2` 构建。
2. 环境变量见 `.env.example`。与 northflank1 相比，`GITHUB_BASE` 必须保持 `pi`，
   `BACKUP_OBJECT_KEY` 默认 `northflank2/data.tar.gz.enc`；两个隔离 base 避免互相覆盖。
3. 看研究进展：R2 备份拉回 `outputs/`，或进容器看 `/opt/data/outputs/`。

## 本地构建与冒烟

```bash
docker build -t quant-pi .
# 单轮研究冒烟（真实调用 LLM）
docker run --rm -e NEW_API_KEY=sk-xxx \
  --entrypoint /opt/scripts/research-round.sh quant-pi
# 完整入口冒烟（不调 LLM）
docker run --rm -e NEW_API_KEY=sk-xxx -e RESEARCH_FIRST_DELAY_SECONDS=3600 quant-pi
```

## 与 northflank1 的差异

| | northflank1 (Hermes) | northflank2 (pi) |
| --- | --- | --- |
| 内核 | nousresearch/hermes-agent 官方镜像 | npm 安装 pi（固定版本） |
| 常驻形态 | gateway + dashboard :9119 | 纯循环，无端口 |
| 跨轮记忆 | hermes session（--continue 命名会话） | pi session 文件（--session-dir） |
| 部署类型 | Combined Service（带端口） | Background Worker |
| 运维入口 | 浏览器 dashboard 直接对话/查看 | 日志 + outputs 文件 |

研究人格、知识库、看板一致，但 GitHub base 隔离：northflank1 用 `main`，本服务用 `pi`。GitHub 只同步 `outputs/` 的人类可读产物；pi session、运行时状态和缓存走 R2 加密冷备。

## 注意

- pi 以 root 运行且带 bash 工具，但容器本身就是隔离边界；不要往镜像/挂载里放敏感凭据以外的 anything。
- `/knowledge` 对 agent 只读；无真实行情数据源，结论会标注「待验证」。
- 研究日志在 `/opt/data/outputs/logs/round-*.log`。

## 已知限制（ponytail: 记录上限，触发再升级）

- **A/B 主题仍需人工分派**：本服务使用 `GITHUB_BASE=pi`，northflank1 使用 `main`，不会再互相覆盖；但两个 base 中的看板仍可能同时选择同一个待研究主题。
- **模型兼容**：`openai/gpt-oss-20b` 经 openai-completions 中转会产出畸形工具调用（工具名混入 `<|channel|>` 残留，上游 IndexError）。研究轮用默认 `nvidia/nemotron-3-super-120b-a12b`（gpt-oss-20b 有工具调用缺陷）。
- **restore 语义**：重启只从 `pi` base 恢复 outputs；未合并 `research/*` 分支不参与恢复。若 `pi` 分支不存在，会从默认分支引导。
