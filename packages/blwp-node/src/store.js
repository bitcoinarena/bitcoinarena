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
import { ed25519 } from '@noble/curves/ed25519.js';

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

    -- THE RECEIPTS THIS NODE HAS ISSUED, keyed by the mark they answer.
    --
    -- A receipt says "I held this mark at this time", and a mark re-sent by a
    -- client that never learned the first one landed must get the SAME answer
    -- back - the same time, the same signature, the same bytes. A fresh
    -- timestamp on a repeat would hand the player two different times for one
    -- commitment, and section 10's whole claim is that the player committed to
    -- that state at approximately that real time. So the receipt is stored
    -- once and re-served, and the key is the checkpoint it answers rather than
    -- (round, entry, tick), because the mark's own id is what it commits to.
    --
    -- AND THE SIGNER IS PART OF THE KEY, because gossip puts other nodes'
    -- receipts in here too. Section 13C counts a chain as canonical when it
    -- carries receipts from at least five committee nodes, so the same mark
    -- must be able to hold seven of them - one per member - while a second,
    -- different receipt from the SAME member for that mark is a node
    -- contradicting itself and is refused by name.
    -- A PLAYER WHO SIGNED TWO DIFFERENT WORLDS AT ONE TICK.
    --
    -- Section 13B: "A player who publishes two different checkpoints for the
    -- same (round_id, player_pubkey, tick)... forfeits the entry", and "the two
    -- conflicting signed checkpoints are a complete, portable proof; no replay
    -- is needed". Nodes MUST publish such a proof when they hold one.
    --
    -- The second mark is still REFUSED - it does not become a checkpoint, and
    -- the chain the committee carries is unchanged. It is kept here as
    -- evidence, beside the first, because a node that refused it and threw it
    -- away destroyed the only thing that proves what the player did. That is
    -- what this node used to do.
    CREATE TABLE IF NOT EXISTS equivocations (
      round_id      BLOB NOT NULL,
      entry_id      BLOB NOT NULL REFERENCES entries(entry_id),
      tick          INTEGER NOT NULL,
      stored_bytes  BLOB NOT NULL,
      offered_bytes BLOB NOT NULL,
      seen_ms       INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, tick)
    );

    CREATE TABLE IF NOT EXISTS receipts (
      checkpoint_id BLOB NOT NULL,
      node_pubkey   BLOB NOT NULL,
      bytes         BLOB NOT NULL,
      PRIMARY KEY (checkpoint_id, node_pubkey)
    );

    -- A mark is looked up by its own id when a receipt arrives for it - from
    -- this node or from a peer - and the table above is keyed by
    -- (round, entry, tick), which cannot answer that question.
    CREATE INDEX IF NOT EXISTS checkpoints_by_id ON checkpoints (checkpoint_id);

    -- THIS NODE'S OWN KEY. One row, and the CHECK is what makes it one: a
    -- daemon with two identities would sign some receipts with each and a
    -- client checking them against the committee would be right to refuse
    -- half of them.
    --
    -- It is the whole of the identity this cut needs. Where a key comes to be
    -- KNOWN to strangers is the bond advertisement, M2.1 step 5b, and that is
    -- discovery: it is not what lets a node sign. A client already holds the
    -- key it should expect, in the Round Contract's nodes list.
    CREATE TABLE IF NOT EXISTS identity (
      one    INTEGER PRIMARY KEY CHECK (one = 0),
      secret BLOB NOT NULL,
      pubkey BLOB NOT NULL
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

/**
 * The node's own keypair, made once and kept.
 *
 * Generated on first ask and read from the file every time after, so a daemon
 * that restarts is the same node to every client that has one of its receipts.
 * A node that made a fresh key on each start would invalidate every receipt it
 * had ever issued the moment it was restarted.
 */
export function nodeIdentity(db) {
  const row = db.prepare('SELECT secret, pubkey FROM identity WHERE one = 0').get();
  if (row) return { secret: new Uint8Array(row.secret), pubkey: new Uint8Array(row.pubkey) };

  const secret = ed25519.utils.randomSecretKey();
  const pubkey = ed25519.getPublicKey(secret);
  db.prepare('INSERT INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(secret, pubkey);
  return { secret, pubkey };
}
