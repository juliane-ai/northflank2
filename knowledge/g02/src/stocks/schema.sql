CREATE SCHEMA IF NOT EXISTS stock_watch;

CREATE TABLE IF NOT EXISTS stock_watch.stocks (
  symbol text PRIMARY KEY,
  name text NOT NULL,
  sector text NOT NULL,
  position integer NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  dividend numeric(12,4),
  dividend_asof text NOT NULL DEFAULT '',
  ex_date text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 0,
  quote jsonb
);
CREATE TABLE IF NOT EXISTS stock_watch.rules (
  id uuid PRIMARY KEY,
  symbol text NOT NULL REFERENCES stock_watch.stocks(symbol),
  slot integer NOT NULL CHECK (slot BETWEEN 1 AND 3),
  target numeric(12,2),
  enabled boolean NOT NULL DEFAULT true,
  cycle integer NOT NULL DEFAULT 1,
  armed_at timestamptz NOT NULL DEFAULT now(),
  triggered_at timestamptz,
  UNIQUE (symbol, slot)
);
CREATE TABLE IF NOT EXISTS stock_watch.alerts (
  id uuid PRIMARY KEY,
  rule_id uuid NOT NULL REFERENCES stock_watch.rules(id),
  cycle integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  handled boolean NOT NULL DEFAULT false,
  delivery text NOT NULL DEFAULT 'unconfigured',
  attempts integer NOT NULL DEFAULT 0,
  next_attempt timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, cycle)
);
CREATE INDEX IF NOT EXISTS stock_alerts_created ON stock_watch.alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS stock_alerts_delivery ON stock_watch.alerts(delivery, next_attempt);
CREATE TABLE IF NOT EXISTS stock_watch.plans (
  month text PRIMARY KEY,
  regular_budget numeric(14,2) NOT NULL DEFAULT 0,
  extra_budget numeric(14,2) NOT NULL DEFAULT 0,
  regular_spent numeric(14,2) NOT NULL DEFAULT 0,
  extra_spent numeric(14,2) NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stock_watch.sessions (
  token_hash text PRIMARY KEY,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS stock_sessions_expiry ON stock_watch.sessions(expires_at);
CREATE TABLE IF NOT EXISTS stock_watch.meta (key text PRIMARY KEY, value text NOT NULL);
