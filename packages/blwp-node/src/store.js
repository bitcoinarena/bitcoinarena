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
import { schnorr } from '@noble/curves/secp256k1.js';

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

    -- THIS NODE'S OWN KEY. One row, and the CHECK is what makes it one: a
    -- daemon with two identities would sign some receipts with each and a
    -- client checking them against the committee would be right to refuse
    -- half of them.
    --
    -- It is the whole of the identity this cut needs. Where a key comes to be
    -- KNOWN to strangers is the bond advertisement, M2.1 step 5b, and that is
    -- discovery: it is not what lets a node sign. A client already holds the
    -- key it should expect, in the Round Contract's nodes list.
    -- WHO THIS ROUND SEATED, from the census at its own census_height.
    --
    -- A round's committee is not a list its author typed: 5A.4 seats it from
    -- the chain census, and this is where that answer is kept so every trust
    -- check reads the same one. A round with no rows here was never seated by
    -- this node, and it issues no receipts against it.
    CREATE TABLE IF NOT EXISTS seats (
      round_id BLOB NOT NULL,
      pubkey   BLOB NOT NULL,
      PRIMARY KEY (round_id, pubkey)
    );

    -- THE SHARES A PLAYER PUBLISHED FOR THEIR STAKE PREIMAGE, once this node
    -- has checked them. 23.1's vss_shares_ref on an Entry Contract names a
    -- row here, and an entry that names one this node never accepted is
    -- refused: a seat that cannot check a handout has no business letting the
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

    -- THE STAKE OF ONE ENTRY, WHILE IT IS IN FLIGHT. 23.1: the endpoint issues
    -- a hold invoice for the entry's payment hash, the player's wallet pays it,
    -- and from that moment the money is "accepted but not settled ... in
    -- nobody's balance". This is what this node knows about that hold.
    --
    -- The STATE is the whole point: HELD until a final result says otherwise,
    -- then SETTLED or CANCELLED by an act, or EXPIRED because nobody acted -
    -- and 23.2 makes that last one the default, which is why a VOID has no row
    -- to write rather than a cancel to issue.
    CREATE TABLE IF NOT EXISTS holds (
      entry_id     BLOB PRIMARY KEY REFERENCES entries(entry_id),
      round_id     BLOB NOT NULL,
      payment_hash BLOB NOT NULL,
      amount_msat  INTEGER NOT NULL,
      state        TEXT NOT NULL,
      why          TEXT NOT NULL,
      updated_ms   INTEGER NOT NULL,
      -- The payment request itself, because a player asks for their invoice
      -- more than once: a page reloaded, a wallet reopened, a second device.
      -- Making a second invoice for one stake would be a second claim on it,
      -- so the one that exists is kept and handed back.
      request      TEXT
    );

    -- 23.1 STEP 5, THIS NODE'S HALF: the stake was seen PAID and held. HELD in
    -- the holds table also covers an invoice nobody has paid yet, so play is gated on
    -- this row, written once when Lightning first showed the full amount. A
    -- table of its own so a store written before it existed gains it.
    CREATE TABLE IF NOT EXISTS stake_seen (
      entry_id   BLOB PRIMARY KEY REFERENCES entries(entry_id),
      paid_msat  INTEGER NOT NULL,
      seen_ms    INTEGER NOT NULL
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

    -- THIS SEAT'S NONCE PAIR FOR A ROUND'S SPEND, AND IT OUTLIVES THE PROCESS.
    --
    -- It lived in a Map on PoolSigning and died with the daemon, and letter
    -- 19 measured what that costs: a second asker after a restart got FRESH
    -- nonces from all five seats, a new signature, and a different txid over
    -- the same input - a conflicting spend of the pool. Before the restart the
    -- same asker got the same commitments back and rebuilt the IDENTICAL
    -- transaction, which is harmless. The difference was only the memory.
    --
    -- So it is on disk, one row per round, keyed by the round: this node holds
    -- one seat, and a seat is one signature. seat_id is stored beside it so
    -- a store that somehow met a different share refuses rather than signing
    -- with a pair that is not its own.
    --
    -- hiding and binding are the SECRET scalars and are cleared the moment
    -- the pair is used - spent_share is what a retry gets after that, which
    -- is enough to answer twice and not enough to sign twice.
    CREATE TABLE IF NOT EXISTS pool_nonces (
      round_id       BLOB PRIMARY KEY,
      seat_id        TEXT NOT NULL,
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

    -- The seats' signatures over that table id. Keyed by signer, so one seat
    -- signing twice is one vote, the way results already are.
    CREATE TABLE IF NOT EXISTS payout_signatures (
      round_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, node_pubkey)
    );

    CREATE TABLE IF NOT EXISTS identity (
      one    INTEGER PRIMARY KEY CHECK (one = 0),
      secret BLOB NOT NULL,
      pubkey BLOB NOT NULL
    );

    -- THE COMMITTEE'S OWN KEY, MADE WITHOUT A DEALER (M3.3 item 14).
    --
    -- One row per EPOCH, and an epoch is the set of seats: the owner's rule is
    -- that a DKG runs once per committee and not once per round, because the
    -- pool is one P2TR output across rounds and a per-round key would mint a
    -- new address every round. The same seats keep the same key until the
    -- committee changes, and a changed committee is a different epoch_id.
    --
    -- WHAT IS KEPT AND WHY. mine is this seat's own contribution, bytes and
    -- all: a restart must serve the SAME deal to a peer that has already seen
    -- it, because re-dealing would publish a second polynomial under a second
    -- id and the seats that combined the first would be holding shares of a
    -- key nobody else has. share is this seat's share of the group secret -
    -- the sum of what it was dealt, normalised - and it is the one secret in
    -- this table; it is written only when every seat has contributed.
    -- group_pubkey is public and is stored beside it so a seat can answer
    -- what the committee's key is without redoing the sum.
    CREATE TABLE IF NOT EXISTS dkg_epochs (
      epoch_id     BLOB PRIMARY KEY,
      seats        BLOB NOT NULL,      -- the committee, 32 bytes each, sorted
      mine         BLOB,               -- this seat's own encoded contribution
      share        BLOB,               -- 32 bytes, this seat's share of the secret
      seat_no      INTEGER,            -- its x on the polynomial, 1..n
      group_pubkey BLOB,               -- 33 bytes, compressed and even-y
      negated      INTEGER NOT NULL DEFAULT 0,
      updated_ms   INTEGER NOT NULL
    );

    -- The contributions this node has ACCEPTED, one per dealer per epoch.
    --
    -- Keyed by (epoch, dealer) so a seat that deals twice is one row and not
    -- two: dealing again after seeing everybody else's commitments is how a
    -- seat would steer the group key, and the primary key is the whole of the
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
    -- results of others beside its own and one seat may hold only one.
    CREATE TABLE IF NOT EXISTS results (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL REFERENCES entries(entry_id),
      node_pubkey BLOB NOT NULL,
      result_id   BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, node_pubkey)
    );

    -- A SETTLEMENT SEAT'S WORD THAT IT POSTED A RUN'S TRANSCRIPT (P2, 13A),
    -- its own and the other seats', one per seat. A result is FINAL only once
    -- the round's threshold of these agree, and W opens when that was so here.
    CREATE TABLE IF NOT EXISTS postings (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      seat_pubkey BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, seat_pubkey)
    );

    -- A COMMITTEE SEAT'S RE-RUN OF A SUSPENDED RESULT (13A), its own and the
    -- other seats', one per seat: counted to 5 of 7, it replaces SUSPENDED.
    CREATE TABLE IF NOT EXISTS reruns (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      seat_pubkey BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, seat_pubkey)
    );

    -- A SLASH PROOF THIS NODE FILED (5A.3B step 1): REPLAY_CONTRADICTS against
    -- a seat that signed a result the committee's re-run contradicted, with the
    -- signed result beside it. One per accused seat per run.
    CREATE TABLE IF NOT EXISTS slash_proofs (
      round_id    BLOB NOT NULL,
      entry_id    BLOB NOT NULL,
      node_pubkey BLOB NOT NULL,
      proof_id    BLOB NOT NULL,
      bytes       BLOB NOT NULL,
      seen_ms     INTEGER NOT NULL,
      PRIMARY KEY (round_id, entry_id, node_pubkey)
    );

    -- A STAKE LOCK THIS SEAT VERIFIED (23.1 step 5): the contract the player
    -- handed over, the federation's id for it, and where it sits.
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
    -- refund key can spend. The seat's record that it released the stake.
    CREATE TABLE IF NOT EXISTS forfeits (
      entry_id     BLOB PRIMARY KEY,
      round_id     BLOB NOT NULL,
      message      BLOB NOT NULL,
      signature    BLOB NOT NULL,
      claim_pk     BLOB NOT NULL,
      made_ms      INTEGER NOT NULL
    );

    -- AN ENTRY THIS SEAT HOLDS FORFEIT FOR A LATE START (§15, §13C): its first
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

    -- WHAT EACH OTHER SEAT ANSWERED when this seat offered it the player's
    -- on-time first mark (§16's evidence): receipted, unanswered, late, refused.
    -- A receipted answer is never written over.
    CREATE TABLE IF NOT EXISTS first_mark_offers (
      entry_id  BLOB NOT NULL,
      peer      TEXT NOT NULL,
      answer    TEXT NOT NULL,
      at_ms     INTEGER NOT NULL,
      PRIMARY KEY (entry_id, peer)
    );

    -- AN ENTRY THIS SEAT HOLDS ENTRY_VOID (§16, the outage refund): an on-time
    -- first mark that, when the start deadline passed, had fewer than the
    -- threshold's receipts, the seats it was short of offered it and silent.
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
      decided_ms     INTEGER NOT NULL
    );

    -- WHAT A SEATED PLAYER CHOSE TO BE CALLED IN A ROUND (M3.3-34): the record
    -- as the player signed it with the round key it is seated under
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

    -- WHERE THIS SEAT'S CLOSE OF A RUN STANDS, when it could not sign it at its
    -- close (M3.3-34): HOLDING while a peer that matters is unreachable and the
    -- close is tried again, SIGNED once it was. Kept here, beside everything
    -- else this seat must not forget across a restart.
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

    -- THE BEACON THIS SEAT'S CHAIN NAMED FOR A ROUND (M3.3-34): the block, its
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
  `);
  // A STORE MADE BEFORE A NONCE ROW CARRIED ITS SIGNING ATTEMPT gets the column:
  // every row it already holds was attempt 0.
  if (!db.prepare('PRAGMA table_info(pool_nonces)').all().some((c) => c.name === 'attempt'))
    db.exec('ALTER TABLE pool_nonces ADD COLUMN attempt INTEGER NOT NULL DEFAULT 0');
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
 * for NONE of them. So "the committee is the seated census" was not a rule
 * anybody could satisfy - the trusted list and the seated list could not
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
