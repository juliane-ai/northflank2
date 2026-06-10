# northflank2: CLI Proxy API + GPT-Load + SearXNG 聚合架构

这个目录参考 `lumincc-north-multi-v1` 和 `cloudflare-docker-storage` 的设计：用一个 Northflank Service 承载多个进程，并为需要持久化的目录提供 Cloudflare Worker + R2 备份/恢复脚本。

当前聚合：

| 服务 | 端口 | 角色 | 说明 |
| --- | --- | --- | --- |
| CLI Proxy API | `8317` | 主服务 | 当前容器主等待进程，健康检查包含此端口 |
| GPT-Load | `3001` | 后台服务 | AI API 透明代理、Key 轮询、管理后台 |
| SearXNG | `8080` | 可选附加服务 | 轻量搜索服务，默认启用 |
| CLI Proxy API 附加端口 | `8085`, `1455`, `54545`, `51121`, `11451` | 预留 | 按官方 Docker 文档保留 |

## 文件结构

```text
northflank2/
├── Dockerfile
├── entrypoint.sh
├── settings.yml
├── env
├── README.md
└── scripts/
    ├── backup-data.sh
    ├── restore-data.sh
    ├── backup-searxng.sh
    ├── restore-searxng.sh
    ├── backup-all.sh
    └── scheduled-backup.sh
```

## 架构说明

`Dockerfile` 使用多阶段构建：

1. 从 `eceasy/cli-proxy-api:latest` 提取 `CLIProxyAPI`。
2. 从 `ghcr.io/tbphp/gpt-load:latest` 提取 `gpt-load`。
3. 以 `searxng/searxng:latest` 作为最终运行镜像，保留 SearXNG 的 Python/Granian 运行环境。
4. 复制 `settings.yml` 到 `/etc/searxng/settings.yml`。
5. 复制 R2 备份/恢复脚本到 `/usr/local/bin`。

`entrypoint.sh` 启动顺序：

```text
/entrypoint.sh
├── restore-data -> /app/data
├── optional restore-searxng -> /etc/searxng
├── start SearXNG background process -> :8080
├── start scheduled-backup loop -> optional daily backup-all
├── start GPT-Load background process -> :3001
└── start CLI Proxy API primary process -> :8317
```

健康检查只检查 `CLI Proxy API` 和 `GPT-Load`，避免 SearXNG 上游搜索引擎波动导致整个容器被重启。

## Northflank 部署

1. 创建 Northflank Service，选择从 Git 仓库构建。
2. Root directory 选择 `Northflank/northflank2`。
3. Dockerfile path 使用 `Dockerfile`。
4. 暴露 HTTP 端口 `8317` 给 CLI Proxy API。
5. 暴露 HTTP 端口 `3001` 给 GPT-Load。
6. 暴露 HTTP 端口 `8080` 给 SearXNG。
7. 如后续功能需要，继续暴露 CLI Proxy API 附加端口：`8085`、`1455`、`54545`、`51121`、`11451`。
8. 在 Northflank Environment Variables 中按本地 `env` 添加变量；仓库只提交脱敏的 `env.example`，密码类变量建议使用 Secret。

## 环境变量

### CLI Proxy API

```env
MANAGEMENT_PASSWORD="..."
PGSTORE_DSN="postgresql://..."
PGSTORE_SCHEMA="northflank_work"
PGSTORE_LOCAL_PATH="/tmp/pgstore_work"
```

### GPT-Load

```env
GPTLOAD_PORT="3001"
GPTLOAD_HOST="0.0.0.0"
AUTH_KEY="..."
ENCRYPTION_KEY="..."
DATABASE_DSN="postgres://.../defaultdb?sslmode=require&search_path=gpt_load_northflank2"
REDIS_DSN=""
LOG_ENABLE_FILE="false"
```

当前实例使用同一个 Aiven PostgreSQL 的 `defaultdb`，但把 GPT-Load 表放在独立 schema：

```sql
CREATE SCHEMA IF NOT EXISTS gpt_load_northflank2;
```

如果 GPT-Load 初始化时没有尊重 `search_path`，说明它的 PostgreSQL 驱动/ORM 不兼容同库不同 schema；这时退回“不同 Database”的方案更稳。

### SearXNG

```env
SEARXNG_ENABLED="true"
SEARXNG_PORT="8080"
SEARXNG_CONFIG_DIR="/etc/searxng"
SEARXNG_SETTINGS_PATH="/etc/searxng/settings.yml"
SEARXNG_BASE_URL="http://127.0.0.1:8080"
INSTANCE_NAME="mcp-search"
SEARXNG_SECRET_KEY="<openssl rand -hex 32>"
GRANIAN_LOG_LEVEL="warning"
GRANIAN_BLOCKING_THREADS="2"
```

`settings.yml` 是低内存配置：裁剪搜索引擎、开启 `html`/`json` 输出、关闭 metrics/image proxy/limiter。`server.secret_key` 会在启动时由 `SEARXNG_SECRET_KEY` 注入，生产环境必须在平台 Secret 中配置真实随机值。

## Cloudflare R2 持久化

本项目复用 `cloudflare-docker-storage` 的 Worker + R2 方案。主数据目录和 SearXNG 配置目录独立备份，避免多个服务共用同一个 R2 key。

### 主数据目录

```env
DATA_DIR="/app/data"
BACKUP_WORKER_URL="https://cloudflare-docker-storage.564510493.workers.dev"
BACKUP_WORKER_API_KEY="<Northflank Secret>"
BACKUP_PASSWORD="<openssl rand -base64 48>"
BACKUP_OBJECT_KEY="northflank2/data.tar.gz.enc"
RESTORE_IF_DATA_EXISTS="false"
SHA256_VERIFY="warn"
```

### SearXNG 配置目录

```env
SEARXNG_ENABLE_BACKUP="false"
SEARXNG_BACKUP_PASSWORD="<openssl rand -base64 48>"
SEARXNG_BACKUP_OBJECT_KEY="northflank2/searxng-config.tar.gz.enc"
SEARXNG_RESTORE_IF_DATA_EXISTS="false"
```

默认不启用 SearXNG 自动恢复，因为镜像已经内置 `settings.yml`。只有当你会在容器内动态修改 `/etc/searxng` 时，才建议设置：

```env
SEARXNG_ENABLE_BACKUP="true"
```

### 手动备份

进入容器 Shell 后执行：

```bash
backup-all
```

也可以单独执行：

```bash
backup-data
backup-searxng
```

### 定时备份

内置 `scheduled-backup` 后台循环，不依赖 cron。调度使用容器本地时间；当前 `TZ=Asia/Shanghai`，所以 `SCHEDULED_BACKUP_TIME` 按北京时间解释。启用方式：

```env
TZ="Asia/Shanghai"
SCHEDULED_BACKUP_ENABLED="true"
SCHEDULED_BACKUP_TIME="03:30"
SCHEDULED_BACKUP_RUN_ON_START="false"
SCHEDULED_BACKUP_INTERVAL_SECONDS="60"
BACKUP_ALL_STRICT="false"
```

`BACKUP_ALL_STRICT=false` 时，SearXNG 备份失败不会影响主流程。

## 本地构建检查

```bash
docker build -t northflank2-cliproxy-gptload-searxng .
```

构建后本地运行时至少需要提供 CLI Proxy API、GPT-Load 的数据库相关环境变量；R2 备份变量可以先留空，脚本会跳过恢复。
