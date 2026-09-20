# 跟单子仓位生命周期存储

## 目的

生命周期库保存“跟单开仓之后发生了什么”，作为保本滑动止盈、重复开单和实时趋势研究的共同输入。它只观察，不下单、不平仓，也不修改 OKX 设置。

## 当前状态

2026-09-13 使用当前真实只读凭据验证时：账户配置、余额、当前跟随带单员和账户聚合仓位可以读取；带 `subPosType=copy` 的当前与历史子仓位接口返回 OKX 错误码 `59263`。官方含义是相关经纪渠道需要进入功能允许名单。

在权限问题解决前，系统保持数据源失败状态，不使用账户聚合仓位推测某个仓位属于哪位带单员。生命周期结构可以使用模拟数据验证，但不能声称已经完成真实跟单仓位采集。

## 状态与事件

当前只建立可由 REST 观察事实支持的两种状态：

| 状态 | 含义 |
| --- | --- |
| `OBSERVING` | 在一次成功读取中发现实际跟单子仓位。 |
| `CLOSED_DETECTED` | 连续多次成功读取都未再发现该子仓位。 |

事件：

- `COPIED_OPEN_DETECTED`：首次观察到 `subPosId`。
- `CLOSE_DETECTED`：达到连续消失确认次数。
- `POSITION_REAPPEARED`：已经判定结束的同一标识再次出现，保留异常轨迹而不是新建重复记录。

`BREAKEVEN_ARMED`、`TRAILING` 和 `PROTECTED_EXIT` 等研究状态尚未加入；它们必须在行情采集和策略版本模型建立后推进。

## 防误判规则

- 只使用 `subPosType=copy` 返回的数据。
- 数据源失败时不增加消失次数。
- 默认连续两次成功读取缺失才确认结束，可通过 `RESEARCH_CLOSE_CONFIRMATIONS` 调整。
- 同一个 overview 读取时间只处理一次，多个浏览器或缓存命中不会重复推进状态。
- REST 仓位快照默认最短 15 秒保存一次，可通过 `RESEARCH_SNAPSHOT_MS` 调整。

## PostgreSQL 数据

- `lifecycle_positions`：每个 `subPosId` 一条生命周期摘要。
- `lifecycle_events`：首次发现、结束确认和异常重现事件。
- `position_snapshots`：标记价格、数量和浮动盈亏观察值。
- `research_meta`：最后处理的读取时间和数据源状态。

以上数据表位于 `okx_research` schema，与 A 股的 `stock_watch` 分开。正式服务和本地模拟预览都使用 PostgreSQL，预览使用独立数据库。没有本地数据库回退，不导入旧记录，配置方式见 [OKX PostgreSQL](okx-postgres.md)。
