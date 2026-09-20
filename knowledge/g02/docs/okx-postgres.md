# OKX PostgreSQL

OKX 8080 服务现在只使用 PostgreSQL 17 保存登录会话和跟单研究数据。A 股 8081 是独立服务，两者可共用同一 PostgreSQL 实例。OKX 使用 `okx_research` schema，A 股使用 `stock_watch` schema；账号与 Cookie 独立。两者不会操作对方的数据表。

## 正式配置

在 Northflank OKX 服务的 Secret 中配置：

```env
OKX_DATABASE_URL=<平台内部 PostgreSQL 连接串>
OKX_VIEWER_USERNAME=<原有看板用户名>
OKX_VIEWER_PASSWORD=<至少16位密码>
```

原有 OKX API 只读凭据、HTTPS、地区限制配置继续使用。端口仍为 `PORT=8080`，构建文件仍为 `Dockerfile`。`npm start` 会加载本地 `.env`，容器读取平台注入的环境变量。

连接串优先使用 `OKX_DATABASE_URL`，未设置时兼容 `EXTERNAL_JDBC_POSTGRES_URI_ADMIN`。支持 `jdbc:postgresql://...` 以及 JDBC 的 `user`、`password` 查询参数。TLS 保留证书验证，不会为了连接成功关闭验证；生产优先使用数据库平台提供的内部连接地址与正确的 TLS 设置。

首次启动会以事务创建所需表，不导入旧记录或旧登录会话，也不读取旧数据库文件。切换后首次访问需要重新登录。之后服务重启仍可使用未过期会话，默认有效 30 天，可由 `AUTH_SESSION_TTL_MS` 调整。

应用不再使用 `/data` 卷、`AUTH_SESSION_DB_PATH` 或 `RESEARCH_DB_PATH`。旧配置应从部署中移除。数据库备份由平台管理；应用停止、替换容器不会删除 PostgreSQL 数据。初始化命令是幂等的，不清空已存在的 PostgreSQL 表。

```sh
# 仅验证连通性，不创建数据表
npm run okx:migrate -- --check
# 初始化 OKX 的表（服务启动也会自动执行）
npm run okx:migrate
npm start
```

当前仍保持单副本：服务持有 PostgreSQL advisory lock，第二个 OKX 实例会拒绝启动；A 股使用另一把锁，可以同时运行。锁连接丢失时 OKX 退出，让平台重启。普通数据库请求失败返回 503，健康检查也检查数据库，不把数据库错误当作登录失效，也不会改写到其他存储。

## 数据与权限

| 表 | 内容 |
| --- | --- |
| `auth_sessions` / `auth_meta` | 哈希化会话标识、CSRF、创建与到期时间、账号绑定 |
| `lifecycle_positions` | 每个跟单子仓位的生命周期摘要 |
| `lifecycle_events` | 开仓发现、结束确认、仓位重新出现事件 |
| `position_snapshots` | 价格、数量、浮动盈亏快照 |
| `research_meta` / `storage_meta` | 最近观察时间、数据源状态、模拟/真实隔离标记 |

价格、数量和盈亏保留 OKX 返回的字符串精度；时间使用毫秒整数。一次观察在事务中完整提交，数据库锁与观察时间共同拦截重复或乱序结果。数据源失败不增加仓位消失次数；这些规则与原有看板一致。

推荐给两个服务分别分配数据库账号。初始化账号需要创建 schema、表与索引的权限；也可以由管理员预建各自 schema，再分别赋予对应账号所有权。运行账号只应访问自己的 schema，不要把管理员连接串提供给前端。现有管理员连接串可用于初次验证，但应用代码的 schema 分离本身不构成数据库权限隔离。

## 本地模拟预览

预览使用虚构 OKX 数据，单独读取 `OKX_DEMO_DATABASE_URL`，不会使用真实的 `OKX_DATABASE_URL` 或外部管理员连接串。生产环境拒绝模拟模式。

若已按 A 股文档启动 `stock-watch-dev-pg`，只需在该开发实例首次创建 OKX 预览数据库：

```sh
docker exec stock-watch-dev-pg createdb -U stockdev okx_research_dev
PORT=8096 npm run dev
```

默认预览连接为 `postgresql://stockdev:local-stock-preview-only@127.0.0.1:15432/okx_research_dev`；这些是本地演示凭据。若没有本地实例，可先执行：

```sh
docker run --name stock-watch-dev-pg -d -p 127.0.0.1:15432:5432 \
  -e POSTGRES_USER=stockdev -e POSTGRES_PASSWORD=local-stock-preview-only \
  -e POSTGRES_DB=okx_research_dev postgres:17-alpine
```

模拟模式仅监听本机，免登录，记录也会保留，但不能与真实服务混用同一份 OKX 数据区。

## 验证

```sh
docker exec stock-watch-dev-pg createdb -U stockdev okx_research_test
OKX_TEST_DATABASE_URL=postgresql://stockdev:local-stock-preview-only@127.0.0.1:15432/okx_research_test npm run okx:test
npm run check
docker build -t okx-copy-research .
```

集成测试只接受名称以 `okx_research_test` 开头的专用数据库，会清理其中的测试 schema。测试使用假凭据，不调用真实 OKX；覆盖并发去重、事务回滚、会话过期与撤销、进程重启、数据库故障、单实例锁、与 A 股共享数据库时的隔离。
