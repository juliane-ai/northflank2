# OKX 跟单研究台

这是一个自建的 OKX 跟单研究系统。当前第一版只读取账户、跟单关系和实际跟单子仓位，为后续保本滑动止盈、大波动重复开单和开单后趋势分析建立可信的数据入口。

## 第一版能力

- 使用 `okx-api@3.2.3` 访问 OKX V5，只调用只读方法。
- 使用 `@tabler/core@1.5.1` 构建自托管的响应式看板和登录页。
- 内置简约白（默认）、石墨黑、经典紫三套主题；登录页和看板的外观按钮可即时切换，并在当前浏览器保存偏好。
- 实盘与模拟盘共用看板框架、主题资源和切换反馈；返回实盘时可先显示 60 秒内的已标注快照并在后台更新，手动刷新仍等待最新数据。
- 使用持久安全会话保护看板，登录失败按来源和账户限流并临时锁定。
- 读取当前跟随的带单员及关系级盈亏。
- 读取 `subPosType=copy` 的实际跟单子仓位，包括 `subPosId`、`uniqueCode`、方向、开仓价、标记价、数量、保证金和浮动盈亏。
- 读取账户聚合仓位和非零资产，用于核对账户状态。
- 读取当前挂单、近期订单和最近 3 天成交，作为账户实际执行证据；不猜测它们属于某位带单员。
- 按需读取单个带单员的跟单设置。
- 对各数据源独立降级；一个接口失败时，仍展示其他可用数据。
- 将实际跟单子仓位的发现、观察快照和结束确认写入 PostgreSQL 生命周期库。

第一版没有下单、平仓、修改杠杆、修改跟单设置或自动止盈功能。研究路线见 [docs/research-roadmap.md](docs/research-roadmap.md)。

## 本地运行

独立的 A 股到价提醒服务使用端口 `8081` 和 PostgreSQL 17，启动、部署与配置见 [A 股收息观察服务](docs/stock-watch.md)。下文仍为 OKX 服务说明。

Node.js 24 或更高版本：

```bash
npm ci
cp env.example .env
```

在 `.env` 配置 PostgreSQL 和 OKX 凭据后运行（命令自动加载 `.env`）：

```bash
npm start
```

打开 `http://127.0.0.1:8080`，在 Tabler 登录页使用 `OKX_VIEWER_USERNAME` 和 `OKX_VIEWER_PASSWORD` 登录。生产容器默认使用 Secure Cookie，因此必须通过 HTTPS 访问。

可选启用同容器 ZeroClaw Agent sidecar，见 [ZeroClaw 同容器部署](docs/zeroclaw.md)。

主镜像已集成 rclone / InfiniCLOUD WebDAV 周期快照与启动恢复，默认关闭。支持一个或多个本地目录、SQLite 一致快照及凭据／缓存排除；填写项与部署设置见 [WebDAV 持久化](docs/webdav-persistence.md)。

不连接 OKX 的界面预览使用独立本地 PostgreSQL 数据库，初始化方式见 [OKX 数据库配置](docs/okx-postgres.md)：

```bash
npm run dev
```

模拟数据均为虚构数据，因此开发预览不要求登录；真实 OKX 模式始终要求看板认证。

## 环境变量

Northflank Secrets：

```env
OKX_API_KEY=<read-only-key>
OKX_API_SECRET=<secret>
OKX_API_PASSPHRASE=<passphrase>
OKX_VIEWER_PASSWORD=<strong-random-password>
OKX_DATABASE_URL=<PostgreSQL 内部连接串，也兼容 EXTERNAL_JDBC_POSTGRES_URI_ADMIN>
```

普通变量：

```env
OKX_VIEWER_USERNAME=research
PORT=8080
AUTH_TRUST_PROXY=1
AUTH_ALLOWED_COUNTRIES=CN,US
```

可选变量：

```env
# 模拟盘 API Key
OKX_SIMULATED=1

# GLOBAL、OPENAPI_GLOBAL、EEA 或 US；全球站可省略
OKX_MARKET=GLOBAL

# 摘要缓存毫秒数
OKX_CACHE_MS=8000

# 生命周期快照间隔和结束确认次数
RESEARCH_SNAPSHOT_MS=15000
RESEARCH_CLOSE_CONFIRMATIONS=2

# 默认 CF-IPCountry；使用其他可信地理位置代理时修改
AUTH_COUNTRY_HEADER=CF-IPCountry
```

API Key 必须只有 **Read** 权限，不要授予 Trade 或 Withdraw 权限。
看板密码至少 16 个字符，建议使用密码管理器生成 24 个以上的随机字符。

`AUTH_ALLOWED_COUNTRIES` 使用 ISO 3166-1 两位国家代码。配置后，如果请求没有可信的国家代码请求头，服务会默认拒绝访问；`/healthz` 不受地区限制。当前默认方案读取 Cloudflare 的 `CF-IPCountry`，因此需要在 Cloudflare 开启 IP Geolocation，并确保 Northflank 源站不能绕过 Cloudflare 直接访问。只依赖 Northflank 时，它会提供来源 IP 的 `X-Forwarded-For`，但不会自动把 IP 转换成国家代码。

## 接口

| 路径 | 认证 | 说明 |
| --- | --- | --- |
| `GET /healthz` | 无 | 检查 PostgreSQL 连通性与服务锁，不访问 OKX。 |
| `GET /login` | 无 | Tabler 登录页。 |
| `POST /auth/login` | 登录限流 | 校验账号密码并创建安全会话。 |
| `POST /auth/logout` | Session + CSRF | 注销当前会话。 |
| `GET /api/overview` | Session | 账户、带单员、实际跟单子仓位、账户聚合仓位、订单和成交。 |
| `GET /api/copy-settings/:uniqueCode` | Session | 当前带单员的只读跟单设置。 |
| `GET /api/research/lifecycles` | Session | 已持久化的跟单子仓位生命周期摘要。 |

除登录和退出外，业务服务仍只接受 `GET`。登录会话和研究记录只保存在 PostgreSQL 的 `okx_research` schema 中，保留数据库且看板账号密码不变时，服务重启后仍可继续登录。

OKX 与 A 股可共用 PostgreSQL 17 实例：OKX 使用 `okx_research`，A 股使用 `stock_watch`，端口与 Cookie 分别独立。服务不再依赖 `/data` 持久卷，不读取或导入旧数据库文件；首次切换到空库需重新登录。没有连接串或数据库连接失败时，服务会明确失败，不回退到本地存储。部署与权限配置见 [OKX PostgreSQL](docs/okx-postgres.md)。

登录会话默认有效 30 天，需要浏览器保留本站 Cookie，以及服务端保留会话数据库。关闭页面不会主动注销；主动退出、到期、更换看板账号密码或超过 10 个会话时淘汰旧会话，会要求重新登录。密码框保留显示/隐藏按钮，支持系统粘贴和密码管理器自动填充，不主动读取剪贴板。

如果 Native Alpha 从最近任务中划掉后立即要求登录，可按以下顺序定位：

1. 确认该站点开启 `Accept cookies`，并始终使用相同的 HTTPS 域名、快捷方式及沙盒。本站登录不依赖第三方 Cookie。
2. 重新看到登录页时，先手动刷新一次。若无需输入密码就恢复，优先检查冷启动导航时的 Cookie 携带条件（包括 `SameSite=Strict`），而不是认定 Cookie 已被删除。
3. 在手机普通浏览器中单独登录同一网址，再关闭并重开做对照。只有 Native Alpha 失效时，优先检查其 Cookie 持久化、沙盒和 Android System WebView 版本；网页无法直接调用 Android 的 `CookieManager.flush()` 强制保存 Cookie。
4. 普通浏览器也失效时，核对线上运行版本、`AUTH_SESSION_TTL_MS`、数据库连接与看板账号密码是否发生变化。当前服务要求单副本，并通过 PostgreSQL advisory lock 防止多个实例同时运行。

## 验证

```bash
npm run check
npm test
# 使用独立测试库执行 PostgreSQL 集成测试（数据库名必须以 okx_research_test 开头）
OKX_TEST_DATABASE_URL=postgresql://.../okx_research_test npm run okx:test
docker build -t okx-copy-research .
```

## 文档

- [文档索引](docs/README.md)
- [系统架构](docs/architecture.md)
- [OKX 只读数据模型](docs/okx-read-model.md)
- [研究路线](docs/research-roadmap.md)
- [生命周期存储](docs/lifecycle-storage.md)
- [OKX PostgreSQL 配置](docs/okx-postgres.md)
- [安全边界](docs/security.md)

## 方向策略模拟服务

主镜像在同一端口（默认 8080）提供实盘只读看板与 OKX 模拟策略：顶部切换“实盘 / 模拟盘”，共用原有看板登录，模拟盘地址为 `/simulation/`。设置 `SIGNAL_ENABLED=true` 并配置模拟账户即可启用，云端配置见 [部署指南](docs/signal-cloud.md)。方向策略支持成本保本、滑动止盈和重复入场；模拟执行始终使用专用模拟账户，切换页面不改变交易模式。常规自动开单默认只开放 `BTC-USDT-SWAP` 与 `ETH-USDT-SWAP`，可用 `SIGNAL_AUTO_INSTRUMENTS` 明确配置；行情分析仍可读取其他准确合约。

本地已配置 `.env` 的 `SIGNAL_OKX_DEMO_*` 后，可直接运行 `npm run signals:local -- up`。它启动独立 PostgreSQL 和模拟服务，默认打开 `http://127.0.0.1:8082`；登录信息自动保存在被 Git 忽略的 `.env.signals.local`。`status` 查看状态，`restart` 重建应用容器，`down` 停止服务并保留数据库卷。

`npm run signals:observe -- direction.json` 可让 ZeroClaw 结合行情和网络检索评估用户方向，通过证据校验后自动登记模拟观察任务；每轮最多 100 USDT 保证金、3 倍逐仓。加 `--preview` 只生成评估、不登记任务。输入格式、运行前提与当前 Discord 接入状态见 [方向自动评估](docs/signal-discord.md)。
