-- EVERY KIND OF PAYMENT, AND PAGES PAST THE NEWEST 1000 (kanban #683, 2026-10-26: "I don't see item purchases in the explorer and I don't
-- see other apps in the explorer. Add paging to the explorer to display more than a 1000"; #682: a gift "doesn't show in the explorer"):
-- each row says its kind - an order (every row before), an item bought, a donation, a zap - and a gift or purchase its federation
-- transaction, so the wallet history's link by that transaction finds it. A page is read newest first by (time, id), within one app or kind.
ALTER TABLE txs ADD COLUMN kind TEXT NOT NULL DEFAULT 'order';
ALTER TABLE txs ADD COLUMN fed_txid TEXT;
CREATE INDEX IF NOT EXISTS txs_stored_id ON txs (stored_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS txs_app_stored ON txs (app, stored_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS txs_kind_stored ON txs (kind, stored_ms DESC, id DESC);
CREATE INDEX IF NOT EXISTS txs_fed_txid ON txs (fed_txid);
DROP INDEX IF EXISTS txs_stored;
