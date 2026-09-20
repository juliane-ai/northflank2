# OKX 只读数据模型

## 三类数据不能混用

### 1. 跟单关系

SDK：

```js
client.getCopytradingMyLeadTraders({ instType: 'SWAP' })
```

回答“当前正在跟随谁”，并提供 `uniqueCode`、昵称、关系保证金、复制额度和关系级盈亏。它不代表一笔具体开仓。

### 2. 实际跟单子仓位

SDK：

```js
client.getCopytradingSubpositions({
  instType: 'SWAP',
  subPosType: 'copy',
})
```

这是第一版的核心数据源。重要字段：

| 字段 | 用途 |
| --- | --- |
| `subPosId` | 跟单子仓位标识；后续仓位生命周期的首要外部标识。 |
| `uniqueCode` | 带单员标识，用于连接跟单关系。 |
| `instId`、`posSide` | 合约和多空方向。 |
| `subPos`、`availSubPos` | 仓位数量和可平数量。 |
| `openAvgPx`、`openTime` | 实际跟单开仓均价和时间。 |
| `markPx`、`upl`、`uplRatio` | 当前标记价和浮动盈亏。 |
| `lever`、`margin`、`mgnMode` | 杠杆与保证金信息。 |

该能力必须用目标 OKX 地区、真实跟单角色和只读 API Key 验证。若地区或账户不返回 `copy` 子仓位，UI 会明确显示该数据源失败；不能用账户聚合仓位猜测归属。

### 当前 Open API 权限限制

OKX 官方 API 更新记录显示，“Existing lead or copy positions”、历史子仓位和跟单通知频道已于 2024-12-16 从普通 Open API 能力中下线，跟单能力仅对白名单用户开放。当前目标账户请求 `current-subpositions?subPosType=copy` 和历史子仓位时都返回 `59263`：ND broker 需由 OKX BD 加入 allowlist。

因此，SDK 中仍然存在方法并不等于当前账户有权访问。要获得稳定的 `subPosId + uniqueCode` 映射，正式路径是向 OKX BD/API 支持提供 UID、地区站点、目标接口和错误码，申请跟单 Open API 白名单。

### 3. 账户聚合仓位

SDK：

```js
client.getPositions({ instType: 'SWAP' })
```

回答账户当前总仓位，用于保证金、强平价和总风险核对。多个跟单子仓位、手工仓位或其他来源可能聚合到同一合约仓位，因此它不是跟单研究的主键。

## 其他只读数据

- `getAccountConfiguration()`：确认账户角色、账户等级、持仓模式和 API 权限。
- `getBalance()`：账户总权益、可用权益和非零资产。
- `getCopytradingCopySettings()`：按 `uniqueCode` 查看复制模式、额度和已有止盈止损设置。
- `getOrderList()`：当前未完成的账户委托。
- `getOrderHistory()`：近期完成或取消的账户订单。
- `getFills()`：最近 3 天的真实成交明细。

订单和成交可以证明账户实际发生了什么，但普通订单响应没有 `subPosId` 或 `uniqueCode`。`source` 字段的官方枚举用于触发单、止盈止损、算法单和追踪止损等来源，没有可供我们依赖的“跟单”枚举。页面必须将这些记录标为“账户核对”，不根据合约、时间或方向猜测带单员。

## 浏览器输出原则

- 所有金额和数量继续保留为 OKX 返回的十进制字符串；UI 格式化仅用于展示。
- 只返回页面需要的字段，不透传完整 SDK 响应。
- SDK 原始异常可能包含实现信息，禁止直接返回或完整记录。
- `uniqueCode` 缺失时显示未知归属，不通过昵称、交易对或时间猜测。

## 资料链接

- [OKX API 更新记录](https://www.okx.com/docs-v5/log_en/)
- [OKX 跟单交易管理说明](https://www.okx.com/en-gb/help/copy-traders-how-to-manage-copied-trades)
