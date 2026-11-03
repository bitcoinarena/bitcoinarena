-- WHOSE ROUNDS ARE NOT PLAYERS' (kanban #1090, the owner 2026-11-03: "Wieviel Runden insgesamt und pro Spiel, tu da meine Runden RAUS NEHMEN.
-- Indem es ein Flag im Frontend gibt, was ich aktivieren kann"): the entry keys the owner's page (admin flag) and our own bots reported, each
-- with its kind (a key is an entry id - the transaction's id - or a player key); the played-rounds counts leave them out of the real players' figures
CREATE TABLE IF NOT EXISTS marked (key TEXT PRIMARY KEY, kind TEXT NOT NULL, at_ms INTEGER NOT NULL);
