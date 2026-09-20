# InfiniCLOUD / rclone 持久化恢复副本

用户已选择本地目录读写、定期备份与启动恢复。主 `Dockerfile` 安装 rclone、Python 和 tini；持久化 supervisor 在应用启动前恢复，在运行期间生成快照，在应用停止后做最后一次备份。默认关闭，未配置时保持原有启动行为。无需 FUSE、特权容器或额外监听端口。

## 要填写的 .env

在 InfiniCLOUD **My Page → Apps Connection** 启用应用连接，复制 WebDAV Connection URL、Connection ID 和 Apps Password：

```dotenv
PERSIST_ENABLED=true
PERSIST_WEBDAV_URL=https://你的服务器名.infini-cloud.net/dav/
PERSIST_WEBDAV_USER=你的Connection-ID
PERSIST_WEBDAV_PASSWORD=你的Apps-Password
PERSIST_WEBDAV_WORKSPACE=trader-workspace
PERSIST_REMOTE_PATH=g02-ritup-repo02-mix/production
PERSIST_PATHS_JSON=[{"name":"zeroclaw","local":"/zeroclaw-data"}]
```

URL 必须原样使用账户页面给出的完整地址；部分账户仍使用 `teracloud.jp` 域名，不要自行替换域名。Connection ID 是用户 ID；Apps Password 是应用连接密码，不是网页登录密码。重新签发 Apps Password 会使其他应用的旧连接密码一起失效。

`PERSIST_WEBDAV_WORKSPACE` 是网盘上的工作目录，默认 `trader-workspace`；`PERSIST_REMOTE_PATH` 是其内部的项目／环境路径。实际快照全部位于 `trader-workspace/g02-ritup-repo02-mix/production/snapshots-v1/`，不会写到网盘根目录其他位置。

本地 `.env` 已被 Git 和 Docker build context 排除。Northflank 不会自动读取本机 `.env`，部署时须将同名变量填入平台环境变量／Secrets，密码仅放 Secret。JSON 按示例原样填写，不额外加单引号。配置不会在构建阶段接入网盘。

## 一个或多个目录

默认只备份 `/zeroclaw-data`，包括其 `data` 数据库目录、`.zeroclaw/agents` 工作区和 `.zeroclaw/shared` 共享资料；默认过滤见下表。

多目录示例：

```dotenv
PERSIST_PATHS_JSON=[{"name":"zeroclaw","local":"/zeroclaw-data"},{"name":"shared","local":"/app/data/shared"},{"name":"reports","local":"/app/data/reports"}]
PERSIST_EXCLUDE_JSON=["**/downloads/**","**/attachments/**","drafts/**"]
```

`name` 是稳定的快照标识，`local` 是容器内目录，不是 Mac 上的目录。应用必须确实把文件写入所选路径。允许 `/zeroclaw-data`、`/app/data`、`/data` 及其子目录；拒绝系统目录、符号链接目录、重叠目录和重复名称。最多 16 个映射。修改本地路径而保留同一个 name 可在新容器中恢复原目录；新增 name 没有旧数据时保持空目录。

自定义排除规则相对于每个映射根目录，大小写敏感，支持 `*`、`?`、`**/`。内置排除不可通过配置关闭；排除会在备份及恢复时同时应用。

| 数据 | 处理 |
| --- | --- |
| ZeroClaw 记忆、会话 SQLite | 本地运行；通过 SQLite 在线备份接口生成包含已提交 WAL 数据的一致副本，再压缩上传 |
| 工作区文档、人格、技能、共享资料、指定报告 | 保存普通文件；符号链接、socket、设备文件不上传 |
| `.env`、`.env.*`、`config.toml`、`auth*.json`、`credentials*`、名称含 `secret` / `keyring` 的文件 | 排除；配置从镜像和平台 Secrets 恢复，运行期界面配置修改不会自动保留 |
| `.ssh`、`.gnupg`、`.aws`、私钥、PEM | 排除 |
| `.git`、`node_modules`、`__pycache__`、`target` | 排除 |
| `cache`、`caches`、`.cache`、`tmp`、`temp`、`logs`、`*.log`、PID/锁文件、SQLite WAL/SHM/journal | 排除；数据库主文件通过专门快照处理 |
| OKX、A 股、独立模拟服务 PostgreSQL | 继续保存在各自数据库，由数据库备份方案保护；不复制数据库运行目录到 WebDAV |

文件名过滤不会识别任意正文中的秘密，聊天记录和记忆本身也可能含个人信息。保持网盘与快照私有，敏感原始文件应放在未映射目录或明确排除。rclone obscure 仅为凭据格式转换，不是备份加密；归档通过 HTTPS 传输，未启用客户端内容加密。

## 参数与完整性

| 参数 | 默认 | 作用 |
| --- | --- | --- |
| `PERSIST_INTERVAL_SECONDS` | `300` | 每轮结束后间隔 5 分钟再检查；完全相同的快照不重复上传 |
| `PERSIST_KEEP_SNAPSHOTS` | `288` | 保留最近 288 个已提交版本；持续变化时约覆盖 24 小时，未变化时更久 |
| `PERSIST_MAX_BYTES` | `536870912` | 全部映射的未压缩数据总上限 512 MiB，超限失败并保留旧远端版本 |
| `PERSIST_MAX_FILES` | `10000` | 文件数上限，限制枚举清单和归档元数据的内存占用 |
| `PERSIST_OPERATION_TIMEOUT_SECONDS` | `120` | 整个备份或启动恢复的时间预算；含列目录、上传、下载验证与提交 |
| `PERSIST_SHUTDOWN_TIMEOUT_SECONDS` | `25` | 服务停止后的最后一次备份预算 |
| `PERSIST_RESTORE_POLICY` | `empty` | 全部映射都没有可备份数据时恢复最新版本；本地历史完整时保留本地版本，部分历史缺失时阻止启动 |

rclone 使用 `webdav` / `vendor=other`，单传输、检查并发 2、最多 4 个连接、每秒请求目标上限 4、连接超时 10 秒、空闲 I/O 超时 30 秒、高低层重试各 3 次、重试间隔 2 秒。整体时间预算会进一步限制重试；这些是小规模状态数据的保守配置，不是 InfiniCLOUD 公布的请求配额。

内存配置固定为每次传输 `--buffer-size 1Mi`、所有缓冲 `--max-buffer-memory 4Mi`、关闭多线程传输、队列上限 1000；Go 使用 `GOMEMLIMIT=48MiB` 和 `GOGC=50`。GOMEMLIMIT 是 Go 的软目标，**不是进程 RSS 硬上限**。rclone 只在检查／传输时短暂运行，两个快照周期之间没有常驻 rclone 进程，也不使用 VFS 内存缓存。文件和压缩归档通过磁盘流式处理，rclone 的元数据输出也先落临时文件并限制读取大小。

Linux 下大文件复制每 8 MiB 刷新临时文件并提示内核释放文件缓存，归档／恢复后同样释放可回收缓存，避免 RSS 很低但容器因脏页缓存耗尽内存。2026-09-16 在 ARM64 镜像（rclone 1.74.1）实测：64 MiB 不可压缩随机数据，在独立 **128 MiB、无 swap** 的客户端容器中完成上传、下载校验、恢复和内容比对；rclone RSS 峰值约 **82.4 MiB**，Python 约 **20.7 MiB**。测试 WebDAV 服务在另一容器。该限额接近压力边界，生产建议为持久化组件留约 160–192 MiB 活动余量，再加 Node / ZeroClaw 的自身预算；不要把整个应用容器限制为 128 MiB。512 MiB 默认数据上限不是已通过同等内存限额的性能承诺。

普通 WebDAV 不保留原始修改时间，也不提供可依赖的远端内容哈希，因此不用修改时间、`--size-only` 或 `--checksum` 推断数据正确。大量小文件合并为压缩级别 1 的归档，降低请求数和 CPU 开销。相同内容的归档确定性生成；上传后下载副本验证 SHA-256，成功后才上传 JSON 提交清单。下载验证会增加一份归档的流量，换取可验证的恢复副本。

远端只写入独占目录：

```text
trader-workspace/g02-ritup-repo02-mix/production/snapshots-v1/
  20260916T150000000000Z-0123456789ab.tar.gz
  20260916T150000000000Z-0123456789ab.json
```

JSON 是完成标记。上传中断且没有 JSON 的归档不会被恢复，也不触发旧版本清理。成功提交或确认内容未变后，仅按命名规则清理超过保留数的本服务旧版本，以及超过 24 小时仍无提交清单的孤立归档；不使用 `sync`、`bisync` 或远端目录级删除。不匹配本服务文件命名的其他文件不清理。

启动恢复先下载到临时目录，验证大小、SHA-256、文件清单和解包路径，全部通过后才复制到映射目录。目标含符号链接或恢复中断留下标记时拒绝启动，须用空的新容器重新恢复。多目录中若已有本地数据，却又缺少另一目录的远端历史，则阻止启动，避免混合两个时点。最新提交版本损坏时同样拒绝启动，不会静默回退旧数据。显式 `never` 用于已有可信本地数据的迁移，仍会上传后续版本；不要用它绕过真实恢复失败。

## 部署与验证

仅允许**单副本、一个写入者**，每套环境使用不同 `PERSIST_REMOTE_PATH`。部署策略应先停止旧实例并完成最终备份，再启动新实例；不要滚动重叠运行两个写入者。WebDAV 没有本方案可依赖的分布式写锁。

Northflank 启动宽限期建议至少 180 秒，终止宽限期至少 60 秒（应用排空最多 20 秒＋最终备份默认 25 秒＋余量）；增大超时后应同步调整平台宽限期。临时磁盘至少预留约 3 倍数据大小用于 SQLite 副本、归档与下载验证，实际用量取决于压缩率。Docker 的健康检查同时检查应用和备份新鲜度；若平台单独配置 HTTP 探针，应另外监控 `persistence.backup_failed` 日志，否则 HTTP 健康不代表备份健康。

```sh
docker build -t okx-copy-research:webdav-local .
# 自动读取本地 .env，只向 128 MiB 诊断容器传入 PERSIST_* 变量
npm run persistence:validate
# 在工作目录内创建独立临时目录，验证 32 KiB 上传／下载／SHA-256 后清理
npm run persistence:probe
# 只校验 .env 和目录配置，不联网、不打印密码
docker run --rm --env-file .env --entrypoint python3 okx-copy-research:webdav-local /app/scripts/persistence/persist.py validate
# 实际启用时沿用现有服务的端口、数据库等运行配置，并设置至少 60 秒停止宽限
docker run --rm --env-file .env --stop-timeout 60 -p 8080:8080 okx-copy-research:webdav-local
```

示例使用无外层单引号的 JSON，同时兼容 Docker `--env-file` 和 Node 的 `.env` 加载器；不要直接通过 shell `source .env` 执行它。

日志仅记录事件、快照标识、文件数和字节数，不打印网盘密码、完整 URL 或源文件内容。`persistence.restored` / `saved` 表示已恢复／已提交；连续超过 3 个周期加一次操作预算没有成功备份／远端检查，容器健康检查失败。启动时网盘不可达或凭据错误会阻止应用启动。

开发验证：`npm run test:persistence` 测试 SQLite WAL、一致性、排除项、多目录冲突、符号链接、失败提交、保留策略和服务停止。`test/persistence/integration_webdav.py` 在构建镜像内使用本机 HTTPS WebDAV 验证真实 rclone 上传／恢复及停机最终备份，可用 `PERSIST_TEST_MIB=64` 加入随机大文件并采样进程内存。真实网盘的 32 KiB 连接测试已通过（2026-09-16），测试文件和目录已清理。

`test/persistence/benchmark_client.py` 是分离测试服务后的客户端内存压测。它只连接 `https://127.0.0.1:19443/` 上的临时测试服务，使用 `/tls/cert.pem` 作为测试 CA；按实际 cgroup 上限输出内存测量，不读取真实网盘凭据。

没有本地持久卷时，断电、强制终止或网盘长期故障仍可能丢失**最近一次成功快照之后**的数据。该方案提供周期性恢复副本，不是同步零丢失存储。正常停止会尽力做最后一次备份；关键交易状态仍使用 PostgreSQL。

## 在本地查看云端数据

```sh
npm run persistence:mirror
# 等价命令；读取本地 .env，默认使用已构建的 rclone 镜像
node --env-file-if-exists=.env scripts/persistence-local.mjs mirror
```

命令只允许 WebDAV 列目录、读取清单和下载，**不创建、不上传、不删除远端文件**。复用上述低内存参数，在 128 MiB、无 swap 的临时容器中运行；脚本从当前仓库只读挂载，不必因修改脚本重新构建镜像。容器结束后没有常驻同步进程。每次需要了解云端最新状态时重新执行命令。

本地查看副本固定保存在仓库的 `data/cloud-mirror/`，已被 `data/` 的 Git 忽略规则覆盖：

```text
data/cloud-mirror/
  README.md             # 本次拉取结果和检查时间
  inventory.json        # 云端目录、快照数、当前版本及状态
  latest/               # 指向最新已校验快照的数据，可直接浏览
    zeroclaw/           # 映射名；内部保持备份时的相对路径
  snapshots/
    <snapshot-id>/
      snapshot.tar.gz   # 原始已校验归档
      manifest.json     # 远端提交清单
      files.json        # 实际可查看文件列表与大小
      data/             # 应用排除规则后展开的数据
```

仅下载配置的 `PERSIST_REMOTE_PATH` 中最新已提交版本；工作目录清单用于了解云端结构，不会把其他项目的内容一起下载。保留之前拉取的版本，未变归档复用本地缓存并重新校验，避免重复流量。SHA-256、归档大小、路径、文件数量和排除规则全部通过后才更新 `latest/`。失败时保留之前的查看副本；`inventory.json` 中的检查时间用于判断是否过期。云端没有已提交快照时仍生成 `README.md` 和 `inventory.json`，明确说明尚无可下载数据；不会把空目录伪装成成功恢复。

这里是独立查看副本，不连接本地正在运行的数据库，也不把文件覆盖到 `.zeroclaw`、`.env` 或应用工作目录。SQLite 应以只读方式打开，例如 `sqlite3 -readonly data/cloud-mirror/latest/zeroclaw/data/brain.db`（文件名以实际清单为准）；修改副本不会回传。密钥、配置和缓存仍按恢复时的排除规则过滤。外部 PostgreSQL 数据不在该快照内。

2026-09-17 已通过真实 InfiniCLOUD 的只读列目录检查：`trader-workspace/g02-ritup-repo02-mix/production/snapshots-v1/` 目录存在，但当时没有已提交快照。因此本地生成的清单反映空备份目录，暂时没有云端应用数据可展开。这并不能证明云端服务本身没有数据，只说明当前 WebDAV 路径尚未产生备份。

## 官方资料

- [InfiniCLOUD 连接地址、Connection ID 与 Apps Password](https://infini-cloud.net/en/support_account_login-settings_apps.html)
- [InfiniCLOUD WebDAV 兼容性与文件系统挂载限制](https://infini-cloud.net/en/support_guide_general_webdavcli.html)
- [InfiniCLOUD 上传时间戳行为](https://infini-cloud.net/en/support_webbrowser_issues_uploadts.html)
- [rclone WebDAV](https://rclone.org/webdav/)
- [Northflank 原生持久卷](https://northflank.com/docs/v1/application/databases-and-persistence/add-a-volume)
