# 文档索引

本目录只描述当前产品边界和后续已确认的研究方向。旧的 Freqtrade 观察器与 Python 手写 OKX 签名方案已经废弃。

| 文档 | 内容 |
| --- | --- |
| [project-direction.md](project-direction.md) | 当前项目定位、四组对照、ZeroClaw 职责与开发优先级。 |
| [architecture.md](architecture.md) | 第一版系统结构、数据流和模块职责。 |
| [okx-read-model.md](okx-read-model.md) | 跟单关系、跟单子仓位和账户聚合仓位的区别。 |
| [research-roadmap.md](research-roadmap.md) | 保本滑动止盈、重复开单、实时趋势分析的后续研究计划。 |
| [discord-entry-research.md](discord-entry-research.md) | Discord 方向观察、成本保本、滑动止盈与重复入场；含截图解读和首轮模拟规则。 |
| [signal-research.md](signal-research.md) | 独立 OKX 模拟盘服务、每轮 100 USDT 保证金、本地 Docker 和策略规则。 |
| [signal-discord.md](signal-discord.md) | MCP 工具、ZeroClaw 只读分析、报告校验与 Discord 接入说明。 |
| [signal-cloud.md](signal-cloud.md) | Northflank 云端方向看板、Discord 截图入口、环境变量与 WebDAV 审计目录。 |
| [lifecycle-storage.md](lifecycle-storage.md) | 跟单子仓位发现、快照、结束确认和持久化规则。 |
| [okx-postgres.md](okx-postgres.md) | OKX PostgreSQL 配置、会话持久化与独立模拟预览。 |
| [stock-watch.md](stock-watch.md) | 独立 A 股价格提醒服务、数据库与通知配置。 |
| [security.md](security.md) | 第一版只读边界和未来交易执行的隔离要求。 |
| [zeroclaw.md](zeroclaw.md) | ZeroClaw 同容器 sidecar 部署、配置与端口。 |
| [webdav-persistence.md](webdav-persistence.md) | InfiniCLOUD / rclone 多目录快照、SQLite 恢复、排除规则和环境变量。 |

## 当前里程碑

第一版只负责可靠地读到：

1. 当前正在跟随哪些带单员。
2. 当前实际产生了哪些跟单子仓位。
3. 账户聚合仓位、资产和跟单设置等核对信息。

只读跟单看板保存跟单子仓位生命周期；方向策略与模拟成交由独立服务提供，尚未实现真实交易或与原跟单轨迹的对照回放。

方向策略服务现已实现，配置、测试、OKX 模拟盘和 Discord 工具桥见 [signal-research.md](signal-research.md)。
