-- 筹码计数器 schema v1（与概设 §5.2 逐项对齐；InnoDB / utf8mb4，MySQL 5.7.44 兼容基线）
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INT UNSIGNED NOT NULL PRIMARY KEY,
  applied_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS player (
  id         VARCHAR(64) NOT NULL,             -- 微信 openid（D2，云通道注入）
  nickname   VARCHAR(64) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS room (
  id             CHAR(36)     NOT NULL,
  room_no        INT UNSIGNED NOT NULL,        -- 6 位房间号（D1）
  name           VARCHAR(128) NOT NULL,
  host_player_id VARCHAR(64)  NOT NULL,
  base_chips     INT UNSIGNED NOT NULL,        -- ∈预设值由服务层校验（5.7 CHECK 不生效）
  status         ENUM('active','dissolved') NOT NULL,
  created_at     DATETIME(3) NOT NULL,
  dissolved_at   DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_room_no (room_no),
  KEY idx_room_cleanup (status, dissolved_at),           -- 保留期清理扫描
  CONSTRAINT fk_room_host FOREIGN KEY (host_player_id) REFERENCES player(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS room_player (
  id         CHAR(36)    NOT NULL,
  room_id    CHAR(36)    NOT NULL,
  player_id  VARCHAR(64) NOT NULL,
  nickname   VARCHAR(64) NOT NULL,
  chips      INT UNSIGNED NOT NULL DEFAULT 0,
  status     ENUM('active','left') NOT NULL,
  joined_at  DATETIME(3) NOT NULL,
  left_at    DATETIME(3) NULL,
  -- 一人一房间（INV-7）：生成列 + 唯一索引，等价 partial unique index
  active_player_key VARCHAR(64)
    AS (CASE WHEN status = 'active' THEN player_id ELSE NULL END) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_room_member (room_id, player_id),
  UNIQUE KEY uniq_room_nickname (room_id, nickname),     -- utf8mb4_general_ci 大小写不敏感
  UNIQUE KEY uniq_room_player_active (active_player_key),
  CONSTRAINT fk_rp_room FOREIGN KEY (room_id) REFERENCES room(id) ON DELETE CASCADE
  -- 注：不设 player_id → player 的外键。MySQL 5.7 不允许 STORED 生成列（active_player_key）
  -- 的表达式引用带外键约束的列（errno 150）；player 存在性由服务层保证（ensurePlayer 先于加入），
  -- 保留期清理的级联删除由 fk_rp_room 承接（系统从不删除 player 行）。
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS game (
  id            CHAR(36)     NOT NULL,
  room_id       CHAR(36)     NOT NULL,
  seq           INT UNSIGNED NOT NULL,
  status        ENUM('in_progress','ended') NOT NULL,
  issued_chips  INT UNSIGNED NOT NULL DEFAULT 0,
  started_at    DATETIME(3) NOT NULL,
  ended_at      DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_room_game_seq (room_id, seq),
  CONSTRAINT fk_game_room FOREIGN KEY (room_id) REFERENCES room(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS round (
  id         CHAR(36)     NOT NULL,
  game_id    CHAR(36)     NOT NULL,
  seq        INT UNSIGNED NOT NULL,
  status     ENUM('in_progress','closed') NOT NULL,
  pool       INT UNSIGNED NOT NULL DEFAULT 0,
  opened_at  DATETIME(3) NOT NULL,
  closed_at  DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_game_round_seq (game_id, seq),
  CONSTRAINT fk_round_game FOREIGN KEY (game_id) REFERENCES game(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS action (
  id              CHAR(36)     NOT NULL,
  round_id        CHAR(36)     NOT NULL,
  room_player_id  CHAR(36)     NOT NULL,
  seq             INT UNSIGNED NOT NULL,
  type            ENUM('bet','collect','partial_collect') NOT NULL,
  amount          INT UNSIGNED NOT NULL,       -- >0 由服务层校验（UNSIGNED 拒绝负数）
  is_all_in       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(64) NULL,
  created_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_round_action_seq (round_id, seq),
  UNIQUE KEY uniq_action_idempotency (idempotency_key),  -- 唯一索引允许多个 NULL，等价部分唯一
  KEY idx_action_member (room_player_id),
  CONSTRAINT fk_action_round  FOREIGN KEY (round_id)       REFERENCES round(id)       ON DELETE CASCADE,
  CONSTRAINT fk_action_member FOREIGN KEY (room_player_id) REFERENCES room_player(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS feed_event (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,  -- 房间内游标（断线补拉）
  room_id         CHAR(36)    NOT NULL,
  type            VARCHAR(32) NOT NULL,                     -- 枚举在应用层（§6.4），便于扩展
  actor_player_id VARCHAR(64) NULL,
  payload         TEXT        NOT NULL,                     -- JSON（§6.4）
  created_at      DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_feed_room  (room_id, id),
  KEY idx_feed_actor (room_id, actor_player_id),
  KEY idx_feed_type  (room_id, type),
  CONSTRAINT fk_feed_room  FOREIGN KEY (room_id)         REFERENCES room(id) ON DELETE CASCADE,
  CONSTRAINT fk_feed_actor FOREIGN KEY (actor_player_id) REFERENCES player(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
