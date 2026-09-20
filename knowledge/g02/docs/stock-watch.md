# A 股收息观察服务

与 OKX 服务分别启动、部署、登录。默认端口 `8081`，OKX 保持 `8080`。A 股服务不读取 OKX 凭据、不调用交易接口。两者可以使用同一个代码仓库，Northflank 中建立两个服务即可。

## PostgreSQL 17

数据全部保存在 PostgreSQL 的 `stock_watch` schema：观察列表、三档目标价、报价缓存、提醒事件、每月预算和登录会话。首次启动自动创建表，并预置参考图片中 22 只股票的名称与 A 股代码；不导入图片中的历史股价、分红数字或买入价格。

数据库连接优先读取 `STOCK_DATABASE_URL`，兼容现有 `EXTERNAL_JDBC_POSTGRES_URI_ADMIN`。支持 `jdbc:postgresql://...?...` 连接串。生产应用建议使用平台内部连接串和专用数据库账号；不要公开 Secret。服务保留连接串中的 TLS 配置，不关闭证书验证。

在 Northflank 新建服务，选择 `Dockerfile.stocks`、端口 `8081`、单副本、HTTPS。配置：

```env
STOCK_DATABASE_URL=<平台内部 PostgreSQL 连接串，放入 Secret>
STOCK_VIEWER_USERNAME=<自行设置的 A 股登录名>
STOCK_VIEWER_PASSWORD=<至少 16 位密码，放入 Secret>
STOCK_PORT=8081
STOCK_POLL_MS=60000
# 仅在可信反向代理后开启，用于登录失败限流
STOCK_TRUST_PROXY=1
```

使用独立 Cookie 名，A 股与 OKX 登录互不覆盖。Cookie 不按端口隔离；正式部署建议两个独立域名。认证有效期 30 天，会话存入 PostgreSQL；账号密码变化会使旧会话失效。不同域名或容器清理 Cookie 仍会要求重新登录。

后台工作者使用 PostgreSQL advisory lock，拒绝同一库同时启动第二个实例，防止重复推送。`/healthz` 检查数据库连通性。备份交给数据库平台管理，建议每日备份并保留至少 7 天。

## 本地启动

Node.js 24+；先安装依赖，再配置 `.env`：

```sh
npm ci
npm run stocks:start
```

`stocks:start` 会加载当前目录 `.env`；无需启动 OKX 服务。独立连接测试和初始化可运行 `npm run stocks:migrate`。

无真实价格、无外部推送的本地功能预览使用独立 PostgreSQL 数据库：

```sh
docker run --name stock-watch-dev-pg -d -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=stockdev -e POSTGRES_PASSWORD=local-stock-preview-only \
  -e POSTGRES_DB=stock_watch_dev postgres:17-alpine
npm run stocks:dev
```

预览默认仅监听 `127.0.0.1:8081`，使用上面的本地库，不读取 `.env` 中的真实数据库连接串。可用独立变量 `STOCK_DEMO_DATABASE_URL` 指定另一份预览库。首次初始化后，模拟库和真实库不能混用。默认未设置目标价；模拟价格会在界面标明。不要删除开发容器，否则其本地预览数据会丢失。

## 提醒规则

- 每只股票可配置 3 个递减的目标价；空档不提醒。触发条件为实际未复权价格 `<=` 目标价。
- 保存新目标价后，等待报价时间晚于或等于设置时间的有效行情。每档每轮只记录一次；服务重启、重复行情、修改备注均不会重复触发。手动重新开启或修改价格会开启新一轮。
- 后台默认每分钟抓取一次腾讯行情，合并请求并设置超时。手动刷新最短间隔 15 秒，重叠请求合并。
- 真实提醒仅在上海时区周一到周五 09:30–11:30、13:00–15:00 检查；报价必须同日、有效成交量大于零且不超过 180 秒。不含完整交易所节假日日历，节假日靠报价日期与新鲜度拦截，不会用上个交易日价格触发。
- 腾讯接口是公开网页行情来源，没有服务可用性承诺。源故障或不完整响应保留旧报价并显示状态，不拿旧价触发提醒；轮询无法保证捕捉间隔内短暂触价。
- 分红金额、统计截止日与除息日先提供手动录入。分红填近 12 个月已实施税前现金分红的每股合计，参考股息率为该金额除以最新价，不视为未来分红承诺。若填写的除息日与触发日一致，提醒会附上除息说明；目标价不会自动调整。
- 每月定投预算、额外加仓预算与实际投入金额按自然月分别手动填写。新月份默认待填写，不自动沿用、不自动扣款。

## 外部通知

默认只保存站内提醒，不发送手机消息。外部通知尚未指定时，UI 明确显示“手机推送待配置”。后续可通过 Secret `STOCK_WEBHOOK_URL` 配置 HTTPS 接收端（例如连接微信推送渠道的自建桥接服务）。该接口发送通用 JSON，不是企业微信等厂商的原生消息格式。

```json
{
  "event": "stock.price_reached",
  "id": "事件 UUID",
  "symbol": "sh601398",
  "name": "工商银行",
  "price": 5,
  "target": 5,
  "slot": 1,
  "quoteTime": "ISO 时间",
  "source": "腾讯行情",
  "simulated": false,
  "exDividend": false
}
```

事件和待发送状态在同一数据库事务中保存。发送超时 10 秒，以 1、2、4、8 分钟退避，最多尝试 5 次；失败保留站内记录。采用至少一次交付，接收端应按 `Idempotency-Key` 或 JSON `id` 去重。HTTP 2xx 仅代表接收端接受，不能证明手机已经收到。配置前产生的站内事件不会事后自动外发，模拟事件永不外发。日志不输出连接串、Cookie、密码或 Webhook URL。

## 验证

```sh
npm run check
npm test
# 仅对专用测试数据库运行，名称必须以 stock_watch_test 开头
STOCK_TEST_DATABASE_URL=postgresql://stockdev:local-stock-preview-only@127.0.0.1:15432/stock_watch_test npm run stocks:test
docker build -f Dockerfile.stocks -t stock-watch .
```

集成测试会重建专用测试库中的 `stock_watch` schema，覆盖持久化、去重、重启恢复、认证与 CSRF。不要把生产连接串填入测试变量。
