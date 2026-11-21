-- kanban #2985 (audit faucet r1-1, gap in #2758): GET /api/recent?fed= walked the whole txs table newest first per request (no index on
-- federation); a filter by federation reads its own rows in page order, as app and kind do (0002)
CREATE INDEX IF NOT EXISTS txs_fed_stored ON txs (federation, stored_ms DESC, id DESC);
