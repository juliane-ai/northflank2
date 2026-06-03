# northflank2: CLI Proxy API 聚合架构示例

这个目录参考 `Northflank-multi-Instance` 的架构设计：用一个 Northflank Service 承载多个进程。当前只放入 `cli-proxy-api`，后续需要服务聚合时，可以继续在同一个 Dockerfile 中复制其他服务二进制，并在 `entrypoint.sh` 中追加后台启动逻辑。

配置和 PostgreSQL Store 使用环境变量控制，不再维护 `config.yaml`。

## 架构

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 多阶段构建：先从官方 `eceasy/cli-proxy-api:latest` 取 CLIProxyAPI 二进制，再放入 Alpine 聚合运行时 |
| `entrypoint.sh` | 聚合启动脚本；当前启动 CLI Proxy API，后续服务也从这里统一启动和清理 |
| `env` | Northflank 环境变量参考，不会复制进镜像 |

## 当前服务

| 服务 | 端口 | 用途 |
| --- | --- | --- |
| CLI Proxy API | `8317` | 主 API 服务 |
| CLI Proxy API 附加端口 | `8085`, `1455`, `54545`, `51121`, `11451` | 按官方 Docker 文档预留 |

## PostgreSQL Store 环境变量

参考官方文档：`PGSTORE_DSN` 存在时会启用 PostgreSQL Store，并优先于 Object Store 和 Git Store。

```env
MANAGEMENT_PASSWORD="..."
PGSTORE_DSN="postgresql://user:password@host:5432/dbname?sslmode=require"
PGSTORE_SCHEMA="northflank_work"
PGSTORE_LOCAL_PATH="/tmp/pgstore_work"
```

| 变量 | 说明 |
| --- | --- |
| `PGSTORE_DSN` | PostgreSQL 连接串，必填 |
| `PGSTORE_SCHEMA` | 数据库 schema，可选，默认 `public` |
| `PGSTORE_LOCAL_PATH` | 本地镜像目录，可选，默认 `./pgstore` |

## Northflank 部署

1. 创建 Northflank Service，选择从 Git 仓库构建。
2. Root directory 选择 `Northflank/northflank2`。
3. Dockerfile path 使用 `Dockerfile`。
4. 暴露 HTTP 端口 `8317`。
5. 如后续功能需要，继续暴露附加端口：`8085`、`1455`、`54545`、`51121`、`11451`。
6. 在 Northflank Environment Variables 中按 `env` 文件添加变量。

## 后续聚合方式

1. 在 `Dockerfile` 中增加新的源码阶段，例如 `FROM some-service:latest AS service-src`。
2. 在最终 Alpine 运行时中 `COPY --from=service-src ...` 复制二进制或配置。
3. 增加 `EXPOSE` 端口和可选 `HEALTHCHECK`。
4. 在 `entrypoint.sh` 中后台启动新服务，记录 PID，并在 `cleanup()` 中清理。

## 本地构建检查

```bash
docker build -t northflank2-cliproxy-aggregation .
```
