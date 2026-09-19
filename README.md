# 筹码计数器（Chips Counter）

德州扑克及类德州扑克对局的**多人筹码记分器**服务端。只计数、不推进游戏：没有翻前/翻牌/转牌/河牌等任何游戏阶段概念，不校验动作顺序与扑克规则；玩家线下得出结论后，把筹码数量的变化记录进来。

- 需求：[doc/requirements.md](doc/requirements.md)（v2.11）
- 概要设计：[doc/design.md](doc/design.md)（v1.5）
- 详细设计：[doc/detailed-design.md](doc/detailed-design.md)（v2.1，含全部接口/错误码/事件 payload 定义）

## 技术栈

Node.js ≥ 18（ESM）· Koa 3 · Sequelize 6 + mysql2 · MySQL 5.7.44 · ws · node-cron。
部署形态：微信云托管（容器化、**最大实例数=1** 单实例锁定、不开放公网访问）；小程序经 `wx.cloud.callContainer` / `connectContainer` 云通道接入（身份由平台注入 `x-wx-openid`，免 code2Session）。

## 本地开发

```bash
# 1. 起 MySQL 5.7.44（宿主机映射 33061，避开本机已占用的 3306）
docker compose up -d mysql

# 2. 配置
cp config.example.json config.json   # 按需修改；本地 compose 对应 mysql.port=33061、user/password=chips/chips

# 3. 安装并启动（首启动对空库自动执行版本化迁移建表）
pnpm install
pnpm dev                              # http://127.0.0.1:3000

# 4. 冒烟（devMode 下以 x-dev-openid 头模拟云通道身份）
curl -s localhost:3000/api/health
curl -s -X POST localhost:3000/api/auth/session -H 'x-dev-openid: alice'
```

`devMode: true` 时全部端点接受 `x-dev-openid` 头模拟身份（等价云通道注入）；生产必须关闭且不开公网访问。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm dev` | 启动开发服务（--watch） |
| `pnpm test` | 全量测试（需本地 MySQL；每个测试进程使用独立临时库，跑完即删） |
| `pnpm verify [--room <roomNo>] [--fix]` | 一致性重算 CLI（D12）：回放公屏绝对快照 + 动作流水，比对缓存列；`--fix` 按推导值回写 |
| `pnpm bench [--n 100]` | NFR-01 基准：N 次下注延迟分布（P50/P95/P99） |
| `pnpm lint` / `pnpm format` | eslint / prettier |

测试与基准连接 MySQL 的凭据：默认 `root/chipsroot@127.0.0.1:33061`（对应 docker-compose），可用 `MYSQL_HOST / MYSQL_PORT / MYSQL_ADMIN_USER / MYSQL_ADMIN_PASSWORD` 覆盖。

## 备份

- **云托管数据库**（推荐）：控制台自动备份；发布/迁移前手动触发一次全量备份。
- **自建 MySQL**：`mysqldump --single-transaction` 定时脚本 + 云盘快照。
- 恢复后无需回放：所有状态（含 chips/pool/issued_chips 缓存列）均在库中，启动即恢复（D10）。

## 部署（微信云托管，M8）

1. `docker build -t chips-counter .`（多阶段、非 root、仅生产依赖；镜像内健康检查 `/api/health`）。
2. 云托管控制台：开通数据库（MySQL，建库授权）→ 创建服务（镜像、**最大实例数=1**、最小 0、监听 `PORT`、健康检查 `/api/health`、注入 `MYSQL_*` / `AUTH_TOKEN_SECRET` 环境变量、**关闭公网访问**——`x-wx-*` 头仅云通道可信）。
3. 小程序侧 `wx.cloud.callContainer` / `connectContainer`（基础库 ≥ 2.23.0）真机联调；重连与断线补拉策略见详细设计 §7.5。

## 目录结构

```
src/
├── index.js          组合根：装配一切并启动（createContainer 亦供测试装配复用）
├── app/              Koa 工厂、路由、中间件（error/auth/requestLog）
├── config/           config.json + 环境变量覆盖 + 深冻结
├── db/               sequelize 实例、schema.vN.sql 版本化迁移、init 执行器
├── entities/         7 个 Sequelize 模型 + 关联
├── repositories/     SQL 全部收口；唯一约束冲突翻译为业务错误码
├── services/         业务校验与状态变更（room/game/action/feed/query/auth/retention/consistency）
├── controllers/      参数校验 / 身份透传 / 调用 service / 序列化
├── queue/            房间级串行队列 + 事务 + 提交后广播（D3/D21）
├── ws/               WebSocket 网关（hello/welcome、频道、心跳、publish）
├── jobs/             node-cron 保留期清理（0 * * * *）
├── scripts/          verifyConsistency CLI、bench
└── common/           errors / logger / validator / token / quickBets / ids / clock
```

## 实现与详细设计的已知偏差

- **room_player 不设 `player_id → player` 外键**：MySQL 5.7 不允许 STORED 生成列（`active_player_key`，INV-7 的唯一索引载体）的表达式引用带外键约束的列（errno 150）。player 存在性由服务层保证（ensurePlayer 先于加入）；保留期清理的级联删除由 `fk_rp_room`（room 侧）承接——系统从不删除 player 行。
- 其余（DDL、接口、错误码、事件 payload、命令管线）与详细设计一致，测试覆盖见 `test/`（AC-01~13 映射见详细设计 §9）。
