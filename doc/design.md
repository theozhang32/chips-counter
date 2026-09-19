# 筹码计数器 概要设计文档

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.5 |
| 发布日期 | 2026-09-18 |
| 文档状态 | 修订稿 |
| 设计依据 | [doc/requirements.md](./requirements.md) v2.11（需求规格书） |
| 范围声明 | 本文档为概要设计：给出系统架构、用例模型、数据设计（ER 与数据库表）、关键流程时序与数据流。**接口设计（REST 路径、报文结构、推送协议细节）不在本文档范围**，另行输出接口设计文档 |

---

## 1. 引言

### 1.1 目的

依据《筹码计数器需求规格书》v2.9，给出系统的总体设计与数据设计，确定技术选型、模块划分、数据模型与关键流程的实现方案，作为详细设计与编码的依据。

### 1.2 设计底线（承接需求核心边界）

以下需求边界直接决定了设计的"形状"，任何设计决策不得违背：

1. **只计数、不推进游戏**：系统中不存在任何牌桌规则引擎——没有阶段状态机、没有顺序校验、没有牌力/底池计算。动作处理只做金额类校验（见 §6.2）。
2. **动作双重归属**（INV-8）：动作记录同时携带"发起玩家"与"所属轮次"两个必填关联。
3. **公屏是房间唯一流水**（FR-503）：一切历史回溯从公屏事件表读取；动作表仅作为计数推导的计算流水，不对外提供独立的"历史查询"能力。
4. **筹码守恒**（INV-2）：任何写操作必须保持"Σ玩家筹码 + 当前池 = 本游戏发放总额"。
5. **实时推送**（FR-504）：状态变更全部推送，不引入轮询。

### 1.3 读者

开发、测试与后续维护者。

---

## 2. 总体设计

### 2.1 技术选型

| 项 | 选型 | 理由（对应需求） |
| --- | --- | --- |
| 运行时 | Node.js ≥ 18（复用现有工程骨架，Docker 容器交付） | 部署于微信云托管、单实例锁定（NFR-07 v2.11） |
| Web 框架 | Koa 3 + @koa/router + @koa/bodyparser | 工程已就绪；REST 接入 |
| 实时推送 | WebSocket（`ws` 库），按房间频道广播 | 实时推送、无轮询（FR-504、NFR-11） |
| 存储 | MySQL 5.7.44（Sequelize ORM + mysql2，InnoDB / utf8mb4） | 云端部署（NFR-07 v2.11）后容器本地盘易失、多实例不共享，单文件库不再适用；事务与唯一索引承接持久化与并发不变量（NFR-03/05，详见详细设计 v2.0 §3） |
| 并发模型 | 单进程事件循环 + 房间级命令队列串行化 + 部署层单实例锁定 | 多端并发不丢账不串账（NFR-05）；单实例免除跨节点一致性问题 |
| ID 生成 | 资源主键 UUID（客户端不可见）；动作/事件排序用自增或事务内 seq | — |
| 时间 | 统一存 UTC（MySQL DATETIME(3)），展示按本地时区（NFR-10） | — |

### 2.2 关键设计决策

| 编号 | 决策 | 说明 |
| --- | --- | --- |
| D1 | **房间号**：6 位随机数字（如 843217），全局唯一，解散后在数据保留期内不回收复用（由唯一约束保证），随保留期清理一并释放 | 承接 FR-102"知道房间号即可加入" |
| D2 | **玩家身份**：以微信 openid 作为全局唯一玩家 ID（`player.id` = openid）。客户端 `wx.login()` 取得 code，服务端调用微信 `code2Session` 换取 openid（session_key 不落库）；首次使用时注册 player 记录，昵称由玩家在小程序内设置。一人一房间约束落在 openid 维度，服务端以部分唯一索引强制（见 §5.2） | 承接 FR-102、INV-7；无账号密码体系（NFR-08） |
| D3 | **房间级串行队列**：同一房间的所有写命令（动作、管理操作）进入该房间的 FIFO 队列逐个执行，队列内每个命令包在一个 SQLite 事务中；不同房间互不阻塞 | 承接 NFR-05；杜绝"并发双花筹码" |
| D4 | **计数缓存列**：`room_player.chips` 与 `round.pool` 为缓存列，在与动作写入同一个事务内更新；缓存值必须与动作流水推导值一致（可离线重算校验） | 承接需求 §4.2"允许缓存但必须与推导结果一致" |
| D5 | **游戏发放总额**：`game.issued_chips` 在每次发放（开局、中途加入、重建后重发）于同事务内累加，作为守恒校验基准（Σchips + pool = issued_chips，INV-2） | — |
| D6 | **快捷下注数值生成规则**：档位 = 本金 × {5%, 10%, 20%, 25%, 50%, 100%}（6 档），外加"全下"；服务端按房间当前本金即时计算，无存储、无配置项 | 承接 FR-107，示例见 §2.3 |
| D7 | **误操作修正**：不实现任何撤销/回滚代码路径；修正即常规动作命令 | 承接 FR-409 |
| D8 | **保留期清理**：配置文件提供 `retentionDays`（默认 90），定时任务每小时删除"已解散且解散时间超过保留期"的房间及其级联数据；玩家不可配置 | 承接 FR-106 |
| D9 | **客户端交付形态**：微信小程序（微信内即用，免装原生 App）。正式环境要求 HTTPS / WSS，且域名在小程序后台配置为合法域名；局域网体验可用体验版开启"不校验合法域名"调试模式 | 承接 NFR-07、FR-504 |
| D10 | **内存无常驻主数据**：SQLite 是唯一事实来源，chips / pool / issued 等缓存列随库恢复；房间命令队列按需懒创建、房间解散即销毁 | 承接 NFR-03（重启零丢失 = 重启后从库直接恢复） |
| D11 | **事件同事务写入（outbox）**：`feed_event` 与其对应的状态变更在**同一个事务**内落库，广播仅在事务提交后触发——杜绝"状态已变、公屏未记"的中间态 | 承接 FR-501 / 503、INV-5（公屏完整可信的前提） |
| D12 | **一致性校验工具**：提供离线重算命令——回放 `action` 流水推导各成员 chips、各轮次 pool、各游戏 issued_chips，与缓存列逐项比对并输出差异报告；作为发版前与怀疑出错时的信任校验手段 | 承接 D4"缓存必须与推导一致"、INV-2 |

### 2.3 快捷下注数值（D6 生成结果）

| 本金 | 快捷数值档位（6 档） | 全下 |
| --- | --- | --- |
| 100 | 5 / 10 / 20 / 25 / 50 / 100 | ✓ |
| 200 | 10 / 20 / 40 / 50 / 100 / 200 | ✓ |
| 400 | 20 / 40 / 80 / 100 / 200 / 400 | ✓ |
| 500 | 25 / 50 / 100 / 125 / 250 / 500 | ✓ |
| 800 | 40 / 80 / 160 / 200 / 400 / 800 | ✓ |
| 1000 | 50 / 100 / 200 / 250 / 500 / 1000 | ✓ |

全部预设本金下六档均为正整数，天然满足 NFR-06（不出现小数）；若未来引入非预设本金，档位按向下取整生成。

---

## 3. 系统架构

### 3.1 系统架构图（C4 模型）

按 C4 模型分两个视图：容器图刻画系统边界与主要部件（C4Container）；服务端内部以**分层框图**呈现——命令自上而下、事件自下而上，层内模块平铺、互不直连。配置文件（端口 / retentionDays）不属于运行时部件，见 §5.3。

**（1）容器图**

```mermaid
C4Container
    title 系统架构 · 容器图
    Person(host, "房主", "房间管理者，兼有玩家全部能力")
    Person(player, "玩家", "参与线下对局")
    System_Ext(wxapi, "微信开放接口", "code2Session：登录换取 openid")

    System_Boundary(counter, "筹码计数器") {
        Container(mp, "小程序客户端", "微信小程序", "动作录入 · 公屏与总览展示 · 断线补拉")
        Container(server, "服务端应用", "Node.js 单实例", "REST 命令与查询 · WebSocket 推送 · 业务逻辑")
        ContainerDb(db, "SQLite 数据库", "SQLite WAL 单文件", "唯一事实来源：房间 / 成员 / 游戏 / 轮次 / 动作 / 事件")
    }

    Rel(host, mp, "使用")
    Rel(player, mp, "使用")
    Rel(mp, server, "命令与查询 HTTPS / 事件推送 WSS")
    Rel(server, db, "事务读写（房间级串行队列）")
    Rel(server, wxapi, "code2Session 换取 openid")
```

**（2）服务端分层图**

```mermaid
flowchart TB
    P["玩家 / 房主（小程序客户端）"]
    WX["微信开放接口<br/>code2Session（换取 openid）"]

    subgraph L1["接入层"]
        direction LR
        REST["REST 接入层<br/>命令与查询 · 写入房间命令队列"]
        GW["WebSocket 网关<br/>按房间频道广播"]
    end

    subgraph L2["业务服务层"]
        direction LR
        S1["房间服务"]
        S2["游戏服务"]
        S3["轮次与动作服务"]
        S4["公屏服务<br/>事件同事务落库（D11）"]
        S5["查询服务"]
    end

    subgraph L3["数据访问层"]
        direction LR
        DAO["数据访问<br/>事务 · 房间级串行队列"]
        T["定时任务<br/>保留期清理"]
    end

    DB[("SQLite<br/>WAL 模式 · 单文件")]

    P -- "命令 / 查询" --> REST
    REST -. "code2Session 换取 openid" .-> WX
    REST -- "命令分发（房间 / 动作 / 查询）" --> L2
    L2 -- "SQL 读写" --> DAO
    DAO <--> DB
    T -- "清理超期已解散房间" --> DAO
    S4 -- "提交后广播" --> GW
    GW -- "实时推送" --> P
```

> 分层规则：命令自上而下（接入层 → 业务服务层 → 数据访问层 → 存储），事件沿右侧上行（公屏服务 → 网关 → 客户端）。层内模块平铺、互不直连：房间 / 游戏 / 动作服务的事件均在其状态变更事务内写入公屏服务（D11）；断线补拉走"REST 接入层 → 公屏服务"查询路径（§6.5）；小程序登录换取 openid 由接入层调用微信开放接口完成（D2）。

### 3.2 层次职责

| 层 | 职责 |
| --- | --- |
| 客户端层 | 微信小程序（D9）：登录（`wx.login` → 服务端换取 openid，D2）、动作录入（快捷数值 / 全下 / 手动）、公屏与总览展示、断线重连与补拉；openid 与登录态存于小程序本地存储 |
| REST 接入层 | 接收命令与查询请求，做参数解析与身份透传，写入对应房间的命令队列；接口细节见后续接口设计文档 |
| WebSocket 网关 | 客户端接入后按房间号订阅频道；公屏服务产生事件后广播给频道内全部连接；重连时客户端凭本地已有的事件游标补拉缺失事件 |
| 业务服务层 | 与需求功能模块一一对应：房间服务（FR-101~107）、游戏服务（FR-201~204）、轮次与动作服务（FR-301~304、FR-401~409）、公屏服务（FR-501~504）、查询服务（FR-601~602） |
| 数据访问层 | 全部 SQL 收口于此；提供"房间级串行队列 + 事务"的写通道（D3）——队列随房间首个写命令懒创建、房间解散后销毁；并提供守恒校验、流水推导重算等一致性工具（D4/D5/D12） |
| 定时任务 | 保留期清理（D8） |

### 3.3 业务服务职责与协作

- **房间服务**：建房（生成房间号、注册房主、发放本金）、加入（一人一房间校验、发放本金）、离开/回归（筹码定格与恢复；重建后回归按新游戏本金重发并计入新游戏发放总额）、设置本金（仅预设值、仅影响后续游戏）、移交、解散（成员置为离开、房间只读）。
- **游戏服务**：建房自动开局、重建游戏（池非 0 需二次确认；旧游戏关闭、全员重置本金、发放总额重记）、游戏编号。
- **轮次与动作服务**：三种动作的校验（发起者为**在场成员**、金额规则）与状态变更（含收池后同事务自动换轮）、动作流水与缓存列更新、全下标记。
- **公屏服务**：事件的唯一落库口——事件由各服务在状态变更的**同一事务内**写入（D11），提交成功后由公屏服务交 WebSocket 网关广播；提供按房间的事件游标查询（含按玩家/类型筛选）。
- **查询服务**：房间总览（聚合缓存列）、筹码榜、守恒校验视图。

服务重启后无需任何回放：所有状态（含缓存列）均在 SQLite 中，启动即恢复（D10）；房间命令队列此时为空，随新命令懒创建。

---

## 4. 用例模型

### 4.1 用例图

```mermaid
flowchart LR
    P(("玩家"))
    H(("房主"))
    T(("定时任务"))

    subgraph SYS["筹码计数器"]
        UC1(["新建房间"])
        UC2(["加入房间"])
        UC3(["离开房间"])
        UC4(["回归房间"])
        UC5(["下注（快捷 / 全下 / 手动）"])
        UC6(["收池"])
        UC7(["部分收注"])
        UC8(["修正误操作（单独转账）"])
        UC9(["查看公屏 / 回溯历史"])
        UC10(["查看房间总览 / 筹码榜"])
        UC11(["设置本金"])
        UC12(["移交房主"])
        UC13(["重建游戏"])
        UC14(["解散房间"])
        UC15(["清理超期房间数据"])
        UC16(["自动开启新轮次"])
    end

    H -->|"泛化：继承玩家全部用例"| P
    P --- UC2
    P --- UC3
    P --- UC4
    P --- UC5
    P --- UC6
    P --- UC7
    P --- UC8
    P --- UC9
    P --- UC10
    H --- UC1
    H --- UC11
    H --- UC12
    H --- UC13
    H --- UC14
    T --- UC15
    UC6 ==>|"include"| UC16
```

### 4.2 用例清单

| 用例 | 主角色 | 简述 | 需求 |
| --- | --- | --- | --- |
| 新建房间 | 房主 | 选预设本金建房，自动开局开轮次，生成房间号 | FR-101 |
| 加入房间 | 玩家 | 凭房间号加入；一人一房间校验；发放本金 | FR-102、INV-7 |
| 离开房间 | 玩家 | 筹码定格、不可再动作、公屏留痕 | FR-103 |
| 回归房间 | 玩家 | 凭房间号重新加入；未重建则恢复定格筹码，重建过则按本金重发 | FR-103 |
| 下注 | 玩家 | 快捷数值 / 全下 / 手动输入；金额校验 | FR-401、FR-402、FR-107 |
| 收池 | 玩家 | 收下整池；同事务自动开启新轮次 | FR-403、FR-302 |
| 部分收注 | 玩家 | 收走指定数量（＜池），本轮继续 | FR-404、FR-405 |
| 修正误操作 | 玩家 | 线下空闲时以"下注＋收池"转移差额；系统无撤销 | FR-409 |
| 查看公屏 | 玩家 | 事件流浏览与筛选，唯一历史入口 | FR-501~503 |
| 查看总览 | 玩家 | 房间设置、成员筹码、当前游戏/轮次/池、筹码榜 | FR-601、FR-602 |
| 设置本金 | 房主 | 仅预设值；仅影响后续游戏 | FR-104 |
| 移交房主 | 房主 | 移交给房间内在场玩家 | FR-105 |
| 重建游戏 | 房主 | 全员重置本金；池非 0 二次确认 | FR-201~203 |
| 解散房间 | 房主 | 房间与数据转只读，等待保留期清理 | FR-106 |
| 清理超期数据 | 定时任务 | 删除解散超期的房间级联数据 | FR-106、D8 |

---

## 5. 数据设计

### 5.1 ER 图

```mermaid
erDiagram
    PLAYER      ||--o{ ROOM_PLAYER : "用户加入房间 → 成为玩家（成员）"
    ROOM        ||--o{ ROOM_PLAYER : "容纳成员"
    ROOM        ||--o{ GAME        : "包含游戏"
    GAME        ||--o{ ROUND       : "包含轮次"
    ROUND       ||--o{ ACTION      : "轮次归属（必填，INV-8）"
    ROOM_PLAYER ||--o{ ACTION      : "发起（仅在场成员可产生动作）"
    ROOM        ||--o{ FEED_EVENT  : "记录房间事件"
    PLAYER      ||--o{ FEED_EVENT  : "事件主语（openid 标识）"

    PLAYER {
        TEXT   id         PK "微信 openid，全局唯一身份"
        TEXT   nickname      "默认昵称"
        TEXT   created_at    "首次注册时间（UTC ISO8601）"
    }
    ROOM {
        TEXT   id             PK "UUID"
        INTEGER room_no       "6位房间号，全局唯一"
        TEXT   name           "房间名称"
        TEXT   host_player_id FK "当前房主"
        INTEGER base_chips    "本金（预设值）"
        TEXT   status         "active / dissolved"
        TEXT   created_at     "创建时间"
        TEXT   dissolved_at   "解散时间，可空"
    }
    ROOM_PLAYER {
        TEXT   id         PK "UUID"
        TEXT   room_id    FK "所属房间"
        TEXT   player_id  FK "玩家身份"
        TEXT   nickname      "房间内昵称（房间内唯一）"
        INTEGER chips        "当前筹码（缓存列）"
        TEXT   status        "active 在场 / left 已离开"
        TEXT   joined_at     "首次加入时间"
        TEXT   left_at       "最近离开时间，可空"
    }
    GAME {
        TEXT   id            PK "UUID"
        TEXT   room_id       FK "所属房间"
        INTEGER seq          "房间内游戏序号，单调递增"
        TEXT   status        "in_progress / ended"
        INTEGER issued_chips "本游戏累计发放筹码（守恒基准）"
        TEXT   started_at    "开启时间"
        TEXT   ended_at      "结束时间，可空"
    }
    ROUND {
        TEXT   id         PK "UUID"
        TEXT   game_id    FK "所属游戏"
        INTEGER seq       "游戏内轮次序号，单调递增"
        TEXT   status     "in_progress / closed"
        INTEGER pool      "筹码池（缓存列）"
        TEXT   opened_at  "开启时间"
        TEXT   closed_at  "归零关闭时间，可空"
    }
    ACTION {
        TEXT   id              PK "UUID"
        TEXT   round_id        FK "所属轮次（必填，INV-8）"
        TEXT   room_player_id  FK "发起成员（归属玩家，须在场）"
        INTEGER seq            "轮次内动作序号"
        TEXT   type            "bet / collect / partial_collect"
        INTEGER amount         "金额，正整数"
        INTEGER is_all_in      "全下标记 0/1"
        TEXT   idempotency_key "防重复提交键，可空"
        TEXT   created_at      "动作时间"
    }
    FEED_EVENT {
        INTEGER id              PK "全局自增，兼作房间内事件游标"
        TEXT   room_id          FK "所属房间"
        TEXT   type             "事件类型（见 §5.3 枚举）"
        TEXT   actor_player_id  FK "事件主语玩家，系统事件为空"
        TEXT   payload          "事件内容 JSON（谁/做什么/多少）"
        TEXT   created_at       "事件时间"
    }
```

归属与角色说明：`player` 是微信 openid 的全局**身份注册表**——未加入房间的用户只是身份，**还不是玩家**；用户加入房间后产生 `room_player` 成员记录，才成为该房间的玩家。因此动作的发起者是**成员**：`action.room_player_id`（发起时成员须在场）与 `action.round_id`（INV-8）两个必填外键共同表达"成员归属 + 轮次归属"；玩家身份经 `room_player.player_id` 关联获得，动作类公屏事件的主语即发起成员。

### 5.2 数据库表设计

命名约定：表名单数蛇形；时间列统一 `*_at TEXT`（UTC ISO8601）；金额/计数统一 INTEGER；主键除 `feed_event`（自增）与 `player`（openid）外均为 TEXT UUID。

**表 1：`player` — 玩家身份（全局）**

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | 微信 openid，全局唯一玩家身份（D2） |
| nickname | TEXT | NOT NULL | 默认昵称，玩家在小程序内设置；加入房间时可另起房间内昵称 |
| created_at | TEXT | NOT NULL | 首次加入任一房间时注册 |

**表 2：`room` — 房间**

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | UUID |
| room_no | INTEGER | NOT NULL，UNIQUE | 6 位随机数字房间号，加入凭证；解散后保留期内不复用（D1） |
| name | TEXT | NOT NULL | 房间名称 |
| host_player_id | TEXT | NOT NULL，FK→player.id | 当前房主；移交即更新此列 |
| base_chips | INTEGER | NOT NULL，CHECK IN (100,200,400,500,800,1000) | 本金，仅预设值（FR-104） |
| status | TEXT | NOT NULL，CHECK IN ('active','dissolved') | active 进行中 / dissolved 已解散（只读） |
| created_at | TEXT | NOT NULL | 创建时间 |
| dissolved_at | TEXT | NULL | 解散时间；保留期清理据此判定（D8） |

**表 3：`room_player` — 房间成员（玩家 × 房间）**

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | UUID |
| room_id | TEXT | NOT NULL，FK→room.id（级联删除） | 所属房间 |
| player_id | TEXT | NOT NULL，FK→player.id（级联删除） | 玩家身份 |
| nickname | TEXT | NOT NULL | 房间内昵称，UNIQUE(room_id, nickname) |
| chips | INTEGER | NOT NULL，CHECK (chips ≥ 0) | 当前筹码，缓存列（D4），CHECK 兜底防负 |
| status | TEXT | NOT NULL，CHECK IN ('active','left') | 在场 / 已离开；离开后筹码定格于 chips 列 |
| joined_at | TEXT | NOT NULL | 首次加入时间 |
| left_at | TEXT | NULL | 最近一次离开时间 |

索引与约束：

- `UNIQUE(room_id, player_id)`：同一玩家在同一房间至多一条成员记录（离开/回归复用同一条，更新 status）。
- 部分唯一索引 `UNIQUE(player_id) WHERE status='active'`：**一人一房间**（INV-7）的数据库级强制——一个身份至多有一个"在场"成员关系；房间解散时成员全部置为 left。

**表 4：`game` — 游戏**

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | UUID |
| room_id | TEXT | NOT NULL，FK→room.id（级联删除） | 所属房间 |
| seq | INTEGER | NOT NULL，UNIQUE(room_id, seq) | 房间内游戏序号，从 1 单调递增（INV-4） |
| status | TEXT | NOT NULL，CHECK IN ('in_progress','ended') | 同房间至多一个 in_progress（INV-3，事务内校验） |
| issued_chips | INTEGER | NOT NULL，默认 0 | 本游戏累计发放总额：开局按在场人数 × 本金记账，中途加入 / 回归重发时追加（D5，INV-2 基准） |
| started_at | TEXT | NOT NULL | 开启时间 |
| ended_at | TEXT | NULL | 结束时间（重建 / 解散时置为结束） |

**表 5：`round` — 轮次**

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | UUID |
| game_id | TEXT | NOT NULL，FK→game.id（级联删除） | 所属游戏 |
| seq | INTEGER | NOT NULL，UNIQUE(game_id, seq) | 游戏内轮次序号，从 1 单调递增（INV-4） |
| status | TEXT | NOT NULL，CHECK IN ('in_progress','closed') | 同游戏至多一个 in_progress（INV-3） |
| pool | INTEGER | NOT NULL，CHECK (pool ≥ 0) | 筹码池，缓存列（D4）；归零即在同事务内关闭并开新轮次（INV-6） |
| opened_at | TEXT | NOT NULL | 开启时间 |
| closed_at | TEXT | NULL | 归零关闭时间 |

**表 6：`action` — 动作流水（计算流水，只增不改，INV-5）**

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | TEXT | PK | UUID |
| round_id | TEXT | NOT NULL，FK→round.id（级联删除） | 轮次归属，必填（INV-8） |
| room_player_id | TEXT | NOT NULL，FK→room_player.id（级联删除） | 发起成员：只有房间的在场成员能产生动作；玩家身份经成员记录关联（player_id） |
| seq | INTEGER | NOT NULL，UNIQUE(round_id, seq) | 轮次内动作序号，事务内分配 |
| type | TEXT | NOT NULL，CHECK IN ('bet','collect','partial_collect') | 动作类型 |
| amount | INTEGER | NOT NULL，CHECK (amount ＞ 0) | 金额；collect 时记录整池数值 |
| is_all_in | INTEGER | NOT NULL，默认 0 | 仅 bet 且金额 = 发起者当时全部筹码时置 1（FR-402） |
| idempotency_key | TEXT | NULL | 防重复提交键（FR-408）；非空时全表唯一（部分唯一索引） |
| created_at | TEXT | NOT NULL | 动作时间 |

校验规则（事务内，与写入同批执行）：发起成员必须属于本房间且在场（status='active'），当前游戏与轮次进行中；bet 要求 `0 ＜ amount ≤ 成员当前 chips`；collect 要求 `pool ＞ 0`，amount 记为整池；partial_collect 要求 `0 ＜ amount ＜ pool`。任何校验失败整事务回滚，不产生半成功（NFR-04）。

**表 7：`feed_event` — 公屏事件（展示流水，只增不改）**

| 字段 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| id | INTEGER | PK，AUTOINCREMENT | 全局自增；在房间内单调，作为断线补拉游标 |
| room_id | TEXT | NOT NULL，FK→room.id（级联删除） | 所属房间 |
| type | TEXT | NOT NULL | 事件类型，枚举见下 |
| actor_player_id | TEXT | NULL，FK→player.id | 事件主语玩家；房间级系统事件为空 |
| payload | TEXT | NOT NULL | JSON 内容：谁 / 做了什么 / 多少（含金额、全下标记、轮次号、游戏号、设置项新旧值等） |
| created_at | TEXT | NOT NULL | 事件时间 |

事件类型枚举（对应 FR-502）：

| 分类 | 枚举值 |
| --- | --- |
| 房间 | `room_created`、`setting_changed`、`host_transferred`、`room_dissolved` |
| 成员 | `player_joined`、`player_left`、`player_returned` |
| 游戏 | `game_started`（含建房自动开局）、`game_rebuilt` |
| 轮次 | `round_opened`、`round_closed`（归零） |
| 动作 | `action_bet`（含全下标记）、`action_collect`、`action_partial_collect` |

索引：`INDEX(room_id, id)` 支撑按房间游标正/倒序翻页；`type`、`actor_player_id` 支撑筛选。

**存储双份的说明**：动作同时存在于 `action`（计算流水：推导 chips/pool、守恒校验）与 `feed_event`（展示流水：公屏历史）中。二者都只增不改，互为印证；对外的一切历史查询只走 `feed_event`（FR-503），`action` 不暴露独立的历史查询入口。

### 5.3 数据保留与清理（D8）

- 配置文件 `config.json`：`{ "port": 3000, "dbPath": "data/chips.db", "retentionDays": 90 }`，仅运维可改，玩家不可配置（FR-106）。
- 定时任务每小时执行：`DELETE FROM room WHERE status='dissolved' AND dissolved_at ＜ now − retentionDays`，成员、游戏、轮次、动作、事件经外键级联删除。
- 保留期内的已解散房间只读可查（FR-103 / AC-09）。
- 持久化参数：SQLite 以 WAL 模式运行并设置 `synchronous=FULL`——提交即落盘，掉电不丢已确认事务（NFR-03 零丢失）；对局记账写入频率低，无性能顾虑。
- 备份：SQLite 为单文件（`dbPath`），通过 `VACUUM INTO` 或拷贝 checkpoint 后的文件即可整库备份。

### 5.4 数据一致性校验（D12）

计数应用的信任基础是"缓存列与流水永远一致"（D4）。提供离线重算工具（服务端子命令，不影响在线服务）：

1. 按 `action` 流水逐轮回放，推导每个 `room_player.chips`、每个 `round.pool`；
2. 按发放事件（开局 / 中途加入 / 重建重发）推导每个 `game.issued_chips`；
3. 与缓存列逐项比对，输出差异报告（房间 / 对象 / 字段 / 差值）。

正常情况下差异恒为 0；若出现差异，以流水推导值为准修复缓存列，并以公屏事件追溯根因。该工具同时用于发版前的回归确认。

---

## 6. 关键流程时序图

参与者缩写：API=REST 接入层，WS=WebSocket 网关，DB=SQLite。所有写命令在对应房间的串行队列内执行（D3），图中不再重复标注。

### 6.1 建房与加入

```mermaid
sequenceDiagram
    actor H as 房主客户端
    actor P as 玩家客户端
    participant API as REST 接入层
    participant RS as 房间服务
    participant DB as SQLite（事务）
    participant FS as 公屏服务
    participant WS as WebSocket 网关

    H->>API: 创建房间（本金 1000，携身份 UUID）
    API->>RS: 建房命令（入房间队列）
    RS->>DB: BEGIN
    RS->>DB: INSERT player（首次）；INSERT room（生成 6 位房间号，房主=H）
    RS->>DB: INSERT room_player(H, chips=1000)；INSERT game(seq=1, issued=1000)；INSERT round(seq=1, pool=0)
    RS->>DB: INSERT feed_event ×3（room_created / game_started / round_opened，与状态同事务 D11）
    RS->>DB: COMMIT
    RS->>FS: 提交完成 → 触发广播
    FS->>WS: 按房间频道广播 3 条事件
    API-->>H: 建房成功（房间号 843217 + 总览）

    P->>API: 凭房间号 843217 加入（携身份 UUID）
    API->>RS: 加入命令
    RS->>DB: 校验：房间存在且未解散；部分唯一索引校验一人一房间
    RS->>DB: BEGIN：INSERT room_player(P, chips=1000)；UPDATE game SET issued_chips += 1000；INSERT feed_event(player_joined)；COMMIT
    RS->>FS: 提交完成 → 触发广播
    FS->>WS: 广播房间频道
    WS-->>H: 推送"P 加入，本金 1000"
    API-->>P: 加入成功（总览）
```

### 6.2 下注（三种输入统一处理）

```mermaid
sequenceDiagram
    actor P as 玩家客户端
    participant API as REST 接入层
    participant AS as 轮次与动作服务
    participant DB as SQLite（事务）
    participant FS as 公屏服务
    participant WS as WebSocket 网关
    actor O as 其他客户端

    P->>API: 下注 200（快捷值 / 手动 / 全下，携幂等键）
    API->>AS: 动作命令（入房间队列）
    AS->>AS: 幂等键查重；校验：P 在场、游戏轮次进行中、0 ＜ 200 ≤ P 当前筹码
    alt 校验失败
        AS-->>API: 拒绝（筹码与池不变）
        API-->>P: 失败原因
    else 校验通过
        AS->>DB: BEGIN
        AS->>DB: INSERT action(bet, 200, round_id=当前轮次, is_all_in=200=全部筹码?)
        AS->>DB: UPDATE room_player SET chips=chips−200（P）；UPDATE round SET pool=pool+200
        AS->>DB: INSERT feed_event(action_bet，含全下标记)——与状态变更同事务（D11）
        AS->>DB: COMMIT（状态与事件原子生效）
        AS->>FS: 提交完成 → 触发广播
        FS->>WS: 广播房间频道
        WS-->>O: 推送公屏事件 + 最新筹码/池
        API-->>P: 成功（P 最新筹码 / 最新池 / 当前轮次号）
    end
```

### 6.3 收池并自动换轮

```mermaid
sequenceDiagram
    actor P as 玩家客户端
    participant API as REST 接入层
    participant AS as 轮次与动作服务
    participant DB as SQLite（事务）
    participant FS as 公屏服务
    participant WS as WebSocket 网关

    P->>API: 收池
    API->>AS: 动作命令
    AS->>AS: 校验：P 在场、当前池 ＞ 0（池为 0 收池拒绝）
    AS->>DB: BEGIN
    AS->>DB: INSERT action(collect, amount=当前池值)
    AS->>DB: UPDATE room_player SET chips=chips+池值（P）；UPDATE round SET pool=0
    AS->>DB: UPDATE 旧轮次 SET status=closed；INSERT round(seq+1, pool=0)
    AS->>DB: INSERT feed_event ×3（action_collect / round_closed / round_opened，D11）
    AS->>DB: COMMIT（收池、换轮与事件同一事务，INV-6）
    AS->>FS: 提交完成 → 触发广播
    FS->>WS: 广播房间频道
    API-->>P: 成功（最新筹码 / 池 0 / 新轮次号）
```

### 6.4 重建游戏

```mermaid
sequenceDiagram
    actor H as 房主客户端
    participant API as REST 接入层
    participant GS as 游戏服务
    participant DB as SQLite（事务）
    participant FS as 公屏服务
    participant WS as WebSocket 网关
    actor O as 其他客户端

    H->>API: 重建游戏（若当前池非 0，附二次确认标记）
    API->>GS: 重建命令（校验发起者=房主）
    GS->>GS: 池非 0 且未带确认标记 → 返回确认提示，不做变更
    GS->>DB: BEGIN
    GS->>DB: 旧 game 置 ended；当前 round 置 closed（差额随旧游戏封存）
    GS->>DB: INSERT game(seq+1)；在场成员 chips 重置为本金（离开成员定格筹码不动）；新 game.issued_chips = 在场人数 × 本金
    GS->>DB: INSERT round(seq=1, pool=0)
    GS->>DB: INSERT feed_event ×2（game_rebuilt / round_opened，D11）
    GS->>DB: COMMIT（重建与事件原子生效）
    GS->>FS: 提交完成 → 触发广播
    FS->>WS: 广播房间频道
    WS-->>O: 推送"游戏重建，全员重置为本金"
    API-->>H: 成功（新游戏总览）
```

> **重置范围修正**：重建仅重置**在场成员**的筹码；已离开成员的定格筹码属于旧游戏账目，保持不动。离开成员其后回归时按新游戏本金重发，并计入新游戏的 `issued_chips`（FR-103、INV-2）。若一并重置离开成员，会同时破坏其定格值与新游戏的守恒校验。

### 6.5 断线重连与事件补拉

```mermaid
sequenceDiagram
    actor P as 玩家客户端
    participant WS as WebSocket 网关
    participant API as REST 接入层
    participant FS as 公屏服务
    participant DB as SQLite

    Note over P: 网络中断 / 切后台，本地保留已收到的事件游标（feed id）
    P->>WS: 重连（房间号 + 本地游标）
    WS-->>P: 订阅成功
    P->>API: 补拉缺失事件（房间号 + 游标）
    API->>FS: 查询
    FS->>DB: SELECT feed_event WHERE room_id=? AND id ＞ 游标（正序）
    DB-->>FS: 缺失事件列表
    FS-->>API: 返回
    API-->>P: 补拉结果（含新游标）
    Note over P,WS: 此后正常接收实时广播；客户端按事件 id 去重，不丢不重
```

> 先补拉、后收广播：以 `feed_event.id` 单调递增作为游标，断线期间的公屏与状态变化不丢失（FR-504）；全程无轮询。

---

## 7. 数据流图

图例：矩形＝外部实体，圆角＝加工（处理过程），圆柱＝数据存储。

### 7.1 顶层数据流图（0 层）

```mermaid
flowchart LR
    U["玩家 / 房主"]
    S(["P0 筹码计数器系统"])
    O["运维（配置文件）"]

    U -- "命令：建房 / 加入离开 / 动作 / 管理" --> S
    S -- "总览视图 / 公屏实时推送 / 校验结果" --> U
    O -- "端口 / 保留天数等参数" --> S
```

### 7.2 一层数据流图

```mermaid
flowchart TB
    U["玩家 / 房主"]
    O["运维（配置文件）"]

    P1(["P1 房间管理"])
    P2(["P2 游戏管理"])
    P3(["P3 动作处理"])
    P4(["P4 公屏服务"])
    P5(["P5 查询统计"])
    P6(["P6 保留期清理"])

    D1[("D1 玩家 / 房间 / 成员")]
    D2[("D2 游戏 / 轮次")]
    D3[("D3 动作流水")]
    D4[("D4 公屏事件")]
    D5[("D5 配置")]

    U -- "建房 / 加入 / 离开 / 回归 / 设置 / 移交 / 解散" --> P1
    P1 <--> D1
    P1 -- "建房完成 → 自动开局" --> P2
    U -- "重建游戏" --> P2
    P2 <--> D2
    P2 -- "重置筹码" --> D1

    U -- "下注 / 收池 / 部分收注" --> P3
    P3 <--> D1
    P3 <--> D2
    P3 -- "动作流水" --> D3
    D3 -- "动作记录" --> P3

    P1 -- "房间事件" --> P4
    P2 -- "游戏事件" --> P4
    P3 -- "动作事件" --> P4
    P4 -- "事件落库" --> D4

    U -- "浏览 / 筛选 / 总览查询" --> P5
    D4 -- "事件流" --> P5
    D1 -- "成员筹码" --> P5
    D2 -- "游戏轮次池" --> P5
    P5 -- "总览 / 筹码榜 / 推送" --> U

    O -- "保留天数" --> D5
    D5 -- "清理参数" --> P6
    P6 -- "删除超期已解散房间（级联）" --> D1
    P6 -- "级联删除" --> D2
    P6 -- "级联删除" --> D3
    P6 -- "级联删除" --> D4
```

---

## 8. 需求覆盖对照

| 需求 | 设计落点 |
| --- | --- |
| FR-101~107 房间管理 | 房间服务（§3.3）、room / room_player 表（§5.2）、建房加入时序（§6.1） |
| FR-201~204 游戏管理 | 游戏服务（§3.3）、game 表、重建时序（§6.4） |
| FR-301~304 轮次与筹码池 | 轮次与动作服务（§3.3）、round 表、收池换轮时序（§6.3） |
| FR-401~409 玩家动作 | 轮次与动作服务（§3.3、§6.2）、action 表、误操作无撤销（D7） |
| FR-501~504 公屏 | 公屏服务（§3.3）、feed_event 表、WS 网关（§3.1）、事件同事务写入（D11）、断线补拉（§6.5） |
| FR-601~602 查询统计 | 查询服务（§3.3）、缓存列（D4） |
| INV-1 金额校验 | §5.2 action 表校验规则、§6.2 |
| INV-2 守恒 | game.issued_chips（D5）、查询服务守恒校验、重算工具（§5.4） |
| INV-3 / INV-4 唯一性与序号 | game / round 表 UNIQUE 约束、事务内状态校验 |
| INV-5 只增不改 | action / feed_event 无 update / delete 路径（仅级联清理） |
| INV-6 换轮原子 | §6.3 同事务换轮 |
| INV-7 一人一房间 | 部分唯一索引（§5.2 表 3）、§6.1 加入校验 |
| INV-8 轮次归属必填 | action.round_id NOT NULL FK |
| 在场成员才能动作（FR-401~404"发起者为在场玩家"） | action.room_player_id NOT NULL FK + 在场校验（§5.2） |
| NFR-03/04/05 持久化 / 完整性 / 并发 | SQLite WAL + synchronous=FULL（§5.3）+ 房间级串行队列 + 事务（D3、§3.2）+ 重启恢复（D10） |
| NFR-06 整数 | 全表 INTEGER、CHECK 约束、快捷值整数生成（D6） |
| NFR-07 部署 | 微信小程序客户端（D9）、微信云托管容器化 + 单实例锁定；callContainer / connectContainer 云通道免合法域名与备案（详见详细设计 v2.0 §6） |
| NFR-08 身份 | 微信 openid 身份（D2） |
| NFR-10/11 时间与实时 | UTC 存储（§2.1）、WS 广播与游标补拉（§3.2、§6.5） |
| FR-106 保留期 | retentionDays 配置 + 定时清理（D8、§5.3） |

---

## 9. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1.0 | 2026-09-17 | 依据需求规格书 v2.9 输出首版概要设计：技术选型（Node.js + Koa + WebSocket + SQLite）、系统架构图、用例图、ER 图与 7 张数据库表设计、4 幅关键流程时序图、两级数据流图、快捷数值生成规则与需求覆盖对照；接口设计按约定暂缓 |
| v1.1 | 2026-09-18 | 修正与补充：① 修正重建重置范围——仅在场成员重置本金，离开成员定格筹码保留（原"全员重置"会破坏定格值与守恒）；② 事件改为与状态变更同事务写入（D11，outbox），广播在提交后触发，§6.1~6.4 时序图同步更新；③ 新增决策 D9 浏览器零安装客户端、D10 内存无状态与重启恢复、D12 一致性重算校验工具（新增 §5.4）；④ 新增断线重连补拉时序（§6.5）与 SQLite 持久化参数（§5.3）；⑤ 需求覆盖对照表同步 |
| v1.2 | 2026-09-18 | 客户端定为微信小程序：玩家身份改用 openid（D2 重写，含 `wx.login` → `code2Session` 登录链路；架构图新增微信开放接口外部依赖，player 表主键改为 openid）；快捷数值档位由 4 档扩充为 6 档（D6：本金 × 5/10/20/25/50/100%），§2.3 生成表同步；同步修订需求规格书 FR-107 示例与 AC-03（v2.10） |
| v1.4 | 2026-09-18 | 概念澄清：未加入房间的用户只是 openid 身份、不是玩家，动作只能由在场成员产生。ER 图中动作的发起关系由 PLAYER 改为 ROOM_PLAYER（身份经成员记录间接关联）；action 表外键 player_id 改为 room_player_id；§5.2 校验规则补"发起成员在场"前置校验；§3.3、§8 对照表同步 |
| v1.3 | 2026-09-18 | 修复系统架构图 mermaid 语法错误（带标签虚线边写法非法），并按 C4 模型重绘：容器图（C4Container：小程序客户端 / 服务端应用 / SQLite / 微信开放接口外部依赖）；服务端内部改为分层框图（接入层 / 业务服务层 / 数据访问层 / 存储，命令下行、事件上行，边数由 15 收敛至 7）；配置文件移出架构图，归入 §5.3 说明 |
| v1.5 | 2026-09-18 | 部署与存储选型修订（详见详细设计 v2.0）：① 部署形态定为**微信云托管**（容器化、最大实例数=1 单实例锁定），原"本地 / 局域网单实例"作废，需求 NFR-07 已同步修订（v2.11）；② 存储由 SQLite（better-sqlite3）更换为 **MySQL 5.7.44**（Sequelize + mysql2），§5 数据设计的落库细节（时间列 TEXT→DATETIME(3) UTC、CHECK→ENUM/UNSIGNED+服务层校验、部分唯一索引→生成列唯一索引、user_version→schema_migrations）以详细设计 §3 的 MySQL DDL 为准；③ 登录免 code2Session：callContainer 云通道注入 openid（D2 的实现细节由详细设计 §7.1 承载，appid/secret 配置随之移除），WS 经 connectContainer 接入 |
