# Backpack × Jupiter 美股代币价差监控器

这是 `design.md` 第一阶段的可运行实现：只读监控、机会提醒、模拟行情、纸面成交、SQLite 留痕和回测数据导出。程序不包含自动成交，也不会接受 Backpack RFQ 或签名/发送 Jupiter 交易。

## 当前实现

- 9 个 Backpack Securities 官方 Mint 白名单，默认优先监控 `MU、SKHY、SNDK、INTC、MSTR`
- 按 `1、2、5` 股三个档位对双向机会执行“公开行情初筛 → 按需可执行性复核”
- 初筛优先使用 Backpack 指定数量订单簿 VWAP；深度不足时依次降级为盘口顶价、Venue 最新成交价和 External 参考价，并明确标记为不可执行
- 只有参考价差达到门槛且 `ALERT_MODE=EXECUTABLE` 时，才使用签名 `AwaitAccept` RFQ 复核；只读取候选报价，让 RFQ 自动过期
- Jupiter 使用 Swap API V2 `/order`，固定滑点并采用 `otherAmountThreshold`
- Jupiter 买入为 ExactIn：先固定 USDC 输入，再按“最小保证代币输出”向 Backpack 询卖价，两腿数量口径一致
- 毛价差、净价差、最低利润、价格冲击、报价年龄和有效期风控
- 控制台与 Telegram 提醒，同一机会带冷却时间
- `QUOTE_ONLY` 观察提醒模式完全不发 Backpack RFQ，无需 Backpack 股票库存；消息会显示报价来源和深度限制
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
# 纯观察模式不需要 Backpack API 密钥
BACKPACK_API_KEY=
BACKPACK_API_SECRET=
BACKPACK_QUOTE_MODE=auto
```

然后运行：

```bash
npm run validate:assets
npm run monitor -- --once
npm run pm2:start
```

`QUOTE_ONLY` 模式下，程序会强制忽略 `JUPITER_TAKER`，Jupiter `/order` 不组装交易，Backpack 也不会发 RFQ，因此两边账户都可以没有交易库存。价差达到阈值仍会提醒，但消息会标为“公开行情初筛”，并列出订单簿、盘口顶价或 ticker 等具体来源。

需要验证钱包余额和最终交易组装时再切换：

```dotenv
ALERT_MODE=EXECUTABLE
JUPITER_TAKER=你的Solana公钥
BACKPACK_API_KEY=...
BACKPACK_API_SECRET=Base64编码的ED25519私钥seed
```

`JUPITER_TAKER` 只用于让 `/order` 组装一笔真正可提交的交易；程序不会读取 Solana 私钥，也不会签名和发送交易。

Backpack RFQ API 密钥只在参考价差达到门槛后的第二阶段使用，用于创建 `AwaitAccept` RFQ 和轮询候选报价。程序没有调用 `/rfq/accept` 的代码路径，未接受的 RFQ 会自然过期。建议仍为监控程序创建独立、最小权限的 API 密钥。

第一阶段固定按以下顺序取得 Backpack 参考价：足量订单簿 VWAP、深度不足时的盘口顶价、Venue 最新成交价、External 参考价。后三者仅用于发现候选机会，绝不会标记成可执行价格。第二阶段的 `BACKPACK_QUOTE_MODE=auto` 仍采用 RFQ 优先、足量现货订单簿回退；RFQ-only 标的必须成功取得 RFQ 才能通过可执行性复核。

## PM2 进程管理

项目使用本地安装的 PM2 管理实时监控进程。`ecosystem.config.cjs` 固定使用单实例 `fork` 模式，避免多个进程同时写入 SQLite。启动和重启命令会先编译 TypeScript，再运行 `dist/cli.js monitor`；应用仍从项目根目录的 `.env` 读取配置。

```bash
# 首次启动
npm run pm2:start

# 查看状态与实时日志
npm run pm2:status
npm run pm2:logs

# 更新代码或 .env 后重新编译并重启
npm run pm2:restart

# 停止或从 PM2 中移除进程
npm run pm2:stop
npm run pm2:delete
```

需要机器重启后自动恢复时，先保存当前进程列表：

```bash
npm run pm2:save
npx pm2 startup
```

`npx pm2 startup` 会输出一条与当前操作系统和用户相关的命令；按提示执行该命令即可启用开机启动。不要直接用多实例或 cluster 模式运行本项目。

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
| `QUOTE_ONLY` | 无 | 只发公开行情参考价差，不发 RFQ |
| `EXECUTABLE` | 复核阶段需要相应余额 | 先发达标参考价差，再仅对候选机会执行 RFQ/足量订单簿复核 |

## 数据与回测

关键表：

| 表 | 内容 |
| --- | --- |
| `scan_runs` | 每轮扫描的模式、状态和耗时 |
| `quotes` | 两边原始可执行报价、数量、延迟、年龄、路由 JSON |
| `opportunities` | 参考/复核阶段、成本前后利润、价差、资格判断和拒绝原因 |
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
  stage,
  requested_quantity,
  COUNT(*) AS samples,
  AVG(net_spread_bps) AS avg_net_bps,
  MAX(net_spread_bps) AS max_net_bps,
  SUM(eligible) AS triggers
FROM opportunities
GROUP BY asset, direction, stage, requested_quantity;
```

## 为什么先用 SQLite

当前采集器是单进程、单写入者，SQLite + WAL 零运维、便于携带整份历史数据，也能支撑数百万条报价。以下情况再迁移 PostgreSQL 更合适：

- 多个采集实例同时写入
- Web 控制台和回测任务有大量并发查询
- 需要远程部署、主从或长期在线备份

表结构已把原始报价与派生机会分开，后续迁移不会改变计算层接口。

## 重要限制

- Price V3 只用于资产动态检查；Jupiter 侧触发判断使用 Swap V2。Backpack 参考初筛可使用深度、盘口顶价或官方 ticker，最终可执行提醒只接受 RFQ/足量深度。
- `otherAmountThreshold` 是 Jupiter 腿的保护口径，但跨 CEX 与 Solana 无法原子成交，提醒不等于无风险利润。
- `QUOTE_ONLY` 机会没有验证钱包余额、账户状态、整档流动性或最终交易组装，不能直接作为下单指令；ticker 不提供最后成交时间，可能陈旧。
- RFQ 报价寿命很短。提醒到达后重新询价是必需的，不能直接沿用数据库里的旧报价。
- 当前阶段没有库存四桶和自动再平衡；相关成本通过配置项保守扣减。启用实盘前仍需实现库存、限额、双腿状态机和密钥隔离。
