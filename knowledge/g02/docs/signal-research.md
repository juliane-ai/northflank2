# 方向策略模拟服务

2026-09-16：已实现策略状态机、PostgreSQL 账本、后台行情轮询、登录看板与 MCP 工具桥。本地 Docker 模拟服务已启动，最小模拟开平仓与 ZeroClaw 实际行情分析均已验证；报告会校验模型结论并保存工具证据。当前部署目标锁定 OKX 模拟盘。未部署到 Northflank，尚无策略盈利或回测结论。

## 本地 Docker 启动

本地需要 Docker Compose 和 Node.js 24+，应用本身在 Node.js 24 容器运行。在 `.env` 保留已配置的三个 `SIGNAL_OKX_DEMO_*` 模拟盘凭据，然后执行：

```sh
npm run signals:local -- up
npm run signals:local -- status
```

首次执行会创建 `.env.signals.local`（仅当前用户可读写），保存独立的看板账号、随机密码、工具令牌、数据库密码和本地端口。重复启动保留原值，原 `.env` 不会被改写。打开 `http://127.0.0.1:8082`，使用该文件的 `SIGNAL_VIEWER_USERNAME` / `SIGNAL_VIEWER_PASSWORD` 登录。修改本地端口时编辑 `SIGNAL_LOCAL_PORT` 后再次 `up`。

`compose.signals.yaml` 为当前工作目录建立独立项目、数据库容器和持久卷。数据库不发布宿主端口，网页只发布在 `127.0.0.1`。只向应用传入专用模拟盘凭据；原看板 Key、其他数据库连接串不会进入服务。启动只恢复已有任务和后台对账，不自动创建新的交易方向。

```sh
npm run signals:local -- restart # 重建应用容器，保留数据库及登录会话
npm run signals:local -- down    # 停止服务，保留数据库卷及本地配置
```

停止期间策略保护不运行。再次 `up` 会从原账本恢复任务，先核对订单与模拟账户库存。保留 `.env.signals.local` 和数据库卷；不要删除配置后直接复用旧卷，否则数据库密码和账本绑定会不一致。

本地 Compose 显式使用开发环境的 HTTP Cookie 和容器内监听地址 `SIGNAL_HOST=0.0.0.0`，由宿主 loopback 端口限制访问；独立生产镜像仍使用 Secure Cookie 与 HTTPS。

## 看板信息与显示设置

2026-09-17：看板分为任务总览、行情分析、事件记录和显示设置。总览默认按异常、持仓、运行任务的顺序展示，可搜索合约、来源 ID 和方向依据，并筛选状态、调整排序。创建方向使用独立弹窗；任务控制、来源全文、订单和轮次记录在任务详情中。

“刷新数据”仅重新读取看板，不调用策略推进接口。页面默认每 15 秒自动读取；读取失败或超过一分钟未更新时标注旧数据。详情和行情分析是带时间的快照，分别通过“刷新详情”和“分析当前行情”更新。事件参数默认折叠，可按类别筛选并展开原始字段。

卡片密度、是否展示来源摘要及页面自动刷新开关保存到当前浏览器，不影响后台调度和交易规则。“已结束轮次净结果”包含手续费和预估资金费，不代表交易所账户余额，也不含未完成轮次的浮盈或部分退出结果。

## 手动启动模拟成交

需要 Node.js 24+ 和 PostgreSQL 数据库。生产推荐独立数据库；也可以让 `SIGNAL_DATABASE_URL` 使用与 `EXTERNAL_JDBC_POSTGRES_URI_ADMIN` 相同的连接串，策略服务会使用独立的 `signal_research` schema。将以下配置写入被忽略的 `.env`；不要复制现有只读看板凭据。服务默认监听 `127.0.0.1:8082`。

```dotenv
SIGNAL_MODE=okx-demo
SIGNAL_DATABASE_URL=postgresql://用户:密码@数据库地址/signal_research_demo
SIGNAL_VIEWER_USERNAME=signalresearch
SIGNAL_VIEWER_PASSWORD=至少16位的独立密码
SIGNAL_API_TOKEN=至少32位的随机工具访问令牌
SIGNAL_SERVICE_URL=http://127.0.0.1:8082
SIGNAL_OKX_MARKET=OPENAPI_GLOBAL
SIGNAL_POLL_MS=5000
SIGNAL_OKX_DEMO_API_KEY=模拟盘专用Key
SIGNAL_OKX_DEMO_API_SECRET=模拟盘专用Secret
SIGNAL_OKX_DEMO_API_PASSPHRASE=模拟盘专用Passphrase
```

```sh
npm run signals:migrate
npm run signals:start
```

打开 `http://127.0.0.1:8082` 登录，登记准确合约（例如 `ETH-USDT-SWAP`）、`long` 或 `short`、原始消息 ID 与方向依据。历史截图不会自动创建当前交易任务。重复原消息返回原任务；同合约同时只允许一个未结束任务。取消会停止观察，并要求已有持仓完成退出；暂停仅停止新开仓，已有持仓继续受到策略保护。

每个任务最多有效 24 小时；到期不再开新仓，已有仓位继续执行保护和最长 48 小时持仓规则。服务使用真实匿名公共行情。`paper` 不是看板的 `OKX_MOCK`：它保存策略轮次、报价成交与估算费用，仅用于自动化测试；部署服务应使用 `okx-demo` 和专用模拟盘 Key。

## 策略与风险默认值

- 小时 EMA20/EMA50 与收盘价格进行方向过滤；已收盘 15 分钟 K 线计算 ATR(14)。
- 从观察以来有利极值回撤/反弹 1.5 ATR 后等待确认；后续收盘超过前根高点（多）或跌破前根低点（空），下一条有效报价才可入场。
- 初始止损为 2 ATR；保护激活所需有利价格变动为 `max(1 × 入场 ATR, 有方向的成本保本价差 + 0.5 × 入场 ATR)`。成本保本含开平仓费用、滑点、资金费预留和缓冲；启用后以 1 倍入场 ATR 追踪有利极值，保护线只能收紧。25 USDT 是风险上限，不是盈利触发门槛；策略没有固定盈利目标。
- 非负净结果的保护退出后等待两次 15 分钟收盘，再从新的观察参考点等待下一次波动。亏损、初始止损、成本过高、信息不足等暂停自动重开。
- 每轮计划风险最多 25 USDT，任务累计最多 75 USDT，单轮名义金额最多 1,000 USDT，单轮保证金预算固定以 100 USDT 为默认上限（可调低），固定杠杆为 1～10 倍（默认 3 倍），最多 3 轮；已实现盈利不增加这些上限。组合未平仓/待确认计划风险最多 75 USDT，初始模拟资金 10,000 USDT。保证金预算用于按合约张数和杠杆换算开仓大小，服务端会再次校验。
- 手续费初始估计单边 5 bps、滑点 2 bps、缓冲 2 bps；资金费按每个开始的 8 小时窗口预留 3 bps。资金费为保守估算，并非交易所真实资金流水，页面净盈亏是研究口径。

参数未被证明有正收益。退出按可执行报价及滑点成交，跳价可能超过保护线造成净亏。服务默认每 5 秒轮询，15 分钟仅用于入场条件；它不是逐笔 WebSocket 撮合或高频交易系统。

## OKX 模拟盘 API

OKX 支持模拟盘 API，需要在 OKX「模拟交易」里创建专用 Read + Trade API Key。真实盘 Key 不能替代。此服务强制 SDK `demoTrading: true` 与请求头 `x-simulated-trading: 1`，不提供实盘执行模式。

更换为新建的模拟盘数据库，并配置：

```dotenv
SIGNAL_MODE=okx-demo
SIGNAL_DATABASE_URL=postgresql://用户:密码@数据库地址/signal_research_demo
SIGNAL_OKX_DEMO_API_KEY=模拟盘专用Key
SIGNAL_OKX_DEMO_API_SECRET=模拟盘专用Secret
SIGNAL_OKX_DEMO_API_PASSPHRASE=模拟盘专用Passphrase
```

首次启动请使用没有其他仓位、普通挂单或算法挂单的专用模拟账户。账户需为净持仓（`net_mode`）和合约逐仓保证金自动划转（`ctIsoMode=automatic`）；目标合约自身必须是处于 `live` 状态且 `settleCcy=USDT` 的线性合约。账户配置里的 `settleCcy`/`settleCcyList` 只描述 USD 本位合约，不用于判断 USDT 本位合约是否可交易。`automatic` 表示 OKX 自动为逐仓合约划转保证金；`autonomy` 需要调用额外的保证金划转接口，本服务没有该副作用，因此会拒绝启动。服务只读取检查这些账户配置。

每个方向任务保存自己的杠杆和保证金预算。首次使用或发现账户设置变化时，服务通过 Demo API 设置逐仓杠杆并回读核验，失败则不提交订单；提交前还会再次核验杠杆，并调用 `getMaxBuySellAmount`（OKX `/api/v5/account/max-size`）检查当前方向的最大可下单张数。接口不可用、返回字段异常或额度不足时均保持失败关闭。订单用逐仓市价单，退出 `reduceOnly`。账户需自行具备足够模拟 USDT 保证金。

策略账本按模式和模拟盘 Key 指纹绑定。启动/运行时读取账户仓位与挂单对账，外部仓位或未归属订单会停止订单提交。下单前持久化 `clOrdId` 和意图，超时、响应未知或重启时只查询，不盲目重发。`filled` 或终态取消才进入账本，已确认的市价单超过 15 秒未终结时仅撤其未成交余量并重新查询，最多尝试 3 次；部分成交取消保留实际数量；未知订单会冻结相关任务并继续查询。需要人工核对的状态会在看板显示。

当前止损、保本和追踪保护由服务轮询执行，尚未放置交易所原生止损单。服务停止、网络中断或部分成交仍未终结时保护可能不可用；恢复后用实际可获得报价，不补造断线期间成交。模拟盘是验证订单与恢复行为的环境，不能用来宣称实盘成交效果。

官方来源：[OKX API v5 模拟交易与订单接口](https://www.okx.com/docs-v5/en/)。

### 本地模拟交易验证（2026-09-16）

使用专用 `SIGNAL_OKX_DEMO_*` 凭据，在 Docker 中调用 Demo 执行器。只读预检确认 `acctLv=2`、`posMode=net_mode`、`ctIsoMode=automatic`，可用模拟 USDT 为 5,000，测试前无持仓或挂单。App 的“USD 本位结算币种”显示 USDC/USDG 不影响 ETH-USDT 合约，无需在该菜单寻找 USDT。

`ETH-USDT-SWAP` 最小数量为 0.01 张，每张面值 0.1 ETH；本次以 3 倍逐仓开多 0.01 张（0.001 ETH），随后立即以 `reduceOnly` 平仓。开仓均价 2408.17，平仓均价 2407.66，两个回执均为 `filled`。开仓名义金额约 2.40817 USDT、初始保证金约 0.803 USDT（不含手续费）；0.1 USDT 不足该合约最小数量。结束后确认持仓、普通挂单和算法单均为 0。

本次验证的是模拟账户与执行器的开平仓链路；未创建持续运行的方向任务，也不代表已验证策略收益。修复了账户 USD 结算偏好的误拦截，以及设置杠杆回执 `posSide` 为空时的兼容；杠杆回读仍必须是 `net`、逐仓且倍数匹配。

## Discord 与 ZeroClaw

工具桥通过标准输入输出 MCP 调用此服务，只需要 `SIGNAL_SERVICE_URL`、`SIGNAL_API_TOKEN`，不需要数据库或交易所密钥。具体工具及 ZeroClaw 配置见 [signal-discord.md](signal-discord.md)。

本地可运行 `npm run signals:analyze -- ETH-USDT-SWAP`，让 ZeroClaw 读取实时行情和同合约任务，生成带工具证据的分析报告。首次使用需按 [本地分析步骤](signal-discord.md#本地-zeroclaw-分析) 构建运行镜像并配置模型。分析工具返回与执行共用的 `strategyRules`，不创建任务、不推进保存的状态。看板的“分析当前行情”和“分析当前任务”也使用同一组计算。

AI 应先确认准确目标合约和方向，保留原消息 ID；截图中的原作者数量、杠杆、盈利百分比不会自动进入订单参数，杠杆与保证金必须在任务设置中显式给出并受服务端上限约束。缺少品种、方向或无法确认当前意图时先澄清；旧截图、历史平仓或不确定截图不自动转成当前方向任务。桥只接受结构化的模拟方向参数，拒绝任意订单、真实盘模式及风险上限扩张。

## 独立部署与验证

当前 Northflank 主部署使用主 `Dockerfile`：实盘与模拟盘共用 8080 和原看板登录，顶部选项切换，模拟页面及 API 位于 `/simulation/`，详见 [云端部署](signal-cloud.md)。ZeroClaw 分析子进程仅获得工具服务地址与令牌，不继承数据库和交易所凭据。

如果需要单独运行模拟服务，仍可使用 `Dockerfile.signals`、独立数据库与 Secret，暴露 8082 的 HTTPS 入口，单副本。本文前面的独立启动命令适用于这种开发方式；不要同时启动连接同一模拟账户的两个策略调度器。

健康接口 `/healthz` 检查数据库和调度锁；看板显示最近成功观察时间与行情/订单错误。模式、行情缺口、保护更新、轮次关闭和订单终态保存在 `signal_research`；每个使用过的报价及已收盘 K 线分别去重保存。账本没有自动清空或删除功能。

```sh
npm run check
# 仅使用以 signal_research_test 开头的可丢弃测试数据库
SIGNAL_TEST_DATABASE_URL=postgresql://.../signal_research_test npm run signals:test
```

`PaperExecutor` 和 `createSignalService(..., mode='paper')` 只供自动化测试调用；生产入口 `npm run signals:start` 会拒绝 `SIGNAL_MODE=paper`，且只创建内置 OKX Demo 执行器。

测试覆盖多空对称、保本线单向移动、跳价实际亏损、重新入场、费用、重复消息、部分成交、超时查询、认证/CSRF、数据库重启和单实例限制。实际公开 ETH 行情与专用模拟盘最小开平仓链路已验证；持续策略执行和 Discord 到订单的完整流程仍需后续观察。
