// The two artifacts everything else hangs off.
//
// A RoundContract is what every participant must agree on byte for byte before
// a round can start; its digest IS the round_id. An EntryContract is one
// player's commitment to that round.
//
// Field order is protocol. Adding a field means a new version, not an append -
// an old implementation reading a new contract must fail rather than silently
// mis-parse, which is why the version comes second, right after the type.

import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
// THE RUN LENGTH IS THE CORE'S. `genesis.js` already reads it from the same
// place and writes it into the config hash a contract's network_id commits to;
// restating the number here would be the second clock letter 21 forbade.
import {
  TAG, PROTOCOL_VERSION, TYPE_ROUND_CONTRACT, TYPE_ENTRY_CONTRACT, ROLES,
  CUSTODY, custodyByte, custodyName, slashRemainderByte, slashRemainderOf, MIN_ENTRY_WINDOW_MS,
  STAKE_EXPIRY_BLOCKS, START_DEADLINE_TICKS, OBJECTION_WINDOW_MS,
  SCORE_SCALE,
} from './constants.js';

/**
 * The balance constants live in the contract because 18A.7 says they must:
 * a contract that leaves the rank curve flat or exposure additive is one whose
 * safe route is +EV, and a client has to be able to see that before entering.
 */
export function encodeRoundContract(c) {
  // A CUSTODY THIS NETWORK HAS FIRST (§23.6): anything but FEDERATION throws that it is not one - before any
  // question that only a FEDERATION round is asked.
  custodyByte(c.custody);
  // A PAYING FEDERATION ROUND NAMES ITS FEDERATION, or it is not a contract (M3 W7).
  const named = federationIsNamed(c);
  if (!named.ok) throw new Error(named.why);
  const w = new Writer();
  w.u8(TYPE_ROUND_CONTRACT);
  w.u16(PROTOCOL_VERSION);

  // WHICH NETWORK THIS ROUND IS FOR, section 27A.4: "Round Contracts carry it,
  // nodes and clients reject contracts that do not match the one they were
  // built for, and censuses are per-network."
  //
  // AND WHICH RULES IT RUNS UNDER, 27A.7.5: "A round is bound to the config it
  // was created under. The Round Contract carries `config_hash` alongside
  // `network_id`. A round created before activation and still running after it
  // keeps its own rules to the end."
  //
  // Both are here before anything uses them, which is the point: adding a
  // field to something signed is a format break, and after the first bond
  // exists a break costs every node its census entry. Neither VALUE can be
  // computed in this package - `networkAnchor()` and `genesisConfigHash()`
  // both refuse - but the fields are on version one, where they have to be.
  //
  // 27A.4 and 27A.7.5 both say the contract carries `network_id`; section 6's
  // field list does not name it, and predates them. They pair the two, so the
  // two sit together, ahead of the code hash: which network, then which rules,
  // then which build - a decoder can refuse a foreign contract before parsing
  // anything else about it.
  w.bytes32(c.networkId);
  w.bytes32(c.configHash);

  w.bytes32(c.simCoreHash);
  w.u64(c.startTimeMs);
  w.u64(c.entryCloseMs);

  // HOW LONG ANYONE HAS TO OBJECT, in milliseconds. Section 13A: "the window
  // W (reference: 10 minutes, CONTRACT-DEFINED)". It is in the contract and
  // not a constant here because a window the caller chooses is a window the
  // operator chooses - and the operator is the party a veto exists against.
  // The player signs up to it with the rest of the round.
  w.u64(c.objectionWindowMs);

  // WHICH CUSTODY CONSTRUCTION THE STAKE SITS IN, section 23.6: "The Round
  // Contract names which construction it uses." The two have the same residual
  // and different maturity, and a player is entitled to know which one they
  // staked into before they pay. Naming it is not implementing it.
  w.u8(custodyByte(c.custody));

  // WHICH FEDERATION HOLDS THE STAKE LOCKS, AND HOW LONG A LOCK MUST RUN,
  // section 6 (v4.6.2): "federation_id - the federation holding the stake
  // locks" and "stake_expiry_blocks - replaces htlc_cltv_days; 144 (§23.1)".
  // In the id because a custodian named after entry is one the creator picked
  // after seeing who entered, and a shorter expiry lets a loser refund before
  // settlement. All zeros names no federation: no stake lock is wired into the
  // node or the client yet, and a made-up id would claim one.
  w.bytes32(c.federationId);
  w.u32(c.stakeExpiryBlocks);

  // WHAT A NODE HAS TO HAVE DONE TO EARN ITS FEE SHARE, section 22A: "A
  // selected node earns its share only if it performed the CONTRACT-DEFINED
  // minimum service". It was an argument to the slashing check until this
  // field existed, and a minimum the caller chooses is a minimum the operator
  // chooses - the same fault the objection window was moved in here to fix,
  // and worse, because this one decides whether a bond is taken.
  w.u32(c.slashMinimumServed);

  // AND WHERE THE OTHER HALF OF A SLASHED BOND GOES, section 5A.3: "half to the
  // affected players of that round; the other half 75% evenly to the active
  // census nodes at the slashing height minus the round's own seats (the
  // witnesses) and 25% to the donation set of §22A - the developers". The
  // witnesses are the set the rule SUBTRACTS, not one it pays. The halves are
  // the spec's own numbers
  // and are a constant, because a contract that could move them would let an
  // operator write itself the whole bond.
  w.u8(slashRemainderByte(c.slashRemainder));

  // WHICH DONATION SET THIS ROUND'S ENTRIES WERE MADE UNDER, section 22A:
  // "The set is named in the Round Contract and its HASH IS PART OF THE
  // CONTRACT HASH, so it cannot change after entry."
  //
  // The id and not the set itself, which is what the spec asks for and keeps
  // the contract small. Before this a set had an id and nothing named which
  // one applied, so two honest nodes could agree on a set's bytes and still
  // disagree about whether it was the round's - the last way one player's
  // donation could be split by a list nobody signed up to.
  //
  // A SET THAT DOES NOT STAND CANNOT REACH HERE, because `donationSetId`
  // refuses to hash one: shares that do not sum to 10000, a payee listed
  // twice, or a mixed-case address all throw before there is an id to name.
  w.bytes32(c.donationSetId);

  w.u32(c.censusHeight);

  // HOW DEEP A BOND HAS TO BE, section 5A.11: "The Round Contract contains:
  // census_height, census_confirmations". It sits next to the height because
  // 5A.11 puts it there and because the two answer one question together.
  //
  // It was a caller argument on every census function, beside a height that
  // was already taken off the contract on purpose. A caller who picks the
  // depth picks which bonds are in the census, and the census picks the
  // committee - the same fault the version filter had, in the same file.
  w.u32(c.censusConfirmations);

  w.bytes32(c.censusRoot);

  // WHEN THE COMMITTEE COMES INTO EXISTENCE, and where its randomness comes
  // from. Section 6 lists both; this contract carried neither, and in their
  // place it carried a `committee_seed` - thirty-two bytes the AUTHOR wrote,
  // which the lottery read. That is the grinding attack 5A.5 exists to close:
  // 34 offline tries were enough to assign a chosen pair out of eight bonded
  // nodes. The seed is derived from the beacon now, so the field is gone, and
  // these two say WHICH beacon and WHEN - never its value, which does not
  // exist yet when a round is published.
  //
  // "committee_time  beacon value appears -> committees selected & verified"
  w.u64(c.committeeTimeMs);
  w.str(c.randomnessRule);

  // WHERE TRANSCRIPTS, ATTESTATIONS AND OBJECTIONS ARE POSTED, section 6
  // (v4.6.2) and 13A: a result is FINAL only once >=5 settlement signer nodes have
  // posted its transcript to these. "Data in the contract - any URL, any
  // relay, several - never infrastructure of this protocol." In the author's
  // order, because that order is what they signed.
  //
  // `publication_txid` is NOT here although section 6 lists it: it is the id
  // of a transaction carrying H(RoundContract), so a contract holding it has
  // no fixed point - like `round_id` and `creator_signature`, it rides beside
  // the contract, not in it.
  if (!Array.isArray(c.publicationRelays))
    throw new Error('publicationRelays is a list of URLs, and it may be empty');
  w.vec(c.publicationRelays, (s, ww) => ww.str(s));

  // HOW MANY SIGNER NODES EACH POOL HAS, section 5A.7: "GAME/VERIFY: 7 slots... 
  // SETTLEMENT: 7 slots". Section 6 carries them and says what they mean:
  // "echoed for readability; MUST equal genesis_parameters, which network_id
  // commits to. A contract disagreeing with the network it names is invalid,
  // NOT A SMALLER COMMITTEE."
  //
  // That last clause is why they are here. `selectCommittee` took `slots` from
  // whoever called it, so nobody had to forge a census to shrink a committee -
  // they could pass a smaller number. Five of seven is the whole security
  // argument; five of two is not.
  w.u8(c.gameVerifySlots);
  w.u8(c.settlementSlots);

  w.u64(c.stakeMsat);
  w.u64(c.bondMinSats);
  w.u16(c.blockTicks);

  // balance, all integers
  w.u32(c.exposureReference);
  w.u32(c.corridorHalfWidth);
  w.u32(c.spawnFreeRadius);
  w.u32(c.timeFloor);
  w.u32(c.timeCeil);
  w.u32(c.minScore);
  w.u8(c.rankNumerator);          // 3 of 4 = the 0.75 curve
  w.u8(c.rankDenominator);

  w.vec([...c.nodes].sort(compare32), (n, ww) => ww.bytes32(n), { sortedBy: compare32 });

  // THE START DEADLINE (§16), in ticks after a player's join tick - and LAST,
  // AND ONLY WHEN IT IS NOT THE DEFAULT. A round that names none (or names
  // START_DEADLINE_TICKS) encodes exactly as it did before the field existed,
  // so every round id already published stays what it was; one encoding per
  // contract, because the default and its omission are the same round.
  if (c.startDeadlineTicks !== undefined && c.startDeadlineTicks !== START_DEADLINE_TICKS) {
    if (!Number.isInteger(c.startDeadlineTicks) || c.startDeadlineTicks < 1 || c.startDeadlineTicks >= c.blockTicks)
      throw new Error(`startDeadlineTicks is a whole number of ticks from 1 to below the round's ${c.blockTicks}`);
    w.u32(c.startDeadlineTicks);
  }
  // THE SERIES AND THE INDEX, present only on a round of a series (ALL-BUT-MIN-1727; multiplayer_p2p.md "Round i of a
  // series is derived, never authored": round_id(i) = H(series_id || i)). Written after the deadline and only when
  // named, so every contract that names no series keeps its bytes and its id.
  if (c.seriesId !== undefined && c.seriesId !== null) {
    if (!(c.seriesId instanceof Uint8Array) || c.seriesId.length !== 32) throw new Error('a round of a series names its 32-byte series id');
    if (!Number.isInteger(c.roundIndex) || c.roundIndex < 0 || c.roundIndex > 0xffffffff) throw new Error('a round of a series names its index');
    w.bytes32(c.seriesId);
    w.u32(c.roundIndex);
  } else if (c.roundIndex !== undefined && c.roundIndex !== null) throw new Error('a round index without its series');
  return w.finish();
}

/**
 * A CUSTODY BYTE THIS NETWORK HAS, OR THE RECORD DOES NOT PARSE (RULED, the owner 2026-09-22 22:59).
 *
 * §23.6: "a record from before this ruling that carries the old value is not a round of this network
 * and is neither decoded, replayed, settled, listed nor counted; a node that holds such a record treats
 * it as it treats BYTES THAT DO NOT PARSE. There is no decode-only label and no history exception."
 *
 * So this throws, exactly as a bad length or an unknown type byte throws. It does not return a label,
 * a null, or a flag a caller could choose to ignore - any of which would be the decode-only value the
 * ruling refuses. Every byte but FEDERATION's throws the same sentence, byte 0 as byte 2: a message
 * that named what byte 0 once was would be that label.
 */
function custodyOrRefuse(byte) {
  const name = custodyName(byte);
  if (name === null)
    throw new Error(`custody byte ${byte} is not a custody of this network: the one value is FEDERATION`);
  return name;
}

export function decodeRoundContract(bytes) {
  const r = new Reader(bytes);
  const type = r.u8();
  if (type !== TYPE_ROUND_CONTRACT) throw new Error('not a RoundContract: type ' + type);
  const version = r.u16();
  if (version !== PROTOCOL_VERSION)
    throw new Error('protocol version ' + version + ', this build speaks ' + PROTOCOL_VERSION);

  const c = {
    // ON THE WIRE SINCE VERSION ONE AND DISCARDED BY THIS DECODER UNTIL NOW.
    // 5d wants a node's selectability decided against the round's version, and
    // the census could not read it off a contract that did not carry it back.
    protocolVersion: version,
    networkId: r.bytes32(),
    configHash: r.bytes32(),
    simCoreHash: r.bytes32(),
    startTimeMs: r.u64(),
    entryCloseMs: r.u64(),
    objectionWindowMs: r.u64(),
    custody: custodyOrRefuse(r.u8()),
    federationId: r.bytes32(),
    stakeExpiryBlocks: r.u32(),
    slashMinimumServed: r.u32(),
    slashRemainder: slashRemainderOf(r.u8()),
    donationSetId: r.bytes32(),
    censusHeight: r.u32(),
    censusConfirmations: r.u32(),
    censusRoot: r.bytes32(),
    committeeTimeMs: r.u64(),
    randomnessRule: r.str(),
    publicationRelays: r.vec((rr) => rr.str()),
    gameVerifySlots: r.u8(),
    settlementSlots: r.u8(),
    stakeMsat: r.u64(),
    bondMinSats: r.u64(),
    blockTicks: r.u16(),
    exposureReference: r.u32(),
    corridorHalfWidth: r.u32(),
    spawnFreeRadius: r.u32(),
    timeFloor: r.u32(),
    timeCeil: r.u32(),
    minScore: r.u32(),
    rankNumerator: r.u8(),
    rankDenominator: r.u8(),
    nodes: r.vec((rr) => rr.bytes32()),
  };
  // The start deadline, present only when the round named one that is not the
  // default. Written as the default it would be a second encoding of one round. And after it the series and the
  // index, only on a round of a series: 4 bytes left is the deadline, 36 the series, 40 both.
  const left = r.b.length - r.at;
  if (left !== 0 && left !== 4 && left !== 36 && left !== 40) throw new Error(`a round contract with ${left} trailing bytes`);
  if (left === 4 || left === 40) {
    const d = r.u32();
    if (d === START_DEADLINE_TICKS) throw new Error('a start deadline equal to the default is written by omitting it');
    if (d < 1 || d >= c.blockTicks) throw new Error(`a start deadline of ${d} ticks is outside 1 to below the round's ${c.blockTicks}`);
    c.startDeadlineTicks = d;
  }
  if (left === 36 || left === 40) {
    c.seriesId = r.bytes32();
    c.roundIndex = r.u32();
  }
  r.end();
  // AND BYTES FROM ANYWHERE ARE HELD TO THE SAME (M3 W7): a paying FEDERATION round naming none is refused.
  const named = federationIsNamed(c);
  if (!named.ok) throw new Error(named.why);
  return c;
}

/**
 * THE ROUND'S ID. A round of a series: H(series_id || i) - the series fixes the round, and a node holds its contract
 * only when it is exactly the one the series derives (series.js seriesRoundCheck). Any other round: its contract's hash.
 */
export const roundId = (c) => {
  if (c && c.seriesId !== undefined && c.seriesId !== null) {
    encodeRoundContract(c);                                   // a contract that does not encode has no id
    const i = new Uint8Array(4); new DataView(i.buffer).setUint32(0, c.roundIndex, false);
    const body = new Uint8Array(36); body.set(c.seriesId, 0); body.set(i, 32);
    return taggedHash(TAG.seriesRound, body);
  }
  return taggedHash(TAG.roundContract, encodeRoundContract(c));
};

/**
 * IS THIS CONTRACT FOR THIS BUILD'S NETWORK, AND FOR RULES IT IS RUNNING?
 *
 * 27A.4: "nodes and clients reject contracts that do not match the one they
 * were built for". 27A.9: "The trust anchor is the client's own built-in
 * `network_id`, NEVER A VALUE FROM THE CONTRACT" - so the anchor is handed in
 * and is not read off the thing being judged, the same discipline
 * `censusRootMatchesRound` needed for its entries.
 *
 * AND 27A.7.5, the config half: "A node that has not upgraded simply stops
 * being selectable for rounds naming the new hash... It is not ejected and it
 * is not slashed; it serves nothing." That is why this answers rather than
 * throwing, and why the refusal names which of the two failed: not serving a
 * round is an ordinary outcome, not an error.
 *
 * This build's anchors are testnet4 + the live core config. A contract naming
 * another network is not selectable, not slashed.
 */
export function contractIsForThisBuild(contract, { anchor, config } = {}) {
  if (!contract || !is32(contract.networkId))
    return { ok: false, why: 'that contract names no network' };
  if (!is32(contract.configHash))
    return { ok: false, why: 'that contract names no config' };
  if (!is32(anchor))
    return { ok: false, why: 'this build names no network to check it against' };
  if (!is32(config))
    return { ok: false, why: 'this build names no config to check it against' };

  if (!contract.networkId.every((b, i) => b === anchor[i]))
    return {
      ok: false,
      why: 'that contract is for another network: a fork that changes the '
        + 'donation authority is a different network, not a theft',
    };
  if (!contract.configHash.every((b, i) => b === config[i]))
    return {
      ok: false,
      why: 'that round runs a config this build is not running, so it is not '
        + 'selectable for it - not ejected, not slashed, it serves nothing',
    };
  return { ok: true, why: 'that contract is for this network and this config' };
}

const is32 = (v) => v instanceof Uint8Array && v.length === 32;

export function encodeEntryContract(e) {
  const w = new Writer();
  w.u8(TYPE_ENTRY_CONTRACT);
  w.u16(PROTOCOL_VERSION);
  w.bytes32(e.roundId);
  w.bytes32(e.playerPubkey);
  w.bytes32(e.sessionPubkey);
  w.bytes32(e.stakeCommitment);      // H(P), the hold-invoice preimage commitment
  w.u64(e.stakeMsat);
  w.u64(e.feeMsat);
  w.u64(e.donationMsat);
  w.u32(e.joinTick);
  // the owner 2026-09-08: the world secret is on the entry so a node can replay.
  w.bytes32(e.worldSecret);
  // 23.1's `vss_shares_ref`: the id of the handout this entry's stake preimage
  // was split into. IN THE SIGNED BYTES, because that is the whole of what it
  // buys - a reference a player could change after signing would let a dealer
  // swap the polynomial under a committee that had already checked one.
  //
  // 32 zero bytes is a real value and means "this entry publishes no shares",
  // which is every entry in M2 until a stake exists to protect. It is not a
  // default the encoder supplies: a caller says which it means, because an
  // entry that forgot the field and an entry that has no shares must not be
  // the same bytes by accident.
  w.bytes32(e.vssSharesRef);

  // THE STAKE LOCK'S HALF OF THE ENTRY, section 7 (v4.6.2), §23.1 steps 0-5:
  //
  //   stake_point                P.G - a POINT, so a signer node can check Feldman's
  //                              A0 against it; with only H(P) a loser could
  //                              deal consistent shares of Q != P and escape
  //                              at expiry (F1)
  //   fee_preimage               F in clear: opens the fee lock once FINAL
  //   stake_lock_outpoint,       where the federation holds the two locks -
  //   fee_lock_outpoint          Fedimint's (txid, out_idx)
  //   claim_key_attestation_ref  the >=5 signer node signatures on (round_id, claim_pk)
  //
  // `stakeCommitment` = H(P) stays above them while the hold invoice is the
  // path that ships: its payment hash is that hash. Zeros in every one of these
  // name "no stake lock", which is every entry until the lock is wired - said
  // by the caller, never supplied here.
  w.bytes(e.stakePoint, STAKE_POINT_BYTES);
  w.bytes32(e.feePreimage);
  writeOutpoint(w, e.stakeLockOutpoint, 'stakeLockOutpoint');
  writeOutpoint(w, e.feeLockOutpoint, 'feeLockOutpoint');
  w.bytes32(e.claimKeyAttestationRef);
  // THE DONATION OUTPOINTS (the owner 2026-10-03, FEDERATION.md "Donations in the federation"): where the player's lock
  // transaction paid each recipient key of a set of keys its share - in the set's order, one per share above 0 msat
  // (donationOutputsExpected). WRITTEN ONLY WHEN THERE ARE ANY: an entry that pays no key - every entry before this, every
  // LNURL round - keeps exactly its bytes and its id. An empty list is never written, so an entry has one encoding.
  const donations = e.donationOutpoints || [];
  if (!Array.isArray(donations)) throw new Error('donationOutpoints is a list of federation outpoints');
  if (donations.length) w.vec(donations, (o, ww) => writeOutpoint(ww, o, 'a donation outpoint'));
  return w.finish();
}

/** The same compressed point as a Feldman commitment (`handout.js`). */
export const STAKE_POINT_BYTES = 33;

function writeOutpoint(w, o, name) {
  if (!o || typeof o !== 'object') throw new Error(`${name} is a federation outpoint { txid, outIdx }`);
  w.bytes32(o.txid);
  w.u64(o.outIdx);
}

const readOutpoint = (r) => ({ txid: r.bytes32(), outIdx: r.u64() });

export function decodeEntryContract(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_ENTRY_CONTRACT) throw new Error('not an EntryContract');
  const version = r.u16();
  if (version !== PROTOCOL_VERSION) throw new Error('protocol version ' + version);
  const e = {
    roundId: r.bytes32(),
    playerPubkey: r.bytes32(),
    sessionPubkey: r.bytes32(),
    stakeCommitment: r.bytes32(),
    stakeMsat: r.u64(),
    feeMsat: r.u64(),
    donationMsat: r.u64(),
    joinTick: r.u32(),
    worldSecret: r.bytes32(),
    vssSharesRef: r.bytes32(),
    stakePoint: r.bytes(STAKE_POINT_BYTES),
    feePreimage: r.bytes32(),
    stakeLockOutpoint: readOutpoint(r),
    feeLockOutpoint: readOutpoint(r),
    claimKeyAttestationRef: r.bytes32(),
  };
  if (r.at < bytes.length) {
    e.donationOutpoints = r.vec(readOutpoint);
    if (!e.donationOutpoints.length) throw new Error('an empty list of donation outpoints is not written: these bytes are not an entry\'s one encoding');
  }
  r.end();
  return e;
}

export const entryId = (e) => taggedHash(TAG.entryContract, encodeEntryContract(e));

/**
 * DO THE SHARES OPEN TO THE LOCK'S OWN SECRET? §23.1 step 2 (v4.6.2, F1): "Each
 * signer node verifies its share against the commitments AND THAT THE CONSTANT
 * COMMITMENT A0 EQUALS stake_point, and refuses the entry otherwise."
 *
 * Byte equality of two compressed points is point equality. An entry naming no
 * stake point is refused rather than passed: "no point" must never read as "a
 * point that matched".
 */
export function stakePointIsTheHandouts(entry, handout) {
  if (!entry || !(entry.stakePoint instanceof Uint8Array) || entry.stakePoint.length !== STAKE_POINT_BYTES)
    return { ok: false, why: 'that entry names no 33-byte stake point' };
  if (entry.stakePoint.every((b) => b === 0))
    return { ok: false, why: 'that entry names no stake point, so no share can be checked against it' };
  const a0 = handout && Array.isArray(handout.commitments) ? handout.commitments[0] : undefined;
  if (!(a0 instanceof Uint8Array) || a0.length !== STAKE_POINT_BYTES)
    return { ok: false, why: 'that handout publishes no constant commitment A0' };
  for (let i = 0; i < STAKE_POINT_BYTES; i++)
    if (a0[i] !== entry.stakePoint[i])
      return {
        ok: false,
        why: 'the handout\'s A0 is not the entry\'s stake point: these shares open to a '
          + 'different secret than the lock',
      };
  return { ok: true };
}

/**
 * IS THIS ROUND'S RUN LENGTH THE ONE THE SIMULATOR ACTUALLY USES?
 *
 * `blockTicks` is section 6's `player_run_duration` in the unit the core
 * counts in, and the core is where it lives: `rules/gate.js` ends a run
 * `RUN_MISSED` at `BLOCK_TICKS` elapsed ticks, and `genesis.js` writes that
 * same number into the config hash a contract's `network_id` commits to.
 *
 * So the field on the contract is section 6's own words - "echoed for
 * readability; MUST equal genesis_parameters, which network_id commits to. A
 * contract disagreeing with the network it names is invalid" - and this is
 * that check, the same one letter 16 wrote for the committee slot counts.
 *
 * MEASURED BEFORE IT EXISTED: a round naming 9000, one naming 4500 and one
 * naming 1 were all accepted, while the core stopped every run at 9000
 * regardless. The number on the wire meant nothing, and a node bounded batches
 * with it - a second clock disagreeing with the first, which is exactly what
 * letter 21 put the tick in the core to prevent.
 */
//
// AND SINCE M3 R1 R3 (the owner 2026-09-15 08:07: several cores at once) "the core" is the ROUND'S core
// under the round's config - handed in as `coreTicks` by whoever resolved it (the signer node's cores.js) -
// and no longer the truck's BLOCK_TICKS read from its rules: the protocol names no game.
export function runLengthIsTheCores(contract, coreTicks) {
  if (!contract || !Number.isInteger(contract.blockTicks))
    return { ok: false, why: 'that round names no run length' };
  if (!Number.isInteger(coreTicks) || coreTicks < 1)
    return { ok: false, why: 'there is no core run length to check that round against' };
  if (contract.blockTicks !== coreTicks)
    return {
      ok: false,
      why: `that round says a run is ${contract.blockTicks} ticks and this core ends one at `
        + `${coreTicks}: a contract disagreeing with the network it names is invalid, and a `
        + 'second clock is not a shorter round',
    };
  return { ok: true, blockTicks: coreTicks };
}

/**
 * THE LAST TICK A RUN MAY CARRY, for an entry that joined at `joinTick`: THE ROUND'S LAST TICK, for every entry.
 *
 * EVERY RUN OF A ROUND ENDS AT THE ROUND'S 82 s (kanban #130, the owner 2026-10-04 14:30: "They always end at the 82/90
 * boundary: the run ends at 82 s, the slot at 90 s. A later join does not extend the round. The late joiner has less
 * time"). Ticks are counted from the round's start; an entry joined at tick J carries ticks J .. blockTicks - 1, and its
 * run is blockTicks - J (runTicksForEntry). Before, the last tick was joinTick + blockTicks - 1 - a whole run from the
 * join - which every entry made so far met with joinTick 0, the same tick as now: old rounds replay as they did.
 */
export function lastTickOfRun(joinTick, blockTicks) {
  // The run length is the round's (its contract's blockTicks, checked against its core) - M3 R1 R3.
  if (!Number.isInteger(blockTicks) || blockTicks < 1)
    throw new Error('a run\'s last tick is counted from the round\'s run length, and none was given');
  if (!Number.isInteger(joinTick) || joinTick < 0 || joinTick >= blockTicks)
    throw new Error(`an entry joins at a tick of the round's run, 0 to ${blockTicks - 1}, not ${joinTick}`);
  return blockTicks - 1;
}

// THE LAST ENTRY OF A LATE-JOIN ROUND (kanban #130, the owner 2026-10-04 14:30: "Join closes when 45 s remain. A player who
// would have 45 s or less left must not enter"): remaining is the round clock to its run's end at start + 82 s, so an entry
// is taken only before start + 37 s; at that instant 45 s remain and it is refused. Stricter than the bytes (entry_close
// start + 45 s), which stay as posted: no new series.
export const LATE_JOIN_RUN_MS = 82000n;
export const LATE_JOIN_LEFT_MS = 45000n;
export const LATE_JOIN_LAST_ENTRY_MS = LATE_JOIN_RUN_MS - LATE_JOIN_LEFT_MS;   // 37 000 ms after the start

/** THE RUN AN ENTRY GETS (kanban #130): from its join tick to the round's last tick - blockTicks - joinTick ticks. */
export function runTicksForEntry(joinTick, blockTicks) {
  return lastTickOfRun(joinTick, blockTicks) - joinTick + 1;
}


function compare32(a, b) {
  for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * Warnings a client must show before a player stakes anything.
 *
 * Spec 18A.7: a contract whose rank curve is flat, or whose paying ranks cover
 * most of the field, is one whose safe route is positive expected value. The
 * protocol does not forbid it - balance is not protocol - but a player is
 * entitled to know before paying.
 */
/**
 * THE 5A.5 WINDOWS: is there time to enter this round at all?
 *
 *   entry_open_time == committee_time
 *   start_time      >= committee_time + min_entry_window
 *
 * ENTRY OPENS AT COMMITTEE_TIME, and that is not a policy this contract can
 * set differently: 23.1 encrypts the preimage shares TO the settlement
 * committee, so an entry cannot be constructed before the committee exists.
 * There is no separate `entry_open_time` on this contract and there must not
 * be one - a second field could disagree with `committee_time`, and the spec's
 * own line is an equality, not a range. So the equality holds by construction
 * and what is checked here is the half that can be got wrong: the window
 * AFTER it.
 *
 * A round with no window is not a strict round, it is one nobody can join -
 * the committee appears and the round has already begun.
 */
export function roundWindowsAreValid(c) {
  if (!c || typeof c.committeeTimeMs !== 'bigint')
    return { ok: false, why: 'that round names no committee time, so nothing says when entry opens' };
  if (typeof c.startTimeMs !== 'bigint')
    return { ok: false, why: 'that round names no start time' };

  const opensAt = c.committeeTimeMs;
  const earliestStart = opensAt + MIN_ENTRY_WINDOW_MS;
  if (c.startTimeMs < earliestStart)
    return {
      ok: false,
      opensAt,
      why: `that round starts at ${c.startTimeMs} and its committee forms at ${opensAt}, `
        + `leaving ${c.startTimeMs - opensAt}ms to enter where this protocol asks for `
        + `${MIN_ENTRY_WINDOW_MS}`,
    };

  // AND THE LAST LATE JOIN CANNOT BE BEFORE THE FIRST. `entry_close_time` is
  // the end of the same window entry_open_time begins.
  if (typeof c.entryCloseMs === 'bigint' && c.entryCloseMs < opensAt)
    return {
      ok: false,
      opensAt,
      why: `that round closes entry at ${c.entryCloseMs}, before its committee forms at ${opensAt}`,
    };

  // AND ITS OBJECTION WINDOW IS EXACTLY 600 000 ms (§13A, WINDOW-10-SPEC, RULED the owner 2026-10-01 09:40): "A Round
  // Contract whose objection_window_W is not exactly 600000 ms is invalid: a node refuses to open it, list it or take an
  // entry for it." The field was contract-defined with a 10-minute reference and a 6-hour cap; neither stands.
  if (typeof c.objectionWindowMs !== 'bigint')
    return { ok: false, opensAt, why: 'that round names no objection window, so nothing says when a result may become final' };
  if (c.objectionWindowMs !== OBJECTION_WINDOW_MS)
    return {
      ok: false,
      opensAt,
      why: `that round's objection window is ${c.objectionWindowMs}ms: the objection window is exactly ${OBJECTION_WINDOW_MS}ms `
        + '(600 s of wall time from the round\'s end, §13A), so the contract is invalid',
    };

  return { ok: true, opensAt, earliestStart };
}

/**
 * DO THE CUSTODY FIELDS SAY WHAT v4.6.2 RULES?
 *
 * Three things the spec states and a contract can get wrong: the expiry is
 * 144 blocks (ruled 2026-09-11, §23.1) - not a number an author tunes; a round
 * that takes a stake into a FEDERATION names which one (§23.6); and every relay
 * is a URL, each once (§13A). Whether the named federation's guardians are
 * bonded census nodes is the client's check against the census, not this one.
 */
const RELAY_SCHEMES = ['http:', 'https:', 'ws:', 'wss:'];

export function custodyFieldsAreValid(c) {
  if (!c) return { ok: false, why: 'no contract' };
  if (c.stakeExpiryBlocks !== STAKE_EXPIRY_BLOCKS)
    return {
      ok: false,
      why: `that round names stake_expiry_blocks ${c.stakeExpiryBlocks} where §23.1 rules `
        + `${STAKE_EXPIRY_BLOCKS}`,
    };
  if (!is32(c.federationId)) return { ok: false, why: 'that round names no 32-byte federation_id' };
  const named = federationIsNamed(c);
  if (!named.ok) return named;
  return publicationRelaysAreValid(c);
}

/**
 * DOES A ROUND THAT TAKES A STAKE INTO A FEDERATION SAY WHICH ONE? (§23.6, M3 W7). A zero
 * federation_id on a paying FEDERATION round is unsigned custody - nothing says who holds its
 * stake locks - so such a contract is not a contract: encoding and decoding refuse it, for every
 * builder and for bytes from anywhere. A free round moves no money and names no federation; it
 * passes. Whether the named federation's guardians are bonded census nodes is
 * federationIsBonded, parked with "which guardians".
 */
export function federationIsNamed(c) {
  if (!c) return { ok: false, why: 'no contract' };
  if (!(typeof c.stakeMsat === 'bigint' && c.stakeMsat > 0n)) return { ok: true };
  if (!is32(c.federationId) || c.federationId.every((b) => b === 0))
    return {
      ok: false,
      why: 'that round takes a stake into a FEDERATION and names no federation_id, '
        + 'so nothing says who holds its stake locks',
    };
  return { ok: true };
}

/**
 * CAN THIS ROUND'S TRANSCRIPTS BE POSTED ANYWHERE? Every relay a URL, each
 * once (§13A) - and at least one on a round that takes a stake. Since P2 no
 * result is FINAL until the round's settlement signer nodes have posted its
 * transcript to these relays, so a paying round naming none could never settle
 * a stake it took: measured, two daemons opened one, held both players' stakes
 * and were still provisionally final after the window. A free round moves no
 * money and may name none.
 */
/**
 * A ROUND MAY NOT NAME MORE SITTING SEATS THAN ITS OWN POOLS HAVE SLOTS (§22A).
 *
 * 22A pays the node fee to "the round's **sitting seats** - the seats the census seated for this round, its
 * `nodes` - however many there are: two in a 2-of-2, seven in a 5-of-7", and says it again as a warning:
 * "**Not seven census slots when the round is 2-of-2**". A fee lock is sized for the same seats the
 * settlement pays, so a contract that names seven seats on a two-slot round mints a lock divided seven ways
 * and a settlement that pays seven - from a committee of two. The extra shares go to seats that never sat.
 *
 * MEASURED BEFORE THIS EXISTED: `feeLockPays` reads `contract.nodes` and never looks at the slot counts, so a
 * 2-of-2 round naming seven seats answered `pays true, signerNodes 7`. The lock was sized for seven.
 *
 * IT IS AN UPPER BOUND, NOT AN EQUALITY, and that is deliberate. The spec's number is "however many there
 * are", and a slot a census left unfilled is a round with fewer seats than slots - legitimate, and not this
 * rule's business. Only naming MORE seats than the round has slots is the fault 22A warns about, so that is
 * all this refuses.
 */
export function sittingSeatsFitTheSlots(c) {
  if (!c) return { ok: false, why: 'no contract' };
  const seats = Array.isArray(c.nodes) ? c.nodes.length : 0;
  const gv = Number.isInteger(c.gameVerifySlots) ? c.gameVerifySlots : 0;
  const st = Number.isInteger(c.settlementSlots) ? c.settlementSlots : 0;
  const slots = Math.max(gv, st);
  if (seats > slots)
    return { ok: false, seats, slots,
      why: `that round seats ${seats} signer nodes on ${gv}/${st} slots: 22A pays the seats the census `
        + 'seated, and a fee lock sized for more of them pays seats that never sat' };
  return { ok: true, seats, slots, why: '' };
}

export function publicationRelaysAreValid(c) {
  if (!c) return { ok: false, why: 'no contract' };
  if (!Array.isArray(c.publicationRelays))
    return { ok: false, why: 'that round names no publication relays list' };
  const seen = new Set();
  for (const relay of c.publicationRelays) {
    let url;
    try { url = new URL(relay); } catch { url = null; }
    if (!url || !RELAY_SCHEMES.includes(url.protocol))
      return { ok: false, why: `publication relay ${JSON.stringify(relay)} is not an http(s) or ws(s) URL` };
    if (seen.has(relay)) return { ok: false, why: `publication relay ${relay} is named twice` };
    seen.add(relay);
  }
  if (c.stakeMsat > 0n && !c.publicationRelays.length)
    return {
      ok: false,
      why: 'that round takes a stake and names no publication relay: none of its results can become '
        + 'final (§13A), so no stake in it could ever settle',
    };
  return { ok: true };
}

export function contractWarnings(c) {
  const out = [];
  // Integer comparison, not a quotient. This is only a client warning and a
  // float here would change nothing - which is exactly why it is worth not
  // writing: a division on a money-shaped number is a habit, and the next one
  // will be somewhere it matters.
  if (Math.imul(c.rankNumerator, 100) >= Math.imul(c.rankDenominator, 95))
    out.push('flat_rank_curve');
  if (c.exposureReference === 0) out.push('exposure_ignored');
  if (c.timeFloor >= c.timeCeil) out.push('time_factor_degenerate');
  // min_score is in the score's unit, 1e-5 points (constants.js SCORE_SCALE): a floor above 100 points is a danger rule
  if (c.minScore > 0 && c.minScore > 100 * SCORE_SCALE) out.push('minimum_score_is_a_danger_rule');
  return out;
}
