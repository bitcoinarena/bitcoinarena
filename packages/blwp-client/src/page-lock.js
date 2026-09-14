// THE PLAYER'S STAKE LOCK, MADE FROM THE PAGE (W1b; v4.6.2 §23.1 steps 3-5).
//
// The lock client (lock-client/, the stock fedimint 0.12.0 client crates built
// to wasm) is INJECTED, like the curve: this bundle carries no crypto and no
// federation code. What is here decides only what the lock client is asked -
// which federation, under whose secret, how much, to which keys, until when,
// all read off the round, the dealt stake and the attested claim key - and it
// refuses an answer that is not the lock it asked for (`lockFromClient`).
//
// AND IT HANDS THE LOCK TO THE SEATS once they hold the entry: a seat verifies
// it in the federation and only then counts the stake (§23.1 step 5).
//
// A RELOAD LOSES NOTHING. The lock client's wallet is kept in the tab
// (`lockStoreFor`), so a reload between the deposit and the lock reopens the
// wallet that holds it; and a lock already made, that no seat has committed
// yet, is kept with its stake (`saveLock`), so a reload before the seat takes
// the entry uses that lock instead of dealing and paying again.
import { taggedHash, toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { TAG } from '../../protocol/src/constants.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson, lockFieldsFromJson } from '../../protocol/src/stake-lock.js';
import { decodeHandout, handoutId } from '../../protocol/src/handout.js';
import { lockFromClient } from './lock-result.js';
import { feeLockPays } from '../../protocol/src/lock-settlement.js';
import { roundLocks, playerFor } from './join.js';
import { encodeRoundContract, decodeRoundContract } from '../../protocol/src/contracts.js';
import { decodeBolt11 } from '../../protocol/src/bolt11.js';

// THE BLOCKS OVER stake_expiry_blocks A LOCK IS MADE FOR. The seat requires
// expiration >= its federation height + 144 when it verifies, and the chain
// moves between the lock and the check; W1a locked with 150 and both seats
// committed. How large this margin must be is a parked ruling (the expiry
// margin, §23.1 step 4 vs step 5) - it is W1a's number, named, not a choice.
export const LOCK_EXPIRY_MARGIN_BLOCKS = 6;

const namesNothing = (b) => !(b instanceof Uint8Array) || b.every((x) => x === 0);

/**
 * THE LOCK CLIENT'S SECRET FOR THIS ROUND, FROM THE PLAYER'S SEED. The ecash a
 * deposit buys, before it is locked, is then the seed's and not this tab's.
 */
export function lockSecretFor(seed, roundId) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new Error('the lock client\'s secret comes from the player\'s 32-byte seed, and none was given');
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32)
    throw new Error('the lock client\'s secret is per round, and no round id was given');
  const msg = new Uint8Array(64);
  msg.set(seed, 0);
  msg.set(roundId, 32);
  return taggedHash(TAG.lockClientSecret, msg);
}

/**
 * WHERE THE LOCK CLIENT'S WALLET IS KEPT: the tab's storage, one key per
 * database key, under this round and this seed's secret (its hash, never the
 * secret). The shape `lock-client/src/store.rs` reads: `entries()` as JSON.
 */
export function lockStoreFor(storage, roundId, secret) {
  const prefix = `blwp.lockdb.${toHex(roundId).slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`;
  return {
    entries() {
      const out = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) out.push([k.slice(prefix.length), storage.getItem(k)]);
      }
      return JSON.stringify(out);
    },
    put(k, v) { storage.setItem(prefix + k, v); },
    remove(k) { storage.removeItem(prefix + k); },
  };
}

/** The same shape, kept nowhere: for a caller that hands no storage. */
function unkeptLockStore() {
  const held = new Map();
  return { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
}

/**
 * THE LOCK, AS THE PLAYER IS SHOWN IT: how much, where, and when the contract
 * lets it come back to their own key if nobody settles it. The refund itself is
 * made by the player's key after that block (the lock's refund_pk).
 */
export function lockLine(stakeLock) {
  if (!stakeLock || !stakeLock.outpoint || !(stakeLock.outpoint.txid instanceof Uint8Array)) return '';
  const f = stakeLock.fields || {};
  return `stake locked in the round's federation: ${String(f.amountMsat)} msat at `
    + `${toHex(stakeLock.outpoint.txid).slice(0, 16)}…:${String(stakeLock.outpoint.outIdx)}`
    + (Number.isInteger(f.expiration) ? ` · back to your key from federation block ${f.expiration} if nobody settles it` : '');
}

/**
 * The net stake a lock holds: the stake less the node fee and the player's own
 * donation (§22A) - the same net the seat's stake-lock check wants. It assumed
 * 0 before the page could write a donation (M3.2 6e): a 2% donor's lock would
 * have held 98000 msat where the seat wants 96000.
 */
export const lockAmountMsat = (round, donationMsat = 0n) => {
  const stakeMsat = BigInt(round.stakeMsat || 0n);
  return netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat });
};

/**
 * JOIN THE ROUND'S FEDERATION, FUND THE LOCK, AND MAKE IT.
 *
 * `LockClient` is the wasm class; `storage` the tab's (the wallet is kept
 * there); `onDeposit({ invoice, amountMsat })` is told each invoice the
 * player's wallet must pay - the page shows it. Returns the outpoint and the
 * contract (`lockFromClient`), and the client that holds it.
 */
export async function lockStake({ round, roundId, invite, seed, stake, claimKey, playerPubkey, LockClient,
  storage, donationMsat = 0n, onDeposit = () => {}, onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  if (!invite)
    throw new Error('this round\'s stake goes into a federation lock, and the link names no federation '
      + 'to make it in - add federation=<invite code>');
  if (!LockClient || typeof LockClient.join !== 'function')
    throw new Error('a stake lock is made by the lock client, and none was loaded');
  if (!stake || namesNothing(stake.stakePoint)) throw new Error('a lock is to the stake\'s point, and this stake names none');
  if (!claimKey || !claimKey.ok || namesNothing(claimKey.claimPk))
    throw new Error('no claim key has its seats\' attestation: a client must refuse to lock to a key without it (23.1 step 0)');
  if (!(playerPubkey instanceof Uint8Array) || playerPubkey.length !== 32)
    throw new Error('a lock refunds to the player\'s key, and that is 32 bytes');

  const amount = lockAmountMsat(round, donationMsat);
  const secret = lockSecretFor(seed, roundId);
  const store = storage ? lockStoreFor(storage, roundId, secret) : unkeptLockStore();
  const kept = JSON.parse(store.entries()).length;
  onStep(kept ? 'reopening the wallet this tab kept for this round' : 'joining the federation');
  const client = await LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
  onStep(`holding ${await client.balanceMsat()} msat`);

  // FUNDED FROM THE PLAYER'S OWN DEPOSIT. The federation's fee for the lock is
  // quoted as a dry run over the notes the client holds, so an empty client
  // cannot be quoted - measured on regtest, the first page rehearsal refused
  // its seat with "Insufficient funds" before asking for any deposit. So the
  // first deposit is the net stake and the stock fee allowance
  // (`LockClient.lockAllowanceMsat`); after it the quote decides, and a quote
  // that still finds the funds short is topped up by the allowance again.
  // THE FEE LOCK'S GATE (Pick b, the owner 2026-09-14): a fee lock is minted only
  // when claiming it can pay every entitled sitting seat something after the
  // federation's own fee on every input and output - read from the federation
  // this client joined, not a seat's word. A 100 sat round's 2000 msat fee lock
  // cannot, so none is made and the player is not charged a lock that only
  // expires; a 1000 sat round's 20000 msat lock can. No fee rule known: no lock.
  let feeRule = null;
  if (typeof client.feeRule === 'function') {
    try { const r = JSON.parse(await client.feeRule()); feeRule = { ppm: BigInt(r.fee_ppm), baseMsat: BigInt(r.fee_base_msat) }; }
    catch { feeRule = null; }
  }
  const feeGate = feeLockPays({ contract: round, fees: feeRule });
  const feeMsat = feeGate.pays ? feeGate.lockMsat : 0n;

  // FUNDED FOR EVERY LOCK ABOUT TO BE MADE, each quoted on its own. Measured in a real browser
  // (0.0.1236): the page quoted one 1000000 msat lock (1004544), held 1005056, made the 980000
  // stake lock (983552 with its fees), was left 21504 for a 20000 fee lock that costs more,
  // and the 556 msat top-up was refused - "Amount is too small to cover fees" - with the stake
  // already locked and no seat. Two locks are two transactions, each with its own fees.
  const fund = async (msats) => {
    const total = msats.reduce((t, m) => t + m, 0n);
    const allowance = msats.reduce((t, m) => t + BigInt(LockClient.lockAllowanceMsat(String(m))), 0n);
    for (let tries = 0; ; tries++) {
      const have = BigInt(await client.balanceMsat());
      let cost = 0n;
      for (const m of msats) {
        try { cost += BigInt(await client.lockCostMsat(String(m))); } catch (e) {
          if (!/insufficient funds/i.test(String((e && e.message) || e))) throw e;
          cost = null;
          break;
        }
      }
      onStep(`funding ${msats.map(String).join(' + ')} msat of lock: holding ${have} msat, the locks cost ${cost === null ? 'more than that' : `${cost} msat`}`);
      if (cost !== null && have >= cost) break;
      if (tries >= 3) throw new Error(`after ${tries} deposits the lock client holds ${have} msat and cannot fund ${total} msat of lock`);
      const short = cost !== null ? cost - have : total + allowance - have;
      // NEVER A DEPOSIT SMALLER THAN THE LOCKS' ALLOWANCE: a Lightning receive that small is
      // refused (measured, 556 msat), and the lock waiting for it is never made.
      const plan = JSON.parse(await client.depositFor(String(short > allowance ? short : allowance)));
      const invoice = JSON.parse(await client.receive(String(plan.invoice_msat), String(plan.gateway || '')));
      onDeposit({ invoice: invoice.invoice, amountMsat: BigInt(plan.invoice_msat), creditsMsat: BigInt(plan.credited_msat) });
      onStep('waiting for the deposit');
      const final = await client.awaitReceive(invoice.operation);
      if (final !== 'Claimed') throw new Error(`the deposit was not claimed: ${final}`);
    }
  };
  // ONE DEPOSIT FOR BOTH LOCKS, the stake lock's and the fee lock's costs quoted apart; a
  // fee lock still short when its turn comes is topped up (by at least the allowance).
  await fund(feeMsat > 0n ? [amount, feeMsat] : [amount]);

  onStep(`holding ${await client.balanceMsat()} msat before locking ${amount} msat (and ${feeMsat} msat of node fee after it)`);
  onStep('locking the stake');
  const refundPk = refundKeyOf(playerPubkey);
  const delta = Number(round.stakeExpiryBlocks) + LOCK_EXPIRY_MARGIN_BLOCKS;
  const answer = await client.lock(toHex(stake.stakePoint), String(amount), toHex(claimKey.claimPk), toHex(refundPk), delta);
  const lock = lockFromClient(answer, { point: stake.stakePoint, claimPk: claimKey.claimPk, refundPk });
  if (lock.fields.amountMsat !== amount)
    throw new Error(`the lock client locked ${lock.fields.amountMsat} msat, and this entry's net stake is ${amount}`);

  let feeLock = null;
  if (feeGate.pays) {
    await fund([feeMsat]);
    onStep('locking the node fee');
    const preimage = feeSecretFor(seed, roundId);
    const image = sha256(preimage);
    const said = await client.lockHash(toHex(image), String(feeMsat), toHex(claimKey.claimPk), toHex(refundPk), delta);
    const made = lockFromClient(said, { hash: image, claimPk: claimKey.claimPk, refundPk });
    if (made.fields.amountMsat !== feeMsat)
      throw new Error(`the lock client locked ${made.fields.amountMsat} msat as the fee, and this entry's fee is ${feeMsat}`);
    feeLock = { ...made, preimage };
  }
  return { ...lock, client, feeLock, feeGate };
}

const FEE_SECRET_TAG = new TextEncoder().encode('blwp fee preimage v1');

/**
 * THE FEE LOCK'S F, FROM THE SEED AND THE ROUND - handed over openly in the entry
 * (F5), never the stake's P. Derived, so a reload that kept the lock names the
 * same F.
 */
export function feeSecretFor(seed, roundId) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('a fee secret comes from the player\'s 32-byte seed');
  if (!(roundId instanceof Uint8Array) || roundId.length !== 32) throw new Error('a fee secret is per round');
  const m = new Uint8Array(FEE_SECRET_TAG.length + 64);
  m.set(FEE_SECRET_TAG); m.set(seed, FEE_SECRET_TAG.length); m.set(roundId, FEE_SECRET_TAG.length + 32);
  return sha256(m);
}

const savedLockKey = (roundId, playerPubkey) => `blwp.lock.saved.${toHex(roundId)}.${toHex(playerPubkey).slice(0, 16)}`;

/**
 * A LOCK THIS TAB MADE, WITH THE STAKE IT LOCKS - kept so a reload before any
 * seat has committed it uses the same stake and the same lock. The stake's
 * preimage is kept where the player's seed already is (the tab's storage), and
 * its handout as the bytes the seats took.
 */
export function saveLock(storage, { roundId, playerPubkey, stake, lock }) {
  storage.setItem(savedLockKey(roundId, playerPubkey), JSON.stringify({
    preimage: toHex(stake.preimage), body: toHex(stake.body),
    outpoint: { txid: toHex(lock.outpoint.txid), outIdx: String(lock.outpoint.outIdx) },
    fields: lockFieldsToJson(lock.fields), committedTo: null,
    // AND ITS FEE LOCK, when one was minted (Pick b): the same reload keeps it.
    feeLock: lock.feeLock ? { preimage: toHex(lock.feeLock.preimage),
      outpoint: { txid: toHex(lock.feeLock.outpoint.txid), outIdx: String(lock.feeLock.outpoint.outIdx) },
      fields: lockFieldsToJson(lock.feeLock.fields) } : null,
  }));
}

/** The kept lock for this round and player, rebuilt - or null. `committedTo` names the entry a seat committed it to. */
export function savedLock(storage, { roundId, playerPubkey }) {
  let raw = null;
  try { raw = storage && storage.getItem(savedLockKey(roundId, playerPubkey)); } catch { return null; }
  if (!raw) return null;
  const j = JSON.parse(raw);
  const preimage = fromHex(j.preimage);
  const body = fromHex(j.body);
  const handout = decodeHandout(body);
  if (toHex(handout.playerPubkey) !== toHex(playerPubkey)) return null;
  return {
    stake: { preimage, stakeCommitment: sha256(preimage), vssSharesRef: handoutId(handout),
      stakePoint: handout.commitments[0], handout, body },
    lock: { outpoint: { txid: fromHex(j.outpoint.txid), outIdx: BigInt(j.outpoint.outIdx) }, fields: lockFieldsFromJson(j.fields),
      feeLock: j.feeLock ? { preimage: fromHex(j.feeLock.preimage),
        outpoint: { txid: fromHex(j.feeLock.outpoint.txid), outIdx: BigInt(j.feeLock.outpoint.outIdx) },
        fields: lockFieldsFromJson(j.feeLock.fields) } : null },
    committedTo: j.committedTo || null,
  };
}

/** A seat committed the kept lock to `entryId`: from now on it is that seat's stake, not one to reuse. */
/**
 * WHAT A TAB DOES WITH THE LOCK IT KEPT FOR THIS ROUND, ON A RELOAD (6d, W4 hole 1). None:
 * a new join. One no seat committed: the same stake and lock, no second deposit (W1b).
 * One a seat COMMITTED to an entry: that seat is taken and its stake is locked - measured
 * before: the page dealt a new stake and set out to fund "980000 + 20000 msat of lock",
 * a second deposit for a round the player already stakes. The run itself cannot be
 * resumed (its session key lives in the player and is not kept), so the join stops, says
 * why, and the payout and stake are still collected from the tab's kept record.
 */
export function keptLockUse(kept) {
  if (!kept) return { use: 'new' };
  if (!kept.committedTo) return { use: 'reuse', kept };
  return { use: 'staked', kept,
    why: `this tab's stake in this round is already locked and committed to entry ${String(kept.committedTo).slice(0, 16)}…: `
      + 'no second deposit - the run cannot be resumed after a reload, and its payout and stake are collected after the window' };
}

export function markLockCommitted(storage, { roundId, playerPubkey, entryId }) {
  const key = savedLockKey(roundId, playerPubkey);
  const raw = storage.getItem(key);
  if (!raw) return;
  storage.setItem(key, JSON.stringify({ ...JSON.parse(raw), committedTo: toHex(entryId) }));
}

/**
 * THE PLAYER'S LOCKS IN A ROUND, FOUND BY THEIR REFUND KEY (W5a): what a
 * session holding only the seed can ask - the refund key is derived from it,
 * the outpoint and stake point were random. Each seat answers with the locks it
 * verified; the lock client then refuses one the guardians do not hold as
 * rebuilt, so a lying seat can point at nothing this key can spend.
 */
export async function findLock({ roundId, playerPubkey, nodes, fetcher = fetch } = {}) {
  const refund = toHex(refundKeyOf(playerPubkey));
  const found = new Map();
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/stake-lock?round=${toHex(roundId)}&refund=${refund}`);
      if (!r.ok) continue;
      for (const l of await r.json()) {
        const [txid, outIdx] = String(l.outpoint).split(':');
        if (!found.has(l.outpoint))
          found.set(l.outpoint, { outpoint: { txid: fromHex(txid), outIdx: BigInt(outIdx) }, fields: lockFieldsFromJson(l.fields), entryId: l.entryId });
      }
    } catch { /* a seat that does not answer is one of several */ }
  }
  return [...found.values()];
}

/**
 * THE PLAYER'S REFUND, FROM THE SEED ALONE (§23.2: the default path - nobody
 * acts, the lock expires, the player's key takes it back). The seed gives the
 * round's player key and the lock client's secret; the seats say where the lock
 * is; a fresh wallet under the seed's secret spends it with the player's key.
 * The guardians refuse it before the lock's expiration - reported, not thrown.
 */
export async function refundStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve });
  onStep('asking the seats where this seed\'s lock is');
  const locks = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher });
  if (!locks.length) throw new Error('no seat knows a stake lock that refunds to this seed\'s key in this round');
  const secret = lockSecretFor(seed, roundId);
  const store = storage ? lockStoreFor(storage, roundId, secret) : unkeptLockStore();
  onStep('joining the federation');
  const client = await LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
  const refunds = [];
  for (const l of locks) {
    onStep('refunding the lock');
    const said = JSON.parse(await client.refund(toHex(l.outpoint.txid), Number(l.outpoint.outIdx),
      JSON.stringify(lockFieldsToJson(l.fields)), toHex(player.secret)));
    refunds.push({ outpoint: l.outpoint, ...said });
  }
  return { client, refunds };
}

/**
 * THE COMMITTEE'S FORFEIT OF THIS PLAYER'S LOCK, from the seats (GET /forfeit,
 * W5b): a BIP-340 signature by the round's claim key over the lock's contract
 * id, made only for a qualifier after the window. The first seat that has it
 * answers; a loser's is refused by every seat, with the seats' reasons. The
 * lock client checks it under the contract (and the guardians again) - a seat
 * that answers with bytes that are not the forfeit gets nothing through.
 */
export async function forfeitOf({ roundId, entryId, nodes, fetcher = fetch } = {}) {
  const refused = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/forfeit?round=${toHex(roundId)}&entry=${entryId}`);
      if (!r.ok) { refused.push(`${node}: ${r.status} ${(await r.text()).trim()}`); continue; }
      const j = await r.json();
      if (/^[0-9a-f]{128}$/.test(String(j.signature))) return { ok: true, signature: j.signature, contractId: j.contractId, claimPk: j.claimPk, from: node };
      refused.push(`${node}: answered no signature`);
    } catch (e) { refused.push(`${node}: ${e.message}`); }
  }
  return { ok: false, why: `no seat gave a forfeit of this lock: ${refused.join('; ')}`, refused };
}

/**
 * THE PLAYER'S REDEEM OF A FORFEITED LOCK, FROM THE SEED ALONE (§23.2 row 1:
 * "the player's own client redeems it, and only the player can"). The seed
 * gives the round's player key and the lock client's secret; the seats say
 * where the lock is and give the committee's forfeit; a fresh wallet under the
 * seed's secret spends the lock with the player's key.
 */
export async function redeemStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  client: given = null, onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve });
  onStep('asking the seats where this seed\'s lock is');
  const locks = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher });
  if (!locks.length) throw new Error('no seat knows a stake lock that refunds to this seed\'s key in this round');
  const forfeits = [];
  for (const l of locks) {
    onStep('asking the seats for the forfeit of the lock');
    const f = await forfeitOf({ roundId, entryId: l.entryId, nodes, fetcher });
    if (!f.ok) throw new Error(f.why);
    forfeits.push({ lock: l, forfeit: f });
  }
  const secret = lockSecretFor(seed, roundId);
  const store = storage ? lockStoreFor(storage, roundId, secret) : unkeptLockStore();
  // THE WALLET THE PAYOUT WAS JUST COLLECTED INTO, when there is one (6d): one
  // client over the tab's store, not a second opened beside it.
  if (!given) onStep('joining the federation');
  const client = given || await LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
  const redeems = [];
  for (const { lock: l, forfeit: f } of forfeits) {
    onStep('redeeming the lock');
    const said = JSON.parse(await client.redeem(toHex(l.outpoint.txid), Number(l.outpoint.outIdx),
      JSON.stringify(lockFieldsToJson(l.fields)), f.signature, toHex(player.secret)));
    redeems.push({ outpoint: l.outpoint, forfeitFrom: f.from, ...said });
  }
  return { client, redeems };
}

/**
 * THE ROUND'S SETTLEMENT AS THE SEATS HOLD IT (GET /lock-settlement, W4): the first
 * seat whose settlement the guardians ACCEPTED - its txid and what it moved. The
 * guardians check every payout again when it is spent, so a seat that lies here
 * points at nothing this key can take.
 */
export async function settlementOf({ roundId, nodes, fetcher = fetch } = {}) {
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock-settlement?round=${toHex(roundId)}`);
      if (!r.ok) { said.push(`${node}: ${r.status}`); continue; }
      const j = await r.json();
      if (j.state === 'ACCEPTED' && j.moved && Array.isArray(j.moved.payouts)) return { ok: true, txid: j.txid, moved: j.moved, from: node };
      said.push(`${node}: ${j.state}`);
    } catch (e) { said.push(`${node}: ${e.message}`); }
  }
  return { ok: false, why: `no seat holds an accepted settlement of this round yet (${said.join('; ')})` };
}

/**
 * THE WINNER COLLECTS ITS PAYOUT (6d, W4): the pre-expired payout contract the
 * seats' one settlement made to this seed's key for this round, spent by Refund
 * under that key - open at once, and only that key can. A loser, or a player the
 * table pays nothing on top of their own stake, finds no payout and is told so;
 * nothing is asked of the lock client then. The winner's own stake comes back by
 * its forfeit (`redeemStake`).
 */
export async function redeemPayout({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  client: given = null, onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so it has no payout contract');
  // A PAYOUT THIS TAB ALREADY COLLECTED is answered from the tab's note: after a
  // reload the contract is spent, and asking the federation again could only fail
  // every time the page asks.
  const noted = `${PAYOUT_NOTE}${toHex(roundId)}`;
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) return { ...JSON.parse(kept), amountMsat: BigInt(JSON.parse(kept).amountMsat), ok: true, final: true, kept: true };
  } catch { /* an unreadable note is no note */ }
  const player = playerFor({ ...round, id: roundId }, { seed, curve });
  const mine = toHex(refundKeyOf(player.pubkey));
  onStep('asking the seats for the round\'s settlement');
  const s = await settlementOf({ roundId, nodes, fetcher });
  if (!s.ok) return { ok: false, final: false, why: s.why };
  const at = s.moved.payouts.findIndex((p) => p.kind === 'qualifier' && String(p.pk).toLowerCase() === mine);
  if (at < 0) return { ok: false, final: true, txid: s.txid, why: 'the round\'s settlement pays this seed\'s key nothing: no payout to collect' };
  const p = s.moved.payouts[at];
  const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(p.msat), claimPk: mine, refundPk: mine, expiration: 0 };
  const secret = lockSecretFor(seed, roundId);
  const store = storage ? lockStoreFor(storage, roundId, secret) : unkeptLockStore();
  // THE WALLET THE WITHDRAW WILL PAY FROM, when the caller has it open (one client over the store).
  if (!given) onStep('joining the federation');
  const client = given || await LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
  onStep('collecting the payout');
  const said = JSON.parse(await client.refund(s.txid, at, JSON.stringify(fields), toHex(player.secret)));
  // ALREADY SPENT: the guardians hold no contract there any more, and only this key could
  // spend it - collected before (a reload mid-collect, another tab). Final, and said so;
  // measured before: "waiting ... undefined" for ever, and the stake never asked.
  const spent = said.accepted !== true && (said.stored_before === null || said.stored_before === undefined);
  const got = { ok: said.accepted === true, final: said.accepted === true || spent, spent, txid: s.txid, outIdx: at, amountMsat: BigInt(p.msat), from: s.from,
    ...said, why: said.accepted === true ? undefined : spent ? 'the payout contract is already spent - by this seed\'s key, the only key that can' : (said.error || 'the federation did not accept the refund') };
  if (got.ok && storage) {
    try { storage.setItem(noted, JSON.stringify({ ...got, amountMsat: String(got.amountMsat) })); } catch { /* unkept: a reload asks again */ }
  }
  return { ...got, client };
}
const PAYOUT_NOTE = 'blwp.payout.';

/**
 * AND THE PLAYER'S OWN STAKE BACK, AFTER THE WINDOW (6d, §23.2 row 1). The seats
 * forfeit a qualifier's lock only once its result is FINAL with the window closed;
 * the page asks only once the seats hold an ACCEPTED settlement, which they make
 * only then. Given, the lock is redeemed into the tab's wallet (`redeemStake`) and
 * kept in the tab; refused because the run did not qualify, it is final - that
 * stake went into the round's pool - and the lock client is asked nothing; refused
 * for anything else (the window, a seat short), asked again.
 */
export async function returnStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  client = null, onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const noted = `${STAKE_NOTE}${toHex(roundId)}`;
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) { const k = JSON.parse(kept); return { ...k, amountMsat: BigInt(k.amountMsat), ok: true, final: true, kept: true }; }
  } catch { /* an unreadable note is no note */ }
  const s = await settlementOf({ roundId, nodes, fetcher });
  if (!s.ok) return { ok: false, final: false, why: s.why };
  let got;
  try {
    got = await redeemStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher, client, onStep });
  } catch (e) {
    const lost = /that run is \S+ with score/.test(e.message);
    return { ok: false, final: lost,
      why: lost ? 'the seats forfeit this seed\'s lock to nobody: the run did not qualify, so its stake went into the round\'s pool' : e.message };
  }
  const rs = got.redeems;
  const ok = rs.length > 0 && rs.every((r) => r.accepted === true);
  // ALREADY BACK: the seats forfeit only a qualifier's lock, and after that only this seed's
  // refund key can spend it (the committee's claim needs P, which only a loser's gives up) -
  // so a lock the guardians no longer hold came back to this key already (another tab, a
  // reload mid-redeem). Final, and said so; measured before: "not back yet - ... No contract
  // found for given ContractId", asked again every 5 s.
  const spent = !ok && rs.length > 0 && rs.every((r) => r.accepted !== true && (r.stored_before === null || r.stored_before === undefined));
  const res = { ok, final: ok || spent, spent, amountMsat: BigInt(rs.reduce((t, r) => t + Number(r.amount_msat || 0), 0)),
    balance_before: rs.length ? rs[0].balance_before : undefined, balance_after: rs.length ? rs[rs.length - 1].balance_after : undefined,
    txid: rs.length ? rs[0].txid : undefined, forfeitFrom: rs.length ? rs[0].forfeitFrom : undefined,
    why: ok ? undefined : spent ? 'the stake lock is already spent - back to this seed\'s key, the only key that can after the seats\' forfeit'
      : (rs.find((r) => r.error) || {}).error || 'the federation did not accept the redeem' };
  if (ok && storage) {
    try { storage.setItem(noted, JSON.stringify({ ...res, amountMsat: String(res.amountMsat) })); } catch { /* unkept: a reload asks again */ }
  }
  return { ...res, client: got.client };
}
const STAKE_NOTE = 'blwp.stakeback.';

/**
 * WHAT A TAB STILL HAS TO COLLECT, KEPT IN THE TAB (6d). Measured before: a reload
 * after the seats committed the entry lost the collect's state - the join's lock
 * branch is its only setter, and a reload does not pass it - and 60 s after the
 * settlement the federation still held the winner's 978000 msat payout and 980000
 * msat stake. So the join keeps, per round, what the collect needs (the round, the
 * invite, the seats, the tab's seed, the lock), and the page collects from these
 * records on every load until both answers are final.
 */
export function saveCollect(storage, { roundIdHex, round, invite, nodes, seed, stakeLock = null } = {}) {
  try {
    const key = `${COLLECT_NOTE}${roundIdHex}`;
    const was = storage.getItem(key);
    const done = was ? (JSON.parse(was).done || null) : null;
    // THE LOCK IS FOR THE PANEL'S LINE ONLY - the collect finds the lock through the seats.
    // Measured on 0.0.1236: a lock that did not encode threw the whole record away, and
    // with it the collect (978000 + 980000 msat left in the federation). Kept if it encodes.
    let lock = null;
    try {
      if (stakeLock) lock = { outpoint: `${toHex(stakeLock.outpoint.txid)}:${String(stakeLock.outpoint.outIdx)}`, fields: lockFieldsToJson(stakeLock.fields) };
    } catch { lock = null; }
    storage.setItem(key, JSON.stringify({ roundIdHex, round: toHex(encodeRoundContract(round)), invite, nodes, seed: toHex(seed),
      stakeLock: lock, done, savedMs: Date.now() }));
    return true;
  } catch { return false; }
}

/** Every collect this tab keeps, oldest first; an unreadable record is skipped. */
export function savedCollects(storage) {
  const out = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(COLLECT_NOTE)) continue;
      try {
        const r = JSON.parse(storage.getItem(k));
        const [txid, outIdx] = r.stakeLock ? String(r.stakeLock.outpoint).split(':') : [null, null];
        out.push({ roundIdHex: r.roundIdHex, round: decodeRoundContract(fromHex(r.round)), invite: r.invite, nodes: r.nodes, seed: fromHex(r.seed),
          stakeLock: r.stakeLock ? { outpoint: { txid: fromHex(txid), outIdx: BigInt(outIdx) }, fields: lockFieldsFromJson(r.stakeLock.fields) } : null,
          done: r.done || null, savedMs: Number(r.savedMs) || 0 });
      } catch { /* an unreadable record is no record */ }
    }
  } catch { /* no storage: nothing kept */ }
  return out.sort((a, b) => a.savedMs - b.savedMs);
}

/** A round whose payout and stake answers are both final: the lines kept, and it is not asked again. */
export function markCollectDone(storage, roundIdHex, done) {
  try {
    const key = `${COLLECT_NOTE}${roundIdHex}`;
    const r = JSON.parse(storage.getItem(key));
    if (!r) return false;
    storage.setItem(key, JSON.stringify({ ...r, done }));
    return true;
  } catch { return false; }
}
const COLLECT_NOTE = 'blwp.collect.';

/**
 * THE ROUND'S FEDERATION WALLET IN THIS TAB - the one the payout and the stake were
 * collected into: the same secret (from the seed and the round) and the same store.
 */
export async function tabLockWallet({ round, roundId, invite, seed, LockClient, storage }) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so it has no wallet');
  const secret = lockSecretFor(seed, roundId);
  const store = storage ? lockStoreFor(storage, roundId, secret) : unkeptLockStore();
  return LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
}

/**
 * 6d'S DESTINATION (24A.2): "the client withdraws it over Lightning through any listed
 * gateway". Measured before: the page collected the payout and the stake back into the
 * tab's own federation wallet and never withdrew - a winner who closed the tab kept
 * nothing. The whole withdrawable balance (after the gateway's and the federation's fees,
 * the stock client's own sum) goes to an invoice from the player's own wallet: made by
 * their connected wallet, or pasted. Nothing is remembered between withdraws.
 */
export async function withdrawCollected({ client, invoiceFor, onStep = () => {} } = {}) {
  const withdrawable = BigInt(await client.withdrawableMsat());
  if (withdrawable <= 0n) return { ok: false, final: true, withdrawableMsat: 0n, why: 'nothing in this tab\'s wallet to withdraw' };
  onStep(`asking the player's wallet for an invoice of ${withdrawable} msat`);
  const inv = await invoiceFor(withdrawable);
  if (!inv || !inv.ok) return { ok: false, final: false, withdrawableMsat: withdrawable, why: (inv && inv.why) || 'no invoice to withdraw to' };
  onStep('withdrawing over Lightning');
  const said = JSON.parse(await client.withdraw(inv.invoice));
  const ok = said.state === 'Success';
  return { ok, final: ok, withdrawableMsat: withdrawable, invoiceMsat: said.invoice_msat == null ? null : BigInt(said.invoice_msat),
    state: said.state, gateway: said.gateway, balance_before: said.balance_before, balance_after: said.balance_after,
    why: ok ? undefined : `the withdraw ended ${said.state}${said.state === 'Refunded' ? ' - the money is back in this tab\'s wallet' : ''}` };
}

/**
 * A LOCK NO SEAT WILL SETTLE, BACK BY THE PLAYER'S OWN KEY AFTER ITS EXPIRY (§23.2's default
 * path: nobody acts, the lock expires, the player's key takes it back). W4 / 6d: a player the
 * fee-lock door refused, or a round that never settles - no seat verified the lock or will
 * forfeit it, so refundStake (which asks the seats where the lock is) finds nothing. The tab's
 * own record (saveLock) holds both locks whole. Each is asked where it stands, spending
 * nothing (lockStatus): gone - nothing to do; before its expiry - not final, and when it comes
 * back; expired - refunded into the tab's wallet, from where the withdraw takes it.
 */
export async function refundKept({ round, roundId, seed, curve, client, storage, kept = null } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so it has no lock to refund');
  const player = playerFor({ ...round, id: roundId }, { seed, curve });
  const held = kept || savedLock(storage, { roundId, playerPubkey: player.pubkey });
  if (!held || !held.lock) return { ok: false, final: true, locks: [], why: 'this tab keeps no lock for this round' };
  const locks = [{ kind: 'stake', outpoint: held.lock.outpoint, fields: held.lock.fields }];
  if (held.lock.feeLock) locks.push({ kind: 'fee', outpoint: held.lock.feeLock.outpoint, fields: held.lock.feeLock.fields });
  const each = [];
  for (const l of locks) {
    const txid = toHex(l.outpoint.txid);
    const outIdx = Number(l.outpoint.outIdx);
    const amountMsat = BigInt(l.fields.amountMsat);
    const st = JSON.parse(await client.lockStatus(txid, outIdx));
    if (!st.stored) { each.push({ kind: l.kind, state: 'gone', amountMsat }); continue; }
    const left = Number(st.stored.blocks_left);
    if (left > 0) {
      each.push({ kind: l.kind, state: 'waiting', amountMsat, blocksLeft: left, blockCount: Number(st.block_count), expiration: Number(l.fields.expiration) });
      continue;
    }
    const said = JSON.parse(await client.refund(txid, outIdx, JSON.stringify(lockFieldsToJson(l.fields)), toHex(player.secret)));
    each.push({ kind: l.kind, state: said.accepted === true ? 'refunded' : 'refused', amountMsat, error: said.error || null,
      balance_before: said.balance_before, balance_after: said.balance_after });
  }
  const refunded = each.filter((e) => e.state === 'refunded');
  const open = each.some((e) => e.state === 'waiting' || e.state === 'refused');
  return { ok: refunded.length > 0 && !open, final: !open, locks: each,
    refundedMsat: refunded.reduce((t, e) => t + e.amountMsat, 0n),
    balance_before: refunded.length ? refunded[0].balance_before : undefined,
    balance_after: refunded.length ? refunded[refunded.length - 1].balance_after : undefined };
}

/**
 * WHAT THIS SEED IS OWED IN THIS ROUND, SPENDING NOTHING (W4 / 6d). Measured before: the page
 * collected the payout and redeemed the stake into the TAB's wallet (bearer e-cash in
 * sessionStorage) every 5 s, and withdrawing waited for the player - a tab closed in between
 * lost it, and the federation no longer held it (run 15). So the page only LOOKS until the
 * player withdraws: the settlement (the payout to this key), the seats' /stake-lock and
 * /forfeit (the stake back), and the federation's read-only lockStatus (a lock no seat will
 * settle, after its expiry). `refund` and `redeem` are never called here.
 */
export async function lookOwed({ round, roundId, seed, curve, nodes, fetcher = fetch, client = null, storage = null, kept = null } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so nothing in it is owed from a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve });
  const mine = toHex(refundKeyOf(player.pubkey));
  const rid = toHex(roundId);
  const note = (k) => { try { const v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
  // STILL AT ITS OUTPOINT? The federation's read-only answer; without a wallet it is not asked.
  const held = async (txid, outIdx) => !client || !!JSON.parse(await client.lockStatus(txid, Number(outIdx))).stored;
  const s = await settlementOf({ roundId, nodes, fetcher });
  let payout;
  const paidNote = note(`${PAYOUT_NOTE}${rid}`);
  if (paidNote) payout = { state: 'collected', msat: BigInt(paidNote.amountMsat) };
  else if (!s.ok) payout = { state: 'waiting', why: s.why };
  else {
    const at = s.moved.payouts.findIndex((x) => x.kind === 'qualifier' && String(x.pk).toLowerCase() === mine);
    if (at < 0) payout = { state: 'none' };
    // ALREADY SPENT - only this key can: collected before (another tab, an earlier build's timer).
    else payout = { state: await held(s.txid, at) ? 'owed' : 'gone', msat: BigInt(s.moved.payouts[at].msat) };
  }
  let stake;
  const backNote = note(`${STAKE_NOTE}${rid}`);
  if (backNote) stake = { state: 'collected', msat: BigInt(backNote.amountMsat) };
  else {
    const locks = s.ok ? await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher }) : [];
    if (locks.length) {
      let msat = 0n;
      for (const l of locks) if (await held(toHex(l.outpoint.txid), l.outpoint.outIdx)) msat += BigInt(l.fields.amountMsat);
      const whole = locks.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);
      if (msat === 0n) stake = { state: 'gone', how: 'forfeit', msat: whole };
      else {
        const f = await forfeitOf({ roundId, entryId: locks[0].entryId, nodes, fetcher });
        if (f.ok) stake = { state: 'owed', msat, how: 'forfeit' };
        else if (/that run is \S+ with score/.test(f.why)) stake = { state: 'lost', msat };
        else stake = { state: 'waiting', msat, why: f.why };
      }
    } else {
      // NO SEAT KNOWS THE LOCK (refused at the door) OR NO SETTLEMENT YET: the tab's own record,
      // asked of the federation without spending - owed back by the player's key after expiry.
      const held = kept || savedLock(storage, { roundId, playerPubkey: player.pubkey });
      const ls = held && held.lock ? [held.lock, held.lock.feeLock].filter(Boolean) : [];
      if (!ls.length) stake = { state: s.ok ? 'none' : 'waiting', why: 'this tab keeps no lock for this round' };
      else if (!client) stake = { state: 'waiting', why: 'the federation was not asked yet' };
      else {
        let owed = 0n; let gone = 0; let waiting = null;
        for (const l of ls) {
          const st = JSON.parse(await client.lockStatus(toHex(l.outpoint.txid), Number(l.outpoint.outIdx)));
          if (!st.stored) { gone++; continue; }
          if (Number(st.stored.blocks_left) > 0) { waiting = { expiration: Number(l.fields.expiration), blockCount: Number(st.block_count) }; continue; }
          owed += BigInt(l.fields.amountMsat);
        }
        const total = ls.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);
        if (waiting) stake = { state: 'waiting', how: 'refund', msat: total, ...waiting };
        else if (owed > 0n) stake = { state: 'owed', how: 'refund', msat: owed };
        // GONE AFTER ITS EXPIRY: back to the player's key (this tab's refund, or another start's).
        else stake = { state: 'gone', how: 'refund', msat: total };
      }
    }
  }
  const owed = (how) => (stake.state === 'owed' && stake.how === how ? stake.msat : 0n);
  const payoutMsat = payout.state === 'owed' ? payout.msat : 0n;
  // WHAT THIS TAB'S WALLET HOLDS - read, not spent (the stock client throws on an empty one).
  let inTabMsat = 0n;
  if (client) { try { inTabMsat = BigInt(await client.withdrawableMsat()); } catch { inTabMsat = 0n; } }
  let tabBalanceMsat = null;
  if (client && typeof client.balanceMsat === 'function') { try { tabBalanceMsat = BigInt(await client.balanceMsat()); } catch { tabBalanceMsat = null; } }
  // FINAL: the federation holds nothing more of this seed's in this round. The tab's own balance is apart.
  const final = ['none', 'gone', 'collected'].includes(payout.state) && ['lost', 'gone', 'none', 'collected'].includes(stake.state);
  return { payout, stake, payoutMsat, stakeMsat: owed('forfeit'), refundMsat: owed('refund'), stakeLost: stake.state === 'lost',
    owedMsat: payoutMsat + owed('forfeit') + owed('refund'), inTabMsat, tabBalanceMsat, final, settled: s.ok };
}

/** WHAT THE PLAYER IS OWED, AS THEY SEE IT: yours in the federation until you withdraw, when it comes back, or nothing. */
export function owedToLine(o) {
  if (!o || !o.payout || !o.stake) return '';
  const parts = [];
  if (o.payoutMsat > 0n) parts.push(`${o.payoutMsat} msat payout`);
  if (o.stakeMsat > 0n) parts.push(`your ${o.stakeMsat} msat stake`);
  if (o.refundMsat > 0n) parts.push(`your ${o.refundMsat} msat of lock back by your own key`);
  if (parts.length) return `${parts.join(' and ')} - yours in the round's federation until you withdraw it; nothing is taken out before you press Withdraw`;
  if (o.stake.state === 'waiting' && o.stake.how === 'refund')
    return `${o.payout.state === 'none' ? 'No payout · ' : ''}Your lock (stake ${o.stake.msat} msat) comes back to your key from federation block ${o.stake.expiration} (now ${o.stake.blockCount})`;
  if (o.final) {
    const p = { none: 'No payout', gone: `Payout ${o.payout.msat} msat: no longer in the federation - your key collected it before (another tab, or an earlier build)`,
      collected: `Payout ${o.payout.msat} msat collected` }[o.payout.state];
    const k = { lost: 'No stake back: the run did not qualify, so its stake went into the round\'s pool',
      gone: o.stake.how === 'forfeit' ? `Stake ${o.stake.msat} msat: no longer in the federation - back to your key before`
        : o.stake.how === 'refund' ? `Stake ${o.stake.msat} msat: no longer in the federation - back to your key after its expiry` : 'No stake back: no lock of yours is left in the federation for this round',
      none: 'No stake back: nothing of yours is left in the federation for this round', collected: `Stake ${o.stake.msat} msat back` }[o.stake.state];
    return `${p} · ${k}`;
  }
  if (o.inTabMsat > 0n) return `${o.inTabMsat} msat is in this tab's wallet - withdraw it before you close the tab`;
  if (!o.settled) return 'Waiting for the seats\' settlement';
  return 'Waiting for the seats';
}

/**
 * COLLECT WHAT IS OWED, INSIDE THE WITHDRAW ONLY (W4 / 6d): the payout redeemed, the stake back
 * by the seats' forfeit or by the player's key after expiry - all into the one wallet the
 * withdraw pays from, in the same action. Nothing is collected while the player is not there.
 */
export async function collectOwed({ look, client, ...ask } = {}) {
  const got = { payout: null, stake: null, refund: null };
  if (look.payoutMsat > 0n) got.payout = await redeemPayout({ ...ask, client });
  if (look.stakeMsat > 0n) got.stake = await returnStake({ ...ask, client });
  if (look.refundMsat > 0n) got.refund = await refundKept({ ...ask, client });
  return got;
}

/**
 * COLLECT AND WITHDRAW IN ONE ACTION (W4 / 6d): looked at again as the player presses, collected
 * into the one wallet, and at once out to the player's own. With no invoice to pay (no wallet
 * connected, none pasted) nothing is collected: the money stays in the federation, not the tab.
 * A PASTED INVOICE NEVER COLLECTS: it is for a fixed amount, and what the tab can pay after the
 * federation's and the gateway's fees is known only once collected (live, run 15: 978000 +
 * 980000 msat collected became a 1951232 msat balance) - an invoice for the owed amount would
 * fail after the collect and leave the money in the tab. It pays what is already in the tab,
 * and only when it fits; the federation's money leaves through a wallet asked for the exact sum.
 */
export async function collectAndWithdraw({ look = null, client, invoiceFor, canInvoice = true, pasted = null, onStep = () => {}, ...ask } = {}) {
  const none = (why) => ({ payout: null, stake: null, refund: null, look, withdraw: { ok: false, final: false, why } });
  if (!canInvoice) return none('connect your wallet or paste an invoice from it - nothing was collected, it stays in the federation');
  let fixed = null;
  if (pasted) {
    try { fixed = decodeBolt11(pasted).amountMsat; } catch (e) { return none(`that is not an invoice (${e.message}) - nothing was collected`); }
    if (fixed === null) return none('that invoice names no amount, and this withdraw pays only an invoice with one - nothing was collected');
  }
  const seen = look || await lookOwed({ ...ask, client });
  if (fixed !== null && seen.owedMsat > 0n)
    return { ...none(`an invoice pasted for a fixed ${fixed} msat cannot be matched to what this tab can pay after the federation's and the gateway's fees, known only once collected - connect your wallet to withdraw the ${seen.owedMsat} msat the federation holds for you; nothing was collected, it stays in the federation`), look: seen };
  if (fixed !== null && fixed > seen.inTabMsat)
    return { ...none(`the invoice asks ${fixed} msat and this tab's wallet can pay ${seen.inTabMsat} msat - paste one for at most that`), look: seen };
  const got = await collectOwed({ look: seen, client, onStep, ...ask });
  const withdraw = await withdrawCollected({ client, invoiceFor, onStep });
  return { ...got, look: seen, withdraw };
}

/** THE REFUND AS THE PLAYER SEES IT: when the locks come back, what came back, or that they are gone. */
export function refundLine(k) {
  if (!k || !Array.isArray(k.locks) || !k.locks.length) return '';
  const waiting = k.locks.filter((e) => e.state === 'waiting');
  if (waiting.length) {
    const at = Math.max(...waiting.map((e) => e.expiration));
    return `Your lock${waiting.length > 1 ? 's' : ''} (${waiting.map((e) => `${e.kind} ${e.amountMsat} msat`).join(', ')}) come${waiting.length > 1 ? '' : 's'} back to your key from federation block ${at} (now ${waiting[0].blockCount})`;
  }
  const refused = k.locks.filter((e) => e.state === 'refused');
  if (refused.length) return `Refund refused: ${refused.map((e) => `${e.kind}: ${e.error || 'the federation did not accept it'}`).join('; ')} - asked again`;
  if (k.ok) return `Back by your own key after expiry: ${k.refundedMsat} msat to this tab's wallet (${k.locks.filter((e) => e.state === 'refunded').map((e) => e.kind).join(' + ')} lock${k.locks.length > 1 ? 's' : ''}; balance ${k.balance_before} → ${k.balance_after} msat)`;
  return 'No lock of yours is left in the federation for this round';
}

/** THE WITHDRAW AS THE PLAYER SEES IT: what can go, what went, or why not. */
export function withdrawLine(w, withdrawableMsat = null) {
  if (w && w.ok) return `Withdrawn: ${String(w.invoiceMsat ?? w.withdrawableMsat)} msat to your own wallet over Lightning (this tab's wallet ${w.balance_before} → ${w.balance_after} msat)`;
  if (w && !w.ok && w.why) return `Withdraw: ${w.why}`;
  if (withdrawableMsat !== null && BigInt(withdrawableMsat) > 0n)
    return `${String(withdrawableMsat)} msat is in this tab's wallet - withdraw it to your own wallet before you close the tab`;
  return '';
}

/** THE STAKE AS THE PLAYER SEES IT AFTER THE WINDOW (6d): back, gone into the pool, or not yet. */
export function stakeBackLine(p) {
  if (!p) return '';
  if (p.ok) return `Stake returned: ${String(p.amountMsat)} msat back to this tab's federation wallet by the seats' forfeit`
    + (p.balance_after !== undefined ? ` (balance ${p.balance_before} → ${p.balance_after} msat)` : '');
  if (p.spent) return `Stake already back: ${String(p.amountMsat)} msat - ${p.why}`;
  if (p.final) return `No stake back: ${p.why}`;
  return `Stake: not back yet - ${p.why}`;
}

/** THE PAYOUT AS THE PLAYER SEES IT (6d): collected, none, or still waiting on the seats. */
export function payoutLine(p) {
  if (!p) return '';
  if (p.ok) return `Payout collected: ${String(p.amountMsat)} msat from the round's settlement into this tab's federation wallet`
    + (p.balance_after !== undefined ? ` (balance ${p.balance_before} → ${p.balance_after} msat)` : '');
  if (p.spent) return `Payout already collected: ${String(p.amountMsat)} msat - ${p.why}`;
  if (p.final) return `No payout: ${p.why}`;
  return `Payout: waiting for the seats' settlement - ${p.why}`;
}

/**
 * THE LOCK, HANDED TO EVERY SEAT (POST /lock). A seat that verifies it in the
 * federation answers 201 and counts the stake; `ok` is `needed` of them.
 */
export async function handLock({ entryId, fields, nodes, needed, fetcher = fetch, door = 'lock' } = {}) {
  if (!(entryId instanceof Uint8Array) || entryId.length !== 32) throw new Error('a lock is handed over for an entry, by its id');
  // `door`: 'lock' for the stake lock, 'fee-lock' for the fee lock (Pick b).
  if (door !== 'lock' && door !== 'fee-lock') throw new Error('a lock is handed to a seat\'s /lock or /fee-lock');
  const body = JSON.stringify(lockFieldsToJson(fields));
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/${door}?entry=${toHex(entryId)}`, { method: 'POST', body });
      said.push({ node, status: r.status, why: (await r.text()).trim() });
    } catch (e) {
      said.push({ node, status: 0, why: e.message });
    }
  }
  const committed = said.filter((s) => s.status === 201).length;
  return { ok: committed >= needed, committed, needed, said };
}
