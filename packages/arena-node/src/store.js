// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
import { chmodSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';

export const OPEN = 0, CLOSED = 1;

/**
 * A STORE MADE WHILE A SIGNING MACHINE WAS CALLED A SEAT keeps its rows under the new names
 * (2026-09-15 20:32: seat migrates in code too). The table and the six columns are renamed
 * in place before anything is created, so the tables below find their rows under the names they
 * use - and a store that already has the new names, or none at all, is left as it is. The old names
 * appear here and nowhere else in the node: they are what an old store on disk still says.
 */
const RENAMED_COLUMNS = [
  ['held_shares', 'seat', 'signer_node'],
  ['pool_nonces', 'seat_id', 'signer_node_id'],
  ['dkg_epochs', 'seats', 'signer_nodes'],
  ['dkg_epochs', 'seat_no', 'signer_node_no'],
  ['postings', 'seat_pubkey', 'signer_node_pubkey'],
  ['reruns', 'seat_pubkey', 'signer_node_pubkey'],
];

export function renameToSignerNodes(db) {
  const table = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
  const columns = (t) => (table(t) ? db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name) : []);
  const done = [];
  if (table('seats') && !table('signer_nodes')) { db.exec('ALTER TABLE seats RENAME TO signer_nodes'); done.push('seats'); }
  for (const [t, from, to] of RENAMED_COLUMNS) {
    const have = columns(t);
    if (have.includes(from) && !have.includes(to)) { db.exec(`ALTER TABLE ${t} RENAME COLUMN ${from} TO ${to}`); done.push(`${t}.${from}`); }
  }
  return done;
}

/**
 * A WRITE-AHEAD RECORD, ON THE DISK BEFORE ITS EFFECT (kanban #1243, audit 3 #1210 CRASH-2): the store runs synchronous = NORMAL, so a commit is
 * durable only at the next WAL sync - and a power loss could take the very record a write-ahead fix stands on (an exchange's RECEIVING row while
 * the federation already holds the notes, a deal, an epoch contribution, a settlement SUBMITTING, a send FUNDING). `fn` runs with synchronous =
 * FULL, so its commit fsyncs the WAL (measured on the Beelink: 6.2 ms a write, 0.015 ms at NORMAL); every other write stays NORMAL. Inside an
 * open transaction nothing is switched (the transaction's own commit decides).
 */
export function durably(db, fn) {
  if (!db || typeof db.exec !== 'function' || db.isTransaction === true) return fn();
  let was = null;
  try { const r = db.prepare('PRAGMA synchronous').get(); was = r ? Number(Object.values(r)[0]) : null; } catch { was = null; }
  if (was !== null && was >= 2) return fn();
  try { db.exec('PRAGMA synchronous = FULL'); } catch { return fn(); }
  try { return fn(); } finally { try { db.exec(`PRAGMA synchronous = ${was === null ? 1 : was}`); } catch { /* the next open sets it again */ } }
}

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  // WHERE THIS STORE IS, kept on the handle (2026-09-17 19:15, the ghost lag): a replay worker opens the same
  // file read-only and reads a run's rows itself, instead of the thread that answers /play reading them and handing
  // them across. ':memory:' names no file, and those rows are handed across as before.
  db.arenaPath = path === ':memory:' ? null : path;
  // THE NODE'S SECRETS LIVE IN THIS FILE (feedback #021, kanban #2570: node.db was 0644 beside a 0600 seed.hex): owner-only, as
  // the seed and state are. SQLite gives its -wal and -shm files the database's mode. A path it cannot change (not a file) is left.
  if (db.arenaPath) { try { chmodSync(path, 0o600); } catch { /* not a plain file of ours */ } }
  // EVERY STATEMENT COMPILED ONCE (NODE-OPT-1648, 2026-10-02: "Optimize the node software for CPU, memory, and
  // performance"): node:sqlite keeps no statement cache, and the store is asked through db.prepare(sql) inline - a tick
  // batch alone compiled seven statements per call; profiled on a testnet4 seat during a live round, prepare and exec were
  // ~11 % of its loop. A statement is kept per SQL text and reused (nothing here iterates a statement while running it).
  const compile = db.prepare.bind(db);
  const compiled = new Map();
  db.prepare = (sql) => { let st = compiled.get(sql); if (!st) { st = compile(sql); compiled.set(sql, st); } return st; };
  renameToSignerNodes(db);
  db.exec(`
    PRAGMA journal_mode = WAL;
    -- A COMMIT WITHOUT A DISK SYNC (NODE-OPT-1648): in WAL mode NORMAL keeps every commit across a crash of this process
    -- and the store consistent across a power loss, which can lose only the last commits; FULL synced on every commit -
    -- one per tick batch from every player.
    PRAGMA synchronous = NORMAL;
    -- FEWER CHECKPOINTS (2026-10-13: "Fixe die 15% platte"; measured 10:3xZ on the test host: the system disk 78 % busy at
    -- 1,136 writes/s, each seat inserting ~1,840 seating rows a minute for grid rounds keyed by random round ids): the WAL is
    -- written back every 10 000 pages (40 MB) instead of 1 000, so a page changed many times between two checkpoints is
    -- written to the database once, with one pair of syncs; the WAL file is cut back to 64 MB after each.
    PRAGMA wal_autocheckpoint = 10000;
    PRAGMA journal_size_limit = 67108864;
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
      -- the player's 64-byte session-key signature over batch_id, beside the batch and never in it (kanban #1567):
      -- NULL for a batch taken bare (a /first-mark hand-on that carried none, or a store from before)
      signature BLOB,
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

    -- TWO FIRST MARKS OF ONE ENTRY, NEITHER HELD HERE AS A CHECKPOINT (M3.3-34,
    -- ruled 2026-09-12): the on-time first mark another signer node voided and a
    -- different one the player sent here. Both chain to nothing - one parent,
    -- two chains (13B) - so the pair is the proof, served at /equivocation so
    -- the other signer nodes can pull it. Never a checkpoint; never a refund.
    CREATE TABLE IF NOT EXISTS first_mark_pairs (
      round_id BLOB NOT NULL,
      entry_id BLOB NOT NULL REFERENCES entries(entry_id),
      first_a  BLOB NOT NULL,
      first_b  BLOB NOT NULL,
      seen_ms  INTEGER NOT NULL,
      PRIMARY KEY (entry_id, first_a, first_b)
    );

    -- AND TWO MARKS AT ANY LATER TICK, PULLED FROM A PEER (§13BRULED 2026-10-04): a pair
    -- provesEquivocation accepts - one entry, both signed by its session key, different ids, the same tick or the same
    -- parent - that this node did not hold as a checkpoint and a refused mark of its own. Kept so it serves it too.
    CREATE TABLE IF NOT EXISTS fork_pairs (
      round_id BLOB NOT NULL,
      entry_id BLOB NOT NULL REFERENCES entries(entry_id),
      mark_a   BLOB NOT NULL,
      mark_b   BLOB NOT NULL,
      seen_ms  INTEGER NOT NULL,
      PRIMARY KEY (entry_id, mark_a, mark_b)
    );

    -- ANOTHER SIGNER NODE'S SHARE OF A STAKE'S PREIMAGE, AS IT SEALED IT TO THIS SIGNER NODE
    -- (M3.3-34): the envelope, never the opened share - so a signer node that released
    -- its share and then went down cannot hand the stake back by staying down.
    CREATE TABLE IF NOT EXISTS held_shares (
      entry_id BLOB NOT NULL REFERENCES entries(entry_id),
      signer_node     INTEGER NOT NULL,
      answer   BLOB NOT NULL,
      seen_ms  INTEGER NOT NULL,
      PRIMARY KEY (entry_id, signer_node)
    );

    -- A RECEIPT FOR A MARK THIS NODE HAS NEVER SEEN.
    --
    -- Dropped at the door until now, and that is the signal 13B built receipt
    -- gossip FOR: "a divergence sent to disjoint node subsets surfaces within
    -- a window rather than at settlement". A player who sends chain A to three
    -- nodes and chain B to four leaves every node locally consistent, and the
    -- only thing that shows it is a committee member receipting a mark the
    -- others never got.
    --
    -- It is kept UNATTRIBUTED on purpose. A receipt carries a checkpoint id, a
    -- signer and a time - not a round - so a node holding one for an unknown
    -- mark cannot say which entry it belongs to, and cannot check the signer
    -- against a committee it cannot look up. What it can check is that the
    -- signature verifies under the key the receipt itself names, and that is
    -- what is stored: somebody receipted something this node has not got.
    -- A SIGNED MARK THIS NODE REFUSED, KEPT BESIDE THE CHAIN IT ACCEPTED.
    -- Usually an honest client with a stale head; sometimes the second chain
    -- of 13B. It never joins the chain, and whether it proves anything is
    -- provesEquivocation's answer rather than this table's.
    CREATE TABLE IF NOT EXISTS offered_marks (
      round_id      BLOB NOT NULL,
      entry_id      BLOB NOT NULL REFERENCES entries(entry_id),
      tick          INTEGER NOT NULL,
      checkpoint_id BLOB NOT NULL,
      bytes         BLOB NOT NULL,
      seen_ms       INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, checkpoint_id)
    );

    CREATE TABLE IF NOT EXISTS foreign_receipts (
      checkpoint_id BLOB NOT NULL,
      node_pubkey   BLOB NOT NULL,
      bytes         BLOB NOT NULL,
      seen_ms       INTEGER NOT NULL,
      PRIMARY KEY (checkpoint_id, node_pubkey)
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

    -- THE OPEN ROUNDS IN THE ORDER THEY OPENED, AND THE CLOSED ONES LATEST FIRST, READ FROM AN INDEX (2026-10-02,
    -- the the test host's load): openRounds and finishedRounds sorted every round's contract in a temporary B-tree, and with
    -- ~2,950 rounds held (a series 72 h ahead) the sort spilled to temporary files on every door sweep, close sweep and
    -- lobby listing - 2,276 page writes in 5 s, ~1.6 MB/s from every idle testnet4 seat, while no row changed.
    CREATE INDEX IF NOT EXISTS rounds_by_state_opened ON rounds (state, opened_ms);
    CREATE INDEX IF NOT EXISTS rounds_by_state_closed ON rounds (state, closed_ms);

    -- A ROUND'S ENTRIES, READ FROM AN INDEX (kanban #576, profiled 2026-10-23 01:2xZ on test host seat 1): entriesOf and the book's
    -- proposal read entries by round at every batch of every open market round, and without this each read scanned every entry
    -- the seat holds, contract blobs and all - SQLite's own time was the largest left in the seat.
    CREATE INDEX IF NOT EXISTS entries_by_round ON entries (round_id);

    -- WHICH ENTRIES NAME A LOCK OUTPOINT, IN EVERY ROUND (kanban #1692, #1758): a lock goes to the first entry naming it in ANY round this seat
    -- holds - every round on the same seats has the same claim key, so a copy into another round passed lockMatchesEntry. Written when an
    -- entry is first kept; entries kept before this table are still read by their own round (Round.firstNamingOfLock).
    CREATE TABLE IF NOT EXISTS entry_lock_names (
      kind       TEXT NOT NULL,
      outpoint   TEXT NOT NULL,
      entry_id   BLOB NOT NULL,
      player_pk  BLOB NOT NULL,
      joined_ms  INTEGER NOT NULL,
      PRIMARY KEY (kind, outpoint, entry_id)
    );

    -- THIS NODE'S OWN KEY. One row, and the CHECK is what makes it one: a
    -- daemon with two identities would sign some receipts with each and a
    -- client checking them against the committee would be right to refuse
    -- half of them.
    --
    -- It is the whole of the identity this cut needs. Where a key comes to be
    -- KNOWN to strangers is the bond advertisement, M2.1 step 5b, and that is
    -- discovery: it is not what lets a node sign. A client already holds the
    -- key it should expect, in the Round Contract's nodes list.
    -- WHO THIS ROUND WAS ASSIGNED, from the census at its own census_height.
    --
    -- A round's committee is not a list its author typed: 5A.4 assigns it from
    -- the chain census, and this is where that answer is kept so every trust
    -- check reads the same one. A round with no rows here was never assigned by
    -- this node, and it issues no receipts against it.
    CREATE TABLE IF NOT EXISTS signer_nodes (
      round_id BLOB NOT NULL,
      pubkey   BLOB NOT NULL,
      PRIMARY KEY (round_id, pubkey)
    );

    -- THE SHARES A PLAYER PUBLISHED FOR THEIR STAKE PREIMAGE, once this node
    -- has checked them. 23.1's vss_shares_ref on an Entry Contract names a
    -- row here, and an entry that names one this node never accepted is
    -- refused: a signer node that cannot check a handout has no business letting the
    -- round it gates begin.
    --
    -- Only accepted handouts are stored, so the presence of a row IS the
    -- answer. A refused one leaves nothing behind - there is no state a
    -- second attempt could inherit.
    CREATE TABLE IF NOT EXISTS handouts (
      handout_id  BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      accepted_ms INTEGER NOT NULL
    );

    -- (NO HOLDS TABLE IN A NEW STORE: it was the hold invoice's record of a stake in flight - the withdrawn Lightning
    -- custody's, §23.6; cut 2b RULED 2026-09-25. A store from before keeps its own, untouched and unread: a store is
    -- not rewritten.)

    -- 23.1 STEP 5, THIS NODE'S HALF: the stake was seen - play is gated on
    -- this row, written once when the stake was first verified. A
    -- table of its own so a store written before it existed gains it.
    CREATE TABLE IF NOT EXISTS stake_seen (
      entry_id   BLOB PRIMARY KEY REFERENCES entries(entry_id),
      paid_msat  INTEGER NOT NULL,
      seen_ms    INTEGER NOT NULL
    );

    -- AND THE TICK THE PLAYER HAD REACHED WHEN IT WAS HELD (§15's start window, 2026-09-21).
    --
    -- The start deadline is 900 ticks of the player's OWN run, and the run starts at tick 0 when the session
    -- opens - so a paid entry spent about 87 s of its own clock waiting for an invoice to be paid, and its
    -- first mark landed at tick 5220 against a deadline of 900. MEASURED: 602 batches covering 0..10799 with
    -- the first mark inside them, so marks and batches are one clock and this tick is in it too.
    --
    -- It is the highest tick this node had ALREADY RECEIVED from that player when Lightning showed the hold:
    -- node-observed, never asserted by the client, and pinned by the same replay as every other tick. A
    -- table of its own so a store written before it existed gains it.
    -- WHAT THE TABLE OWES A QUALIFIER, AND WHETHER IT HAS BEEN PAID (§24A.2).
    --
    -- The losing branch settles stakes into the pool and a delivered player's own stake is cancelled back,
    -- but until this table existed nothing recorded the WINNINGS - measured on the Daily's first settled
    -- round: the rule computed 98000 msat owed to the winner, the 98 sat sat in the committee's own
    -- channel, and the payouts table held no row because that path spends an on-chain pool this custody
    -- has none of. One row per qualifier, written when the money is worked out, moved through once.
    -- (NO FEE_HOLDS TABLE IN A NEW STORE - the node fee's hold invoice, RULED 2026-09-25: an old store keeps its fee_holds table, unread.)

    CREATE TABLE IF NOT EXISTS winnings (
      entry_id  BLOB PRIMARY KEY REFERENCES entries(entry_id),
      round_id  BLOB NOT NULL,
      owed_msat INTEGER NOT NULL,
      state     TEXT NOT NULL,
      request   TEXT,
      why       TEXT NOT NULL,
      owed_ms   INTEGER NOT NULL,
      paid_ms   INTEGER
    );

    -- A WINNING SENT ON A FEDERATION ROUND (protocol/winnings-send.js): one row per entry and attempt - the send
    -- plan every signer node checked before it rebuilt the settlement, the contract it became, and the preimage the
    -- gateway revealed when it paid. A second attempt is the same winning re-sent after the first expired.
    CREATE TABLE IF NOT EXISTS winnings_sends (
      entry_id      BLOB NOT NULL REFERENCES entries(entry_id),
      attempt       INTEGER NOT NULL,
      round_id      BLOB NOT NULL,
      address       TEXT NOT NULL,
      invoice       TEXT NOT NULL,
      payment_hash  TEXT NOT NULL,
      invoice_msat  INTEGER NOT NULL,
      payout_msat   INTEGER NOT NULL,
      owed_msat     INTEGER NOT NULL,
      gateway_url   TEXT NOT NULL,
      gateway_pk    TEXT NOT NULL,
      expiration    INTEGER NOT NULL,
      txid          TEXT,
      out_idx       INTEGER,
      preimage      TEXT,
      state         TEXT NOT NULL,
      why           TEXT NOT NULL,
      planned_ms    INTEGER NOT NULL,
      updated_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_id, attempt)
    );

    -- A WALK-AWAY'S DONATION SENDS (RULED 2026-09-30, destination 1): the 25% of a walk-away's claimed lock sent to
    -- the round's donation set, one send per recipient, by the same Lightning-address send a winner is paid by. The
    -- winnings_sends columns, kept apart only because a recipient is no entry: entry_id here is the send's id,
    -- donationSendId(round, recipient index) (protocol/lock-settlement.js).
    CREATE TABLE IF NOT EXISTS donation_sends (
      entry_id      BLOB NOT NULL,
      attempt       INTEGER NOT NULL,
      round_id      BLOB NOT NULL,
      address       TEXT NOT NULL,
      invoice       TEXT NOT NULL,
      payment_hash  TEXT NOT NULL,
      invoice_msat  INTEGER NOT NULL,
      payout_msat   INTEGER NOT NULL,
      owed_msat     INTEGER NOT NULL,
      gateway_url   TEXT NOT NULL,
      gateway_pk    TEXT NOT NULL,
      expiration    INTEGER NOT NULL,
      txid          TEXT,
      out_idx       INTEGER,
      preimage      TEXT,
      state         TEXT NOT NULL,
      why           TEXT NOT NULL,
      planned_ms    INTEGER NOT NULL,
      updated_ms    INTEGER NOT NULL,
      PRIMARY KEY (entry_id, attempt)
    );

    CREATE TABLE IF NOT EXISTS held_final_ask (
      entry_id  BLOB PRIMARY KEY,
      round_id  BLOB NOT NULL,
      mark      BLOB NOT NULL,
      tick      INTEGER NOT NULL,
      held_ms   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payout_address (
      entry_id  BLOB PRIMARY KEY REFERENCES entries(entry_id),
      round_id  BLOB NOT NULL,
      address   TEXT NOT NULL,
      named_ms  INTEGER NOT NULL,
      signature BLOB                       -- the entry's session key over the address (kanban #1071): a seat short of the entry checks it
    );

    CREATE TABLE IF NOT EXISTS stake_seen_tick (
      entry_id  BLOB PRIMARY KEY REFERENCES entries(entry_id),
      tick      INTEGER NOT NULL,
      seen_ms   INTEGER NOT NULL
    );

    -- THE HTLC'S EXPIRY HEIGHT, the one fact Lightning supplies when a hold is
    -- first seen paid (M3.3-30). A hold still HELD once this node's own chain
    -- is past it has gone back to its player, and the row says EXPIRED - the
    -- node's own arithmetic, never Lightning's later label. A table of its own
    -- so a store written before it gains it.
    CREATE TABLE IF NOT EXISTS hold_expiry (
      entry_id      BLOB PRIMARY KEY REFERENCES entries(entry_id),
      expiry_height INTEGER NOT NULL,
      seen_ms       INTEGER NOT NULL
    );

    -- WHEN AN INVOICE NOBODY PAYS RUNS OUT (M3.3-30): the moment this node
    -- issued it plus the expiry it asked Lightning for. Its own number, never
    -- read back; an unpaid row still HELD past it is EXPIRED - nothing was ever
    -- sent. A table of its own so a store written before it gains it.
    CREATE TABLE IF NOT EXISTS invoice_expiry (
      entry_id    BLOB PRIMARY KEY REFERENCES entries(entry_id),
      expires_ms  INTEGER NOT NULL
    );

    -- WHAT A ROUND OWES AND WHETHER IT HAS BEEN PAID (9.4's qualifying tail).
    --
    -- One row per round, not per entry: the payout is ONE transaction spending
    -- ONE pool output, so PAYOUT_QUEUED and PAID are facts about the round.
    -- The state is written BEFORE the spend goes out, for the same reason
    -- SETTLE_REQUESTED is written before a settle - a node that died in between must find
    -- out what happened rather than assume nothing did.
    CREATE TABLE IF NOT EXISTS payouts (
      round_id   BLOB PRIMARY KEY,
      table_id   BLOB NOT NULL,
      state      TEXT NOT NULL,
      why        TEXT NOT NULL,
      txid       BLOB,
      raw        BLOB,
      updated_ms INTEGER NOT NULL,
      -- WHAT THE ROUND STILL OWES BECAUSE IT IS TOO SMALL TO SEND.
      --
      -- A payout row under the relay floor is not an output and is not a loss:
      -- the sats stay in the pool and the debt is written here, so a round is
      -- never quietly finished while somebody is short. Round-scoped on
      -- purpose - a balance that accumulates ACROSS rounds is a policy this
      -- schema does not invent.
      owed_sats  INTEGER NOT NULL DEFAULT 0,
      owed_count INTEGER NOT NULL DEFAULT 0
    );

    -- THIS SIGNER NODE'S NONCE PAIR FOR A ROUND'S SPEND, AND IT OUTLIVES THE PROCESS.
    --
    -- It lived in a Map on PoolSigning and died with the daemon, and letter
    -- 19 measured what that costs: a second asker after a restart got FRESH
    -- nonces from all five signer nodes, a new signature, and a different txid over
    -- the same input - a conflicting spend of the pool. Before the restart the
    -- same asker got the same commitments back and rebuilt the IDENTICAL
    -- transaction, which is harmless. The difference was only the memory.
    --
    -- So it is on disk, one row per round, keyed by the round: this node holds
    -- one signer node, and a signer node is one signature. signer_node_id is stored beside it so
    -- a store that somehow met a different share refuses rather than signing
    -- with a pair that is not its own.
    --
    -- hiding and binding are the SECRET scalars and are cleared the moment
    -- the pair is used - spent_share is what a retry gets after that, which
    -- is enough to answer twice and not enough to sign twice.
    CREATE TABLE IF NOT EXISTS pool_nonces (
      round_id       BLOB PRIMARY KEY,
      signer_node_id        TEXT NOT NULL,
      sighash        BLOB NOT NULL,
      hiding         BLOB,
      binding        BLOB,
      commit_hiding  BLOB NOT NULL,
      commit_binding BLOB NOT NULL,
      spent_list     BLOB,
      spent_share    BLOB,
      attempt        INTEGER NOT NULL DEFAULT 0,
      updated_ms     INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identity (
      one    INTEGER PRIMARY KEY CHECK (one = 0),
      secret BLOB NOT NULL,
      pubkey BLOB NOT NULL
    );

    -- THE COMMITTEE'S OWN KEY, MADE WITHOUT A DEALER (M3.3 item 14).
    --
    -- One row per EPOCH, and an epoch is the set of signer nodes: the owner's rule is
    -- that a DKG runs once per committee and not once per round, because the
    -- pool is one P2TR output across rounds and a per-round key would mint a
    -- new address every round. The same signer nodes keep the same key until the
    -- committee changes, and a changed committee is a different epoch_id.
    --
    -- WHAT IS KEPT AND WHY. mine is this signer node's own contribution, bytes and
    -- all: a restart must serve the SAME deal to a peer that has already seen
    -- it, because re-dealing would publish a second polynomial under a second
    -- id and the signer nodes that combined the first would be holding shares of a
    -- key nobody else has. share is this signer node's share of the group secret -
    -- the sum of what it was dealt, normalised - and it is the one secret in
    -- this table; it is written only when every signer node has contributed.
    -- group_pubkey is public and is stored beside it so a signer node can answer
    -- what the committee's key is without redoing the sum.
    CREATE TABLE IF NOT EXISTS dkg_epochs (
      epoch_id     BLOB PRIMARY KEY,
      signer_nodes        BLOB NOT NULL,      -- the committee, 32 bytes each, sorted
      mine         BLOB,               -- this signer_node's own encoded contribution
      share        BLOB,               -- 32 bytes, this signer_node's share of the secret
      signer_node_no      INTEGER,            -- its x on the polynomial, 1..n
      group_pubkey BLOB,               -- 33 bytes, compressed and even-y
      negated      INTEGER NOT NULL DEFAULT 0,
      updated_ms   INTEGER NOT NULL
    );

    -- The contributions this node has ACCEPTED, one per dealer per epoch.
    --
    -- Keyed by (epoch, dealer) so a signer node that deals twice is one row and not
    -- two: dealing again after seeing everybody else's commitments is how a
    -- signer node would steer the group key, and the primary key is the whole of the
    -- mechanism that stops it.
    CREATE TABLE IF NOT EXISTS dkg_contributions (
      epoch_id   BLOB NOT NULL,
      dealer     BLOB NOT NULL,
      bytes      BLOB NOT NULL,
      accepted_ms INTEGER NOT NULL,
      PRIMARY KEY (epoch_id, dealer)
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

    -- WHAT WENT ON THE BED, and it is an input like the strikes above.
    --
    -- How hard the war hunts a truck is decided by its load, and until letter
    -- 40 that number was written straight into the page's own core and stored
    -- NOWHERE - so this node replayed every run at heat zero and drew every
    -- ghost from it. Sparse for the same reason and keyed the same way: a
    -- load is declared at roll-out and rarely again, and a repeat must not
    -- become a second declaration.
    CREATE TABLE IF NOT EXISTS loads (
      round_id  BLOB NOT NULL,
      entry_id  BLOB NOT NULL REFERENCES entries(entry_id),
      tick      INTEGER NOT NULL,
      fee_sats  INTEGER NOT NULL,
      btc_hund  INTEGER NOT NULL,
      room      INTEGER,
      PRIMARY KEY (round_id, entry_id, tick)
    );

    -- THE LIVE TAPE a run's page handed its core before any sample (batch.js): 64 prices, oldest first, little-endian i32.
    CREATE TABLE IF NOT EXISTS tapes (
      round_id  BLOB NOT NULL,
      entry_id  BLOB NOT NULL REFERENCES entries(entry_id),
      tick      INTEGER NOT NULL,
      prices    BLOB NOT NULL,
      PRIMARY KEY (round_id, entry_id, tick)
    );

    -- THE LIVE PRICE SAMPLES a run's page handed its core (batch.js), one at a tick: the tape the war was fought on.
    CREATE TABLE IF NOT EXISTS samples (
      round_id  BLOB NOT NULL,
      entry_id  BLOB NOT NULL REFERENCES entries(entry_id),
      tick      INTEGER NOT NULL,
      price     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, tick)
    );

    -- WHAT THIS NODE REPLAYED AND SIGNED, section 13's PlayerResult.
    --
    -- A node that signs a result and keeps it nowhere has told nobody: five
    -- of seven can only agree on results that can be handed over. Stored as
    -- the signed record - body then signature, the protocol's own 232-byte
    -- shape - so what is served is exactly what was signed rather than a
    -- re-encoding that might differ by a byte.
    --
    -- Keyed by the SIGNER as well as the run, because a node keeps the
    -- results of others beside its own and one signer node may hold only one.
    CREATE TABLE IF NOT EXISTS results (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL REFERENCES entries(entry_id),
      node_pubkey BLOB NOT NULL,
      result_id   BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, node_pubkey)
    );

    -- A SETTLEMENT SIGNER NODE'S WORD THAT IT POSTED A RUN'S TRANSCRIPT (P2, 13A),
    -- its own and the other signer nodes', one per signer node. A result is FINAL only once
    -- the round's threshold of these agree, and W opens when that was so here.
    CREATE TABLE IF NOT EXISTS postings (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      signer_node_pubkey BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, signer_node_pubkey)
    );

    -- A COMMITTEE SIGNER NODE'S RE-RUN OF A SUSPENDED RESULT (13A), its own and the
    -- other signer nodes', one per signer node: counted to 5 of 7, it replaces SUSPENDED.
    CREATE TABLE IF NOT EXISTS reruns (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      signer_node_pubkey BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, signer_node_pubkey)
    );

    -- A SLASH PROOF THIS NODE FILED (5A.3B step 1): REPLAY_CONTRADICTS against
    -- a signer node that signed a result the committee's re-run contradicted, with the
    -- signed result beside it. One per accused signer node per run.
    CREATE TABLE IF NOT EXISTS slash_proofs (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      proof_id    BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, node_pubkey)
    );
    -- AND THE PROOFS AGAINST AN AGREED RE-RUN'S SIGNERS (§13A, RULED 2026-09-24, slice C2c): their own table, one row
    -- per (round, entry, signer), so a node that signed both the first result and the re-run is filed against once
    -- in each and never collides with its first-result row. The bytes are the proof and the signed re-run beside it.
    CREATE TABLE IF NOT EXISTS rerun_slash_proofs (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      proof_id    BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, node_pubkey)
    );

    -- SLASH PROOFS AGAINST CONTRADICTED AUDITS (§13A.1, kanban #724, #725): one per (round, auditor), since one AUDIT vouched for
    -- every entry of the round and one bond pays for it; entry_id is the entry whose contradicted run the proof names. The bytes are
    -- the proof, the AUDIT and its signature, and the rows its results_hash is over.
    CREATE TABLE IF NOT EXISTS audit_slash_proofs (
      round_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      proof_id    BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, node_pubkey)
    );

    -- TWO DIFFERENT RESULTS ONE SIGNER NODE SIGNED ABOUT ONE RUN (5A.3 row 1, kanban #986): the results table keeps one per signer, so the second
    -- is kept here the moment it arrives, or it is gone. One row per (round, entry, node), as a proof is stored; proof_id and bytes are set
    -- when the proof is filed, which waits for the advertisement that names the bond. The bytes are the proof and both signed results.
    CREATE TABLE IF NOT EXISTS double_results (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      first       BLOB NOT NULL,
      second      BLOB NOT NULL,
      proof_id    BLOB,
      bytes       BLOB,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, node_pubkey)
    );

    -- A CENSUS THIS NODE DERIVED AND CHECKED AGAINST ITS ROUND'S OWN ROOT (OPEN-LIST-2140 item 4): a pure function of the
    -- chain below its height, so it is kept across a restart - a cold derivation held a starting seat's loop 2.7 s each.
    CREATE TABLE IF NOT EXISTS census_kept (
      key      TEXT PRIMARY KEY,
      body     TEXT NOT NULL,
      kept_ms  INTEGER NOT NULL
    );

    -- THE CENSUS KEY'S RUNS (5A.3B, kanban #972, census-key-store.js), beside the claim keys' tables and sharing nothing with them. A deal is the signed
    -- wire bytes, one per dealer per run, the first standing. census_key_held is this node's shares of a key that stands, the one secret here,
    -- and it is kept for as long as anything names the key. census_key_anchors and census_key_scan are what the forward scan of "ARN" 'K'
    -- found and how far it read (kanban #1041 answer 2): kept across restarts, and it has no lookback window.
    CREATE TABLE IF NOT EXISTS census_key_runs (
      run_id      BLOB PRIMARY KEY,
      epoch       INTEGER NOT NULL,
      state       TEXT NOT NULL,
      updated_ms  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS census_key_deals (
      run_id      BLOB NOT NULL,
      dealer      BLOB NOT NULL,
      wire        BLOB NOT NULL,
      accepted_ms INTEGER NOT NULL,
      PRIMARY KEY (run_id, dealer)
    );
    CREATE TABLE IF NOT EXISTS census_key_complaints (
      run_id  BLOB NOT NULL,
      dealer  BLOB NOT NULL,
      node    BLOB NOT NULL,
      bytes   BLOB NOT NULL,
      PRIMARY KEY (run_id, dealer, node)
    );
    CREATE TABLE IF NOT EXISTS census_key_statements (
      run_id     BLOB NOT NULL,
      node       BLOB NOT NULL,
      record_id  BLOB NOT NULL,
      signature  BLOB NOT NULL,
      PRIMARY KEY (run_id, node, record_id)
    );
    CREATE TABLE IF NOT EXISTS census_key_held (
      public_key   BLOB NOT NULL,
      epoch        INTEGER NOT NULL,
      run_id       BLOB NOT NULL,
      record       BLOB NOT NULL,
      negated      INTEGER NOT NULL,
      shares       TEXT NOT NULL,
      commitments  BLOB NOT NULL,
      updated_ms   INTEGER NOT NULL,
      PRIMARY KEY (public_key, epoch)
    );
    CREATE TABLE IF NOT EXISTS census_key_anchors (
      height      INTEGER NOT NULL,
      idx         INTEGER NOT NULL,
      block_hash  TEXT NOT NULL,
      txid        TEXT NOT NULL,
      record_id   BLOB NOT NULL,
      kind        TEXT NOT NULL,
      body        BLOB,
      stands      INTEGER NOT NULL,
      why         TEXT,
      PRIMARY KEY (height, idx)
    );
    CREATE TABLE IF NOT EXISTS census_key_scan (
      height  INTEGER PRIMARY KEY,
      hash    TEXT NOT NULL
    );

    -- A DONATION OUTPUT THIS SIGNER NODE VERIFIED (2026-10-03, FEDERATION.md "Donations in the federation"): a
    -- payout contract in the player's lock transaction paying one recipient key its share. One output is one entry's.
    -- Indexed by key: what a dev's client asks for (GET /donations?key=).
    CREATE TABLE IF NOT EXISTS donation_outputs (
      outpoint      TEXT PRIMARY KEY,
      entry_id      BLOB NOT NULL,
      round_id      BLOB NOT NULL,
      federation_id BLOB NOT NULL,
      recipient_pk  TEXT NOT NULL,
      amount_msat   TEXT NOT NULL,
      contract_id   TEXT NOT NULL,
      verified_ms   INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS donation_outputs_by_key ON donation_outputs (recipient_pk, verified_ms);

    -- THE BACKFILL (2026-10-07): a settlement recovered from the federation, passed over once for its donation-key outputs
    CREATE TABLE IF NOT EXISTS donation_backfill (
      round_id  BLOB PRIMARY KEY,
      indexed   INTEGER NOT NULL,
      why       TEXT,
      made_ms   INTEGER NOT NULL
    );
    -- AND HOW OFTEN IT COULD NOT REBUILD ONE: marked checked after BACKFILL_TRIES such passes
    CREATE TABLE IF NOT EXISTS donation_backfill_tries (
      round_id  BLOB PRIMARY KEY,
      tries     INTEGER NOT NULL,
      last_ms   INTEGER NOT NULL
    );

    -- AN ATTESTED ROUND'S OUTCOME (§0A.7a): every attestation that stood for the round when it came, by the
    -- id of what its attestors signed. One outcome is the round's result; two of different outcomes are the proof the
    -- attestors contradicted themselves (the round settles on neither). Never deleted.
    CREATE TABLE IF NOT EXISTS outcome_attestations (
      body_id      BLOB PRIMARY KEY,
      round_id     BLOB NOT NULL,
      outcome      INTEGER NOT NULL,
      observed_ms  INTEGER NOT NULL,
      bytes        BLOB NOT NULL,
      received_ms  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outcome_attestations_round ON outcome_attestations (round_id);

    -- A MARKET ON A GAME'S OUTCOME (feature 6, §0A.7d): what stands where an attestation would - the source round's
    -- RoundResult (its encoded bytes) with the source committee's BIP-340 signatures that made it stand (JSON [{ key,
    -- signature }] in hex) and the source round's contract as this seat verified it against its id, so any seat re-verifies
    -- the settlement from these bytes and the census. The outcome is the market outcome the result maps to, or 255 (0xff,
    -- GAME_MARKET_REFUND) for a VOID: a result the market refunds (Tick Tock FLAT), or - result_id 32 zero bytes, no result -
    -- a source round that can never fit the market (why says which). observed_ms: when the result was knowable, the source
    -- round's end. Kept once per (market round, result); two standing results of different outcomes are the committee
    -- contradicting itself, and the round settles on neither (attested.js outcomeStanding). Never deleted.
    CREATE TABLE IF NOT EXISTS game_outcomes (
      round_id        BLOB NOT NULL,
      result_id       BLOB NOT NULL,
      source_round_id BLOB NOT NULL,
      outcome         INTEGER NOT NULL,
      why             TEXT,
      result          BLOB NOT NULL,
      sigs            TEXT NOT NULL,
      source          BLOB NOT NULL,
      observed_ms     INTEGER NOT NULL,
      received_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, result_id)
    );

    -- A MARKET ROUND'S STATE (kanban #1151; attested.js MARKET_STATE, marketTransition): no row is OPEN; ATTESTED (one standing
    -- outcome inside its objection window, first_ms and final_at_ms fixed), then FINAL or VOID - TERMINAL, never changed
    -- after: the triggers below refuse any update or delete of a terminal row, and the node moves a row only by compare-and-set
    -- (round.js casMarketState). outcome is the outcome index, value a scalar market's signed value (decimal), reason a VOID's
    -- ('deadline', 'dispute', 'game'), at_ms when the state was reached on this seat's clock. A store made before this table
    -- has no rows: each round's state is derived once from its held evidence and persisted on its first read.
    CREATE TABLE IF NOT EXISTS market_states (
      round_id     BLOB PRIMARY KEY,
      state        TEXT NOT NULL CHECK (state IN ('ATTESTED', 'FINAL', 'VOID')),
      outcome      INTEGER,
      value        TEXT,
      observed_ms  INTEGER,
      first_ms     INTEGER,
      final_at_ms  INTEGER,
      reason       TEXT,
      why          TEXT,
      at_ms        INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS market_states_terminal_update BEFORE UPDATE ON market_states
      WHEN OLD.state IN ('FINAL', 'VOID') BEGIN SELECT RAISE(ABORT, 'a terminal market state is never changed'); END;
    CREATE TRIGGER IF NOT EXISTS market_states_terminal_delete BEFORE DELETE ON market_states
      WHEN OLD.state IN ('FINAL', 'VOID') BEGIN SELECT RAISE(ABORT, 'a terminal market state is never deleted'); END;

    -- A HEAD-TO-HEAD ENTRY'S REVEALED MOVE: the (move, salt) that hashed to the commitment its entry named,
    -- taken by this seat's door inside the reveal window or pulled from a peer at the round's close. One per entry; never
    -- deleted - it is what the round's results were decided from.
    -- THE MARKET ORDER BOOK (comment 1127). An ORDER is an entry with a limit price whose stake lock and fee lock
    -- this seat verified; received_ms is when it became tradable here (both locks verified), batch the batch it is in
    -- (NULL while it waits). Kept once by its entry id.
    CREATE TABLE IF NOT EXISTS market_orders (
      order_id    TEXT PRIMARY KEY,
      round_id    BLOB NOT NULL,
      body        TEXT NOT NULL,
      received_ms INTEGER NOT NULL,
      batch       INTEGER
    );
    CREATE INDEX IF NOT EXISTS market_orders_round ON market_orders (round_id, batch);
    -- A CANCEL OR A SELL of a market entry, signed by its session key: it takes effect only in a certified batch.
    CREATE TABLE IF NOT EXISTS market_book_events (
      event_id    TEXT PRIMARY KEY,
      round_id    BLOB NOT NULL,
      kind        TEXT NOT NULL,
      entry_id    TEXT NOT NULL,
      body        TEXT NOT NULL,
      received_ms INTEGER NOT NULL,
      batch       INTEGER
    );
    CREATE INDEX IF NOT EXISTS market_book_events_round ON market_book_events (round_id, batch);
    -- ONE BATCH THIS SEAT SIGNED OR WAS SHOWN CERTIFIED: its record (orders, cancels, sells, leader and its signature), its id,
    -- this seat's own signature (none if it only imported the certificate), and - once at least the threshold of the round's
    -- seats signed it - the certificate. Only a certified batch is in the book. One per (round, batch).
    CREATE TABLE IF NOT EXISTS market_batches (
      round_id    BLOB NOT NULL,
      k           INTEGER NOT NULL,
      batch_id    TEXT NOT NULL,
      record      TEXT NOT NULL,
      own_sig     TEXT,
      certificate TEXT,
      stored_ms   INTEGER NOT NULL,
      PRIMARY KEY (round_id, k)
    );
    -- the batches still waiting for their certificate, read on every order tick (kanban #576: a full scan of every batch, every 500 ms)
    CREATE INDEX IF NOT EXISTS market_batches_open ON market_batches (round_id) WHERE certificate IS NULL;
    -- A BATCH THIS SEAT DECLINED: it did not sign it and never will, so a leader can show the batch can no longer be certified.
    CREATE TABLE IF NOT EXISTS market_batch_declines (
      round_id    BLOB NOT NULL,
      k           INTEGER NOT NULL,
      PRIMARY KEY (round_id, k)
    );
    -- A BATCH SHOWN VOID (kanban #1150, order-batch.js BATCH.VOID): enough seats declined it that it can never be certified - for good.
    CREATE TABLE IF NOT EXISTS market_batch_voids (
      round_id    BLOB NOT NULL,
      k           INTEGER NOT NULL,
      PRIMARY KEY (round_id, k)
    );

    -- A MARKET ENTRY ITS PLAYER CANCELLED: signed with the entry's session key before the round's entry close,
    -- taken at this seat's door or pulled from a peer before settlement. One per entry; the entry is out of the round's table
    -- from then on, and its stake and fee locks come back at once by the return door.
    CREATE TABLE IF NOT EXISTS market_cancels (
      entry_id    BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      signature   BLOB NOT NULL,
      received_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS market_cancels_round ON market_cancels (round_id);

    -- A HEAD-TO-HEAD ENTRY'S IDENTITY: the player's identity key, signed by it over (round, entry, key) -
    -- what a score across rounds links its rounds by. Kept once per entry. And each round's match record as this seat
    -- counted and signed it: the two identities, their score, the round it continued.
    CREATE TABLE IF NOT EXISTS h2h_identities (
      entry_id    BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      identity    BLOB NOT NULL,
      sig         BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS h2h_identities_identity ON h2h_identities (identity);
    CREATE TABLE IF NOT EXISTS match_records (
      round_id    BLOB PRIMARY KEY,
      record      TEXT NOT NULL,
      sig         TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS head_to_head_reveals (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      move        INTEGER NOT NULL,
      salt        BLOB NOT NULL,
      received_ms INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id)
    );

    -- A STAKE LOCK THIS SIGNER NODE VERIFIED (23.1 step 5): the contract the player
    -- handed over, the federation's id for it, and where it sits.
    -- A STAKE LOCKED FOR A ROUND THIS SIGNER NODE REFUSES, AND NEVER ENTERED (§23.2 row REFUSEDAlice
    -- 2026-10-06): kept under the id of this node's own accepted handout for the round that the lock's image is A0 of, so
    -- the forfeit (asked by round and that id) returns it to the player at once.
    CREATE TABLE IF NOT EXISTS refused_locks (
      handout_id   BLOB PRIMARY KEY,
      round_id     BLOB NOT NULL,
      outpoint     TEXT NOT NULL,
      fields       TEXT NOT NULL,
      contract_id  TEXT NOT NULL,
      kept_ms      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stake_locks (
      entry_id     BLOB PRIMARY KEY,
      round_id     BLOB NOT NULL,
      outpoint     TEXT NOT NULL,
      fields       TEXT NOT NULL,
      contract_id  TEXT NOT NULL,
      verified_ms  INTEGER NOT NULL
    );

    -- A QUALIFIER'S STAKE LOCK, RELEASED (§23.2 row 1, W5b): the committee's
    -- forfeit signature over the lock's contract id, which only the lock's
    -- refund key can spend. The signer node's record that it released the stake.
    -- THE ROUND'S ONE SETTLEMENT OF ITS LOSERS' STAKE LOCKS (W4): the txid the
    -- signer nodes rebuilt, their combined claim_pk signature over it, and where it
    -- stands - SUBMITTING is written before the federation is asked, so a signer node
    -- that died there knows it signed.
    -- A FEE LOCK THIS SIGNER NODE VERIFIED (Pick A, §23.1 step 5, F5): the entry's 2%
    -- node fee locked to H(F), claimed for the sitting signer nodes in the round's one
    -- settlement with the F the entry hands over openly.
    CREATE TABLE IF NOT EXISTS fee_locks (
      entry_id     BLOB PRIMARY KEY,
      round_id     BLOB NOT NULL,
      outpoint     TEXT NOT NULL,
      fields       TEXT NOT NULL,
      contract_id  TEXT NOT NULL,
      verified_ms  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lock_settlements (
      round_id     BLOB PRIMARY KEY,
      txid         TEXT NOT NULL,
      message      BLOB NOT NULL,
      signature    BLOB NOT NULL,
      state        TEXT NOT NULL,
      why          TEXT NOT NULL,
      made_ms      INTEGER NOT NULL
    );

    -- A SERIES' PUBLICATION FEE, PROVEN (§5A.5publisher-payout.js): the first confirmed publication's txid and the
    -- fee its parents prove - paid back to the series' creator in the first of its rounds with entries.
    CREATE TABLE IF NOT EXISTS series_publications (
      series_id BLOB PRIMARY KEY,
      txid      TEXT NOT NULL,
      fee_sats  TEXT NOT NULL
    );

    -- A ROUND'S CREATOR SIGNATURE (§6): the BIP-340 signature by the key the contract names over its id, kept
    -- beside the round as the id is (a signature is never inside the bytes it signs), and served at GET /round-creator.
    CREATE TABLE IF NOT EXISTS round_creators (
      round_id  BLOB PRIMARY KEY,
      signature BLOB NOT NULL
    );

    -- THE ACKS A SEAT JOINED A SETTLEMENT'S SIGNING ON (§5A.3, kanban #1040), and the table they name, served by GET /settlement-acks.
    -- scope: empty for the round's own settlement, else a late entry's id or a federation's id in hex. Kept for every transaction acked,
    -- landed or not.
    CREATE TABLE IF NOT EXISTS settlement_acks (
      round_id BLOB NOT NULL,
      scope    TEXT NOT NULL,
      txid     TEXT NOT NULL,
      table_id BLOB NOT NULL,
      tbl      BLOB NOT NULL,
      acks     BLOB NOT NULL,
      made_ms  INTEGER NOT NULL,
      PRIMARY KEY (round_id, scope, txid)
    );

    -- A FALSE TABLE, FILED (§5A.3 table row, kanban #1040): one proof per seat that acked it. The bytes are the proof and all it stands on.
    CREATE TABLE IF NOT EXISTS table_slash_proofs (
      proof_id    BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS table_slash_proofs_round ON table_slash_proofs (round_id);

    -- A NAMED CLAIM'S OFFENCE, FILED (§5A.3 rows (a), (b), protocol 27, kanban #1044 B1): one proof per named signer, row 1 (a), 2 (b) or 3 (a) at level 2.
    CREATE TABLE IF NOT EXISTS named_claim_proofs (
      proof_id    BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      row         INTEGER NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS named_claim_proofs_round ON named_claim_proofs (round_id);
    -- WHERE A PROTOCOL-27 ROUND'S LOCKS CAN FIRST BE FUNDED, per federation (kanban #1044 B1): the federation's finished-session count read before
    -- the first lock of the round this seat verified - a named claim's proof carries the sessions from there. The first reading stays.
    CREATE TABLE IF NOT EXISTS funding_session_floors (
      round_id      BLOB NOT NULL,
      federation_id TEXT NOT NULL,
      floor         INTEGER NOT NULL,
      PRIMARY KEY (round_id, federation_id)
    );

    -- ROUNDS A SEAT WAS ASKED TO ACK OR COMMIT TO ANOTHER PAIR THAN IT REBUILT: read for a false table for 6 h, and only these, so no honest round costs a read.
    CREATE TABLE IF NOT EXISTS settlement_suspects (
      round_id BLOB PRIMARY KEY,
      seen_ms  INTEGER NOT NULL
    );

    -- A ROUND THAT TAKES ANY FEDERATION (2026.0.3) SETTLES ONE TRANSACTION PER FEDERATION (federation-settlement.js):
    -- one row per (round, federation), with the same intent and state as a round's own settlement row.
    CREATE TABLE IF NOT EXISTS fed_lock_settlements (
      round_id      BLOB NOT NULL,
      federation_id TEXT NOT NULL,
      txid          TEXT NOT NULL,
      message       BLOB NOT NULL,
      signature     BLOB NOT NULL,
      state         TEXT NOT NULL,
      why           TEXT NOT NULL,
      made_ms       INTEGER NOT NULL,
      PRIMARY KEY (round_id, federation_id)
    );

    -- THE FEDERATIONS A ROUND'S SPLIT NAMES, KEPT BEFORE ANYTHING IS SIGNED (kanban #1576): a federation gets its fed_lock_settlements row only at its
    -- first SUBMITTING, so one whose part failed before that (its port down, fewer than the threshold committed, a share withheld) had no row,
    -- and the round read settled on the other federations' ACCEPTED rows alone. A round is settled only when every federation named here is ACCEPTED.
    CREATE TABLE IF NOT EXISTS fed_lock_split (
      round_id      BLOB NOT NULL,
      federation_id TEXT NOT NULL,
      PRIMARY KEY (round_id, federation_id)
    );

    -- WHAT THE SIGNED SETTLEMENT MOVES (W6): its claimed outpoints and how many
    -- payout contracts it makes, kept with its intent - so a signer node restarted inside
    -- it asks the federation without rebuilding the bytes it signed.
    CREATE TABLE IF NOT EXISTS lock_settlement_moves (
      round_id     BLOB PRIMARY KEY,
      txid         TEXT NOT NULL,
      claims       TEXT NOT NULL,
      payouts      INTEGER NOT NULL
    );
    -- A LOSER'S STAKE LOCK READ GONE AT THE FEDERATION (kanban #1183, ruling #1146 A): F' leaves its entry out as refunded. Kept, so a seat restarted
    -- after the read builds F' again instead of F (it built F after every restart, its peers on F', neither reaching 5); one row per lock, never removed:
    -- a spent lock does not come back
    -- EVERY SETTLEMENT TXID THIS SEAT SIGNED OR WAS HANDED FOR A ROUND (kanban #1171): F and F' are two transactions; only one lands. Each with what it
    -- moves, so the federation is asked about every one of them before the round's row says REFUSED, and a landed one is found after a restart
    CREATE TABLE IF NOT EXISTS lock_settlement_txids (
      round_id     BLOB NOT NULL,
      txid         TEXT NOT NULL,
      message      BLOB NOT NULL,
      signature    BLOB NOT NULL,
      claims       TEXT NOT NULL,
      payouts      INTEGER NOT NULL,
      made_ms      INTEGER NOT NULL,
      PRIMARY KEY (round_id, txid)
    );
    CREATE TABLE IF NOT EXISTS gone_stakes (
      round_id     BLOB NOT NULL,
      outpoint     TEXT NOT NULL,
      why          TEXT NOT NULL,
      made_ms      INTEGER NOT NULL,
      PRIMARY KEY (round_id, outpoint)
    );
    -- A LATE LOSER'S SECOND SETTLEMENT (§13A, RULED 2026-09-24, slice C3b-1): one per (round, entry), never a second
    -- row under the round's key - an entry the round's settlement left out while it was in its re-run window, which
    -- then ended FAILED or FORFEIT. The same intent and state as the round's own settlement row.
    -- A PROTOCOL-27 SETTLEMENT'S BATCH (kanban #1044 B1, rulings #1134 2, #1135): per (round, scope) - '' the round's own, a late entry's hex, a
    -- federation's hex - the body the seats acked, the real txid, the signer set S and every signature the batch made (the claim, each send's auth,
    -- each qualifier's presigned refund (c)), with what each signed. Every seat keeps it; a qualifier's client gets its refund (c) from any seat.
    CREATE TABLE IF NOT EXISTS named_batches (
      round_id   BLOB NOT NULL,
      scope      TEXT NOT NULL,
      body_id    TEXT NOT NULL,
      txid       TEXT NOT NULL,
      signers    TEXT NOT NULL,
      signatures TEXT NOT NULL,
      slots      TEXT NOT NULL,
      made_ms    INTEGER NOT NULL,
      PRIMARY KEY (round_id, scope)
    );
    -- EVERY BATCH OF A SCOPE, BY ITS TXID (kanban #1170): two signer sets over one body are two txids, both valid. Kept once each, never replaced;
    -- named_batches holds the one the scope's row stands on, and a batch of another txid never takes its place while the row is SUBMITTING or
    -- ACCEPTED on it.
    CREATE TABLE IF NOT EXISTS named_batch_txids (
      round_id   BLOB NOT NULL,
      scope      TEXT NOT NULL,
      txid       TEXT NOT NULL,
      body_id    TEXT NOT NULL,
      signers    TEXT NOT NULL,
      signatures TEXT NOT NULL,
      slots      TEXT NOT NULL,
      made_ms    INTEGER NOT NULL,
      PRIMARY KEY (round_id, scope, txid)
    );
    -- EVERY TXID OF A FEDERATION'S OR A LATE ENTRY'S SETTLEMENT (kanban #1172), as lock_settlement_txids is the round's own: scope 'fed:<hex>' or
    -- 'late:<hex>', what each moves, so the federation is asked about every one before a row is REFUSED.
    CREATE TABLE IF NOT EXISTS scoped_settlement_txids (
      round_id     BLOB NOT NULL,
      scope        TEXT NOT NULL,
      txid         TEXT NOT NULL,
      message      BLOB NOT NULL,
      signature    BLOB NOT NULL,
      claims       TEXT NOT NULL,
      payouts      INTEGER NOT NULL,
      made_ms      INTEGER NOT NULL,
      PRIMARY KEY (round_id, scope, txid)
    );
    -- AN OBJECTION BEING CHECKED (kanban #1173): written at its arrival, before its replay runs, and gone once the check answered. While one that
    -- arrived before final_after stands, this seat holds the entry SUSPENDED: no FINAL signature, no P, no ack.
    CREATE TABLE IF NOT EXISTS pending_objections (
      round_id   BLOB NOT NULL,
      entry_id   BLOB NOT NULL,
      arrived_ms INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, arrived_ms)
    );
    -- AN ENTRY FINAL AT THIS SEAT (kanban #1173): kept once reached, never undone - the run it is FINAL on, the final_after it was FINAL past, and
    -- whether that run is an agreed re-run. An objection that reaches this seat afterwards is evidence, never a suspension.
    CREATE TABLE IF NOT EXISTS entry_finals (
      round_id       BLOB NOT NULL,
      entry_id       BLOB NOT NULL,
      run_id         TEXT NOT NULL,
      final_after_ms INTEGER NOT NULL,
      on_rerun       INTEGER NOT NULL,
      at_ms          INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id)
    );
    CREATE TABLE IF NOT EXISTS late_lock_settlements (
      round_id  BLOB NOT NULL,
      entry_id  BLOB NOT NULL,
      txid      TEXT NOT NULL,
      message   BLOB NOT NULL,
      signature BLOB NOT NULL,
      state     TEXT NOT NULL,
      why       TEXT,
      made_ms   INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id)
    );
    -- A LATE SETTLEMENT'S SENDS (§13A, RULED 2026-09-24, slice C3b-2a): the winnings_sends rows of one late
    -- (round, entry), in a table of their own, so a winner's late send and its first-round send never share a key -
    -- a first-round PAID row is never overwritten or re-sent by a late one.
    CREATE TABLE IF NOT EXISTS late_winnings_sends (
      round_id      BLOB NOT NULL,
      late_entry_id BLOB NOT NULL,
      entry_id      BLOB NOT NULL,
      attempt       INTEGER NOT NULL,
      address       TEXT NOT NULL,
      invoice       TEXT NOT NULL,
      payment_hash  TEXT NOT NULL,
      invoice_msat  INTEGER NOT NULL,
      payout_msat   INTEGER NOT NULL,
      owed_msat     INTEGER NOT NULL,
      gateway_url   TEXT NOT NULL,
      gateway_pk    TEXT NOT NULL,
      expiration    INTEGER NOT NULL,
      txid          TEXT,
      out_idx       INTEGER,
      preimage      TEXT,
      state         TEXT NOT NULL,
      why           TEXT NOT NULL,
      planned_ms    INTEGER NOT NULL,
      updated_ms    INTEGER NOT NULL,
      PRIMARY KEY (round_id, late_entry_id, entry_id, attempt)
    );
    -- AND THE SHARES IT IS SPLIT BY: what the round's settlement paid each winner, in the table's order (JSON), kept
    -- when that settlement is signed, so a late loser's stake is split the same way at every signer node, restart or not.
    CREATE TABLE IF NOT EXISTS lock_settlement_shares (
      round_id BLOB PRIMARY KEY,
      shares   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS forfeits (
      entry_id     BLOB PRIMARY KEY,
      round_id     BLOB NOT NULL,
      message      BLOB NOT NULL,
      signature    BLOB NOT NULL,
      claim_pk     BLOB NOT NULL,
      made_ms      INTEGER NOT NULL
    );

    -- WHEN A CLOSED LOCK ROUND NOBODY SETTLED IS ASKED AGAIN (kanban #1186), per (round, scope) - scope '' the round's own settlement: its tries and the
    -- chain height before which it is not asked again, kept across restarts, and a terminal state: SETTLED (ACCEPTED here) or EXPIRED (every stake
    -- lock of the round past its expiration: nothing can be claimed any more, each lock returns to its player). Moved only by settle-retry.js.
    CREATE TABLE IF NOT EXISTS settle_retries (
      round_id        BLOB NOT NULL,
      scope           TEXT NOT NULL,
      state           TEXT NOT NULL,
      tries           INTEGER NOT NULL,
      next_at_height  INTEGER,
      why             TEXT NOT NULL,
      updated_ms      INTEGER NOT NULL,
      PRIMARY KEY (round_id, scope)
    );

    -- WHAT THIS SEAT COMMITTED A LOCK TO (kanban #1184): CLAIMING once it acked, shared, was handed or kept a settlement that claims the
    -- outpoint; RETURNING once it gave a share of, took or kept a forfeit of it. Written once (compare-and-set: INSERT OR IGNORE, then read
    -- back), before the ack, share or forfeit leaves this seat; a lock is never both - two valid spends of one lock, the faster wins.
    CREATE TABLE IF NOT EXISTS lock_fates (
      outpoint  TEXT PRIMARY KEY,
      round_id  BLOB NOT NULL,
      state     TEXT NOT NULL,
      txid      TEXT,
      why       TEXT NOT NULL,
      made_ms   INTEGER NOT NULL
    );

    -- AN ENTRY THIS SIGNER NODE HOLDS FORFEIT FOR A LATE START (§15, §13C): its first
    -- mark, signed by the player, names a tick after join_tick + the round's
    -- start deadline - the player's own act, not an outage and not a refund.
    -- The mark is the evidence and is kept whole; it was refused, not
    -- receipted. Not a PlayerResult: nothing was played. No mark, no row. The
    -- lock is claimed only by W4's settlement; until then it refunds at expiry.
    CREATE TABLE IF NOT EXISTS start_forfeits (
      entry_id    BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      mark_tick   INTEGER NOT NULL,
      last_tick   INTEGER NOT NULL,
      mark        BLOB NOT NULL,
      why         TEXT NOT NULL,
      decided_ms  INTEGER NOT NULL
    );

    -- WHAT EACH OTHER SIGNER NODE ANSWERED when this signer node offered it the player's
    -- on-time first mark (§16's evidence): receipted, unanswered, late, refused.
    -- A receipted answer is never written over.
    CREATE TABLE IF NOT EXISTS first_mark_offers (
      entry_id  BLOB NOT NULL,
      peer      TEXT NOT NULL,
      answer    TEXT NOT NULL,
      at_ms     INTEGER NOT NULL,
      PRIMARY KEY (entry_id, peer)
    );

    -- AN ENTRY THIS SIGNER NODE HOLDS ENTRY_VOID (§16, the outage refund): an on-time
    -- first mark that, when the start deadline passed, had fewer than the
    -- threshold's receipts, the signer nodes it was short of offered it and silent.
    -- The first mark and the evidence the deadline passed - the player's own
    -- signed mark past the line, or this round closed - are kept whole. Its
    -- lock is forfeited at once to the player's refund key (§23.2).
    CREATE TABLE IF NOT EXISTS entry_voids (
      entry_id       BLOB PRIMARY KEY,
      round_id       BLOB NOT NULL,
      first_mark     BLOB NOT NULL,
      evidence_kind  TEXT NOT NULL,
      evidence       BLOB,
      why            TEXT NOT NULL,
      decided_ms     INTEGER NOT NULL,
      learned        TEXT NOT NULL DEFAULT 'own'
    );

    -- A FIRST MARK THIS SIGNER NODE, UP, REFUSED (M3.3-34, one-signer node refusal): the
    -- player's own signed, on-time first mark of an entry joined here, refused
    -- when another signer node handed it on (the stake not seen here, or the mark not
    -- taken), while this signer node holds no first mark of that entry. What lets this
    -- signer node reach §13C's VOID from its own store, as the signer node that took it does.
    CREATE TABLE IF NOT EXISTS refused_first_marks (
      entry_id    BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      mark        BLOB NOT NULL,
      why         TEXT NOT NULL,
      at_ms       INTEGER NOT NULL
    );

    -- HOW THIS SEAT'S LAST SETTLEMENT PASS OF A ROUND STOPPED (§5A.3 "Stalled in its rounds", protocol 26, kanban #1052): the step it stopped at and the seats that gave it no
    -- signed word at that step. Only a seat that asked knows, and each seat asks in its turn. One row per round and federation; a pass that goes on replaces it.
    CREATE TABLE IF NOT EXISTS settle_passes (
      round_id    BLOB NOT NULL,
      scope       TEXT NOT NULL,
      step        TEXT NOT NULL,
      silent      TEXT NOT NULL,
      made_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, scope)
    );

    -- §13C'S NO-QUORUM OUTCOME, decided here once the result window passed with
    -- no result at the threshold: VOID (the operator side's fault - nothing is
    -- signed or moved, the lock returns at its expiry) or FORFEIT (proven
    -- player equivocation). Reachable only from PROVISIONAL (§14).
    CREATE TABLE IF NOT EXISTS no_quorum (
      entry_id    BLOB PRIMARY KEY,
      round_id    BLOB NOT NULL,
      outcome     TEXT NOT NULL,
      why         TEXT NOT NULL,
      decided_ms  INTEGER NOT NULL
    );

    -- WHAT A JOINED PLAYER CHOSE TO BE CALLED IN A ROUND (M3.3-34): the record
    -- as the player signed it with the round key it is joined under
    -- (lobby-name.js), kept to be shown to the other players. Nothing replays
    -- it and nothing is paid on it. A player's newest record wins.
    CREATE TABLE IF NOT EXISTS lobby_names (
      round_id       BLOB NOT NULL,
      player_pubkey  BLOB NOT NULL,
      record         BLOB NOT NULL,
      signature      BLOB NOT NULL,
      at_ms          INTEGER NOT NULL,
      PRIMARY KEY (round_id, player_pubkey)
    );

    -- WHERE THIS SIGNER NODE'S CLOSE OF A RUN STANDS, when it could not sign it at its
    -- close (M3.3-34): HOLDING while a peer that matters is unreachable and the
    -- close is tried again, SIGNED once it was. Kept here, beside everything
    -- else this signer node must not forget across a restart.
    CREATE TABLE IF NOT EXISTS close_holds (
      round_id   BLOB NOT NULL,
      entry_id   BLOB NOT NULL,
      state      TEXT NOT NULL,
      attempts   INTEGER NOT NULL,
      since_ms   INTEGER NOT NULL,
      last_why   TEXT,
      signed_ms  INTEGER,
      PRIMARY KEY (round_id, entry_id)
    );

    -- THE BEACON THIS SIGNER NODE'S CHAIN NAMED FOR A ROUND (M3.3-34): the block, its
    -- height and time. A held close is retried after a restart, and a retry
    -- replays from this beacon; a chain reader that keeps its answers in memory
    -- has none for a round it has not read again.
    CREATE TABLE IF NOT EXISTS round_beacons (
      round_id   BLOB PRIMARY KEY,
      hash       BLOB NOT NULL,
      height     INTEGER NOT NULL,
      time_ms    INTEGER NOT NULL
    );

    -- WHAT THIS NODE KEEPS AS A RELAY: transcripts by their own hash, so any
    -- node can be one of a contract's publication_relays[] and serve nothing
    -- under a name its bytes do not have.
    CREATE TABLE IF NOT EXISTS relayed (
      hash     BLOB PRIMARY KEY,
      bytes    BLOB NOT NULL,
      seen_ms  INTEGER NOT NULL
    );

    -- AN OBJECTION AGAINST A RUN, 13A. Only what the pool needs to know that
    -- one exists: the run it is against and when it arrived. The objection
    -- PROTOCOL - who may file, what it costs, how it is settled - is not here
    -- and is not invented here; this is the intake, so the queue that already
    -- puts objections first can have something in it on a running daemon.
    CREATE TABLE IF NOT EXISTS objections (
      round_id BLOB NOT NULL,
      entry_id BLOB NOT NULL REFERENCES entries(entry_id),
      seen_ms  INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id)
    );

    -- §13C'S EVIDENCE NAMES ITS BLOCK (RULED 2026-09-24): for each player mark this node holds as evidence - a
    -- checkpoint, a refused or offered mark, a pair's mark, a late start, the Void's first mark, a refused first mark -
    -- the block of each record of it: this node's tip when it recorded it, or the block a peer named for its own record.
    -- The mark is placed at the earliest of them; it counts when that is strictly before the window's end block.
    CREATE TABLE IF NOT EXISTS evidence_blocks (
      entry_id   BLOB NOT NULL,
      mark_id    BLOB NOT NULL,
      block_hash BLOB NOT NULL,
      PRIMARY KEY (entry_id, mark_id, block_hash)
    );

    -- AND THE ONE OBJECTION AGAINST AN AGREED RE-RUN (§13A, RULED 2026-09-24, slice C2b): the same shape as the
    -- first, one per entry - a second valid objection voids the entry, and there is no third run to object to.
    CREATE TABLE IF NOT EXISTS rerun_objections (
      round_id BLOB NOT NULL,
      entry_id BLOB NOT NULL REFERENCES entries(entry_id),
      seen_ms  INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id)
    );

    -- THE SEATS' FINAL SIGNATURES (§13A, WINDOW-10-SPEC, 2026-10-01): one per seat per run, the latest that counted
    -- on arrival (signed within 5 s of this seat's clock when it came), with when it came. The run is FINAL at the
    -- round's threshold of them.
    CREATE TABLE IF NOT EXISTS final_sigs (
      round_id      BLOB NOT NULL,
      entry_id      BLOB NOT NULL,
      run_id        BLOB NOT NULL,
      signer_pubkey BLOB NOT NULL,
      bytes         BLOB NOT NULL,
      seen_ms       INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, run_id, signer_pubkey)
    );
    -- THE ROUND'S SEATED SIGNER NODES' ADDRESSES, KEPT AT SEATING TIME (kanban #735, measured 2026-10-27: seat 1 was restarted
    -- inside round 2927d830's objection window and for ~15 min read no chain view for the round - its roster could not say who was
    -- bonded - so it gathered no FINAL signature from its peers). The certificate names the seated set; each seated node's
    -- endpoint, off the census advert the seat held then, is written here per role, so the round's peers are found without a
    -- chain view. A seating record (transcript-prune.js COMMITTEE_TABLES): it marks no round used.
    CREATE TABLE IF NOT EXISTS round_peers (
      round_id BLOB NOT NULL,
      role     TEXT NOT NULL,
      node     TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      PRIMARY KEY (round_id, role, node)
    );
    -- AND THE ONES THAT DID NOT COUNT BECAUSE OF THEIR TIME (§13A rule 3): "A back-dated or forward-dated signature does
    -- not count and is itself evidence against its signer." Kept as they came, with why.
    CREATE TABLE IF NOT EXISTS final_sig_evidence (
      round_id      BLOB NOT NULL,
      entry_id      BLOB NOT NULL,
      signer_pubkey BLOB NOT NULL,
      bytes         BLOB NOT NULL,
      seen_ms       INTEGER NOT NULL,
      why           TEXT NOT NULL,
      PRIMARY KEY (round_id, entry_id, signer_pubkey, bytes)
    );
  `);
  // A STORE MADE BEFORE A NONCE ROW CARRIED ITS SIGNING ATTEMPT gets the column:
  // every row it already holds was attempt 0.
  if (!db.prepare('PRAGMA table_info(pool_nonces)').all().some((c) => c.name === 'attempt'))
    db.exec('ALTER TABLE pool_nonces ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
  // AN OBJECTION NAMES ITS BLOCK (§13A, RULED 2026-09-24): the window places it by that block, not by when it came.
  // A store made before the ruling gets the column; a row there names none, and counts nowhere.
  // THE ROOM A LOAD FILLS (2026-10-04 08:54: the cargo factor C is the bed fill, crossing with the load): a store
  // made before it gets the column; a row there carries none, and replays at the 0.7 every run had.
  // EACH BATCH'S SIGNATURE BESIDE IT (kanban #1567, feedback #013 by Hexbox Tools): the player's own session-key signature
  // over the batch's id, kept so GET /batch-signatures can hand a reloaded page proof of which batches it signed. A store
  // from before gets the column; its rows carry none.
  if (!db.prepare('PRAGMA table_info(batches)').all().some((c) => c.name === 'signature'))
    db.exec('ALTER TABLE batches ADD COLUMN signature BLOB');
  if (!db.prepare('PRAGMA table_info(loads)').all().some((c) => c.name === 'room'))
    db.exec('ALTER TABLE loads ADD COLUMN room INTEGER');
  // THE IDENTITY'S CONSENT BESIDE A NAME RECORD (kanban #1278, RULED #1276): the identity key over (round id, round key), checked at the door; a row from
  // before carries none, and books its round to nobody
  if (!db.prepare('PRAGMA table_info(lobby_names)').all().some((c) => c.name === 'identity_sig'))
    db.exec('ALTER TABLE lobby_names ADD COLUMN identity_sig BLOB');
  for (const t of ['objections', 'rerun_objections'])
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'block_hash'))
      db.exec(`ALTER TABLE ${t} ADD COLUMN block_hash BLOB`);
  // AN OBJECTION CARRIES ITS TRANSCRIPT AND RECEIPTS (§13ARULED 2026-10-04): the bundle a seat checked
  // at its door is kept with the row. A row from before carries none, and holds only on this seat's own replay, as it did.
  for (const t of ['objections', 'rerun_objections'])
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'bundle'))
      db.exec(`ALTER TABLE ${t} ADD COLUMN bundle BLOB`);
  // A FORK PAIR SAYS WHETHER BOTH ITS MARKS WERE RECEIPTED BY A SEAT (§13BRULED 2026-10-05 (b)): a
  // same-parent pair forfeits only then. A row from before counts as not receipted.
  if (!db.prepare('PRAGMA table_info(fork_pairs)').all().some((c) => c.name === 'receipted'))
    db.exec('ALTER TABLE fork_pairs ADD COLUMN receipted INTEGER NOT NULL DEFAULT 0');
  // A DONATION OUTPUT SAYS WHETHER THE SENDER'S KEY IS ON ITS CONTRACT (2026-10-05): 1 when its payment
  // image is the entry's player key. A row from before carries the zero image.
  if (!db.prepare('PRAGMA table_info(donation_outputs)').all().some((c) => c.name === 'sender_on_contract'))
    db.exec('ALTER TABLE donation_outputs ADD COLUMN sender_on_contract INTEGER NOT NULL DEFAULT 0');
  // AND THAT KEY ITSELF FOR A ROW TAKEN FROM ANOTHER SEAT: a reserve row learned from a peer has no entry
  // stored here to read the player key from, so the image the federation's contract carries is kept beside it
  if (!db.prepare('PRAGMA table_info(donation_outputs)').all().some((c) => c.name === 'image'))
    db.exec('ALTER TABLE donation_outputs ADD COLUMN image TEXT');
  // AND WHAT IT PAID FOR WHEN IT IS NO ROUND'S ENTRY: an item purchase's reserve output, "game · item id"
  if (!db.prepare('PRAGMA table_info(donation_outputs)').all().some((c) => c.name === 'item'))
    db.exec('ALTER TABLE donation_outputs ADD COLUMN item TEXT');
  // AND A MARKET DONATION'S PARTS (kanban #580): each filled order's entry, player key and fee, as JSON - a market pays its donation once per
  // round out of every order's fee, so the row itself names no one player
  if (!db.prepare('PRAGMA table_info(donation_outputs)').all().some((c) => c.name === 'parts'))
    db.exec('ALTER TABLE donation_outputs ADD COLUMN parts TEXT');
  // A PEER'S ANSWER TO AN OFFERED FIRST MARK NAMES ITS BLOCK (§13C, RULED 2026-09-24): this node's tip when it recorded
  // the answer. A store made before the ruling gets the column; a row there names none, and its refusal counts nowhere.
  if (!db.prepare('PRAGMA table_info(first_mark_offers)').all().some((c) => c.name === 'block_hash'))
    db.exec('ALTER TABLE first_mark_offers ADD COLUMN block_hash BLOB');
  // §13C'S EVIDENCE COUNTS BY WHEN THIS SEAT HELD IT (§13A, WINDOW-10-SPEC, RULED 2026-10-01): a record of a mark
  // keeps the moment it was made here, and counts in a decision only if it was held before the decision's instant. A row
  // from before the column counts as held from the start.
  if (!db.prepare('PRAGMA table_info(evidence_blocks)').all().some((c) => c.name === 'seen_ms'))
    db.exec('ALTER TABLE evidence_blocks ADD COLUMN seen_ms INTEGER');
  // AND BEFORE AN ENTRY_VOID SAID HOW THIS SIGNER NODE LEARNED IT (M3.3-34): every row
  // it already holds was decided on its own record.
  if (!db.prepare('PRAGMA table_info(entry_voids)').all().some((c) => c.name === 'learned'))
    db.exec("ALTER TABLE entry_voids ADD COLUMN learned TEXT NOT NULL DEFAULT 'own'");
  // AND THE SIGNATURE OVER A NAMED ADDRESS (kanban #1071): a store from before keeps its rows, which cannot be handed on
  if (!db.prepare('PRAGMA table_info(payout_address)').all().some((c) => c.name === 'signature'))
    db.exec('ALTER TABLE payout_address ADD COLUMN signature BLOB');
  // AND THE SIGNERS A PROTOCOL-27 FORFEIT NAMES (kanban #1044 B1, ruling #1131 3): a row from before is a FROST forfeit and names none
  if (!db.prepare('PRAGMA table_info(forfeits)').all().some((c) => c.name === 'signers'))
    db.exec('ALTER TABLE forfeits ADD COLUMN signers TEXT');
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
/**
 * ONE KEY, AND IT IS THE BOND KEY.
 *
 * This was an ed25519 key, and that made the node's identity a different
 * ANIMAL from its census entry: 5A.3B derives a bond output from `node_pubkey`
 * on secp256k1, so an ed25519 identity could never be the key a bond is posted
 * under. Measured before this changed: of 500 fresh ed25519 identities, 235
 * happened to be valid secp x-only points and the node held the secp secret
 * for NONE of them. So "the committee is the assigned census" was not a rule
 * anybody could satisfy - the trusted list and the assigned list could not
 * contain the same bytes.
 *
 * It is one key now: x-only secp256k1, the key a bond is built from, the key
 * an advertisement is signed with, and the key a receipt is signed with -
 * BIP-340 throughout.
 *
 * A NODE THAT ALREADY HAS A SECRET KEEPS IT. The pubkey column is recomputed
 * from it, so an existing daemon changes IDENTITY - its old ed25519 key names
 * nobody now - rather than losing its file. That is a rotation and it is
 * written down in TASKBOOK: receipts issued under the old key verify under
 * nothing, which is the honest consequence of the two key spaces having been
 * wrong to begin with.
 */
/**
 * THE NODE IDENTITY FROM THE OWNER'S SEED (kanban #650/#653, 2026-10-25: "the node identity (without nostr) needs to be tied to the
 * seed"): the installer hands the key its seed gives (arena-installer/src/seed.js nodeKeyOf) before the node's first start, so the same
 * 24 words - or the same nsec - restore the same node, its bond included. A node that has an identity keeps it: answers whether `secret`
 * is now this node's key.
 */
export function adoptIdentity(db, secret) {
  const pubkey = schnorr.getPublicKey(secret);
  const row = db.prepare('SELECT pubkey FROM identity WHERE one = 0').get();
  if (row) return Buffer.from(new Uint8Array(row.pubkey)).equals(Buffer.from(pubkey));
  db.prepare('INSERT INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(secret, pubkey);
  return true;
}

export function nodeIdentity(db) {
  const row = db.prepare('SELECT secret, pubkey FROM identity WHERE one = 0').get();
  if (row) {
    const secret = new Uint8Array(row.secret);
    const held = new Uint8Array(row.pubkey);
    let pubkey;
    try { pubkey = schnorr.getPublicKey(secret); }
    catch { pubkey = null; }
    // A secret this curve cannot use is not a secret this node can sign with.
    // Astronomically unlikely from 32 random bytes and refused rather than
    // worked around, because the alternative is a node that cannot receipt.
    if (!pubkey) throw new Error('this node\'s stored secret is not a key it can sign with');
    if (!held.every((b, i) => b === pubkey[i]))
      db.prepare('UPDATE identity SET pubkey = ? WHERE one = 0').run(pubkey);
    return { secret, pubkey };
  }

  const secret = schnorr.utils.randomSecretKey();
  const pubkey = schnorr.getPublicKey(secret);
  db.prepare('INSERT INTO identity (one, secret, pubkey) VALUES (0, ?, ?)').run(secret, pubkey);
  return { secret, pubkey };
}
