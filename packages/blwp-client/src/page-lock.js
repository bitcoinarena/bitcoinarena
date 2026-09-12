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
import { roundLocks, playerFor } from './join.js';

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

/** The net stake a lock holds: the stake less the node fee and the donation (§22A). */
export const lockAmountMsat = (round) => {
  const stakeMsat = BigInt(round.stakeMsat || 0n);
  return netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat: 0n });
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
  storage, onDeposit = () => {}, onStep = () => {} } = {}) {
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

  const amount = lockAmountMsat(round);
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
  const allowance = BigInt(LockClient.lockAllowanceMsat(String(amount)));
  for (let tries = 0; ; tries++) {
    const have = BigInt(await client.balanceMsat());
    let cost = null;
    try { cost = BigInt(await client.lockCostMsat(String(amount))); } catch (e) {
      if (!/insufficient funds/i.test(String((e && e.message) || e))) throw e;
    }
    if (cost !== null && have >= cost) break;
    if (tries >= 3) throw new Error(`after ${tries} deposits the lock client holds ${have} msat and cannot fund a ${amount} msat lock`);
    const short = cost !== null ? cost - have : amount + allowance - have;
    const plan = JSON.parse(await client.depositFor(String(short > 0n ? short : allowance)));
    const invoice = JSON.parse(await client.receive(String(plan.invoice_msat), String(plan.gateway || '')));
    onDeposit({ invoice: invoice.invoice, amountMsat: BigInt(plan.invoice_msat), creditsMsat: BigInt(plan.credited_msat) });
    onStep('waiting for the deposit');
    const final = await client.awaitReceive(invoice.operation);
    if (final !== 'Claimed') throw new Error(`the deposit was not claimed: ${final}`);
  }

  onStep('locking the stake');
  const refundPk = refundKeyOf(playerPubkey);
  const answer = await client.lock(toHex(stake.stakePoint), String(amount), toHex(claimKey.claimPk), toHex(refundPk),
    Number(round.stakeExpiryBlocks) + LOCK_EXPIRY_MARGIN_BLOCKS);
  const lock = lockFromClient(answer, { point: stake.stakePoint, claimPk: claimKey.claimPk, refundPk });
  if (lock.fields.amountMsat !== amount)
    throw new Error(`the lock client locked ${lock.fields.amountMsat} msat, and this entry's net stake is ${amount}`);
  return { ...lock, client };
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
    lock: { outpoint: { txid: fromHex(j.outpoint.txid), outIdx: BigInt(j.outpoint.outIdx) }, fields: lockFieldsFromJson(j.fields) },
    committedTo: j.committedTo || null,
  };
}

/** A seat committed the kept lock to `entryId`: from now on it is that seat's stake, not one to reuse. */
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
 * THE LOCK, HANDED TO EVERY SEAT (POST /lock). A seat that verifies it in the
 * federation answers 201 and counts the stake; `ok` is `needed` of them.
 */
export async function handLock({ entryId, fields, nodes, needed, fetcher = fetch } = {}) {
  if (!(entryId instanceof Uint8Array) || entryId.length !== 32) throw new Error('a lock is handed over for an entry, by its id');
  const body = JSON.stringify(lockFieldsToJson(fields));
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock?entry=${toHex(entryId)}`, { method: 'POST', body });
      said.push({ node, status: r.status, why: (await r.text()).trim() });
    } catch (e) {
      said.push({ node, status: 0, why: e.message });
    }
  }
  const committed = said.filter((s) => s.status === 201).length;
  return { ok: committed >= needed, committed, needed, said };
}
