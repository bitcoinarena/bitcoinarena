// The round, on disk, in `node:sqlite`.
//
// IDEMPOTENCE IS IN THE SCHEMA, not in the code that writes to it. A batch is
// keyed by (round, entry, tick) with a PRIMARY KEY, so a repeat is a no-op the
// database performs and not a check a caller can forget. `M2.1` step 2 asks
// for exactly that property; putting it in later would be a migration, and
// putting it in the caller would mean every future caller has to remember it.
//
// A gap needs nothing at all: ticks are absolute, so `MAX(tick)` against
// `COUNT(*)` says whether any are missing, and which ones is a query rather
// than a reconstruction.
//
// Nothing here steps the core. The node stores and serves; it does not judge.
// Verification arrives with the checkpoints and is measured on its own.
import { DatabaseSync } from 'node:sqlite';

export const OPEN = 0, CLOSED = 1;

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS rounds (
      round_id   BLOB PRIMARY KEY,
      contract   BLOB NOT NULL,
      state      INTEGER NOT NULL DEFAULT 0,
      opened_ms  INTEGER NOT NULL,
      closed_ms  INTEGER
    );

    CREATE TABLE IF NOT EXISTS entries (
      entry_id   BLOB PRIMARY KEY,
      round_id   BLOB NOT NULL REFERENCES rounds(round_id),
      contract   BLOB NOT NULL,
      joined_ms  INTEGER NOT NULL
    );

    -- One row per TICK, not per message. That is what makes a repeated batch
    -- harmless: the second write of a tick is refused by the key, not by a
    -- caller remembering to look.
    CREATE TABLE IF NOT EXISTS ticks (
      round_id  BLOB NOT NULL,
      entry_id  BLOB NOT NULL REFERENCES entries(entry_id),
      tick      INTEGER NOT NULL,
      words     BLOB NOT NULL,
      PRIMARY KEY (round_id, entry_id, tick)
    );

    -- The batches themselves, kept whole and in chain order. The ticks table
    -- above answers "what did the player press at tick N"; this one answers
    -- "hand me the transcript", and they are different questions: the second
    -- needs the bytes exactly as they were signed and chained, not a
    -- reassembly of them.
    CREATE TABLE IF NOT EXISTS batches (
      round_id  BLOB NOT NULL,
      entry_id  BLOB NOT NULL REFERENCES entries(entry_id),
      seq       INTEGER NOT NULL,
      batch_id  BLOB NOT NULL,
      bytes     BLOB NOT NULL,
      PRIMARY KEY (round_id, entry_id, seq)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS batches_by_id
      ON batches (round_id, entry_id, batch_id);

    -- THE CHECKPOINTS, and the key is the rule. Section 13B forfeits a player
    -- who publishes two different checkpoints for the same tick; keyed
    -- (round, entry, tick) that is not a policy anyone has to enforce, it is
    -- the shape of the table. The checkpoint id sits beside it so the two
    -- cases can be told apart: the SAME bytes again is a repeat and a no-op,
    -- different bytes at the same key is the equivocation.
    --
    -- The bytes are kept whole. The node cannot recompute a state hash -
    -- nothing in this package imports the core - so what it serves has to be
    -- what it was given, byte for byte.
    CREATE TABLE IF NOT EXISTS checkpoints (
      round_id      BLOB NOT NULL,
      entry_id      BLOB NOT NULL REFERENCES entries(entry_id),
      tick          INTEGER NOT NULL,
      checkpoint_id BLOB NOT NULL,
      bytes         BLOB NOT NULL,
      received_ms   INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, tick)
    );

    -- Sparse, because a liquidation is rare, and keyed the same way so a
    -- repeat cannot double a strike.
    CREATE TABLE IF NOT EXISTS liquidations (
      round_id  BLOB NOT NULL,
      entry_id  BLOB NOT NULL REFERENCES entries(entry_id),
      tick      INTEGER NOT NULL,
      size      INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, tick)
    );
  `);
  return db;
}
