# Backpack × Jupiter 美股代币价差监控器

这是 `design.md` 第一阶段的可运行实现：只读监控、机会提醒、模拟行情、纸面成交、SQLite 留痕和回测数据导出。程序不包含自动成交，也不会接受 Backpack RFQ 或签名/发送 Jupiter 交易。

## 当前实现

- 9 个 Backpack Securities 官方 Mint 白名单，默认优先监控 `MU、SKHY、SNDK、INTC、MSTR`
- 按 `1、2、5` 股三个档位计算双向可执行价差
- Backpack 交易时段使用签名 `AwaitAccept` RFQ；只读取候选报价，让 RFQ 自动过期
- 无 RFQ 密钥时，可对已确认存在现货订单簿的标的计算指定数量 VWAP
- Jupiter 使用 Swap API V2 `/order`，固定滑点并采用 `otherAmountThreshold`
- Jupiter 买入为 ExactIn：先固定 USDC 输入，再按“最小保证代币输出”向 Backpack 询卖价，两腿数量口径一致
- 毛价差、净价差、最低利润、价格冲击、报价年龄和有效期风控
- 控制台与 Telegram 提醒，同一机会带冷却时间
- `QUOTE_ONLY` 观察提醒模式无需链上余额；消息明确标记需人工重新询价
- 模拟行情包含随机游走、跨平台基差、深度冲击和短时异常价差
- 模拟纸面成交包含 `BOTH_FILLED`、单腿成交、`COMPENSATING`、`MANUAL_INTERVENTION` 状态历史
- SQLite 保存扫描、原始报价、机会、拒绝原因、错误、提醒、纸面成交和资产动态检查
- 聚合报表与 CSV 导出

## 快速开始

要求 Node.js 22 或更高版本。

```bash
npm install
cp .env.example .env
npm run db:init
npm run simulate -- --cycles 500 --seed 42 --interval-ms 0
npm run report
npm run export -- --out ./data/opportunities.csv
```

默认数据库为 `./data/monitor.sqlite`。模拟命令始终启用纸面成交，不需要任何 API 密钥。

## 实时只读监控

无链上资金、只观察价差时，推荐配置：

```dotenv
ALERT_MODE=QUOTE_ONLY
JUPITER_API_KEY=...
JUPITER_TAKER=
PAPER_TRADING_ENABLED=false
BACKPACK_API_KEY=...
BACKPACK_API_SECRET=Base64编码的ED25519私钥seed
BACKPACK_QUOTE_MODE=auto
```

然后运行：

```bash
npm run validate:assets
npm run monitor -- --once
npm run monitor
```

`QUOTE_ONLY` 模式下，程序会强制忽略 `JUPITER_TAKER`，Jupiter `/order` 不组装交易，因此钱包可以保持空白。价差达到阈值仍会提醒，但消息会标为“观察价差提醒”，人工操作前必须重新询价。

需要验证钱包余额和最终交易组装时再切换：

```dotenv
ALERT_MODE=EXECUTABLE
JUPITER_TAKER=你的Solana公钥
```

`JUPITER_TAKER` 只用于让 `/order` 组装一笔真正可提交的交易；程序不会读取 Solana 私钥，也不会签名和发送交易。

Backpack RFQ API 密钥用于创建 `AwaitAccept` RFQ 和轮询候选报价。程序没有调用 `/rfq/accept` 的代码路径，未接受的 RFQ 会自然过期。建议仍为监控程序创建独立、最小权限的 API 密钥。

在 `auto` 模式下，RFQ 失败时会尝试现货订单簿。当前动态市场信息显示只有部分标的存在股票现货订单簿；RFQ-only 标的在没有密钥时会记录明确的数据源错误，不会使用外部 ticker 或页面价代替。

## 提醒

配置 Telegram Bot：

```dotenv
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
ALERT_COOLDOWN_MS=300000
```

未配置 Telegram 时，符合条件的机会仍会输出到控制台并写入 `alerts` 表。数据源异常也有独立的去重提醒。

两种提醒模式：

| `ALERT_MODE` | 余额要求 | 提醒含义 |
| --- | --- | --- |
| `QUOTE_ONLY` | 无 | 价差满足阈值，未把交易组装作为门槛 |
| `EXECUTABLE` | 需要相应余额 | 两腿报价均通过交易可执行性检查 |

## 数据与回测

关键表：

| 表 | 内容 |
| --- | --- |
| `scan_runs` | 每轮扫描的模式、状态和耗时 |
| `quotes` | 两边原始可执行报价、数量、延迟、年龄、路由 JSON |
| `opportunities` | 成本前后利润、价差、资格判断和拒绝原因 |
| `alerts` | 提醒发送、冷却跳过和失败记录 |
| `source_errors` | 按标的和阶段记录 API/RFQ/深度错误 |
| `paper_trades` | 纸面成交利润及完整状态历史 |
| `asset_checks` | Mint、充提、证券交易、现货市场、Jupiter 价格检查 |

导出的 CSV 一行对应一个方向和数量档位的机会，适合直接用 DuckDB、Polars、pandas 或你后续的 TypeScript 回测程序读取。

示例 SQL：

```sql
SELECT
  asset,
  direction,
  requested_quantity,
  COUNT(*) AS samples,
  AVG(net_spread_bps) AS avg_net_bps,
  MAX(net_spread_bps) AS max_net_bps,
  SUM(eligible) AS triggers
FROM opportunities
GROUP BY asset, direction, requested_quantity;
```

## 为什么先用 SQLite

当前采集器是单进程、单写入者，SQLite + WAL 零运维、便于携带整份历史数据，也能支撑数百万条报价。以下情况再迁移 PostgreSQL 更合适：

- 多个采集实例同时写入
- Web 控制台和回测任务有大量并发查询
- 需要远程部署、主从或长期在线备份

表结构已把原始报价与派生机会分开，后续迁移不会改变计算层接口。

## 重要限制

- Price V3 只用于资产动态检查；触发判断只使用 Swap V2 和 Backpack RFQ/深度。
- `otherAmountThreshold` 是 Jupiter 腿的保护口径，但跨 CEX 与 Solana 无法原子成交，提醒不等于无风险利润。
- `QUOTE_ONLY` 机会没有验证钱包余额、账户状态或最终交易组装，不能直接作为下单指令。
- RFQ 报价寿命很短。提醒到达后重新询价是必需的，不能直接沿用数据库里的旧报价。
- 当前阶段没有库存四桶和自动再平衡；相关成本通过配置项保守扣减。启用实盘前仍需实现库存、限额、双腿状态机和密钥隔离。
