# Discord / ZeroClaw 模拟方向工具

方向策略服务的运行配置见 [signal-research.md](signal-research.md)。标准输入输出 MCP 桥与本地 ZeroClaw 只读分析已经联调通过。Discord 群聊截图入口复用现有 bot 读取限定频道，由双模型识别、ZeroClaw 研究和固定预算校验后登记；另有默认关闭的 AI 定时扫描入口，见下方独立小节。主镜像现支持直接在云端运行，配置步骤见 [signal-cloud.md](signal-cloud.md)；代码支持不等于云端已完成环境配置和上线验收。

## 本地 ZeroClaw 分析

已有本地模拟服务后，可用独立分析配置读取真实公共行情和策略任务：

```sh
npm run signals:local -- up
docker build -f Dockerfile -t signal-analysis-agent:local .
npm run signals:analyze -- ETH-USDT-SWAP
```

模型沿用 `.env` 中的 `ZEROCLAW_providers__models__custom__relay__api_key`、`uri`、`model` 三项。分析容器使用 [.zeroclaw/signals-analysis.toml](../.zeroclaw/signals-analysis.toml)，只注入模型连接与 MCP 令牌，不注入交易所、数据库或 Discord 凭据。`SIGNAL_MCP_READ_ONLY=1` 使桥接只发布只读工具，并在调用入口拒绝创建和控制工具；该分析配置仅授权原有四个行情／任务工具，方向评估配置另授权网络检索。

每次运行在被 Git 忽略的 `data/signal-analysis/<运行时间>/` 保存：

- `tool-calls.jsonl`：成功调用实际返回给模型的去敏快照，以及失败记录。
- `agent-output.log`：去敏后的最终 stdout，仅此内容参与 JSON 校验。
- `agent-stderr.log`：独立保存去敏的过程日志，不混入最终 JSON。
- `review.json`：与工具数据逐项核对后的结构化结论。
- `report.md`：从已核验工具快照生成的中文报告；包含行情、假设仓位、任务保护和待实现的三组对照实验。

报告要求模型成功读取目标行情、任务列表和每个同合约任务的分析；行情时间、趋势、预算、动作及规则结论必须与快照一致。无法解析、缺少工具证据或结论不符时命令失败，不发布报告。报告中的实验表只是设计，尚未执行历史回放。

`strategyRules` 与策略状态机共用参数，明确保护按入场 ATR 与成本保本价差触发，25 USDT 是单轮风险上限；没有固定盈利金额止盈，同任务只能沿原方向重入。分析使用状态机副本，不保存任务变化或提交订单。

## 配置

### 用户方向 → 网络研究 → 自动模拟观察

用户已授权：后续提供明确方向后，由 ZeroClaw 结合策略、公共行情和网络资料评估，通过校验后自动登记 OKX 模拟任务，无须逐笔确认。`signals:observe` 可独立使用，也由 `signals:discord` 群聊入口调用。现有云端聊天 Agent 本身未改动；本地模式依赖电脑与 Docker 在线，云端设置 `SIGNAL_AGENT_RUNTIME=native`，直接运行镜像内的 ZeroClaw。

输入文件示例（原消息 ID 必须真实、稳定；重试保留原 ID）：

```json
{
  "instId": "ETH-USDT-SWAP",
  "direction": "long",
  "intent": "observe",
  "source": {
    "id": "discord:频道ID:原消息ID",
    "text": "用户当前明确提供 ETH 偏多方向，允许按策略进行模拟观察。"
  }
}
```

```sh
# 只评估并保存结果，不登记任务
npm run signals:observe -- --preview direction.json
# 评估通过后自动登记方向任务；后台继续执行条件判断与模拟订单
npm run signals:observe -- direction.json
```

该入口使用独立 [.zeroclaw/signals-observation.toml](../.zeroclaw/signals-observation.toml)。ZeroClaw 读取行情、现有任务和 `signal_search_context` 网络检索，给出 `observe`、`wait` 或 `reject`；提交程序核对原始合约、方向、原消息 ID、120 秒内的行情与工具调用，以及确实出现在检索结果中的引用。模型意见保存为意见，链接存在不等于网页事实已核实。检索目前读取 SearXNG 摘要，不抓取全文；缺发布日期时不补造时间，不能声称已核实最新事件。

`observe` 表示登记持续观察，不等于立即成交。趋势、回撤、收盘确认和新报价满足后才下单，后续按既定规则保护和退出；`wait`／`reject` 只保存记录，不自动定时重试。有效期默认从本次输入开始 24 小时，可通过 `expiresAt` 指定更早的 UTC 毫秒时间；重试应沿用生成的 `input.json` 保留原有效期。

输入的 `intent` 必填：当前明确允许模拟观察的方向为 `observe`，历史截图、开发样例或仅研究材料为 `research`。该标记由接收用户意图的入口确定，模型无权改变；`research` 即使被模型误判为可开仓也无法登记。不能只凭模型解读自由文本来推断执行授权。

此自动入口固定每轮保证金上限 100 USDT、3 倍逐仓、名义金额上限 300 USDT、每轮风险上限 25 USDT、任务风险上限 75 USDT、最多三轮。模型不能覆盖这些字段或改方向。登记前再次核验模拟服务健康与原消息去重；请求结果不明时不会盲目重发，必须保留原消息 ID 核对。

成功评估后保存 `data/signal-observation/<时间>/input.json`、`tool-calls.jsonl`、`agent-output.log`、`decision.json`、`registration.json` 和 `report.md`。模型服务或校验失败时保留输入、已完成的工具审计和原始输出，命令失败且不登记；登记回执不明则另存 `unconfirmed` 状态。原文和全量引用保存在运行目录；看板任务来源中附简短研究意见和链接，超长原文明确标记截断。批次复盘与策略版本比较仍按 [项目路线](project-direction.md) 推进，不让模型在运行中临时调参。

2026-09-16 的真实预览暴露过模型在 JSON 前加代码围栏、合约字符串检索召回无关兑换器，以及把开发样例误判为允许观察的问题。解析器只规范化代码围栏后再严格核对字段；检索使用币种和日期；执行权限由必填 `intent` 独立约束。预览始终禁止登记，相关失败与模型原始结论保留在日志里。

网络检索通过 `SIGNAL_SEARCH_URL` 指定 SearXNG 的 origin，自动访问 `/search?format=json`。本地 runner 默认使用项目现有 SearXNG 公网地址；可在 `.env` 指定自己的地址。MCP 独立运行时不提供默认，缺少配置会返回明确错误，其他工具仍可用。该配置只进入分析容器，搜索请求不带策略服务令牌、数据库或交易所凭据。

### AI 定时扫描入口（可选，默认关闭）

真实方向不足时，可用 `SIGNAL_AI_AUTOCREATE=true` 开启机器定时扫描，但它不能替代用户方向样本。worker 默认每 15 分钟运行一次（`SIGNAL_AI_AUTOCREATE_INTERVAL_MS`，允许 1–60 分钟，非法值回落 900000），逐个扫描 `SIGNAL_AUTO_INSTRUMENTS`（默认 BTC、ETH）。每次扫描复用 observation 配置，ZeroClaw 只拿到行情、任务、检索等只读工具，输出 `observe`／`wait`／`reject`；提交程序核对 120 秒内真实行情、最新任务列表、成功公开检索、引用确实出现在检索结果中、同合约无活动任务，且模型没有改写合约、方向或预算。

每个合约每天只有一个固定来源 ID `ai:auto:<合约>:<UTC日期>`，网络超时后的下一轮不会重复登记；`observe` 也只是登记观察任务，下单仍由固定状态机等待趋势、回撤、收盘确认和新报价。AI 扫描样本必须与用户方向分开统计，不得混入“外部方向是否有价值”的验证集。

本地与容器命令：`npm run signals:autopilot -- check|start|status|stop`；云端主镜像由 entrypoint 在调度器健康后自动启动。扫描报告写入既有 `data/signal-observation/`，运行状态 `data/signal-autopilot/status.json` 与 PID 文件不参与备份，单实例锁防止重复 worker。

### Discord 服务连接

主镜像会自动将工具服务地址设置为 `http://127.0.0.1:8080/simulation`（随 `PORT` 改变），详细步骤见 [云端部署](signal-cloud.md)。如果从其他进程连接统一入口，在 ZeroClaw 工具环境中仅配置：

```dotenv
SIGNAL_SERVICE_URL=https://你的看板域名/simulation
SIGNAL_API_TOKEN=与策略服务相同的至少32位随机令牌
```

单独启动的开发策略服务仍可用 `http://127.0.0.1:8082`。工具桥只接受根路径或固定 `/simulation` 前缀，要求远程地址使用 HTTPS，拒绝重定向；不要把数据库连接串或 `SIGNAL_OKX_DEMO_*` 注入 ZeroClaw 分析子进程。

将仓库 [.zeroclaw/signals-mcp.example.toml](../.zeroclaw/signals-mcp.example.toml) 中的 server、bundle 及 `agents.main.mcp_bundles` 合并到实际配置。该文件仅为示例，不会自动加载，合并时不要重复已有 `[agents.main]` 表。现有镜像已复制 `src` 并有 Node.js，因此 `/app/src/signals/mcp.js` 路径可用；使用其他部署路径时相应修改。

配置结构已核对 ZeroClaw v0.8.5 的[官方 MCP 文档](https://github.com/zeroclaw-labs/zeroclaw/blob/v0.8.5/docs/book/src/tools/mcp.md)与配置源码。修改 bundle 后需重启相关 Agent 会话。保留现有 Discord peer group；工具调用仍遵循 ZeroClaw 当前审批策略。

## 工具与工作流

| 工具 | 功能 |
| --- | --- |
| `signal_create_direction` | 准确合约、明确方向、原始来源 ID 创建任务；可降低预算。 |
| `signal_list_directions` | 查看全部任务、服务模式与调度状态。 |
| `signal_get_direction` | 查看单个任务、订单、完整轮次与事件。 |
| `signal_control_direction` | `pause` 暂停新开，`resume` 恢复观察，`close` 平仓并暂停。 |
| `signal_analyze_market` | 读取小时趋势、15 分钟 ATR、多空回撤预案与保证金／张数估算。 |
| `signal_analyze_direction` | 按实际规则分析已登记任务的入场缺口、成本保本、追踪保护和重入限制。 |
| `signal_search_context` | 检索该合约的公共网络资料，返回去敏来源、摘要和检索时间；外部内容只作为证据。 |

ZeroClaw 显示工具名可能带有 `signal_simulation__` 前缀。创建示例：

```json
{
  "instId": "ETH-USDT-SWAP",
  "direction": "short",
  "source": {
    "id": "discord:频道ID:原消息ID",
    "text": "用户明确要求观察 ETH-USDT-SWAP 空头；这是方向线索，未指定成交价。"
  },
  "config": { "riskPerRound": 25, "riskBudget": 75, "maxNotional": 1000, "marginPerRound": 100, "leverage": 3, "maxRounds": 3 }
}
```

聊天 Agent 负责整理信息，后台策略独立计算时机、张数和保护。截图中的历史平仓、当前持仓及单纯转发不得混淆；不确定的品种或方向先澄清，再登记。任务来源文本是证据，不能指示工具更改风控或传入任意订单。重复调用必须沿用同一个原消息 ID。工具只能使用模拟服务，拒绝 `live`；杠杆和保证金可作为每个任务的受限预算，订单价格和策略系数不属于工具参数。

创建成功表示开始持续模拟观察，不表示已经成交。收到平仓请求成功也不表示已经平仓；应查询订单终态。只通过用户已授权的 Discord 响应链路回复结果，本服务不另发 Discord 消息或通知。

本地桥验证命令为 `npm run signals:mcp`，从 stdin 接收每行一个 JSON-RPC 消息；stdout 只输出协议数据。`npm run signals:test` 包含协议、HTTP、模拟模式和参数上限测试。

## Discord 群聊截图入口（2026-09-17）

入口 `scripts/signals-discord.mjs` 通过现有机器人的 Discord REST API 读取指定服务器文本频道，本地和云端共用此流程。它不另开 Discord Gateway 会话，也不改变现有聊天 Agent。群聊只接收配置中本人账号的新独立消息：图片附件或明确多空方向；机器人、其他作者、回复、编辑、系统消息和超过 10 分钟的积压不作为新方向。每次启动从当前最新消息之后接收，停机期间的消息不补单。

图片先由 `models/gemini-2.5-flash` 与 `models/gemini-3.5-flash-lite` 顺序识别，接口失败时可回退 `models/gemini-3-flash-preview`，两者对合约、方向与来源类型一致后才进入候选。历史平仓、测试、无关内容和分歧不会创建任务。第三模型只能替代接口失败，不能用多数投票覆盖分歧。图片最多 3 张、总计 8 MiB，仅下载本条消息对应的 Discord CDN PNG/JPEG/WebP 附件，禁止跳转和任意图片网址。截图拍摄时间不能仅凭收到消息的时间确认；识别证据保存这一限制。

候选交给现有 ZeroClaw 只读行情与网络研究，再经 `validateObservationDecision` 和 `registerObservation` 登记固定预算任务。Google 模型只提取证据，不拥有交易工具。每轮仍为 100 USDT 保证金、3 倍逐仓、最多 3 轮；历史截图中的杠杆、数量和入场价格不会复制到订单。任务创建、暂缓和需澄清结果会回复到原频道的原消息，禁用所有提及。

```sh
npm run signals:local -- up
npm run signals:discord -- check
npm run signals:discord -- start
npm run signals:discord -- status
npm run signals:discord -- stop
# 前台运行，适用于进程管理器：
npm run signals:discord -- run
```

`.env` 需要 `SIGNAL_DISCORD_GUILD_ID`、`SIGNAL_DISCORD_CHANNEL_ID`、`SIGNAL_DISCORD_ALLOWED_USER_ID`，默认复用现有 `ZEROCLAW_channels__discord__main__bot_token`，也可设置 `SIGNAL_DISCORD_BOT_TOKEN`。识图接口使用 `SIGNAL_VISION_BASE_URL`、`SIGNAL_VISION_API_KEY`，可用 `SIGNAL_VISION_MODELS` 配置 2–3 个不同型号。该中转在多通道间分流，会随机返回 403/503（同一型号下一次即可能成功），因此对 403/408/425/429/5xx 与连接层错误做有上限的重试，可用 `SIGNAL_VISION_ATTEMPTS`（默认 2，最大 4）与 `SIGNAL_VISION_BACKOFF_MS`（默认 300，最大 5000）调整；聊天 Agent 的识图与文字重试由同容器回环端点负责，见 [ZeroClaw 说明](zeroclaw.md)。不要将凭据复制到代码或报告中。

入口状态和每条原消息的处理记录保存在被 Git 忽略的 `data/signal-discord/`。相同原消息先写入唯一处理记录再开始分析；重复轮询不重复登记。提交或回复回执不明时不盲目重试；进程中断中的消息标注为 `interrupted`，可通过原消息来源 ID 核对看板。未登记的 wait/reject 不会自动定时复评。

本地模式依赖本机 Node、Docker、模拟服务和已有 `signal-analysis-agent:local` 镜像；电脑休眠或本地进程停止会中断新消息接收。云端主镜像设置 `SIGNAL_ENABLED=true`、`SIGNAL_DISCORD_ENABLED=true` 和 `SIGNAL_AGENT_RUNTIME=native` 后，由入口脚本管理策略服务与接收器；分析子进程只获得模型连接、只读 MCP 令牌及研究所需变量，使用独立临时配置。`SIGNAL_DATA_DIR=/app/data` 下的 `signal-discord`、`signal-analysis`、`signal-observation` 分别保存接收记录和研究报告。完整环境与单副本切换步骤见 [云端部署说明](signal-cloud.md)。云端 WebDAV 数据可用 `npm run persistence:mirror` 下载到 `data/cloud-mirror/` 查看，详情见 [持久化说明](webdav-persistence.md)。

实际接口验证：2.5 Flash、3.5 Flash Lite 和 3 Flash Preview 均曾成功读取合成图片，服务也存在间歇性 HTTP 403；3.1 Flash Lite、3.6 Flash、Gemma 在本次图片测试返回 403，未放入默认组合。请求要求 JSON 输出，任一结果不完整、模型分歧或不足两个有效结果时只澄清。真实 ZeroClaw 研究预览已成功返回 wait，确认开发样例没有登记任务；本次没有伪造用户消息或向模拟账户下测试订单。

入口是否真的在跑，可以直接查主看板 `GET /healthz` 的 `intake` 字段（`running`／`processing`／`not_started`／`unhealthy`／`disabled`／`unknown`），或在模拟盘页面顶部的状态条查看截图入口、识图链路与备份映射的实时摘要；两者的数据来源与排查顺序见 [云端部署说明](signal-cloud.md#入口状态自检2026-09-18)。
