# 第一版系统架构

## 目标

第一版是一个只读 OKX 跟单看板，为后续仓位生命周期研究提供可信入口。它不是交易机器人，也不是通用账户资产看板。

## 技术组成

- 运行时：Node.js 24，ES modules。
- OKX SDK：固定 `okx-api@3.2.3`。
- UI：固定 `@tabler/core@1.5.1`，从本服务静态提供，不依赖运行时 CDN。
- HTTP：Node 内置 HTTP server，当前规模不引入额外 Web 框架。
- 认证：单账号、PostgreSQL 持久会话，默认有效 30 天；浏览器会话凭据只存在于 HttpOnly Cookie。
- 地区访问：从可信上游的国家代码请求头执行允许名单，默认配置为中国和美国。
- 部署：单个容器，监听 `PORT`，默认 `8080`；PostgreSQL 保存登录会话和生命周期数据，通过数据库服务锁保持单副本。

```text
Browser
  │  Tabler login + HttpOnly session cookie + local JSON
  ▼
Node read-only service
  ├── overview cache
  ├── response allow-list / normalization
  ├── PostgreSQL sessions + position lifecycle store
  └── okx-api RestClient
        ├── account/config
        ├── account/balance
        ├── account/positions
        ├── copytrading/current-lead-traders
        ├── copytrading/current-subpositions?subPosType=copy
        └── copytrading/copy-settings
```

## 模块职责

### `src/okx-reader.js`

这是 SDK 的唯一入口，只包装第一版批准的读取方法。浏览器无法访问 SDK 实例或凭据。

### `src/overview.js`

并行读取各数据源，删除不需要传到浏览器的字段。单个数据源失败时返回该数据源状态，不把 SDK 原始异常传给浏览器。

### `src/server.js`

除登录与退出外只接受 HTTP `GET`。提供国家允许名单、登录限流、失败锁定、安全会话、CSRF 校验、缓存、安全响应头、精简 JSON 和 Tabler 静态资源。

### `public/`

跟单子仓位是首要视图；带单员关系、账户聚合仓位和资产是辅助视图。页面没有改变 OKX 状态的控件。

### `src/okx-postgres-lifecycle.js`

只在跟单子仓位数据源成功时推进状态。首次发现写入 `COPIED_OPEN_DETECTED`，按最小间隔保存观察快照；连续两次成功读取都未出现后才写入 `CLOSE_DETECTED`。数据源失败不会被误判为平仓。

## 缓存和刷新

- 浏览器默认每 15 秒刷新一次。
- 摘要默认缓存 8 秒，避免多个浏览器请求直接放大为 OKX 请求。
- 单个带单员的跟单设置缓存 60 秒，只在用户查看时读取。
- `/healthz` 检查 PostgreSQL 连通性与服务锁，不读取 OKX，避免健康检查消耗交易所限流。
- 生命周期观察以 overview 的读取时间为幂等键，同一缓存结果不会重复累计快照或消失次数。

## 下一阶段架构变化

下一步需要接入 OKX 公共行情 WebSocket。当前 REST 快照用于验证仓位生命周期，不能替代 MFE、MAE 和滑动保护研究所需的行情序列；届时应把行情采集和策略回放定义成独立模块，再决定是否拆分为多个 Northflank 服务。
