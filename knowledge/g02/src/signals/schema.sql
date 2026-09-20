CREATE SCHEMA IF NOT EXISTS signal_research;
CREATE TABLE IF NOT EXISTS signal_research.meta (key text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS signal_research.sessions (
  token_hash text PRIMARY KEY, csrf_token text NOT NULL, created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_research.tasks (
  id uuid PRIMARY KEY, source_id text NOT NULL UNIQUE, state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS signal_research.orders (
  id text PRIMARY KEY, task_id uuid NOT NULL REFERENCES signal_research.tasks(id),
  state jsonb NOT NULL, settled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS signal_research.events (
  id bigserial PRIMARY KEY, task_id uuid REFERENCES signal_research.tasks(id),
  type text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signal_events_task ON signal_research.events(task_id,id DESC);
CREATE INDEX IF NOT EXISTS signal_orders_pending ON signal_research.orders(settled) WHERE settled=false;
CREATE TABLE IF NOT EXISTS signal_research.quotes (
  inst_id text NOT NULL, quote_time bigint NOT NULL, data jsonb NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(inst_id,quote_time)
);
CREATE TABLE IF NOT EXISTS signal_research.candles (
  inst_id text NOT NULL, interval text NOT NULL, candle_time bigint NOT NULL, data jsonb NOT NULL,
  PRIMARY KEY(inst_id,interval,candle_time)
);
