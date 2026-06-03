# northflank2: CLI Proxy API + GPT-Load 聚合架构示例

这个目录参考 `Northflank-multi-Instance` 的架构设计：用一个 Northflank Service 承载多个进程。当前聚合 `cli-proxy-api` 和 `gpt-load`，后续可以继续在同一个 Dockerfile 中复制其他服务二进制，并在 `entrypoint.sh` 中追加后台启动逻辑。

CLI Proxy API 使用 `PGSTORE_*` 环境变量；GPT-Load 使用 `DATABASE_DSN` 连接同一个 Aiven PostgreSQL，并通过不同 schema 做实例隔离。

## 架构

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段构建：从官方镜像提取 CLIProxyAPI 和 GPT-Load 二进制，再放入 Alpine 聚合运行时 |
| `entrypoint.sh` | 聚合启动脚本；后台启动 GPT-Load，再启动 CLI Proxy API，并统一处理退出清理 |
| `env` | Northflank 环境变量参考，不会复制进镜像 |

## 当前服务

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| GPT-Load | `3001` | AI API 透明代理、Key 轮询、管理后台 |
| CLI Proxy API | `8317` | 主 API 服务 |
| CLI Proxy API 附加端口 | `8085`, `1455`, `54545`, `51121`, `11451` | 按官方 Docker 文档预留 |

## GPT-Load 方案 3: 同库不同 Schema

当前实例使用同一个 Aiven PostgreSQL 的 `defaultdb`，但把 GPT-Load 表放在独立 schema：

```env
DATABASE_DSN="postgres://avnadmin:...@pg-2cd0e13b-hutamefohiy46-c768.i.aivencloud.com:11191/defaultdb?sslmode=require&search_path=gpt_load_northflank2"
```

部署前先在 Aiven PG Studio 或 psql 中执行：

```sql
CREATE SCHEMA IF NOT EXISTS gpt_load_northflank2;
```

如果 GPT-Load 初始化时没有尊重 `search_path`，说明它的 PostgreSQL 驱动/ORM 不兼容方案 3；这时退回“不同 Database”的方案会更稳。

## 环境变量

```env
# CLI Proxy API PostgreSQL Store
MANAGEMENT_PASSWORD="..."
PGSTORE_DSN="postgresql://..."
PGSTORE_SCHEMA="northflank_work"
PGSTORE_LOCAL_PATH="/tmp/pgstore_work"

# GPT-Load
GPTLOAD_PORT="3001"
GPTLOAD_HOST="0.0.0.0"
AUTH_KEY="..."
ENCRYPTION_KEY="..."
DATABASE_DSN="postgres://.../defaultdb?sslmode=require&search_path=gpt_load_northflank2"
REDIS_DSN=""
LOG_ENABLE_FILE="false"
```

## Northflank 部署

1. 创建 Northflank Service，选择从 Git 仓库构建。
2. Root directory 选择 `Northflank/northflank2`。
3. Dockerfile path 使用 `Dockerfile`。
4. 暴露 HTTP 端口 `8317` 给 CLI Proxy API。
5. 暴露 HTTP 端口 `3001` 给 GPT-Load。
6. 如后续功能需要，继续暴露 CLI Proxy API 附加端口：`8085`、`1455`、`54545`、`51121`、`11451`。
7. 在 Northflank Environment Variables 中按 `env` 文件添加变量。

## 后续聚合方式

1. 在 `Dockerfile` 中增加新的源码阶段，例如 `FROM some-service:latest AS service-src`。
2. 在最终 Alpine 运行时中 `COPY --from=service-src ...` 复制二进制或配置。
3. 增加 `EXPOSE` 端口和可选 `HEALTHCHECK`。
4. 在 `entrypoint.sh` 中后台启动新服务，记录 PID，并在 `cleanup()` 中清理。

## 本地构建检查

```bash
docker build -t northflank2-cliproxy-gptload-aggregation .
```
