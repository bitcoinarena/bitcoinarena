-- kanban #1107: the list leaves out every transaction of a round whose orders are all our bots' or the owner's; that asks a round's orders
CREATE INDEX IF NOT EXISTS txs_round_kind ON txs (round, kind);
