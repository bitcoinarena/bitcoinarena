-- THE EXPLORER'S STORE (kanban #624, 2026-10-24: "It should all be cached not be fetched from a node"): every transaction as the
-- nodes last described it, merged; written by the minute's read only when it changed
CREATE TABLE IF NOT EXISTS txs (
  id          TEXT PRIMARY KEY,
  round       TEXT,
  app         TEXT,
  federation  TEXT,
  stored_ms   INTEGER NOT NULL,
  settled     TEXT,
  hash        TEXT NOT NULL,
  json        TEXT NOT NULL,
  updated_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS txs_stored ON txs (stored_ms DESC);
