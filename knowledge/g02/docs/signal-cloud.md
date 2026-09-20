# Northflank 云端方向实验室

主 `Dockerfile` 支持在现有 OKX 看板容器中启动方向策略服务和 Discord 截图入口。云端分析直接调用镜像内的 ZeroClaw，使用独立配置和只读工具；不依赖本机 Docker、Docker socket 或 `.env.signals.local`。以下是部署配置，Git 推送成功并不代表 Northflank 已完成构建、环境配置和上线验收。

方向服务只连接 **OKX 模拟盘**。Discord 自动入口固定每轮保证金上限 100 USDT、3 倍逐仓、名义金额上限 300 USDT、单轮风险上限 25 USDT、任务风险上限 75 USDT、最多 3 轮。登记只是开始观察；满足策略条件后才提交模拟订单。

本地 `.env.cloud` 保存已有模型、Discord、模拟盘、WebDAV 配置和 API 令牌。统一入口使用原有 `OKX_VIEWER_USERNAME` / `OKX_VIEWER_PASSWORD` 登录；模拟策略可复用已有 `EXTERNAL_JDBC_POSTGRES_URI_ADMIN`，也可显式填写 `SIGNAL_DATABASE_URL`。该文件包含密钥，权限为 0600，已被 Git 和 Docker 构建忽略，只用于把新增／更新变量导入平台，不能替换或删除现有主服务变量。平台逐项填写时，dotenv 值外层的引号不属于实际值。

## 平台配置

沿用现有 Git 仓库和主 `Dockerfile`。保留现有 OKX 主看板的数据库、登录及只读 API 配置，只需要 **HTTP 8080** 的 HTTPS 公网入口。打开原 OKX 看板域名，在顶部切换“实盘”和“模拟盘”；模拟盘的直接地址为同一域名的 `/simulation/`，两者共用一次登录。切换页面不会改变账户、凭据或执行模式，实盘页仍为只读研究，自动策略始终使用专用模拟盘凭据。

主进程同时提供两套页面和策略调度，不再启动第二个策略 HTTP 监听器。容器内 ZeroClaw 与 Discord 自动访问 `http://127.0.0.1:8080/simulation`（随 `PORT` 改变）。此前的 8082 公网入口可以删除；旧 `SIGNAL_PORT` / `SIGNAL_HOST` 不参与主镜像监听，入口脚本会自动覆盖旧的云端 `SIGNAL_SERVICE_URL`，无需手工迁移内部地址。独立开发命令 `npm run signals:start` 与 `compose.signals.yaml` 仍支持 8082；它们不属于本次主镜像部署。

仅运行 **1 个副本**，部署时先停止旧实例、完成最终备份，再启动新实例；不能用滚动重叠方式同时运行两个 Discord 接收器或 WebDAV 写入者。数据库锁能阻止同一策略数据库的重复调度，但不能协调使用不同数据库的本地和云端接收器。启动宽限至少 **180 秒**，终止宽限至少 **60 秒**；增大持久化超时后同步增加平台宽限。

云端接管前，在本机执行 `npm run signals:discord -- stop`，随后用 `npm run signals:discord -- status` 确认 `processAlive: false`。还需停止连接同一模拟账户的本地方向策略容器，保留其 PostgreSQL 数据卷；不同数据库之间的调度锁不能阻止同账户出现两个交易 worker。原有只读 OKX 看板可以继续运行。停机期间的消息不会补单，云端就绪后再发新的方向。本次交接前已确认本地方向服务为 0 任务、0 持仓；后续切换应重新核对，不能直接沿用本次状态。

## 第一阶段：启用模拟策略看板

在平台运行环境中新增以下变量。尖括号处替换为实际值，密码、令牌、数据库连接串和 API 凭据放入 Northflank Secrets。平台不会读取本机 `.env`。

```dotenv
SIGNAL_ENABLED=true
SIGNAL_DISCORD_ENABLED=false
SIGNAL_AGENT_RUNTIME=native
SIGNAL_DATA_DIR=/app/data
SIGNAL_MODE=okx-demo
# 已有 EXTERNAL_JDBC_POSTGRES_URI_ADMIN 时可省略下一项
# SIGNAL_DATABASE_URL=<专用PostgreSQL数据库连接串>
# 登录沿用已有 OKX_VIEWER_USERNAME / OKX_VIEWER_PASSWORD
SIGNAL_API_TOKEN=<至少32位随机令牌>
AUTH_TRUST_PROXY=1
SIGNAL_OKX_MARKET=OPENAPI_GLOBAL
SIGNAL_OKX_DEMO_API_KEY=<模拟盘API Key>
SIGNAL_OKX_DEMO_API_SECRET=<模拟盘API Secret>
SIGNAL_OKX_DEMO_API_PASSPHRASE=<模拟盘API Passphrase>
```

`SIGNAL_DATABASE_URL` 优先；未填写时自动使用已有 `EXTERNAL_JDBC_POSTGRES_URI_ADMIN`。生产环境也可以配置专用数据库和账号。复用同库时，策略表创建在独立的 `signal_research` schema，主看板表仍在 `okx_research` schema。共享连接账号必须有创建 schema／表的权限。启动时 `SignalStore.initialize()` 自动执行策略 schema，统一入口沿用主看板会话表，无须额外先跑一次迁移命令。`SIGNAL_VIEWER_USERNAME` / `SIGNAL_VIEWER_PASSWORD` 只用于独立策略服务；主镜像无需新增第二组登录凭据。数据库会绑定模拟账户 UID 与 API Key 指纹，替换 Key 或切换账户不能无条件接管旧账本。共享数据库会让两套服务共用权限、数据库连接额度和备份故障域，因此专用库仍是更稳妥的长期配置。

模拟盘 Key 需要 Read + Trade 权限。模拟账户须为净持仓 `net_mode`、合约或跨币种保证金账户模式（`acctLv` 为 2 或 3），合约逐仓保证金模式为 `automatic`；不符合时服务预检失败。`SIGNAL_OKX_MARKET` 可按账户地区调整为 `GLOBAL`、`OPENAPI_GLOBAL`、`EEA` 或 `US`。生产 Cookie 要求 HTTPS。

启动后检查 8080 的 `/simulation/healthz` 返回 `service: signal-research`、`mode: okx-demo`，使用原主看板账号登录并切换到模拟盘，确认调度正常、账户没有未核对的订单或仓位。容器健康检查同时覆盖已开启的服务；若平台只配置 HTTP 探针，还需关注容器进程和持久化故障日志。

## 第二阶段：启用 News / #info 截图入口

保留或补齐既有 ZeroClaw 模型连接三项。`uri` 使用 OpenAI 兼容的 `/v1` 地址，`model` 必须是当前 Key 可用的文本研究模型；识图与研究分别配置。

```dotenv
ZEROCLAW_providers__models__custom__relay__api_key=<已有文本研究模型密钥>
ZEROCLAW_providers__models__custom__relay__uri=<已有文本研究中转地址，含/v1>
ZEROCLAW_providers__models__custom__relay__model=<已有可用文本研究模型>
SIGNAL_SEARCH_URL=https://p01--g02-ritup-repo01-search--4ygvmqls7l8l.code.run
SIGNAL_DISCORD_GUILD_ID=1510549677311791154
SIGNAL_DISCORD_CHANNEL_ID=1510549678025081016
SIGNAL_DISCORD_ALLOWED_USER_ID=1151702590267084851
SIGNAL_VISION_BASE_URL=https://ai--new-api--7jgxq8y8tx2h.code.run
SIGNAL_VISION_API_KEY=<已提供的识图中转密钥>
SIGNAL_VISION_MODELS=models/gemini-2.5-flash,models/gemini-3.5-flash-lite,models/gemini-3-flash-preview
SIGNAL_DISCORD_ENABLED=true
```

入口默认复用已有 `ZEROCLAW_channels__discord__main__bot_token`。如需独立 token，设置 `SIGNAL_DISCORD_BOT_TOKEN`，二选一即可。Bot 需要访问 News 的 `#info`、读取消息历史和发消息的权限，并能取得本人消息正文／附件；已有机器人的 Message Content Intent 应保持开启。`SIGNAL_SEARCH_URL` 是支持 JSON 搜索的 SearXNG origin，不带 `/search` 路径；上面沿用现有搜索服务，也可换成自己的服务。

截图入口通过 REST 轮询，不额外打开 Gateway。`ZEROCLAW_ENABLED` 只控制原有聊天 daemon；截图分析按需启动独立 ZeroClaw，不要求开启聊天 daemon。原聊天 Agent 开启时仍可能按其原配置回复消息，方向入口的结果以 `【方向实验室 · 模拟盘】` 开头。

主镜像也将 `SIGNAL_VISION_BASE_URL` / `SIGNAL_VISION_API_KEY` 接到聊天 Agent 的专用视觉路由，避免截图发给当前 Nemotron 文字模型。无需新增第二份识图密钥；可用 `ZEROCLAW_VISION_MODEL` 覆盖聊天识图型号（默认 `SIGNAL_VISION_MODELS` 第一项）。默认把视觉与文字两个 alias 都改道同容器回环重试端点，因为该中转会随机返回 403/503，而 ZeroClaw 的视觉路由与文字 relay 都不重试；启动日志出现 `Upstream retry relay mounted on /internal/vision/v1/chat/completions`、`.../internal/relay/v1/chat/completions` 与 `ZeroClaw image routing enabled via local retry relay` 即为生效。设 `ZEROCLAW_RELAY_ROUTE=direct` 可改回直连。文字模型不再可选 `nvidia/nemotron-*`（已从该中转分组消失，调用返回 503 no available channel），可用 `SIGNAL_TEXT_MODELS` 指定降级型号，默认复用 `SIGNAL_VISION_MODELS`。只有聊天回复而没有 `【方向实验室 · 模拟盘】` 结果时，还应检查 `SIGNAL_DISCORD_ENABLED=true` 及下述接收器就绪日志。

部署后应看到 `Discord screenshot intake ready in #info`。也可在容器终端运行 `npm run signals:discord -- check` 检查依赖与频道，运行 `npm run signals:discord -- status` 查看接收状态；前者不发送 Discord 消息、不创建任务。完整收件链路的验证应使用本人新发的实际方向；历史截图和测试材料只能产生研究／澄清结果。只有两个有效识图结果一致、ZeroClaw 研究与程序校验通过，才登记任务。

目前识图中转曾出现间歇性 HTTP 403；模型不足两个有效结果、合约不清或方向分歧时会澄清，不创建任务。停止与重启会跳过离线积压；进行中的不确定登记保留来源 ID，不能通过重复发送同一材料来推测结果，应先核对看板。

## WebDAV 持久化与本地查看

在同一服务配置以下变量；InfiniCLOUD 的前三项使用 My Page → Apps Connection 中的 Connection URL、Connection ID 和 Apps Password。

```dotenv
PERSIST_ENABLED=true
PERSIST_WEBDAV_URL=<InfiniCLOUD完整HTTPS WebDAV地址>
PERSIST_WEBDAV_USER=<Connection ID>
PERSIST_WEBDAV_PASSWORD=<Apps Password>
PERSIST_WEBDAV_WORKSPACE=trader-workspace
PERSIST_REMOTE_PATH=g02-ritup-repo02-mix/production
PERSIST_PATHS_JSON=[{"name":"zeroclaw","local":"/zeroclaw-data"},{"name":"signal-discord","local":"/app/data/signal-discord"},{"name":"signal-analysis","local":"/app/data/signal-analysis"},{"name":"signal-observation","local":"/app/data/signal-observation"}]
PERSIST_EXCLUDE_JSON=["**/downloads/**","**/attachments/**","**/cursor.json","**/status.json","**/*.tmp-*"]
PERSIST_INTERVAL_SECONDS=300
PERSIST_KEEP_SNAPSHOTS=288
```

JSON 变量直接填完整 JSON，不加外层 shell 引号。若已有自定义排除规则，应合并后只保留一个 `PERSIST_EXCLUDE_JSON`。改变 `SIGNAL_DATA_DIR` 时同步修改对应的三个映射路径。

这四个映射保存 ZeroClaw 记忆／工作区、Discord 原消息处理记录、分析与观察报告。PID、锁、日志、密钥配置、缓存、依赖由内置规则排除；额外排除接收游标、临时状态和未提交的 JSON 临时文件，避免恢复过期运行状态。`messages/*.json`、`input.json`、`tool-calls.jsonl`、`decision.json`、`registration.json` 和报告保留；`agent-output.log` / `agent-stderr.log` 作为日志只保留在当前容器。

任务、订单、轮次、事件和登录会话属于外部 PostgreSQL，必须使用数据库自身的备份；不会出现在 WebDAV 镜像中。WebDAV 每次内容变化仍上传完整压缩快照，相同内容不重复上传；它不是逐文件增量同步。rclone 只在备份／恢复时运行，内存配置及实测见 [webdav-persistence.md](webdav-persistence.md)。容器必须给 Node、ZeroClaw 和备份留足并发内存，不能直接套用独立备份客户端的 128 MiB 测试限额。

远端统一放在 `trader-workspace/g02-ritup-repo02-mix/production/snapshots-v1/`。首次启动会在本地目录全空时恢复最新已提交快照；普通文件快照最多可能损失最近一次成功备份之后的变化。不能把 WebDAV 当作 PostgreSQL 订单账本。

云端出现 `persistence.saved` 后，本地执行：

```sh
npm run persistence:mirror
```

结果位于仓库被忽略的 `data/cloud-mirror/`。`latest/` 下按 `zeroclaw`、`signal-discord`、`signal-analysis`、`signal-observation` 映射名浏览；该操作只读远端、不覆盖本地应用目录。没有远端提交快照时会明确显示为空，不代表云端业务没有数据。

当前保护单由服务轮询计算和执行，尚无交易所原生止损；服务停机期间不会继续执行保护。历史对照回放和盈利有效性仍未验证，部署完成不改变这一策略边界。

## 本次交付验证（2026-09-17）

主镜像构建成功；168 项应用测试、33 项独立 PostgreSQL 集成测试、21 项持久化与进程生命周期测试通过。主镜像实际启动了主看板和 OKX 模拟策略服务，组合健康检查通过；容器内原生 ZeroClaw 调用了真实行情和网络工具，研究预览通过校验并返回 `wait`，没有登记任务。镜像内 Discord `check` 已验证 News / #info 和本人的接收范围，没有发送测试消息。

交接前本地任务与持仓均为 0，Discord 接收器和本地方向策略容器已停止，数据库卷保留。这次历史验收使用独立策略监听方式；合并端口后的部署只使用 HTTPS 8080，需按上面的统一入口再次验收。

## 启动日志排查

仅出现 8080 主看板、8081 A 股和 ZeroClaw `Channels: discord.main`，不代表方向策略或截图入口已启用。确认运行环境中的 `SIGNAL_ENABLED=true` 与 `SIGNAL_DISCORD_ENABLED=true` 都生效（值为小写 `true`，没有引号或额外空格），数据库使用 `SIGNAL_DATABASE_URL` 或已有 `EXTERNAL_JDBC_POSTGRES_URI_ADMIN`。入口脚本会输出 `Signal research enabled in the shared dashboard on port 8080/simulation (OKX demo only)`，随后必须确认 `/simulation/healthz` 正常及 `Discord screenshot intake ready in #info`；启动配置提示本身不代表调度已经健康。关闭的可选服务也会输出明确提示。

`persistence.restored` 表示启动前已经成功恢复快照；首次定时备份默认在应用启动约 300 秒后，随后检查 `persistence.saved` 或 `persistence.unchanged`。若 WebDAV 清单只有 `zeroclaw` 映射，补齐上面的四目录映射才能备份截图处理记录和分析报告。2026-09-17 已从真实远端校验下载到本地 `data/cloud-mirror/`，当时最新快照含 9 个文件，包括 SQLite 记忆库；查看副本不会修改云端。

`Pairing: ACTIVE` 表明网关认证已启用；监听 `0.0.0.0` 的提示本身不是启动失败。Tini 非 PID 1 和 `Memory: none` 的版本行为及修复见 [ZeroClaw 排障](zeroclaw.md#doctor-常见警告处置)。资源面板的 512 MB 是限额，是否有内存不足还要看实际峰值、OOMKilled 事件和重启次数，不能仅凭启动日志判断。

## 入口状态自检（2026-09-18）

截图入口是否真的在跑，不再依赖容器日志：

- `GET /healthz`（主看板域名）在启用模拟策略后额外返回 `intake`，取值 `running`／`processing`／`starting`／`not_started`／`unhealthy`／`disabled`／`unknown`。`disabled` 代表运行环境里 `SIGNAL_DISCORD_ENABLED` 不是小写 `true`；`not_started` 代表没有 `signal-discord/status.json`，即入口进程从未启动。该字段只有状态，没有凭据、频道或账号信息。
- `GET /simulation/api/dashboard`（Bearer `SIGNAL_API_TOKEN` 或登录会话）返回 `runtime`：`intake`（启用／配置／状态／最近轮询／处理条数／游标时间）、`vision`（是否配置、重试中转还是直连、模型数）、`persistence`（是否启用、映射名列表、上次成功时间）。
- 模拟盘页面顶部显示同一份摘要（截图入口／识图／备份三个状态块），刷新看板即刷新。

排查顺序：`intake=disabled` → 平台变量没有生效，逐项核对 `SIGNAL_DISCORD_ENABLED=true`（小写、无引号）并重新部署；`not_started` → 入口被启用但没有写状态文件，检查启动日志里的 `Discord screenshot intake ready` 与 `Service discord exited`；`unhealthy` → 入口在重试或轮询超时，看 `runtime.intake.error`；`persistence.mappings` 只有 `zeroclaw` → `PERSIST_PATHS_JSON` 仍是旧值，截图处理记录和分析报告不会被备份。

2026-09-18 云端实测：主看板 `/healthz` 正常、`/simulation/healthz` 返回 `okx-demo`、视觉重试中转已挂载，说明镜像已是合并端口后的版本；但 WebDAV 快照 `20260917T160848240077Z-d280ebe3a898` 仍只有 `zeroclaw` 映射，且 Discord `#info` 在 2026-09-17 15:58:13Z 发出的两张截图只有聊天代理回复，没有任何 `【方向实验室 · 模拟盘】` 消息。因此当时的运行环境没有应用四目录映射与截图入口变量，需要在平台补齐后重新部署再用上面的字段确认。
