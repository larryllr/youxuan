PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS "groups" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  valid_days INTEGER NOT NULL DEFAULT 30,
  device_limit INTEGER NOT NULL DEFAULT 0,
  speed_limit_bps INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  reset_cycle TEXT NOT NULL DEFAULT 'none',
  reset_day INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT,
  name TEXT,
  uuid TEXT NOT NULL UNIQUE,
  sub_token TEXT NOT NULL UNIQUE,
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  used_upload INTEGER NOT NULL DEFAULT 0,
  used_download INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  last_reset_at INTEGER NOT NULL DEFAULT 0,
  next_reset_at INTEGER NOT NULL DEFAULT 0,
  device_limit INTEGER NOT NULL DEFAULT 0,
  speed_limit_bps INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  note TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 443,
  host TEXT NOT NULL,
  sni TEXT,
  path TEXT NOT NULL,
  fp TEXT NOT NULL DEFAULT 'chrome',
  security TEXT NOT NULL DEFAULT 'tls',
  type TEXT NOT NULL DEFAULT 'ws',
  group_id TEXT REFERENCES "groups"(id) ON DELETE SET NULL,
  region TEXT,
  tags TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  default_user_quota_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_groups (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES "groups"(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS user_node_limits (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  quota_bytes INTEGER NOT NULL DEFAULT 0,
  used_upload INTEGER NOT NULL DEFAULT 0,
  used_download INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, node_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  ip TEXT,
  ua TEXT,
  colo TEXT,
  country TEXT,
  opened_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  closed_at INTEGER,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  close_reason TEXT
);

CREATE TABLE IF NOT EXISTS usage_daily (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  day TEXT NOT NULL,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  download_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, node_id, day)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'CNY',
  provider TEXT,
  provider_ref TEXT,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  body TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_uuid ON users(uuid);
CREATE INDEX IF NOT EXISTS idx_users_sub_token ON users(sub_token);
CREATE INDEX IF NOT EXISTS idx_users_status_expiry ON users(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_nodes_enabled_group ON nodes(enabled, group_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, closed_at, last_seen_at);
CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_usage_daily_day ON usage_daily(day);
