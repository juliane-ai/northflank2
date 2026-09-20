# ZeroClaw 记忆持久化研究（2026-09，v0.8.5）

> 2026-09-16 更新：用户选择本地 SQLite＋rclone / InfiniCLOUD 周期快照恢复。实现、配置和数据丢失窗口见 [WebDAV 持久化](webdav-persistence.md)。下文保留早期后端比较，不再表示当前方案待定。

## 现状

- 无 Volume（平台侧挂载失败），`/zeroclaw-data` 随容器重建清空
- 预编译二进制（musl/gnu tarball 均验证）**未编译 `memory-postgres`**——lean 发布策略，配置 postgres 后端启动即报：

  ```
  Error: memory backend 'postgres' requested but this build was compiled
  without `memory-postgres`; rebuild with `--features memory-postgres`
  ```

- 其余后端 sqlite / qdrant / markdown / lucid 均编译内置（二进制缺特性字符串仅 memory-postgres 一条）
- 各层持久化能力：记忆可选后端；**配对 token 写死 config.toml（已用 env 预置固定 token 绕开）；网关会话固定 SQLite**——均不随外部数据库走

## 实测记录（方案 A 路线）

本地 Docker 起 `qdrant/qdrant` + zeroclaw（真实 LLM 凭据）E2E：

| 环节 | 结果 |
| --- | --- |
| qdrant 后端识别与连接 | ✅（`storage.qdrant.<alias>` = url + api_key + collection 三字段） |
| agent 调 memory_store 写入 | ❌ 两个前置：**collection 需手动创建**（zeroclaw 不自动建）+ **写入时生成向量需要 embedding provider**（`search_mode = "bm25"` 也不例外） |
| CLI `zeroclaw memory list` | ❌ 不支持 qdrant 后端（仅 sqlite/lucid/markdown），验证数据用 qdrant REST `/collections` |

另：CLI 非交互模式下 `memory_store` 会被风险审批自动拒绝，测试需在 `[risk_profiles.default]` 加 `auto_approve = ["memory_store"]`（生产走仪表盘/Discord 的交互审批，不需要）。

**当前 key 的 new-api 分组（nvidia）没有任何 embedding 模型**——`text-embedding-3-small/large`、`bge-m3`、`nv-embedqa-e5-v5` 等实测全部 `model_not_found`。

## 方案对比

| 方案 | 前置条件 | 工作量 | 持久性 | 备注 |
| --- | --- | --- | --- | --- |
| **A. Qdrant Cloud 免费层 + embedding API** | 注册 cloud.qdrant.io（免费 1GB）+ 一个 OpenAI 兼容 embedding key | 小：改配置 + 建 collection，当天可上线 | ✅ 完全外部，重部署无感 | 推荐 |
| **B. GitHub Action 自编译 `--features memory-postgres`** | 无（复用现有 Northflank Postgres，FTS 纯文本检索即可，不依赖 pgvector/embedding） | 大：Rust musl 交叉编译管线，首次 30-40 分钟，升级 zeroclaw 版本需重跑 | ✅ 现有 Postgres | 一步到位但维护成本高 |
| **C. sqlite + 定期快照外同步**（对象存储/git） | 存储凭据 | 中：entrypoint 下载/上传逻辑 | ⚠️ 有秒~分钟丢失窗口 | hacky，不推荐 |
| **D. 维持现状** | — | 零 | ❌ 记忆随容器消失 | 等官方 prebuilts 带上 memory-postgres 零成本切换 |

## 方案 A 实施清单（待拍板后执行）

1. 注册 Qdrant Cloud，拿集群 URL + API key（Secret：`ZEROCLAW_storage__qdrant__main__api_key`）
2. 搞 embedding key，候选：
   - 硅基流动 siliconflow.cn：`BAAI/bge-m3` 免费档，OpenAI 兼容 `/v1/embeddings`，国内直连（1024 维）
   - OpenAI 官方：`text-embedding-3-small`（1536 维，$0.02/1M tokens）
3. `.zeroclaw/config.toml` 追加：

   ```toml
   [memory]
   backend = "qdrant.main"
   search_mode = "bm25"
   embedding_provider = "custom:https://<embedding服务商>/v1"   # OpenAI 官方则填 "openai"
   embedding_model = "BAAI/bge-m3"
   embedding_dimensions = 1024                                  # text-embedding-3-small 用 1536

   [storage.qdrant.main]
   url = "https://<集群地址>:6333"
   collection = "zeroclaw_memories"
   ```

4. 一次性建 collection（1024 维、Cosine 距离；zeroclaw 不自动建）：

   ```sh
   curl -X PUT "https://<集群地址>:6333/collections/zeroclaw_memories" \
     -H "api-key: <key>" -H "Content-Type: application/json" \
     -d '{"vectors": {"default": {"size": 1024, "distance": "Cosine"}}}'
   ```

5. 重部署 → Discord 里让 agent 记一条 → qdrant 控制台看 points

## 方案 B 实施清单（备选）

1. 新增 `.github/workflows/build-zeroclaw.yml`：Rust musl 交叉编译 `--features memory-postgres`，产物挂到本仓库 Release
2. Dockerfile 下载地址改为自建产物（其余不变）
3. 配置：`[memory] backend = "postgres.main"` + `[storage.postgres.main]`，`db_url` 走 Secret（Northflank Postgres 加独立数据库/schema，遵守 security.md 隔离）

## 相关事实备查

- schema 佐证：`MemoryBackendKind` 含 postgres（"PostgreSQL with optional pgvector"），`PostgresStorageConfig`（db_url/schema/table/vector_enabled 默认 false/vector_dimensions 默认 1536）
- v0.8.3 release note："Standard prebuilts remain on the lean supported channel set"——裁剪是刻意策略
- 用户的 new-api 若自己管理，也可直接在后台加 embedding 渠道，等价于方案 A 的第 2 步
