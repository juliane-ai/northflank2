# ZeroClaw 同容器部署

ZeroClaw 与 OKX 主服务打包进同一个镜像：主进程是 Node 看板，ZeroClaw 作为可选 sidecar 后台运行。背景选型研究见 [mini-agent.md](mini-agent.md)。

## 为什么不用官方容器镜像

官方 `ghcr.io/zeroclaw-labs/zeroclaw` 是 glibc 基座（distroless/debian），无法拷进本仓库的 `node:24-alpine`。因此 Dockerfile 直接下载官方 release 的 musl 静态二进制（`zeroclaw-x86_64/aarch64-unknown-linux-musl.tar.gz`），校验 SHA256 后安装：

- `zeroclaw` → `/usr/local/bin/zeroclaw`
- 网关前端 → `/usr/share/zeroclawlabs/web/dist`（二进制内置路径）
- 数据目录 → `/zeroclaw-data`（构建时已属主给 node）

同 tarball 内的 `zerocode`（TUI）和 `zerorelay` 无头容器用不上，未安装。

## 启动与开关

`entrypoint.sh` 是容器入口，模式与 multi-v1 一致：主服务 `node src/server.js` 后台启动并 `wait`，ZeroClaw 按开关决定是否启动，TERM/INT 统一清理。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ZEROCLAW_ENABLED` | `false` | 不设置则行为与旧镜像完全一致 |
| `ZEROCLAW_HOST` | `127.0.0.1` | 网关绑定地址；非回环时自动设 `allow_public_bind=true` 并输出告警 |
| `ZEROCLAW_PORT` | `42617` | 网关端口 |

其余配置按官方 v0.8.0 语法直接透传（详见下节）；没有配置模型 provider 时 daemon 仍会启动，只是不可对话。

## 配置（LLM 在哪里配）

两个入口，二选一或混用（env 优先级高于文件）：

**方式一：环境变量（key/url/model 全走 env，Northflank Secrets 与 .env 同名同值）**

env 名与 `config.toml` 路径一一对应，`__` 是层级分隔符。当前实际使用的四个变量：

```sh
ZEROCLAW_providers__models__custom__relay__api_key=sk-...                          # 模型凭据，必须放 Secret
ZEROCLAW_providers__models__custom__relay__uri=https://<new-api中转站>/v1           # 必须带 /v1 后缀
ZEROCLAW_providers__models__custom__relay__model=nvidia/nemotron-3-super-120b-a12b # 必须是该 key 分组内的可用模型
ZEROCLAW_agents__main__model_provider=custom.relay                                 # 把默认 agent 绑到该 provider
```

TOML 路径为 `providers.models.<类型>.<别名>.*`（字段：`kind`/`uri`/`model`/`api_key`/`temperature`/`timeout_secs`/`wire_api` 等），env 名就是把点换成双下划线。换直连 Anthropic/OpenAI 等同理，改类型段即可。

**方式二：config.toml 文件（本仓库采用）**

- 源文件：`.zeroclaw/config.toml`（已提交，不含密钥），Dockerfile COPY 到镜像内 `/home/node/.zeroclaw/config.toml`。
- 运行时实际读取：`/zeroclaw-data/.zeroclaw/config.toml`（配置基目录随 `ZEROCLAW_DATA_DIR` 移动）；entrypoint 首次启动时自动把烘焙文件播种过去，挂 Volume 后配置也不丢。
- 文件必须以 `schema_version = 3` 开头，否则 zeroclaw 会静默忽略整个文件。
- key/url/model 都放环境变量（同上四个变量）；`.env` 供本地，Northflank Secrets 供生产。注意 zeroclaw 不读 `.env` 文件——本地手动跑 zeroclaw 时先 `set -a; source .env; set +a`。
- 验证过的一个坑：缺 `risk_profiles.default` 表时 agent 会启动失败（`risk_profile does not name a configured entry`），文件里已带上空表继承安全默认。

上游中转（new-api，OpenAI 兼容）：走 `[providers.models.custom.relay]` slot（custom 即 OpenAI 兼容），`uri` 必须带 `/v1` 后缀（zeroclaw 在其后拼 `/chat/completions`）；`model` 必须是该 key 分组内的可用模型名——实测当前分组仅 nemotron-3-super/ultra 可用（其余 Claude/Kimi/DeepSeek 名义在列但 404/410/超时）。若换直连 Anthropic，改用 `[providers.models.anthropic.<别名>]` + `/v1/messages` 格式。

进阶：`[[model_routes]]` 可按任务 hint 把不同请求路由到不同 provider/model，多 provider 才需要。

### Discord 图片路由

2026-09-17 的云端轨迹确认：`custom.relay` 把截图发给 `nvidia/nemotron-3-super-120b-a12b` 后，上游返回 HTTP 400：`Received multimodal data but multimodal processing is not enabled`。ZeroClaw 的通用 custom provider 默认宣称支持图像，因此必须显式区分文字模型和视觉模型；这个报错不表示 Discord 下载附件失败。

主镜像启动时自动复用 `SIGNAL_VISION_BASE_URL` 和 `SIGNAL_VISION_API_KEY`，建立 `custom.vision`，将当前 Nemotron relay 标为 `vision=false`，并通过 `multimodal.vision_model_provider` 将图片请求送到视觉模型。聊天识图模型默认取 `SIGNAL_VISION_MODELS` 第一项；可用 `ZEROCLAW_VISION_MODEL` 单独指定。Google 中转的 origin 或 `/v1` 地址会规范化成 `/v1`。凭据只进入 ZeroClaw 子进程环境，不写入配置文件或日志；通过环境变量明确配置的视觉路由优先。

此路由使用 ZeroClaw v0.8.5 原生功能，已用同版本二进制验证图片只发送给视觉模型、普通文字只发送给 relay。它与方向实验室的双模型一致性识别是两条流程；普通聊天回复不代表已经登记模拟任务。

2026-09-17 又确认了一层故障：该中转在多个上游通道之间随机分流，同一型号（`models/gemini-2.5-flash`、`models/gemini-3-flash-preview`）会随机返回 HTTP 403 `openai_error`，或 503 `No available channel for model ... under group gemini`，而下一个请求又成功。ZeroClaw 的专用视觉路由是单次尝试实现（`create_model_provider_from_ref_with_model` 返回裸 provider，不走可靠层），一次随机失败就会让整轮 Discord 回复报错。

因此默认把两个 alias 都改道同容器主服务暴露的回环重试端点：视觉走 `http://127.0.0.1:${PORT}/internal/vision/v1`，文字走 `http://127.0.0.1:${PORT}/internal/relay/v1`。只有回环来源、持 Bearer 密钥（视觉默认即 `SIGNAL_VISION_API_KEY`，可用 `SIGNAL_VISION_PROXY_TOKEN` 换一份；文字即该 alias 自己的 `api_key`）的调用会被接受，其余请求返回 404；端点挂在数据库租约与登录之前，所以看板数据库异常时重试仍可用。403/408/425/429/5xx 与连接层错误会在预算内重试：视觉会轮换 `SIGNAL_VISION_MODELS`，文字先重试点名的型号。2026-09-17 晚实测该中转的模型清单已不含任何 `nvidia/nemotron-*`，原文字模型整组下线（503 `No available channel for model ... under group gemini`），因此文字路由在“该型号无可用通道”时会立即降级到 `SIGNAL_TEXT_MODELS`（未配置时复用已批准的 `SIGNAL_VISION_MODELS`），并在日志里写 `relay.fallback`；其他 4xx 语义错误不重试。设置 `ZEROCLAW_RELAY_ROUTE=direct` 可恢复直连上游（无重试）。方向实验室的分析子进程使用同一个文字端点，配置来自 `nativeAgentEnvironment`。

验证配置是否生效：

```sh
docker exec <容器> zeroclaw config list --filter providers   # 💉 标记 = env 已覆盖生效
```

## Northflank 部署

1. 镜像版本由构建参数 `ZEROCLAW_VERSION` 固定（当前 `v0.8.5`），升级改参数重建镜像。
2. 需要 Northflank 侧新增端口映射时用 `42617`；只在本服务内部使用则保持内部端口。
3. 容器健康检查仍只探测主服务 `/healthz`；ZeroClaw 存活通过日志观察（`zeroclaw status --format=exit-code` 可手动排查）。
4. 持久化：ZeroClaw 会话与状态写在 `/zeroclaw-data`。主镜像支持可选的 [InfiniCLOUD / rclone 快照与启动恢复](webdav-persistence.md)，默认关闭；没有启用它或挂载 Volume 时，容器重建仍会清空数据。原生 Volume 的属主须允许 `node`（uid 1000）写入。

## 登录认证（固定配对 token）

无 Volume 时配对码每次重部署都会轮换，登录体验差。改用**预置固定 token**：通过环境变量给 `gateway.paired_tokens` 预置一个明文 `zc_*` token（值必须是 TOML 数组字面量，含内层双引号）：

```sh
ZEROCLAW_gateway__paired_tokens=["zc_<64位hex>"]
```

已验证（v0.8.5）：env 数组注入生效（`config list` 显示 💉+🔒）；网关识别为"已配对"，不再生成一次性码；`/api/*` 对该 Bearer token 返回 200，错/无 token 均 401；`/health` 保持免认证。pairing 保持开启，该 token 等效于一张永久配对凭证，且随环境变量在重部署后依然存在。

浏览器登录（一次性）：打开 zeroclaw 页面 → F12 控制台执行（token 与环境变量同值）→ 刷新：

```js
localStorage.setItem("zeroclaw_token", "zc_<同值>"); location.reload()
```

前端将 token 存于 localStorage（键 `zeroclaw_token`），此后每次请求自动带 `Authorization: Bearer`，重部署/换码均不受影响。换浏览器或清缓存后重跑一次即可。程序化调用（webhook 等）直接用同一 token 做 Bearer。

## Discord 接入（channel 授权模型）

v0.8.5 预编译内置的 channel：discord / telegram / matrix / whatsapp / email / gmail_push / lark / git / filesystem / webhook（slack、微信、QQ、钉钉等被 lean 发布裁剪，配置界面能看到但运行时不可用）。

接入步骤：

1. 开发者门户 `discord.com/developers/applications` → Bot 页拿 token；**MESSAGE CONTENT INTENT 必须打开且点页面底部 Save Changes**——不开则事件照收但 content 为空，机器人静默。
2. 凭据走 env（`__` 分层）：

   ```sh
   ZEROCLAW_channels__discord__main__enabled=true
   ZEROCLAW_channels__discord__main__bot_token=<token>
   ZEROCLAW_channels__discord__main__intents_mask=37377   # GUILDS|GUILD_MESSAGES|DIRECT_MESSAGES|MESSAGE_CONTENT
   ```

3. 连接是出站 WebSocket，无需开入站端口；OAuth2 URL Generator 拉机器人进服务器。
4. **授权走 `[peer_groups]`，这是最易踩的坑**：channel 只负责递消息，agent 只响应 peer group 里的外部用户。缺这层时日志刷 `ignoring message from unauthorized user`（WARN）且不给对方任何提示，表现为“在线但不回话”：

   ```toml
   [peer_groups.owner]
   channel = "discord.main"
   agents = ["main"]
   external_peers = ["<Discord用户ID>"]
   ```

   用户 ID 从仪表盘 Logs 页的 `author_id` 属性拿。CLI 只有 `bind-telegram`，discord 无绑定子命令，只能配置文件。

5. 排障看仪表盘 Logs 页（`zeroclaw.*` 事件流）：`READY received` = 连接正常；`unauthorized` = 缺 peer group；`send message failed` = 机器人缺发言权限。

## Doctor 常见警告处置

- `no context_window set`：provider 段加 `context_window`（已加 131072，否则回退 32000 截长对话）。
- `memory.search_mode hybrid 但无 embedding`：已改 `bm25`（预编译无 embedding provider，hybrid 会静默降级纯关键词）。
- `Memory: none (auto-save: on)`：v0.8.5 横幅根据 `[storage.sqlite.default]` 是否存在显示后端；缺少此声明时会显示 `none`，但运行时仍可能按默认 `memory.backend=sqlite` 打开记忆库，不能据此判断记忆丢失。现已显式配置后端和默认存储声明，保留原数据目录下的 `memory/brain.db`，不迁移或清空记忆。WebDAV 查看副本可核对实际数据库文件。
- `Tini is not running as PID 1`：Northflank 注入环境变量的启动包装器可能占用 PID 1。镜像使用 `tini -s` 注册子进程回收器，非 PID 1 时也能回收孤儿进程；不影响应用的正常关停和最终备份。
- `git/curl/$SHELL not found`：极简容器的提示，聊天与内置工具不受影响；要 agent 跑 git 时再往镜像 `apk add`。
- `SOUL.md/AGENTS.md not found`：SOUL.md 已随镜像播种（仓库 `.zeroclaw/SOUL.md`，改人格直接编辑该文件重部署）；AGENTS.md 可选未配。
- `N paths differ from on-disk`（reload banner）：env 覆盖会让整张表在内存里物化，磁盘没有对应段就全算漂移。已把 `[channels.discord.main]` 表（含默认值）写进磁盘 config.toml 清零（本地验证 `/api/config/drift` 返回空）；密钥仍走 env，不计入漂移。
- 同类坑：`risk_profiles.default.auto_approve` 在内存里会被展开成“默认安全工具全集 + 自定义项”（13 项），磁盘只写自定义项就报漂移——磁盘必须写展开后的完整列表（见 config.toml 内注释）。

## 网络搜索：自建 SearXNG

`search_provider = "searxng"`，指向同 Northflank 项目的 `g02-ritup-repo01-search`（SearXNG 8080 + mcp-searxng 3000，`settings.yml` 的 `formats` 已含 `json`，`limiter: false`）。

- 生产地址：`http://g02-ritup-repo01-search:8080`（同项目内网，免公网）
- 内网不通时备用：`https://p01--g02-ritup-repo01-search--4ygvmqls7l8l.code.run`（实测 JSON 正常，42 条结果/查询）
- `auto_approve = ["web_search"]`：只读工具免审批，Discord 里搜索不弹确认
- 本地 Docker E2E 已验证：agent 主动调 web_search → SearXNG → 正确引用结果

## 记忆后端备忘

预编译二进制**未编译 `memory-postgres`**（lean 发布策略，gnu/musl tarball 均验证），配置 postgres 后端启动即报 `compiled without 'memory-postgres'`；对话记忆继续在本地 SQLite 运行。当前用户选择通过 [WebDAV 一致快照](webdav-persistence.md)提供恢复副本；启用前仍为易失状态。其他后端的历史研究见 [zeroclaw-memory.md](zeroclaw-memory.md)。

## 安全边界

遵守 [security.md](security.md) 的只读边界：ZeroClaw 不接触 OKX API 凭据，不给它任何数据库写连接串；模型 API Key 单独放 Secret。网关保持默认 pairing 认证（配对凭证为 Secrets 中的固定 token），不要设 `require_pairing=false`；token 泄漏时在 Environment 换新值并同步更新浏览器 localStorage。
