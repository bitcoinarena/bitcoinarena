// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PLAYER'S STAKE LOCK, MADE FROM THE PAGE (W1b; v4.6.2 §23.1 steps 3-5).
//
// The lock client (lock-client/, the stock fedimint 0.12.0 client crates built
// to wasm) is INJECTED, like the curve: this bundle carries no crypto and no
// federation code. What is here decides only what the lock client is asked -
// which federation, under whose secret, how much, to which keys, until when,
// all read off the round, the dealt stake and the attested claim key - and it
// refuses an answer that is not the lock it asked for (`lockFromClient`).
//
// AND IT HANDS THE LOCK TO THE SIGNER NODES once they hold the entry: a signer node verifies
// it in the federation and only then counts the stake (§23.1 step 5).
//
// A RELOAD LOSES NOTHING. The lock client's wallet is kept in the tab
// (`lockStoreFor`), so a reload between the deposit and the lock reopens the
// wallet that holds it; and a lock already made, that no signer node has committed
// yet, is kept with its stake (`saveLock`), so a reload before the signer node takes
// the entry uses that lock instead of dealing and paying again.
import { ANCESTOR_TAG } from '../../arena-protocol/src/ancestor.js';
import { taggedHash, toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { feeBpsForRound, stakeOf } from './join.js';
import { refundKeyOf, lockFieldsToJson, lockFieldsFromJson } from '../../arena-protocol/src/stake-lock.js';
import { decodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { lockFromClient } from './lock-result.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { roundLocks, playerFor } from './join.js';
import { encodeRoundContract, decodeRoundContract, roundId as roundIdOf, custodyFieldsAreValid, entryId } from '../../arena-protocol/src/contracts.js';
import { decodeBolt11 } from '../../arena-protocol/src/bolt11.js';
import { splitDonation, donationSetPaysKeys } from '../../arena-protocol/src/donation.js';

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
  const prefix = `arena.lockdb.${toHex(roundId).slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`;
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

/** THE FEDERATION BLOCK FROM WHICH A ROUND'S SAVED LOCK COMES BACK TO THE PLAYER'S KEY, or null when none is kept. */
export function savedLockExpiration(storage, roundIdHex) {
  const prefix = `arena.lock.saved.${String(roundIdHex || '').toLowerCase()}.`;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(prefix)) continue;
      const r = JSON.parse(storage.getItem(k));
      const e = Number(r && r.fields && r.fields.expiration);
      if (Number.isInteger(e) && e > 0) return e;
    }
  } catch { /* nothing kept */ }
  return null;
}

/**
 * THE PENDING LINE'S WORDS (WINDOW-10-SPECMF 18: "window closed … · paying out" forever when no payout came): before
 * the window's close its time; for 10 min after it "paying out"; from then "not paid yet", and when the lock comes back.
 */
export const PAYOUT_GRACE_MS = 600000;
export function pendingWindowLine({ closeMs, provisional = false, nowMs = Date.now(), expiration = null }) {
  if (!closeMs) return '';
  const t = new Date(Number(closeMs)).toISOString().slice(11, 19);
  if (nowMs < closeMs) return `window closes ${t} UTC${provisional ? ' \u00b7 provisional' : ''}`;
  if (nowMs < Number(closeMs) + PAYOUT_GRACE_MS) return `window closed ${t} UTC \u00b7 paying out`;
  return `window closed ${t} UTC \u00b7 not paid yet \u2013 the lock returns to your key ${Number.isInteger(expiration) ? `from block ${expiration}` : 'when it expires'}`;
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
 * donation (§22A) - the same net the signer node's stake-lock check wants. It assumed
 * 0 before the page could write a donation (M3.2 6e): a 2% donor's lock would
 * have held 98000 msat where the signer node wants 96000.
 */
export const lockAmountMsat = (round, donationMsat = 0n) => {
  const stakeMsat = stakeOf(round);
  return netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat, feeBpsForRound(round)), donationMsat });
};

/**
 * WHAT ONE ENTRY'S STAKE IS MADE OF (§22A's transparency listMF 17: "nowhere does the phone page split the 100 sat
 * into stake, fee and donation"): the round's stake, the node fee and the player's donation out of it, and what the lock holds.
 */
export const entryBreakdown = (round, donationMsat = 0n) => {
  const stakeMsat = stakeOf(round);
  const feeMsat = entryFeeMsat(stakeMsat, feeBpsForRound(round));
  return { stakeMsat, feeMsat, donationMsat: BigInt(donationMsat), lockMsat: netStakeMsat({ stakeMsat, feeMsat, donationMsat: BigInt(donationMsat) }) };
};

/**
 * THE PLAYER WALLET'S SECRET (§24A.1, v4.6.3; RULED 2026-09-25): one e-cash wallet per player seed and
 * FEDERATION, kept in the browser, that stakes are spent from. A function of the seed and the federation id only -
 * never of a round: the per-round wallet (`lockSecretFor`) funded each stake with its own Lightning invoice, which is
 * the red of rehearsal item 8 (27e1fbb9).
 */
export function walletSecretFor(seed, federationId) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new Error('the player wallet\'s secret comes from the player\'s 32-byte seed, and none was given');
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32 || namesNothing(federationId))
    throw new Error('the player wallet is per federation, and no federation id was given');
  const msg = new Uint8Array(64);
  msg.set(seed, 0);
  msg.set(federationId, 32);
  return taggedHash(TAG.playerWalletSecret, msg);
}

/**
 * THE SAME SEED'S PLAYER WALLET BEFORE THE ARENA/v1 TAGS (2026-10-08 pick (a); spec 0A.9 "the player
 * wallets' e-cash carries over"): the wallet a seed had on the BLWP network, under the ancestor's tag (ancestor.js). The
 * page opens it only to sweep its e-cash into the Arena wallet (index.html combineWallets); nothing is ever paid into it.
 */
export function ancestorWalletSecretFor(seed, federationId) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new Error('the player wallet\'s secret comes from the player\'s 32-byte seed, and none was given');
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32 || namesNothing(federationId))
    throw new Error('the player wallet is per federation, and no federation id was given');
  const msg = new Uint8Array(64);
  msg.set(seed, 0);
  msg.set(federationId, 32);
  return taggedHash(ANCESTOR_TAG.playerWalletSecret, msg);
}

/**
 * HOW MUCH WALLET A KEPT PHRASE HAS IN THIS BROWSER (2026-10-02: "I should have more than 0 sats on my wallet" - a
 * tab took another kept phrase than the one that deposited: the history, kept per federation, showed the deposit and the
 * stake, the balance was the other phrase's empty wallet). For every federation this browser keeps a ledger for, the
 * entries the phrase's player wallet keeps there - 0 for a phrase that never had one. Read off the store's keys only.
 */
export function phraseWalletEntries(storage, seedHex, federationIdHex = null, { ancestor = false } = {}) {
  if (!storage || !/^[0-9a-f]{64}$/i.test(String(seedHex || ''))) return 0;
  const keys = storageKeys(storage);
  // the federation asked about, when named (a wallet with money and no history row is still a wallet), and every one
  // this browser keeps a history for
  const feds = keys.map((k) => /^arena\.ledger\.([0-9a-f]{64})$/i.exec(k)).filter(Boolean).map((m) => m[1].toLowerCase());
  if (/^[0-9a-f]{64}$/i.test(String(federationIdHex || ''))) feds.push(String(federationIdHex).toLowerCase());
  let n = 0;
  for (const f of new Set(feds)) {
    let secret; try { secret = (ancestor ? ancestorWalletSecretFor : walletSecretFor)(fromHex(String(seedHex).toLowerCase()), fromHex(f)); } catch { continue; }
    const prefix = `arena.walletdb.${f.slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`;
    n += keys.filter((k) => k.startsWith(prefix)).length;
  }
  return n;
}

/**
 * THIS BROWSER FORGETS ONE PHRASE'S WALLETS (2026-10-11: "Im settings screen gibt es die Möglichkeit
 * seinen Account wieder zu löschen um sich mit Nostr oder ähnlich einzuloggen"): every player wallet database the phrase's
 * secrets name - per federation this browser keeps a history for, and the ancestor's - and its recover mark. Nothing is
 * sent and nothing is spent; the notes are the federation's, and the same 24 words (or the Nostr key that keeps them)
 * recover them in any browser (markSeedRecover). Answers how many entries went.
 */
export function forgetPhrase(storage, seedHex) {
  if (!storage || !/^[0-9a-f]{64}$/i.test(String(seedHex || ''))) return 0;
  const seed = fromHex(String(seedHex).toLowerCase());
  const keys = storageKeys(storage);
  const ids = new Set();
  for (const f of keys.map((k) => /^arena\.ledger\.([0-9a-f]{64})$/i.exec(k)).filter(Boolean).map((m) => m[1].toLowerCase()))
    for (const make of [walletSecretFor, ancestorWalletSecretFor]) {
      try { ids.add(`arena.walletdb.${f.slice(0, 16)}.${toHex(sha256(make(seed, fromHex(f)))).slice(0, 16)}.`); } catch { /* not this kind */ }
    }
  let n = 0;
  for (const k of keys) if ([...ids].some((p) => k.startsWith(p))) { storage.removeItem(k); n++; }
  if (storage.getItem(recoverMarkKey(seed)) !== null) { storage.removeItem(recoverMarkKey(seed)); n++; }
  return n;
}

/** WHERE THE PLAYER WALLET IS KEPT: the tab's storage, under the federation and the secret's hash, never the secret. */
export function walletStoreFor(storage, federationId, secret) {
  const prefix = `arena.walletdb.${toHex(federationId).slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`;
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

/**
 * A SEED BROUGHT FROM ANOTHER DEVICE RECOVERS ITS WALLET (2026-10-04: "patch Fedimint's recovery so it runs in
 * the browser, then measure the second device finding the notes the first device held"). The page marks a seed the player
 * typed in (24 words or 64 hex); a player wallet of that seed that this browser keeps nothing of is then RECOVERED from the
 * federation (LockClient.recover: Fedimint's own mintv2 recovery, the notes this secret's keys made) instead of joined
 * empty. Only an imported seed: a seed this page made has no notes anywhere else, and its first open stays a plain join.
 * The mark is per seed, never the seed: the key is a hash of it. A wallet already kept here opens as before.
 */
const recoverMarkKey = (seed) => `arena.recover.${toHex(sha256(seed)).slice(0, 16)}`;
export function markSeedRecover(storage, seedHex) {
  if (!storage || !/^[0-9a-f]{64}$/i.test(String(seedHex || ''))) return false;
  storage.setItem(recoverMarkKey(fromHex(String(seedHex).toLowerCase())), '1');
  return true;
}
export const seedRecovers = (storage, seed) => {
  try { return !!(storage && seed instanceof Uint8Array && storage.getItem(recoverMarkKey(seed)) === '1'); } catch { return false; }
};

/**
 * THE CHECKS A PAYING ROUND'S STAKE IS HELD TO, before the player wallet is even opened: a round that names a
 * federation, custody fields in full (M3 W7, §23), an invite to reach it, a lock client to reach it with.
 */
function paysIntoALock(round, invite, LockClient) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  // A MARKET ROUND'S LOCK SPAN is checked by its terms - the page set them on the round (its market's); else 144
  const custody = custodyFieldsAreValid(round, { manifest: round.marketTerms ? { resultType: 2, marketTerms: round.marketTerms } : null });
  if (!custody.ok) throw new Error(`no stake is locked to this round: ${custody.why}`);
  if (!invite)
    throw new Error('this round\'s stake goes into a federation lock, and the link names no federation '
      + 'to make it in - add federation=<invite code>');
  if (!LockClient || typeof LockClient.join !== 'function')
    throw new Error('a stake lock is made by the lock client, and none was loaded');
}

/**
 * THE PLAYER WALLET FOR THIS ROUND'S FEDERATION: joined under `walletSecretFor(seed, federationId)`, kept in the tab
 * per federation. Two paying rounds of one federation open the same wallet. Returns the lock client over it.
 */
// ONE OPEN WALLET PER LOCK CLIENT, TAB STORE AND WALLET SECRET (INSTANT-1527, 2026-09-30 15:23: the slow steps do
// not sit in front of the user). The page opens the player wallet in the lobby, before PLAY - joining the federation is
// the slowest step of a paying join - and the deposit, the lock and the withdraw use that same open client rather than
// joining again on the same store. A join that failed is not kept.
const openWallets = new WeakMap();
export async function playerWallet({ round, invite, seed, LockClient, storage, onStep = () => {}, openWaitMs = 15000, joinWaitMs = 180000, ancestor = false } = {}) {
  paysIntoALock(round, invite, LockClient);
  return openPlayerWallet({ federationId: round.federationId, invite, seed, LockClient, storage, onStep, openWaitMs, joinWaitMs, ancestor });
}

/**
 * THE SAME PLAYER WALLET, OPENED FROM ITS FEDERATION ALONE (2026-10-12: the cold first deposit waited
 * 41.5 s - the join of the federation began at the Deposit tap). The page opens it before any round is listed, from the
 * invite daily.json names; it is kept under the same key a round's playerWallet asks for, so the deposit and the join find
 * it open. `federationId` is its 32 bytes.
 */
export async function openPlayerWallet({ federationId, invite, seed, LockClient, storage, onStep = () => {}, openWaitMs = 15000, joinWaitMs = 180000, ancestor = false } = {}) {
  if (!(federationId instanceof Uint8Array) || federationId.length !== 32) throw new Error('a player wallet is opened for a 32-byte federation id');
  if (!invite || typeof invite !== 'string') throw new Error('a player wallet is opened from its federation\'s invite');
  if (!LockClient || typeof LockClient.join !== 'function') throw new Error('a player wallet is opened by the lock client, and none was loaded');
  const round = { federationId };
  // `ancestor`: the seed's BLWP-era wallet (ancestorWalletSecretFor), opened only to be swept into this one
  const secret = (ancestor ? ancestorWalletSecretFor : walletSecretFor)(seed, round.federationId);
  const key = `${toHex(round.federationId)}:${toHex(secret)}`;
  const byStore = storage && (openWallets.get(LockClient) || openWallets.set(LockClient, new WeakMap()).get(LockClient));
  const open = byStore && byStore.get(storage);
  // THE WALLET THE LOBBY OPENED, IF IT DID OPEN (JOIN-TIME-1359, measured 2026-10-02 on testnet4: 2 of 12 paid joins sat at
  // "the player wallet is open" for good - the lobby's join of the federation never settled, and PLAY took that promise
  // as an open wallet; a named step is never cut by time). Given `openWaitMs`; then, unsettled or failed, joined again.
  // ONE CLIENT PER WALLET, NEVER TWO (measured 2026-10-16 on live UI 147 with one pinned seed: the lobby's open took
  // 21-25 s, PLAY gave up on it after openWaitMs, "the player wallet did not open in 15 s - joining the federation again", and a
  // SECOND lock client opened the same store beside the first. Each keeps its own notes and operations in memory: the deposit
  // invoiced by one was "Operation not found" to the other, and a balance read off one (the owner's 400 sat) was quoted on the other,
  // "insufficient funds"). An open still running is waited for, however long - it is refused by name after joinWaitMs, and only a
  // refused or failed open is joined again; past openWaitMs the wait is said.
  if (open && open.has(key)) {
    const kept = open.get(key);
    const said = setTimeout(() => onStep(`the player wallet is still opening (over ${Math.round(openWaitMs / 1000)} s) - one wallet, waited for`), openWaitMs);
    if (said.unref) said.unref();
    try { const v = await kept; onStep('the player wallet is open'); return v; }
    catch (e) {
      if (open.get(key) === kept) open.delete(key);
      onStep(`the player wallet did not open (${e && e.message ? e.message : e}) - joining the federation again`);
    } finally { clearTimeout(said); }
  }
  const store = storage ? walletStoreFor(storage, round.federationId, secret) : unkeptLockStore();
  const kept = JSON.parse(store.entries()).length;
  const recover = !kept && !ancestor && typeof LockClient.recover === 'function' && seedRecovers(storage, seed);
  onStep(kept ? 'reopening the player wallet this tab keeps for this federation'
    : recover ? 'recovering the player wallet of this seed from the federation' : 'joining the federation with the player wallet');
  // AND A JOIN THAT NEVER ANSWERS IS REFUSED BY NAME after `joinWaitMs`, so PLAY can be pressed again
  let timer = null;
  const joining = Promise.race([
    (recover ? LockClient.recover : LockClient.join).call(LockClient, invite, toHex(round.federationId), toHex(secret), store),
    new Promise((_, no) => { timer = setTimeout(() => no(new Error(`the federation did not open the player wallet in ${Math.round(joinWaitMs / 1000)} s - press PLAY again`)), joinWaitMs); }),
  ]).finally(() => clearTimeout(timer));
  joining.then((c) => noteClientFederation(c, toHex(round.federationId)), () => {});
  if (byStore) {
    const m = open || new Map(); if (!open) byStore.set(storage, m);
    m.set(key, joining);
    joining.catch(() => m.delete(key));
  }
  return joining;
}

/**
 * WHAT THIS ROUND'S LOCKS ARE, off the federation the wallet joined: the net stake, the fee lock when Pick b's gate says
 * it pays a sitting signer node, and a refusal of a federation that charges a base fee (FEDERATION.md item 4; §22A) -
 * before anything is deposited or locked. An unknown rule is not a base fee (the gate then mints no fee lock).
 */
export async function locksForRound(round, client, donationMsat, donationRecipients = null) { return locksFor(round, client, donationMsat, donationRecipients); }
/**
 * THE DONATION, PAID FROM THE PLAYER WALLET TOO (2026-10-01: "donation is paid by the player as well"): what its
 * shares take from the wallet - each share is its own Lightning payment, so each is rounded up to whole notes. With no
 * set to split by, the donation as one share.
 */
export function donationCostMsat(donationMsat, recipients = null) {
  const d = BigInt(donationMsat || 0n);
  if (d <= 0n) return 0n;
  // a version-11 target: the developers' shares and the reserve output, each its own payment
  if (recipients && recipients.reserve) return donationKeyShares(d, recipients).reduce((t, s) => t + (s.amountMsat > 0n ? ceilNote(s.amountMsat) : 0n), 0n);
  // one set, or a round's two (protocol devs and game dev, §0A.8)
  const split = recipients ? splitDonation({ donationMsat: d, recipients }) : null;
  const shares = split && split.owed ? split.shares.map((x) => x.amountMsat) : [d];
  return shares.reduce((t, m) => t + (m > 0n ? ceilNote(m) : 0n), 0n);
}
async function locksFor(round, client, donationMsat, donationRecipients = null) {
  const amount = lockAmountMsat(round, donationMsat);
  let feeRule = null;
  if (typeof client.feeRule === 'function') {
    try { const r = JSON.parse(await client.feeRule()); feeRule = { ppm: BigInt(r.fee_ppm), baseMsat: BigInt(r.fee_base_msat) }; }
    catch { feeRule = null; }
  }
  if (feeRule && feeRule.baseMsat > 0n)
    throw new Error(`no stake is locked to this round: its federation charges a base fee of ${feeRule.baseMsat} msat `
      + 'on every input and output - a federation for BLWP runs with disable_base_fees (FEDERATION.md)');
  // its fee lock on what this entry stakes: an order's own amount, else the round's
  const feeGate = feeLockPays({ contract: { ...round, stakeMsat: stakeOf(round) }, fees: feeRule, feeBps: feeBpsForRound(round) });
  // A FEDERATION WITH NO FEES (0/0) quotes every lock exactly - its amount in whole notes - so the stake check needs no
  // allowance on top (2026-10-01: the 2 sat "reserve" made one 100 sat round ask 100.352 + 2.006)
  const zeroFees = !!feeRule && feeRule.baseMsat === 0n && feeRule.ppm === 0n;
  return { amount, feeGate, feeMsat: feeGate.pays ? feeGate.lockMsat : 0n, zeroFees,
    donationCostMsat: donationCostMsat(donationMsat, donationRecipients) };
}

/**
 * WHAT THE PLAYER WALLET MUST HOLD FOR THIS ROUND'S LOCKS, each quoted on its own (two locks are two transactions, each
 * with its own fees), and the fee lock's stock allowance again as its margin: the fee lock is quoted a second time over
 * the notes the stake lock leaves (measured in a real browser, 0.0.1236: 21504 msat left for a 20000 msat fee lock that
 * then cost more). `null` quotes: the wallet holds too little to be quoted at all (the stock dry run).
 */
// A LOCK'S QUOTE, KEPT FOR THE WALLET AS IT STANDS (2026-10-02, the join's 2-3 s): the lock client's quote is a dry
// run over the notes held, asked once for the deposit check and again for the lock - measured 1.9 s between 'the player
// wallet is open' and 'locking' in a paid join. Kept per client, amount and balance (a deposit or a spend is another
// wallet and quotes afresh), for two minutes; the two locks' quotes are asked together.
const QUOTES = new WeakMap();
async function quoteLock(client, m) {
  let byKey = QUOTES.get(client);
  if (!byKey) { byKey = new Map(); QUOTES.set(client, byKey); }
  let balance = '';
  try { balance = String(await client.balanceMsat()); } catch { balance = 'unknown'; }
  const key = `${m}|${balance}`;
  const hit = byKey.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit.msat;
  const msat = BigInt(await client.lockCostMsat(String(m)));
  byKey.set(key, { at: Date.now(), msat });
  return msat;
}
async function needFor(client, LockClient, { amount, feeMsat, zeroFees = false, donationCostMsat: donation = 0n }) {
  const locks = feeMsat > 0n ? [amount, feeMsat] : [amount];
  let quoted = 0n;
  const quotes = await Promise.all(locks.map((m) => quoteLock(client, m).then((q) => ({ q }), (e) => ({ e }))));
  let quoteWhy = null;
  for (const { q, e } of quotes) {
    if (e) {
      if (!/insufficient funds/i.test(String((e && e.message) || e))) throw e;
      quoted = null; quoteWhy = String((e && e.message) || e).slice(0, 160);
      break;
    }
    quoted += q;
  }
  const margin = feeMsat > 0n && !zeroFees ? BigInt(LockClient.lockAllowanceMsat(String(feeMsat))) : 0n;
  const allowance = zeroFees ? locks.reduce((t, m) => t + (ceilNote(m) - m), 0n) : locks.reduce((t, m) => t + BigInt(LockClient.lockAllowanceMsat(String(m))), 0n);
  // and the donation's shares, paid from the same wallet once the stake is counted
  return { locks, need: quoted === null ? null : quoted + margin + donation, floor: locks.reduce((t, m) => t + m, 0n) + allowance + margin + donation, quoteWhy };
}

/**
 * THE LOCK QUOTES ASKED AHEAD (2026-10-02, PRIORITIES 19:05, the join's 2-3 s): what a join's deposit check and lock
 * will ask the lock client, asked by the lobby once its wallet is open, so PLAY finds them kept (quoteLock: per client,
 * amount and balance - a deposit or a spend in between quotes afresh). Measured on 0.0.2474: the first quote was 0.47 s of
 * a funded paid join after the click. Spends nothing; answers what the round's locks would need.
 */
export async function warmLockQuotes({ round, client, LockClient, donationMsat = 0n, donationRecipients = null } = {}) {
  const locks = await locksFor(round, client, BigInt(donationMsat), donationRecipients);
  const n = await needFor(client, LockClient, locks);
  return { need: n.need };
}

/**
 * THE TOP-UP: a Lightning deposit INTO THE PLAYER WALLET, its own act and never inside a stake (§24A.1: "if short, a
 * Lightning deposit via any listed gateway"; RULED 2026-09-25: no Lightning between the players). Deposits only what
 * the wallet is short of this round's locks - nothing when it already holds them. `onDeposit({ invoice, amountMsat,
 * creditsMsat })` is told each invoice the player's own Lightning wallet must pay. Returns the deposits made.
 */
/**
 * THE GATEWAY A DEPOSIT GOES THROUGH (2026-09-30 14:30: "A deposit goes only to a gateway that holds e-cash ...
 * Do not pick a gateway at random"). The lock client's own plan picks among the federation's gateways at random, and a
 * gateway with no e-cash in the federation cannot fund the receive: measured on testnet4, gateway A (0 msat in 337ae01a)
 * was picked for five of eight deposits. Given the operator's list of funded gateways, the deposit goes through the
 * planned one only if it is listed, else the first listed - never an unlisted one. With no list, the plan stands.
 */
export function depositGateway(planned, funded = []) {
  const norm = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
  const list = (funded || []).map(norm).filter(Boolean);
  if (!list.length) return String(planned || '');
  const i = list.indexOf(norm(planned));
  return (funded || []).filter((u) => norm(u))[i >= 0 ? i : 0];
}

// ANY GATEWAY THE FEDERATION LISTS, AND THE NEXT ONE AFTER A TIMEOUT (spec §23.1: "a deposit invoice, made
// through any gateway the federation lists ... It can delay: the invoice's CLTV is short, and a client moves to the next
// gateway after a timeout - a slow gateway costs the round, never the money"). The gateways in turn: the lobby's named
// first, then the federation's (LockClient.gateways, the guardians' lists); one that makes no invoice in
// GATEWAY_INVOICE_MS is passed over at once; an invoice that ends Expired or Failure, or is not claimed in
// GATEWAY_UNCLAIMED_MS, gets a fresh invoice from the next gateway - the first stays payable, so a player who pays both
// has both in the wallet. The invoice lives 600 s (the lock client's DEPOSIT_INVOICE_SECS).
export const GATEWAY_INVOICE_MS = 10000;
export const GATEWAY_UNCLAIMED_MS = 120000;
const gwKey = (u) => String(u || '').trim().replace(/\/+$/, '').toLowerCase();
/** The gateways to try, in order, each once: `named` (the lobby's) first, then `listed` (the federation's). */
export function gatewayOrder(named = [], listed = []) {
  const out = []; const seen = new Set();
  for (const u of [...(named || []), ...(listed || [])]) { const k = gwKey(u); if (!k || seen.has(k)) continue; seen.add(k); out.push(String(u).trim()); }
  return out;
}
// THE FEDERATION'S SEATED GATEWAYS FIRST (spec §23A.9: "clients use those two first"; kanban #559, the owner 2026-10-20: "Fix all of it"):
// the page names a lookup - async (federation hex) -> the seated gateways' URLs, as the federation's guardians rank them - and every
// deposit, and both legs of a swap, try those before the lobby's named gateway and the federation's list
let seatedLookup = null;
const federationOfClient = new WeakMap();
/** The page's lookup of a federation's seated gateways (null: none). */
export function useSeatedGateways(lookup) { seatedLookup = typeof lookup === 'function' ? lookup : null; }
/** Which federation a lock client is a wallet of (openPlayerWallet notes it). */
export function noteClientFederation(client, federationHex) { if (client && typeof client === 'object' && federationHex) federationOfClient.set(client, String(federationHex).toLowerCase()); }
/** The seated gateways of `client`'s federation, [] when the page names no lookup or it cannot say. */
export async function seatedGatewaysOf(client) {
  const f = client && typeof client === 'object' ? federationOfClient.get(client) : null;
  if (!f || !seatedLookup) return [];
  try { const l = await Promise.race([seatedLookup(f), new Promise((ok) => setTimeout(() => ok([]), 3000))]); return Array.isArray(l) ? l.filter(Boolean).map(String) : []; } catch { return []; }
}
const listedOf = new WeakMap();
/** The gateways the federation lists, as the lock client reads them (asked once per wallet); none when it cannot say. */
export async function federationGateways(client) {
  if (!client || typeof client.gateways !== 'function') return [];
  if (!listedOf.has(client)) listedOf.set(client, (async () => { try { const l = JSON.parse(await client.gateways()); return Array.isArray(l) ? l : []; } catch { return []; } })());
  return listedOf.get(client);
}
const withinMs = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: no answer in ${ms / 1000} s`)), ms))]);
/**
 * AN INVOICE FROM THE FIRST GATEWAY OF `order` THAT MAKES ONE IN `timeoutMs` (none named: the lock client's own pick).
 * Answers { invoice, operation, gateway, tried: [{ gateway, why, ms }] } or throws naming every gateway tried.
 */
export async function invoiceThroughGateways(client, amountMsat, order = [], { timeoutMs = GATEWAY_INVOICE_MS, nowMs = () => Date.now() } = {}) {
  const list = order.length ? order : [''];
  const tried = [];
  for (const gateway of list) {
    const t0 = nowMs();
    try {
      const got = JSON.parse(await withinMs(client.receive(String(amountMsat), gateway), timeoutMs, `gateway ${gateway || '(the federation\'s pick)'}`));
      return { ...got, gateway, tried };
    } catch (e) { tried.push({ gateway, why: String((e && e.message) || e), ms: nowMs() - t0 }); }
  }
  throw new Error(`no gateway made a deposit invoice: ${tried.map((t) => `${t.gateway || 'the federation\'s pick'} (${t.why})`).join('; ')}`);
}
/**
 * WATCH ONE INVOICE AND FAIL OVER: `d` ({ invoice, operation, gateway }) is awaited; when it ends Expired or Failure, or
 * is not claimed in `unclaimedMs`, the next gateway of `order` after d.gateway makes a fresh invoice, handed to
 * `onInvoice(next)` and watched the same way. `onEnd(d, final)` for every invoice that ends; `done()` true stops it.
 */
export function followWithFailover(client, d, { amountMsat, order = [], unclaimedMs = GATEWAY_UNCLAIMED_MS, onInvoice = () => {},
  onEnd = () => {}, onExhausted = () => {}, done = () => false, timeoutMs = GATEWAY_INVOICE_MS } = {}) {
  let moved = false;
  const at = order.findIndex((g) => gwKey(g) === gwKey(d.gateway));
  const rest = order.slice(at + 1);
  // `onEnd(d, final, failover)`: `failover` true when a next gateway's invoice is still to come
  const next = async (why) => {
    if (moved || done()) return; moved = true;
    if (!rest.length) { onExhausted(why); return; }
    try {
      const got = await invoiceThroughGateways(client, amountMsat, rest, { timeoutMs });
      if (done()) return;
      const n = { ...d, invoice: got.invoice, operation: got.operation, gateway: got.gateway, tried: got.tried, failoverFrom: d.gateway, failoverWhy: why };
      onInvoice(n);
      followWithFailover(client, n, { amountMsat, order, unclaimedMs, onInvoice, onEnd, onExhausted, done, timeoutMs });
    } catch (e) { onExhausted(String((e && e.message) || e)); /* the invoices made stay payable */ }
  };
  const timer = setTimeout(() => next(`not claimed in ${unclaimedMs / 1000} s`), unclaimedMs);
  if (timer.unref) timer.unref();
  const ended = (final, why) => {
    clearTimeout(timer);
    const failover = final !== 'Claimed' && !moved && !done() && rest.length > 0;
    onEnd(d, final, failover);
    if (final !== 'Claimed') next(why);
  };
  client.awaitReceive(d.operation).then((final) => ended(final, `it ended ${final}`),
    (e) => ended('Failure: ' + String((e && e.message) || e), 'its wait failed'));
}
// THE DEPOSIT IS THE GROSS ROUND AMOUNT, IN ROUNDS (2026-09-30 20:53, GROSS-INVOICE-2053: "A 10000 sat round
// invoices 10000 sat, not 9906. Fee and donation are not subtracted from the invoice ... The tabs are '1 round', '2
// rounds', '5 rounds', '10 rounds', and 'Custom' ... The amount is this round's stake times the count"). The gateway's
// receive fee and the lock allowance come out of what the wallet is credited: measured on testnet4, a gross 10000 sat
// invoice credits 9968 sat, more than one round's locks; a gross 100 sat one credits 97.7 sat, 0.6 sat short of one
// 100 sat round with the 2% donation - the page then says the wallet cannot fund the round, and two rounds cover.
export const DEPOSIT_ROUNDS = [1, 2, 5, 10];
// N ROUNDS PLAY N ROUNDS (2026-10-01: "so rounds can always be played. 10 rounds deposit must be capable of playing
// 10 rounds"). Measured: the federation issues e-cash in powers of two from 512 msat, so a deposit credits only its whole
// 512 msat (100000 -> 99840, 5000 -> 4608), and a lock costs its amount rounded up to 512 msat (98000 -> 98304; the fee
// rule is 0/0). So a deposit is sized in whole notes, and N rounds is N x one round's locks plus the stake check's margin.
// 1 SAT = 1 SAT (2026-10-01: "Fix it instead right now and rebuild rust ... we want 1 sat = 1 sat and round 100
// sat round numbers"): the lock client is rebuilt with the mint client issuing and spending notes from 1 msat
// (client_denominations 0..41 - the federation signs those already), so a whole note is any msat: nothing is rounded,
// a 100 sat deposit credits 100 sat, and a 100 sat round takes exactly 100 sat. (512 was the stock client's floor.)
export const NOTE_MSAT = 1n;
export const ceilNote = (msat) => (BigInt(msat) + NOTE_MSAT - 1n) / NOTE_MSAT * NOTE_MSAT;
/** What one round takes from the wallet: each lock's amount in whole notes, and the donation's shares (each in whole notes). */
export const roundCostMsat = ({ amount, feeMsat = 0n, donationCostMsat: donation = 0n }) =>
  ceilNote(amount) + (BigInt(feeMsat) > 0n ? ceilNote(feeMsat) : 0n) + BigInt(donation || 0n);
export const floorNote = (msat) => BigInt(msat) / NOTE_MSAT * NOTE_MSAT;
/** What a whole-sat invoice is credited: its whole notes. */
export const creditedMsat = (msat) => floorNote(msat);
/** What one round needs the wallet to hold: its locks and donation, plus the stake check's margin where fees are charged. */
export function oneRoundNeedMsat(locks, LockClient) {
  const margin = BigInt(locks.feeMsat || 0n) > 0n && !locks.zeroFees ? BigInt(LockClient.lockAllowanceMsat(String(locks.feeMsat))) : 0n;
  return roundCostMsat(locks) + margin;
}
/**
 * THE PRICE PER ROUND, IN WHOLE SATS (2026-10-01: "which amounts are safe, so we show no odd amounts" - "yes"): the
 * smallest whole sat P such that N x P sat, credited in whole notes, holds N rounds for every tab (1, 2, 5, 10). A 100
 * sat round with a two-recipient donation: 101 sat (101 -> 100864 credited = one round's 100864).
 */
export function oneRoundDepositMsat(locks, LockClient) {
  const need = oneRoundNeedMsat(locks, LockClient);
  let p = (need + 999n) / 1000n;
  while (DEPOSIT_ROUNDS.some((n) => creditedMsat(BigInt(n) * p * 1000n) < BigInt(n) * need)) p += 1n;
  return p * 1000n;
}
/** N ROUNDS ARE N x ONE ROUND (2026-10-01: "1 round" 100.xx sat; then 2 rounds 198.656 beside it read as wrong):
 * every round funded as the first is - each with its own margin - so the tabs are 1, 2, 5, 10 x the "1 round" amount. */
export function roundsDepositMsat(n, locks, LockClient) {
  return BigInt(n) * oneRoundDepositMsat(locks, LockClient);
}
export const DEPOSIT_INSUFFICIENT = 'Not enough sats in your player wallet to play this round. Deposit with Lightning?';
/** The deposit tabs for a round of `stakeMsat`: n rounds at n x the stake, then Custom (an amount the player names). */
export function depositChoices(stakeMsat, sizeOf = null) {
  const stake = BigInt(stakeMsat || 0n);
  return [...DEPOSIT_ROUNDS.map((n) => ({ key: String(n), label: n === 1 ? '1 round' : `${n} rounds`, rounds: n, msat: sizeOf ? sizeOf(n) : stake * BigInt(n) })),
    { key: 'custom', label: 'Custom', rounds: null, msat: null }];
}
/**
 * THE WITHDRAWAL TABS (2026-09-30: "The withdrawal is different: 25% 50% 100% custom - you enter a custom
 * amount"): shares of what the wallet can send after its fees, in whole sat (an invoice names sat), then Custom.
 */
export const WITHDRAW_SHARES = [25, 50, 100];
/** THE AMOUNT AN INVOICE ASKS (2026-10-01: the invoice defines the amount - no withdraw selector): msat, or why not. */
export function invoiceAmountMsat(invoice) {
  const text = String(invoice || '').trim();
  if (!text) return { ok: false, why: '' };
  let d;
  try { d = decodeBolt11(text); } catch { return { ok: false, why: 'That is not a Lightning invoice.' }; }
  if (d.amountMsat === null || d.amountMsat === undefined || BigInt(d.amountMsat) <= 0n) return { ok: false, why: 'Please use an invoice with an amount.' };
  return { ok: true, msat: BigInt(d.amountMsat) };
}
export function withdrawChoices(withdrawableMsat) {
  const all = BigInt(withdrawableMsat || 0n);
  return [...WITHDRAW_SHARES.map((pct) => ({ key: String(pct), label: `${pct}%`, pct, msat: (all * BigInt(pct) / 100n) / 1000n * 1000n })),
    { key: 'custom', label: 'Custom', pct: null, msat: null }];
}
/** What the player wallet can send now, after the send's fees, in msat (0 when its fees would eat all of it). Spends nothing. */
export async function playerWithdrawable({ round, invite, seed, LockClient, storage, onStep = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  try { return BigInt(await client.withdrawableMsat()); } catch (e) {
    if (/too low to send any amount after fees/i.test(String((e && e.message) || e))) return 0n;
    throw e;
  }
}
/**
 * ONE DEPOSIT OFFER: `invoice(msat)` asks the wallet's gateway for a gross invoice of exactly that amount (a new one at
 * every tab switch); `claimed` resolves with whichever invoice was paid first, `close()` rejects it. Every invoice made
 * stays payable: one paid after another was claimed is credited to the same wallet.
 */
export function depositOffer({ client, stakeMsat, haveMsat = null, needMsat = null, gateways = [], onDeposit = () => {},
  storage = null, federationId = null, restMsat = null, sizeOf = null, choices = null } = {}) {
  let settle; let fail;
  // WHAT CAME OF IT (option 2, 2026-10-01): once a paid deposit is claimed, the round is looked at again -
  // `outcome` resolves { funded: true } or { funded: false, rest } with the offer for exactly the rest
  let decide;
  const outcome = new Promise((res) => { decide = res; });
  const claimed = new Promise((res, rej) => { settle = res; fail = rej; });
  claimed.catch(() => {});
  const made = [];
  // THE DEPOSIT'S STATUS (2026-09-30): each invoice's end - "Claimed", "Expired", "Failure" or the wait's own
  // error - to whoever watches the offer (the page's status line and bar under the invoice).
  const watchers = [];
  const said = (d, final) => { for (const w of watchers) { try { w(d, final); } catch { /* a watcher's own fault */ } } };
  const invoice = async (msat) => {
    // AS ASKED, IN WHOLE SATS: the tabs are priced so their whole notes hold the rounds (oneRoundDepositMsat)
    const amount = BigInt(msat);
    if (amount <= 0n) throw new Error('a deposit is more than 0 sat');
    // ANY LISTED GATEWAY, THE NEXT AFTER A TIMEOUT: the lobby's first, then the federation's
    const order = gatewayOrder([...await seatedGatewaysOf(client), depositGateway('', gateways)].filter(Boolean), await federationGateways(client));
    const got = await invoiceThroughGateways(client, amount, order);
    let settled = false;
    const shown = (x) => {
      const d = { invoice: x.invoice, amountMsat: amount, creditsMsat: null, gateway: x.gateway, tried: x.tried || [],
        ...(x.failoverFrom !== undefined ? { failoverFrom: x.failoverFrom, failoverWhy: x.failoverWhy } : {}) };
      made.push(d);
      // KEPT UNTIL IT ENDS: a reload between the payment and the claim leaves this page, and the next page's wallet
      // (resumeDeposits) waits on the same operation and writes its history row
      pendingAdd(storage, federationId, { invoice: d.invoice, operation: x.operation, msat: String(amount) });
      onDeposit(d);
      return d;
    };
    const first = shown(got);
    const byOp = new Map([[got.operation, first]]);
    followWithFailover(client, { invoice: got.invoice, operation: got.operation, gateway: got.gateway }, { amountMsat: amount, order,
      done: () => settled,
      onInvoice: (n) => { byOp.set(n.operation, shown(n)); },
      onEnd: (x, final) => {
        const d = byOp.get(x.operation) || first;
        if (final === 'Claimed') depositRowOnce(storage, federationId, d);
        if (final === 'Claimed' || final === 'Expired' || final === 'Failure') pendingDrop(storage, federationId, x.operation);
        said(d, final); if (final === 'Claimed' && !settled) { settled = true; settle(d); }
      } });
    return first;
  };
  const rest = restMsat === null ? null : BigInt(restMsat);
  // what the rest invoice asks: the rest itself, or the 5 sat floor when the rest is under it
  const restPay = rest === null ? null : restInvoiceMsat(rest);
  return { stakeMsat: BigInt(stakeMsat || 0n), perRoundStake: BigInt(stakeMsat || 0n), haveMsat, needMsat, invoice, claimed, made, restMsat: rest, restPayMsat: restPay,
    // THE TABS (1, 2, 5, 10 rounds and Custom, gross), or - for the rest of a round's fees - the one amount
    choices: choices || (rest === null ? depositChoices(stakeMsat, sizeOf) : [{ key: 'rest', label: 'The rest', rounds: null, msat: restPay }]),
    outcome, decided: (o) => decide(o),
    watch: (fn) => { watchers.push(fn); },
    close: (why) => fail(new Error(why || 'the deposit was closed: nothing was paid')) };
}
// DEPOSITS NOT YET ENDED, per federation (arena.deposit.pending.<fed>): every invoice made, until its receive ends.
const PENDING_PREFIX = 'arena.deposit.pending.';
export function pendingDeposits(storage, federationId) {
  try { const raw = storage && storage.getItem(PENDING_PREFIX + fedHexOf(federationId)); const l = raw ? JSON.parse(raw) : []; return Array.isArray(l) ? l : []; }
  catch { return []; }
}
function pendingWrite(storage, federationId, list) {
  try { if (list.length) storage.setItem(PENDING_PREFIX + fedHexOf(federationId), JSON.stringify(list)); else storage.removeItem(PENDING_PREFIX + fedHexOf(federationId)); }
  catch { /* a tab that cannot write keeps no note; the money is not touched */ }
}
function pendingAdd(storage, federationId, p) {
  if (!storage || !fedHexOf(federationId)) return;
  pendingWrite(storage, federationId, [...pendingDeposits(storage, federationId).filter((x) => x.operation !== p.operation), { atMs: Date.now(), ...p }]);
}
function pendingDrop(storage, federationId, operation) {
  if (!storage || !fedHexOf(federationId)) return;
  pendingWrite(storage, federationId, pendingDeposits(storage, federationId).filter((x) => x.operation !== operation));
}
/** One history row per paid invoice, however many pages saw it claimed. */
function depositRowOnce(storage, federationId, d) {
  if (!storage || !fedHexOf(federationId)) return false;
  let invoiceHash = null;
  try { invoiceHash = toHex(decodeBolt11(d.invoice).paymentHash); } catch { invoiceHash = null; }
  if (invoiceHash && ledgerRows(storage, federationId).some((r) => r.kind === 'deposit' && r.invoiceHash === invoiceHash)) return false;
  ledgerAppend(storage, federationId, { kind: 'deposit', msat: String(d.amountMsat), invoiceHash });
  return true;
}
/**
 * THE DEPOSITS AN EARLIER PAGE LEFT (2026-09-30: a reload of the deposit page lands on the lobby, and a payment
 * made just before it must still be in the history): the reopened wallet waits on each kept operation; a claimed one
 * gets its row, and every ended one leaves the list. `onClaimed(d)` for each new row. Spends nothing.
 */
export function resumeDeposits({ client, storage, federationId, onClaimed = () => {} } = {}) {
  return Promise.all(pendingDeposits(storage, federationId).map((p) => client.awaitReceive(p.operation).then((final) => {
    const d = { invoice: p.invoice, amountMsat: BigInt(p.msat) };
    if (final === 'Claimed' && depositRowOnce(storage, federationId, d)) onClaimed(d);
    pendingDrop(storage, federationId, p.operation);
    return final;
  }, () => 'unknown')));
}
/** A deposit into the player wallet from Settings: the same tabs, this round's stake, no round to fund. */
export async function settingsDepositOffer({ round, invite, seed, LockClient, storage, gateways = [], donationMsat = 0n, donationRecipients = null, onDeposit = () => {}, onClaimed = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage });
  const locks = await locksFor(round, client, donationMsat, donationRecipients);
  const offer = depositOffer({ client, stakeMsat: stakeOf(round), haveMsat: BigInt(await client.balanceMsat()), gateways, onDeposit,
    storage, federationId: round.federationId, sizeOf: (n) => roundsDepositMsat(n, locks, LockClient) });
  offer.claimed.then((d) => { depositRow(storage, round, d); onClaimed(d); offer.decided({ funded: true }); }, () => {});
  return offer;
}
function depositRow(storage, round, d) { depositRowOnce(storage, round.federationId, d); }
/**
 * A DEPOSIT BEFORE ANY ROUND (2026-10-12 "Yes" to Deposit on the games screen before a game is picked): no
 * round to count rounds in, so the tabs are plain amounts - 1,000 / 5,000 / 10,000 / 50,000 sat and Custom - into the same
 * player wallet, opened from its federation alone (openPlayerWallet).
 */
export const WALLET_DEPOSIT_SATS = Object.freeze([1000, 5000, 10000, 50000]);
export const walletDepositChoices = () => [...WALLET_DEPOSIT_SATS.map((sat) => ({ key: `sat${sat}`, label: `${sat.toLocaleString('en-US')} sat`, rounds: null, msat: BigInt(sat) * 1000n })),
  { key: 'custom', label: 'Custom', rounds: null, msat: null }];
export async function walletDepositOffer({ federationId, invite, seed, LockClient, storage, gateways = [], onDeposit = () => {}, onClaimed = () => {} } = {}) {
  const client = await openPlayerWallet({ federationId, invite, seed, LockClient, storage });
  const offer = depositOffer({ client, stakeMsat: 0n, haveMsat: BigInt(await client.balanceMsat()), gateways, onDeposit, storage, federationId,
    choices: walletDepositChoices() });
  offer.claimed.then((d) => { depositRowOnce(storage, federationId, d); onClaimed(d); offer.decided({ funded: true }); }, () => {});
  return offer;
}
export const DEPOSIT_MARGIN_PPM = 6000n;
export const DEPOSIT_MARGIN_MSAT = 10000n;
/**
 * THE REST OF A ROUND'S FEES, AS ONE INVOICE (option 2, 2026-10-01: "This round needs N more sat for fees. Pay the
 * rest to join." - measured: a 100 sat round's gross 100 sat credited 99840 msat, short of its locks). What the wallet is
 * short, plus 1 sat for the claim of this small deposit itself, in whole sat.
 */
export const REST_MARGIN_MSAT = 1000n;
/** THE SMALLEST DEPOSIT THE FEDERATION TAKES (measured 2026-10-01 through gateway B: 2, 3, 4 sat refused "Amount is too
 * small to cover fees", 5 sat made). A rest under it is invoiced at it; the extra stays in the player wallet. */
export const REST_FLOOR_MSAT = 5000n;   // the smallest deposit the federation takes (measured: 2, 3, 4 sat refused)
export const restInvoiceMsat = (restMsat) => (BigInt(restMsat) < REST_FLOOR_MSAT ? REST_FLOOR_MSAT : BigInt(restMsat));
/** A donation the player wallet paid, a history row (every deduction is a row - 2026-09-30 16:15). */
export function recordDonation(storage, federationId, { msat, round }) {
  ledgerAppend(storage, federationId, { kind: 'donation', msat: String(msat), round: round ? String(round) : null });
}
/** The rest: the smallest whole sat whose whole notes cover what the wallet is short. */
export function restOfFeesMsat(shortMsat) {
  const short = shortMsat > 0n ? BigInt(shortMsat) : 1n;
  let sat = (short + 999n) / 1000n;
  while (creditedMsat(sat * 1000n) < short) sat += 1n;
  return sat * 1000n;
}
/** A wallet that holds most of a round and is short only by its fees (no more than a tenth of the stake) is asked the rest. */
export const shortOnlyByFees = (haveMsat, shortMsat, stakeMsat) => haveMsat > 0n && shortMsat > 0n && shortMsat * 10n <= BigInt(stakeMsat || 0n);
/**
 * NOTES STILL BEING ISSUED (the join that never started): a wallet's e-cash counts in `balanceMsat` only once the
 * guardians' blind signatures for it are in - a restored wallet's notes are re-issued by an output state machine AFTER `recover`
 * returns, a deposit's after its claim, a payment's change after the payment. Measured on a page with one pinned seed (6b360bd8,
 * a fresh profile): the balance read 0 sat for more than 6 minutes while the seed held 3000 sat, and a deposit "Claimed" at 78 s
 * still read 0 - a quote in that window called a funded wallet "insufficient" and sent it to deposit. `issuingMsat` (lock client)
 * is what is being issued; 0 from a client that cannot tell.
 */
export const ISSUE_POLL_MS = 1000;
export const ISSUE_WAIT_MS = 600000;
export async function issuingMsat(client) {
  if (!client || typeof client.issuingMsat !== 'function') return 0n;
  try { return BigInt(await client.issuingMsat()); } catch { return 0n; }
}
/** Waits until nothing is being issued to the wallet (or `untilMs`, or ISSUE_WAIT_MS), saying so; answers { have, issuing }. */
export async function awaitIssued(client, { untilMs = null, onStep = () => {} } = {}) {
  const end = Math.min(untilMs === null || untilMs === undefined || !Number.isFinite(Number(untilMs)) ? Infinity : Number(untilMs), Date.now() + ISSUE_WAIT_MS);
  let saidAt = 0;
  for (;;) {
    const have = BigInt(await client.balanceMsat());
    const issuing = await issuingMsat(client);
    if (issuing === 0n || Date.now() >= end) return { have, issuing };
    if (Date.now() - saidAt >= 5000) {
      onStep(`the player wallet holds ${have} msat and is being issued ${issuing} msat more (a restore, a deposit or a payment's change): waiting for those notes`);
      saidAt = Date.now();
    }
    await new Promise((r) => setTimeout(r, ISSUE_POLL_MS));
  }
}
/**
 * A WALLET SHORT OF THE STAKE IS ASKED AT THE PRESS (2026-10-18, playtest: "I have no money deposited yet it is trying to place
 * the order. It takes a while then the deposit screen comes. It shouldn't take so long" - measured 27.25 s, 24.8 of them in front of the
 * deposit waiting on the round's donation set from a seat that did not answer). Before the round's other steps: the player wallet opened
 * and read; holding less than the stake it surely cannot enter, so the deposit offer is made now - `fundPlayerWallet({ early })` waits
 * on this same offer instead of asking again. Holding the stake or more: null, and the round's own quote decides as before.
 */
export async function earlyDepositOffer({ round, invite, seed, LockClient, storage, gateways = [], onDeposit = () => {}, onStep = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  const have = BigInt(await client.balanceMsat());
  const issuing = await issuingMsat(client);
  if (have + issuing >= stakeOf(round)) return null;
  onStep(`the player wallet holds ${have} msat, less than this round's stake of ${stakeOf(round)} msat: a deposit is asked at once`);
  return depositOffer({ client, stakeMsat: stakeOf(round), haveMsat: have, needMsat: null, gateways, onDeposit, storage, federationId: round.federationId });
}

export async function fundPlayerWallet({ round, invite, seed, LockClient, storage, donationMsat = 0n, donationRecipients = null, gateways = [],
  estimateDeposit = false, askDeposit = null, onDeposit = () => {}, onStep = () => {}, entryClosesMs = null, early = null } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  const locks = await locksFor(round, client, donationMsat, donationRecipients);
  const deposits = [];
  let prev = null;
  for (let tries = 0; ; tries++) {
    let have = BigInt(await client.balanceMsat());
    let n = await needFor(client, LockClient, locks);
    // A WALLET WHOSE NOTES ARE STILL BEING ISSUED (2026-10-16 06:25Z, right after buying the larger truck:
    // "stake lock: the player wallet holds 400000 msat; this round's locks need more than that" - the join asked a deposit and
    // never started): short of the quote, but not once what is being issued has landed - those notes are waited for, then the
    // round is quoted again. Nothing being issued, the quote stands and its own words are said.
    if (n.need === null || have < n.need) {
      const issuing = await issuingMsat(client);
      if (issuing > 0n && have + issuing >= (n.need !== null ? n.need : n.floor)) {
        const w = await awaitIssued(client, { untilMs: entryClosesMs, onStep });
        if (w.issuing > 0n) onStep(`the player wallet's ${w.issuing} msat were still being issued at the round's entry close`);
        have = w.have; n = await needFor(client, LockClient, locks);
      }
    }
    onStep(`the player wallet holds ${have} msat; this round's locks need ${n.need === null ? `more than that (${n.quoteWhy || 'insufficient funds'})` : `${n.need} msat`}`);
    if (n.need !== null && have >= n.need) { if (prev) prev.decided({ funded: true }); break; }
    // THE PLAYER CHOOSES THE DEPOSIT (GROSS-INVOICE-2053): the page shows the offer - the tabs, the invoice, a close - and
    // this waits for whichever invoice is paid, then looks again.
    // STILL SHORT AFTER A PAID DEPOSIT, OR SHORT ONLY BY THE FEES (option 2, 2026-10-01): not the tabs again - the
    // rest, as one exact invoice, handed to the paid offer's `outcome` (the modal stays and shows it) or, with no paid
    // deposit before it, asked for at once.
    if (askDeposit) {
      const short = (n.need !== null ? n.need : n.floor) - have;
      const restMsat = prev || shortOnlyByFees(have, short, stakeOf(round)) ? restOfFeesMsat(short > 0n ? short : 0n) : null;
      // THE OFFER ALREADY SHOWN AT THE PRESS (earlyDepositOffer, 2026-10-18): a wallet short of the stake was asked at once,
      // while the round's other steps ran - that offer is this one; it is waited for, not made or asked again
      const adopt = !prev && early && !early.adopted && restMsat === null;
      if (adopt) early.adopted = true;
      const offer = adopt ? early : depositOffer({ client, stakeMsat: stakeOf(round), haveMsat: have, needMsat: n.need, gateways, onDeposit,
        storage, federationId: round.federationId, restMsat, sizeOf: (k) => roundsDepositMsat(k, locks, LockClient) });
      if (adopt) { /* already on the screen */ } else if (prev) prev.decided({ funded: false, rest: offer }); else askDeposit(offer);
      onStep(restMsat === null ? 'waiting for the deposit into the player wallet' : `waiting for the rest of this round's fees: ${restMsat} msat`);
      // NOT PAST THE ROUND'S ENTRY (MF 18: a deposit left open was still waiting 30 s and 151 s past the close, the round's
      // clock at 0:00 behind it, no error): at the round's last entry instant the request is closed with the reason - the join is
      // refused by name. Its invoice is still followed: paid later, it lands in the player wallet, for the next round.
      let closeTimer = null;
      // A DEPOSIT ASKED BECAUSE THE WALLET WAS SHORT IS THE WALLET'S, NOT THE ROUND'S (2026-10-18 playtest, RPS with 0 sat: "No deposit
      // screen comes" - measured on the test host: an RPS round's entry closed 3 s after the press, which closed the offer before it was ever
      // seen): at the round's entry close the join ends by name, and the early offer stays on the screen - its invoice still followed, paid
      // later it lands in the player wallet for the next round
      if (adopt && entryClosesMs !== null && entryClosesMs !== undefined && Number.isFinite(Number(entryClosesMs))) {
        const why = `the round's entry closed at ${new Date(Number(entryClosesMs)).toISOString().slice(11, 19)} UTC before the deposit arrived: nothing was taken for this round; the deposit is still open and goes into your wallet for the next round`;
        const left = Math.max(0, Number(entryClosesMs) - Date.now());
        await Promise.race([offer.claimed, new Promise((resolve, reject) => { closeTimer = setTimeout(() => reject(new Error(why)), left); })])
          .finally(() => { if (closeTimer) clearTimeout(closeTimer); });
      } else if (entryClosesMs !== null && entryClosesMs !== undefined && Number.isFinite(Number(entryClosesMs))) {
        const why = `the round's entry closed at ${new Date(Number(entryClosesMs)).toISOString().slice(11, 19)} UTC before the deposit arrived: nothing was taken for this round`;
        const left = Number(entryClosesMs) - Date.now();
        if (left <= 0) offer.close(why); else closeTimer = setTimeout(() => offer.close(why), left);
      }
      const d = await offer.claimed.finally(() => { if (closeTimer) clearTimeout(closeTimer); });
      deposits.push(d);
      depositRow(storage, round, d);
      prev = offer;
      continue;
    }
    if (tries >= 3) throw new Error(`after ${tries} deposits the player wallet holds ${have} msat and cannot fund this round's locks`);
    const shortBy = n.need !== null ? n.need - have : n.floor - have;
    // NEVER A DEPOSIT SMALLER THAN THE LOCKS' ALLOWANCE: a Lightning receive that small is refused (measured, 556 msat).
    const least = n.locks.reduce((t, m) => t + BigInt(LockClient.lockAllowanceMsat(String(m))), 0n);
    const asked = shortBy > least ? shortBy : least;
    // THE INVOICE AT ONCE (INSTANT-1527, 2026-09-30 15:23: "PLAY to the deposit invoice is a Lightning payment").
    // Measured in a page on testnet4: the lock client's depositFor took 256.8 s - it searches the invoice amount with a
    // receive-fee quote over the network at every step - against 1.3 s for the receive itself. With `estimateDeposit`
    // the invoice is sized from the fees here: measured, gateway B's receive plus the claim took 31698 msat of 9899474
    // (0.32%); DEPOSIT_MARGIN_PPM and DEPOSIT_MARGIN_MSAT cover that with room, and what is over stays in the player's
    // own wallet. A credit that still falls short is topped up by this loop's next deposit.
    // GROSS (GROSS-INVOICE-2053): the invoice is the round's stake, never the shortfall less fee and donation
    const plan = estimateDeposit
      ? { invoice_msat: String(stakeOf(round) > 0n ? stakeOf(round) : asked), credited_msat: String(asked), gateway: '' }
      : JSON.parse(await client.depositFor(String(asked)));
    // ANY LISTED GATEWAY, THE NEXT AFTER A TIMEOUT: the named first, then the federation's list
    const order = gatewayOrder([...await seatedGatewaysOf(client), depositGateway(plan.gateway, gateways)].filter(Boolean), await federationGateways(client));
    const invoice = await invoiceThroughGateways(client, plan.invoice_msat, order);
    const d = { invoice: invoice.invoice, amountMsat: BigInt(plan.invoice_msat), creditsMsat: BigInt(plan.credited_msat), gateway: invoice.gateway, tried: invoice.tried };
    deposits.push(d);
    onDeposit(d);
    onStep('waiting for the deposit into the player wallet');
    const final = await new Promise((resolve) => {
      let open = 1, over = false;
      followWithFailover(client, invoice, { amountMsat: plan.invoice_msat, order, done: () => over,
        onInvoice: (n) => { open++; const e = { ...d, invoice: n.invoice, gateway: n.gateway, failoverFrom: n.failoverFrom, failoverWhy: n.failoverWhy }; deposits.push(e); onDeposit(e);
          onStep(`gateway ${n.failoverFrom || 'one'} ${n.failoverWhy}: a fresh invoice from the next gateway - either may be paid`); },
        onEnd: (x, f, failover) => { if (over) return; if (f === 'Claimed') { over = true; resolve(f); return; } open--; if (!failover && open <= 0) { over = true; resolve(f); } },
        onExhausted: () => { if (!over && open <= 0) { over = true; resolve('no gateway left'); } } });
    });
    if (final !== 'Claimed') throw new Error(`the deposit into the player wallet was not claimed: ${final}`);
    depositRow(storage, round, d);
  }
  return { client, deposits, heldMsat: BigInt(await client.balanceMsat()) };
}

/** The shares a donation pays in the federation: for a set of keys, each share above 0 msat, in the set's order; else none. */
export function donationKeyShares(donationMsat, recipients) {
  // A VERSION-11 TARGET (§27A.9.2): { network, game, reserve: { recipientPk, amountMsat } } - the developers' part of
  // the donation over their sets, then one share to the federation's reserve key, marked, last
  if (recipients && recipients.reserve && typeof donationMsat === 'bigint') {
    const r = recipients.reserve;
    const devs = donationMsat - BigInt(r.amountMsat);
    if (devs < 0n) throw new Error('the donation is smaller than its reserve part');
    const shares = devs > 0n ? donationKeyShares(devs, { network: recipients.network, game: recipients.game }) : [];
    return [...shares, { recipientPk: r.recipientPk, amountMsat: BigInt(r.amountMsat), label: 'protocol reserves', reserve: true }];
  }
  if (typeof donationMsat !== 'bigint' || donationMsat <= 0n || !donationSetPaysKeys(recipients)) return [];
  const split = splitDonation({ donationMsat, recipients });
  if (!split.owed) throw new Error(`the donation cannot be split over this round's set: ${split.why}`);
  return split.shares.filter((s) => s.amountMsat > 0n);
}

/**
 * THE DONATION OUTPUTS THE LOCK CLIENT MADE, CHECKED: one per share, in order, each the contract the guardians store, to that
 * share's key, for exactly its amount - or no lock answer is taken. Outpoints as the entry names them.
 */
export function donationOutputsFromClient(said, shares) {
  if (!Array.isArray(said) || said.length !== shares.length)
    throw new Error(`the lock client made ${Array.isArray(said) ? said.length : 'no'} donation output(s), and the donation owes ${shares.length}`);
  return said.map((d, i) => {
    if (d.ids_match !== true) throw new Error('the guardians hold another contract at a donation output than the one built');
    if (String(d.recipient_pk).toLowerCase() !== toHex(shares[i].recipientPk)) throw new Error(`donation output ${i} pays another key than the set's`);
    if (BigInt(d.amount_msat) !== shares[i].amountMsat) throw new Error(`donation output ${i} holds ${d.amount_msat} msat, and its share is ${shares[i].amountMsat}`);
    if (!/^[0-9a-f]{64}$/.test(String(d.txid)) || !Number.isInteger(d.out_idx)) throw new Error('the lock client named no donation outpoint');
    return { txid: fromHex(d.txid), outIdx: BigInt(d.out_idx), recipientPk: shares[i].recipientPk, amountMsat: shares[i].amountMsat, ...(shares[i].reserve ? { reserve: true } : {}) };
  });
}

/**
 * THE STAKE, SPENT FROM THE PLAYER WALLET INTO THE ROUND'S LOCK (§24A.1, §23.1 steps 3-5). Opens the player wallet for
 * the round's federation - never a per-round wallet - and locks the net stake (and the fee lock, when Pick b's gate
 * says it pays) from its notes. It asks for NO deposit: a wallet short of the round's locks is refused by name, and
 * the top-up is `fundPlayerWallet`, before. Returns the outpoint and the contract (`lockFromClient`), the client that
 * holds it, and the wallet's balance before and after.
 */
export async function lockStake({ round, roundId, invite, seed, stake, claimKey, playerPubkey, LockClient,
  storage, donationMsat = 0n, donationRecipients = null, onStep = () => {} } = {}) {
  paysIntoALock(round, invite, LockClient);
  if (!stake || namesNothing(stake.stakePoint)) throw new Error('a lock is to the stake\'s point, and this stake names none');
  if (!claimKey || !claimKey.ok || namesNothing(claimKey.claimPk))
    throw new Error('no claim key has its signer nodes\' attestation: a client must refuse to lock to a key without it (23.1 step 0)');
  if (!(playerPubkey instanceof Uint8Array) || playerPubkey.length !== 32)
    throw new Error('a lock refunds to the player\'s key, and that is 32 bytes');

  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  // THE SAME CHECK THE FUNDING MADE (measured in the tests with 1 msat notes: given only { amount, feeMsat } this check
  // dropped the fee-free flag and the donation and asked the reserve back - a wallet funded for exactly its round refused)
  const locks = await locksFor(round, client, donationMsat, donationRecipients);
  const { amount, feeGate, feeMsat } = locks;
  const before = BigInt(await client.balanceMsat());
  const n = await needFor(client, LockClient, locks);
  if (n.need === null || before < n.need)
    throw new Error(`no stake is locked to this round: the player wallet holds ${before} msat and this round's locks need `
      + `${n.need === null ? `at least ${n.floor}` : n.need} msat - top the player wallet up first; the stake itself asks for no deposit`);

  onStep(`the player wallet holds ${before} msat; locking ${amount} msat (and ${feeMsat} msat of node fee after it) from it`);
  const refundPk = refundKeyOf(playerPubkey);
  // A LOCK IS MADE FOR EXACTLY stake_expiry_blocks (§23.1 step 4, RULED 2026-09-24: no margin).
  const delta = Number(round.stakeExpiryBlocks);
  // THE STAKE AND THE FEE IN ONE TRANSACTION (2026-10-02, the join's 2-3 s): `lockBoth` when the lock client has it
  // and a fee is due - one block count, one transaction, one acceptance, both outpoints read together - each half checked
  // exactly as a lone lock is. Measured before: the two locks one after the other, 7.2 s of a paid join (Q4).
  // THE LOCK ANSWERED ON SUBMISSION, ITS ACCEPTANCE CHECKED AFTER (2026-10-03, OPEN-LIST-2140 item 3: PLAY to the
  // entry committed was 3.5-4.7 s, the lock's federation acceptance 1.9-2.6 s of it). `lockSubmit` hands the guardians the
  // one transaction - stake, fee lock when due, donation outputs - and answers its outpoints at once; the entry names them
  // and goes to the signer nodes while the guardians accept it. `accepted` is the old answer's every check, made when they
  // have: a lock refused there refuses the join by name (the signer nodes never count a stake they cannot find).
  if (typeof client.lockSubmit === 'function' && typeof client.lockAccepted === 'function') {
    const donationShares = donationKeyShares(donationMsat, donationRecipients);
    onStep(`locking the stake${feeGate.pays ? ', the node fee' : ''}${donationShares.length ? ' and the donation' : ''} (submitted, accepted behind)`);
    const preimage = feeGate.pays ? feeSecretFor(seed, roundId) : null;
    const image = preimage ? sha256(preimage) : null;
    const submitted = JSON.parse(await client.lockSubmit(toHex(stake.stakePoint), String(amount), image ? toHex(image) : '',
      String(feeGate.pays ? feeMsat : 0n), toHex(claimKey.claimPk), toHex(refundPk), delta,
      JSON.stringify(donationShares.map((d) => ({ pk: toHex(d.recipientPk), msat: String(d.amountMsat), image: toHex(playerPubkey) })))));
    const asBuilt = (o, image) => ({ outpoint: { txid: fromHex(submitted.txid), outIdx: BigInt(o.out_idx) },
      fields: { paymentImage: image, amountMsat: BigInt(o.amount_msat), claimPk: claimKey.claimPk, refundPk, expiration: o.computed_expiration },
      contractId: o.computed_contract_id });
    const outs = submitted.outputs || [];
    const stakeOut = outs.find((o) => o.role === 'stake');
    const feeOut = outs.find((o) => o.role === 'fee');
    if (!stakeOut || BigInt(stakeOut.amount_msat) !== amount) throw new Error(`the lock client built ${stakeOut ? stakeOut.amount_msat : 'no'} msat of stake, and this entry's net stake is ${amount}`);
    if (feeGate.pays && (!feeOut || BigInt(feeOut.amount_msat) !== feeMsat)) throw new Error(`the lock client built ${feeOut ? feeOut.amount_msat : 'no'} msat of fee lock, and this entry's fee is ${feeMsat}`);
    const lock = asBuilt(stakeOut, { kind: 'point', bytes: stake.stakePoint });
    const feeLock = feeGate.pays ? { ...asBuilt(feeOut, { kind: 'hash', bytes: image }), preimage } : null;
    const donations = donationOutputsFromClient(outs.filter((o) => o.role === 'donation').map((o) => ({ ...o, txid: submitted.txid, ids_match: true })), donationShares);
    const accepted = (async () => {
      const all = JSON.parse(await client.lockAccepted(JSON.stringify(submitted)));
      const got = lockFromClient(all.stake, { point: stake.stakePoint, claimPk: claimKey.claimPk, refundPk });
      if (got.contractId !== lock.contractId || got.outpoint.outIdx !== lock.outpoint.outIdx)
        throw new Error('the guardians hold the stake lock at another output than the entry names');
      if (feeLock) {
        const f = lockFromClient(all.fee, { hash: image, claimPk: claimKey.claimPk, refundPk });
        if (f.contractId !== feeLock.contractId || f.outpoint.outIdx !== feeLock.outpoint.outIdx)
          throw new Error('the guardians hold the fee lock at another output than the entry names');
      }
      donationOutputsFromClient(all.donations, donationShares);
      return { ok: true, walletAfterMsat: BigInt(await client.balanceMsat()) };
    })();
    accepted.catch(() => { /* the caller is handed it; unobserved, it must not be an unhandled rejection */ });
    return { ...lock, client, feeLock, feeGate, donations, accepted, walletBeforeMsat: before, walletAfterMsat: null };
  }
  // THE DONATION IN THE SAME TRANSACTION (2026-10-03, FEDERATION.md "Donations in the federation"): a round whose set
  // pays keys gets one payout contract per share above 0 msat, in the set's order, beside the stake (and the fee lock) -
  // `lockWithDonations`. The entry names the outpoints; the seats check them with the federation before the stake counts.
  const donationShares = donationKeyShares(donationMsat, donationRecipients);
  if (donationShares.length) {
    if (typeof client.lockWithDonations !== 'function')
      throw new Error('this round pays its donation in the federation, and this page\'s lock client cannot - reload the page');
    onStep(`locking the stake${feeGate.pays ? ', the node fee' : ''} and the donation together`);
    const preimage = feeGate.pays ? feeSecretFor(seed, roundId) : null;
    const image = preimage ? sha256(preimage) : null;
    const all = JSON.parse(await client.lockWithDonations(toHex(stake.stakePoint), String(amount), image ? toHex(image) : '',
      String(feeGate.pays ? feeMsat : 0n), toHex(claimKey.claimPk), toHex(refundPk), delta,
      JSON.stringify(donationShares.map((d) => ({ pk: toHex(d.recipientPk), msat: String(d.amountMsat), image: toHex(playerPubkey) })))));
    const lock = lockFromClient(all.stake, { point: stake.stakePoint, claimPk: claimKey.claimPk, refundPk });
    if (lock.fields.amountMsat !== amount)
      throw new Error(`the lock client locked ${lock.fields.amountMsat} msat, and this entry's net stake is ${amount}`);
    let feeLock = null;
    if (feeGate.pays) {
      const made = lockFromClient(all.fee, { hash: image, claimPk: claimKey.claimPk, refundPk });
      if (made.fields.amountMsat !== feeMsat)
        throw new Error(`the lock client locked ${made.fields.amountMsat} msat as the fee, and this entry's fee is ${feeMsat}`);
      feeLock = { ...made, preimage };
    }
    const donations = donationOutputsFromClient(all.donations, donationShares);
    return { ...lock, client, feeLock, feeGate, donations, walletBeforeMsat: before, walletAfterMsat: BigInt(await client.balanceMsat()) };
  }
  if (feeGate.pays && typeof client.lockBoth === 'function') {
    onStep('locking the stake and the node fee together');
    const preimage = feeSecretFor(seed, roundId);
    const image = sha256(preimage);
    const both = JSON.parse(await client.lockBoth(toHex(stake.stakePoint), String(amount), toHex(image), String(feeMsat),
      toHex(claimKey.claimPk), toHex(refundPk), delta));
    const lock = lockFromClient(both.stake, { point: stake.stakePoint, claimPk: claimKey.claimPk, refundPk });
    if (lock.fields.amountMsat !== amount)
      throw new Error(`the lock client locked ${lock.fields.amountMsat} msat, and this entry's net stake is ${amount}`);
    const made = lockFromClient(both.fee, { hash: image, claimPk: claimKey.claimPk, refundPk });
    if (made.fields.amountMsat !== feeMsat)
      throw new Error(`the lock client locked ${made.fields.amountMsat} msat as the fee, and this entry's fee is ${feeMsat}`);
    return { ...lock, client, feeLock: { ...made, preimage }, feeGate, walletBeforeMsat: before, walletAfterMsat: BigInt(await client.balanceMsat()) };
  }
  onStep('locking the stake');
  const answer = await client.lock(toHex(stake.stakePoint), String(amount), toHex(claimKey.claimPk), toHex(refundPk), delta);
  const lock = lockFromClient(answer, { point: stake.stakePoint, claimPk: claimKey.claimPk, refundPk });
  if (lock.fields.amountMsat !== amount)
    throw new Error(`the lock client locked ${lock.fields.amountMsat} msat, and this entry's net stake is ${amount}`);

  let feeLock = null;
  if (feeGate.pays) {
    onStep('locking the node fee');
    const preimage = feeSecretFor(seed, roundId);
    const image = sha256(preimage);
    const said = await client.lockHash(toHex(image), String(feeMsat), toHex(claimKey.claimPk), toHex(refundPk), delta);
    const made = lockFromClient(said, { hash: image, claimPk: claimKey.claimPk, refundPk });
    if (made.fields.amountMsat !== feeMsat)
      throw new Error(`the lock client locked ${made.fields.amountMsat} msat as the fee, and this entry's fee is ${feeMsat}`);
    feeLock = { ...made, preimage };
  }
  return { ...lock, client, feeLock, feeGate, walletBeforeMsat: before, walletAfterMsat: BigInt(await client.balanceMsat()) };
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

// THE WALLET'S HISTORY (2026-09-30 16:15: "Settings, under the balances, shows a transaction history. Every deposit,
// every withdrawal, and every deduction for a game stake. A stake row names the round"). APPEND-ONLY, ONE LIST PER
// FEDERATION, in the tab's vault under arena.ledger.<federation id hex>: a deposit row once its receive is claimed
// (fundPlayerWallet), a stake row when saveLock keeps the lock (markLockCommitted adds its entry), a withdrawal row when a
// withdraw succeeds. Rows are what this tab did; nothing here asks the federation.
const LEDGER_PREFIX = 'arena.ledger.';
const LEDGER_READ_PREFIX = 'arena.ledger.read.';
const fedHexOf = (f) => (f instanceof Uint8Array ? toHex(f) : String(f || '')).toLowerCase();
export const ledgerKey = (federationId) => `${LEDGER_PREFIX}${fedHexOf(federationId)}`;
/** This federation's rows, oldest first, as kept. */
export function ledgerRows(storage, federationId) {
  try { const raw = storage && storage.getItem(ledgerKey(federationId)); const rows = raw ? JSON.parse(raw) : []; return Array.isArray(rows) ? rows : []; }
  catch { return []; }
}
/**
 * WHAT THE WALLET HISTORY DRAWS (2026-10-04 15:45: "One line: Stake round xxx -100 sat. The 100 is the
 * stake plus the donation. No Donation row."): every donation row whose round has a stake row is folded into that stake row
 * - the amounts summed, the stake row's own time, round, entry and player kept. A donation with no stake row of its round
 * stays its own line, so nothing paid disappears. Drawing only: the stored ledger is not rewritten.
 */
export function ledgerHistory(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const stakeOf = new Map();
  for (const r of list) if (r && r.kind === 'stake' && r.round && !stakeOf.has(r.round)) stakeOf.set(r.round, { ...r });
  const out = [];
  for (const r of list) {
    if (r && r.kind === 'donation' && r.round && stakeOf.has(r.round)) {
      const s = stakeOf.get(r.round);
      s.msat = String(BigInt(s.msat || 0) + BigInt(r.msat || 0));
      continue;
    }
    out.push(r && r.kind === 'stake' && r.round && stakeOf.has(r.round) && !out.includes(stakeOf.get(r.round)) ? stakeOf.get(r.round) : r);
  }
  return out;
}
function ledgerAppend(storage, federationId, row) {
  if (!storage || !fedHexOf(federationId)) return;
  try {
    const rows = ledgerRows(storage, federationId);
    rows.push({ atMs: Date.now(), ...row });
    storage.setItem(ledgerKey(federationId), JSON.stringify(rows));
  } catch { /* a tab that cannot write keeps no history; the money is not touched */ }
}
const storageKeys = (storage) => {
  const out = [];
  try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k) out.push(k); } } catch { /* none */ }
  return out;
};
const lockTotalMsat = (j) => BigInt(j.fields && j.fields.amountMsat ? j.fields.amountMsat : 0)
  + BigInt(j.feeLock && j.feeLock.fields && j.feeLock.fields.amountMsat ? j.feeLock.fields.amountMsat : 0);
/**
 * THE STAKES THIS TAB KEPT BEFORE THE HISTORY EXISTED, READ ONCE (per federation): every arena.lock.saved.<round>.<player>
 * without a stake row becomes one, its time unknown (null). A saved lock does not name its federation; the tab's paying
 * rounds are of the one federation it deposits into, which is the one asked for here.
 */
export function ledgerReadSavedStakes(storage, federationId) {
  if (!storage || !fedHexOf(federationId)) return 0;
  const flag = `${LEDGER_READ_PREFIX}${fedHexOf(federationId)}`;
  try { if (storage.getItem(flag)) return 0; } catch { return 0; }
  const rows = ledgerRows(storage, federationId);
  let added = 0;
  for (const k of storageKeys(storage)) {
    const m = /^arena\.lock\.saved\.([0-9a-f]{64})\.([0-9a-f]{16})$/.exec(k);
    if (!m || rows.some((r) => r.kind === 'stake' && r.round === m[1] && r.player === m[2])) continue;
    let j; try { j = JSON.parse(storage.getItem(k)); } catch { continue; }
    rows.push({ atMs: null, kind: 'stake', round: m[1], player: m[2], entry: j.committedTo || null, msat: String(lockTotalMsat(j)), read: true });
    added++;
  }
  try { storage.setItem(ledgerKey(federationId), JSON.stringify(rows)); storage.setItem(flag, String(Date.now())); } catch { return 0; }
  return added;
}

const savedLockKey = (roundId, playerPubkey) => `arena.lock.saved.${toHex(roundId)}.${toHex(playerPubkey).slice(0, 16)}`;

/**
 * A LOCK THIS TAB MADE, WITH THE STAKE IT LOCKS - kept so a reload before any
 * signer node has committed it uses the same stake and the same lock. The stake's
 * preimage is kept where the player's seed already is (the tab's storage), and
 * its handout as the bytes the signer nodes took.
 */
export function saveLock(storage, { roundId, playerPubkey, stake, lock, federationId = null }) {
  const lockMsat = BigInt(lock.fields && lock.fields.amountMsat ? lock.fields.amountMsat : 0n)
    + BigInt(lock.feeLock && lock.feeLock.fields && lock.feeLock.fields.amountMsat ? lock.feeLock.fields.amountMsat : 0n);
  if (federationId) ledgerAppend(storage, federationId, { kind: 'stake', round: toHex(roundId), player: toHex(playerPubkey).slice(0, 16),
    entry: null, msat: String(lockMsat) });
  storage.setItem(savedLockKey(roundId, playerPubkey), JSON.stringify({
    preimage: toHex(stake.preimage), body: toHex(stake.body),
    outpoint: { txid: toHex(lock.outpoint.txid), outIdx: String(lock.outpoint.outIdx) },
    fields: lockFieldsToJson(lock.fields), committedTo: null,
    // AND ITS FEE LOCK, when one was minted (Pick b): the same reload keeps it.
    feeLock: lock.feeLock ? { preimage: toHex(lock.feeLock.preimage),
      outpoint: { txid: toHex(lock.feeLock.outpoint.txid), outIdx: String(lock.feeLock.outpoint.outIdx) },
      fields: lockFieldsToJson(lock.feeLock.fields) } : null,
    // AND ITS DONATION OUTPUTS (2026-10-03): the entry names them, so a reload names the same
    donations: (lock.donations || []).map((d) => ({ txid: toHex(d.txid), outIdx: String(d.outIdx), recipientPk: toHex(d.recipientPk), amountMsat: String(d.amountMsat) })),
  }));
  // THE DONATION IN THE WALLET'S HISTORY, paid with the stake
  const donated = (lock.donations || []).reduce((t, d) => t + BigInt(d.amountMsat), 0n);
  if (federationId && donated > 0n) ledgerAppend(storage, federationId, { kind: 'donation', msat: String(donated), round: toHex(roundId) });
}

/** The kept lock for this round and player, rebuilt - or null. `committedTo` names the entry a signer node committed it to. */
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
        fields: lockFieldsFromJson(j.feeLock.fields) } : null,
      donations: (j.donations || []).map((d) => ({ txid: fromHex(d.txid), outIdx: BigInt(d.outIdx), recipientPk: fromHex(d.recipientPk), amountMsat: BigInt(d.amountMsat) })) },
    committedTo: j.committedTo || null,
  };
}

/** A signer node committed the kept lock to `entryId`: from now on it is that entry's stake, not one to reuse. */
/**
 * WHAT A TAB DOES WITH THE LOCK IT KEPT FOR THIS ROUND, ON A RELOAD (6d, W4 hole 1). None:
 * a new join. One no signer node committed: the same stake and lock, no second deposit (W1b).
 * One a signer node COMMITTED to an entry: that signer node is taken and its stake is locked - measured
 * before: the page dealt a new stake and set out to fund "980000 + 20000 msat of lock",
 * a second deposit for a round the player already stakes. A tab that kept the very entry the lock is committed to
 * plays it again (before the start) or resumes it (until the close); otherwise the join stops, says why, and the
 * payout and stake are still collected from the tab's kept record.
 */
export function keptLockUse(kept, { entry = null, beforeStart = false, beforeClose = false } = {}) {
  if (!kept) return { use: 'new' };
  if (!kept.committedTo) return { use: 'reuse', kept };
  // UNLESS THE TAB KEPT THAT VERY ENTRY AND THE ROUND HAS NOT STARTED (measured 2026-10-03 13:58:51Z on 0.0.2490: a reload
  // 10 s into a chained join, 84 s before its round's start, refused here - the lock was committed and the kept entry and
  // session key (PAID-NIGHT-2155) were never reached). Before the start there is no run to lose: the same entry is sent
  // again, the seats take it as the one they hold, and the run is played from its start.
  let keptId = null;
  // entryId by its own name: the bundle strips imports, and an "as" alias is undefined there (measured: 0.0.2491 refused)
  try { keptId = entry ? toHex(entryId(entry)) : null; } catch { keptId = null; }
  if (beforeStart && keptId && keptId === String(kept.committedTo)) return { use: 'reuse', kept, resumed: true };
  // AND AFTER THE START, UNTIL THE ROUND CLOSES (2026-10-03: "a reload after the round has started ... That run must
  // not be lost"): the same entry, lock and session key, and the run is RESUMED from what the seats hold of it (the bridge
  // replays the transcript and goes on from the adopted mark - blwp.jslib BLWP_RESUME). After the close only the collect.
  if (!beforeStart && beforeClose && keptId && keptId === String(kept.committedTo)) return { use: 'reuse', kept, resumed: 'running' };
  return { use: 'staked', kept,
    why: `this tab's stake in this round is already locked and committed to entry ${String(kept.committedTo).slice(0, 16)}…: `
      + 'no second deposit - the run cannot be resumed after a reload, and its payout and stake are collected after the window' };
}

export function markLockCommitted(storage, { roundId, playerPubkey, entryId }) {
  const key = savedLockKey(roundId, playerPubkey);
  const raw = storage.getItem(key);
  if (!raw) return;
  storage.setItem(key, JSON.stringify({ ...JSON.parse(raw), committedTo: toHex(entryId) }));
  // AND THE STAKE ROW NAMES ITS ENTRY, in whichever federation's history holds it
  const round = toHex(roundId), player = toHex(playerPubkey).slice(0, 16);
  for (const k of storageKeys(storage)) {
    if (!k.startsWith(LEDGER_PREFIX) || k.startsWith(LEDGER_READ_PREFIX)) continue;
    let rows; try { rows = JSON.parse(storage.getItem(k)); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    let changed = false;
    for (const r of rows) if (r.kind === 'stake' && r.round === round && r.player === player && !r.entry) { r.entry = toHex(entryId); changed = true; }
    if (changed) { try { storage.setItem(k, JSON.stringify(rows)); } catch { /* kept as it was */ } }
  }
}

/**
 * THE PLAYER'S LOCKS IN A ROUND, FOUND BY THEIR REFUND KEY (W5a): what a
 * session holding only the seed can ask - the refund key is derived from it,
 * the outpoint and stake point were random. Each signer node answers with the locks it
 * verified; the lock client then refuses one the guardians do not hold as
 * rebuilt, so a lying signer node can point at nothing this key can spend.
 */
export async function findLock({ roundId, playerPubkey, nodes, fetcher = fetch } = {}) {
  const refund = toHex(refundKeyOf(playerPubkey));
  const found = new Map();
  // WHO ANSWERED: the list carries how many signer nodes were asked, answered and named a lock, and each
  // one's reply in short - an empty list nobody answered is not "no lock".
  const asked = [...new Set(nodes || [])];
  const said = [];
  for (const node of asked) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/stake-lock?round=${toHex(roundId)}&refund=${refund}`);
      if (!r.ok) { said.push(`${String(node).replace(/^https?:\/\//, '').slice(0, 40)} ${r.status}`); continue; }
      const got = await r.json();
      said.push(`${String(node).replace(/^https?:\/\//, '').slice(0, 40)} ${got.length}`);
      for (const l of got) {
        const [txid, outIdx] = String(l.outpoint).split(':');
        if (!found.has(l.outpoint))
          found.set(l.outpoint, { outpoint: { txid: fromHex(txid), outIdx: BigInt(outIdx) }, fields: lockFieldsFromJson(l.fields), entryId: l.entryId });
      }
    } catch (e) { said.push(`${String(node).replace(/^https?:\/\//, '').slice(0, 40)} ${String(e && e.message || e).slice(0, 40)}`); }
  }
  const out = [...found.values()];
  out.asked = asked.length;
  out.answered = said.filter((x) => /\s\d+$/.test(x) && !/\s[45]\d\d$/.test(x)).length;
  out.said = said;
  return out;
}

/**
 * THE PLAYER'S REFUND, FROM THE SEED ALONE (§23.2: the default path - nobody
 * acts, the lock expires, the player's key takes it back). The seed gives the
 * round's player key and the lock client's secret; the signer nodes say where the lock
 * is; a fresh wallet under the seed's secret spends it with the player's key.
 * The guardians refuse it before the lock's expiration - reported, not thrown.
 */
export async function refundStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  onStep = () => {}, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  onStep('asking the signer nodes where this seed\'s lock is');
  const locks = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher });
  if (!locks.length) throw new Error('no signer node knows a stake lock that refunds to this seed\'s key in this round');
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
 * THE COMMITTEE'S FORFEIT OF THIS PLAYER'S LOCK, from the signer nodes (GET /forfeit,
 * W5b): a BIP-340 signature by the round's claim key over the lock's contract
 * id, made only for a qualifier after the window. The first signer node that has it
 * answers; a loser's is refused by every signer node, with the signer nodes' reasons. The
 * lock client checks it under the contract (and the guardians again) - a signer node
 * that answers with bytes that are not the forfeit gets nothing through.
 */
// `lock`: 'stake', or 'fee' - a market order's fee lock, which the seats return whole for an order the book
// never filled and claim at resolution for one it did
export async function forfeitOf({ roundId, entryId, nodes, fetcher = fetch, lock = 'stake' } = {}) {
  const refused = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/forfeit?round=${toHex(roundId)}&entry=${entryId}${lock === 'fee' ? '&lock=fee' : ''}`);
      if (!r.ok) { refused.push(`${node}: ${r.status} ${(await r.text()).trim()}`); continue; }
      const j = await r.json();
      if (/^[0-9a-f]{128}$/.test(String(j.signature))) return { ok: true, signature: j.signature, contractId: j.contractId, claimPk: j.claimPk, from: node };
      refused.push(`${node}: answered no signature`);
    } catch (e) { refused.push(`${node}: ${e.message}`); }
  }
  return { ok: false, why: `no signer node gave a forfeit of this lock: ${refused.join('; ')}`, refused };
}

/**
 * THE PLAYER'S REDEEM OF A FORFEITED LOCK, FROM THE SEED ALONE (§23.2 row 1:
 * "the player's own client redeems it, and only the player can"). The seed
 * gives the round's player key and the lock client's secret; the signer nodes say
 * where the lock is and give the committee's forfeit; a fresh wallet under the
 * seed's secret spends the lock with the player's key.
 */
export async function redeemStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  client: given = null, onStep = () => {}, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  onStep('asking the signer nodes where this seed\'s lock is');
  const locks = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher });
  if (!locks.length) throw new Error('no signer node knows a stake lock that refunds to this seed\'s key in this round');
  const forfeits = [];
  for (const l of locks) {
    onStep('asking the signer nodes for the forfeit of the lock');
    const f = await forfeitOf({ roundId, entryId: l.entryId, nodes, fetcher });
    if (!f.ok) throw new Error(f.why);
    forfeits.push({ lock: l, forfeit: f });
  }
  // AND THE ORDER'S FEE LOCK (measured 2026-10-11 by the bots on the regtest Up/Down market: an order the book
  // never filled came back without its 1 % - 54,450 of 55,000 msat, 55,440 of 56,000 - because only stake locks were ever
  // looked up). The tab's own record of it (this order's saved lock, under its own key); the seats give its forfeit only
  // when the order was not filled (or was cancelled, or the market refunded) - a fee they claim at resolution is refused,
  // and left alone.
  const kept = storage ? savedLock(storage, { roundId, playerPubkey: player.pubkey }) : null;
  const fee = kept && kept.lock && kept.lock.feeLock;
  const feeEntry = locks.find((l) => l.entryId) || null;
  if (fee && feeEntry) {
    onStep('asking the signer nodes for the forfeit of the fee lock');
    const f = await forfeitOf({ roundId, entryId: feeEntry.entryId, nodes, fetcher, lock: 'fee' });
    if (f.ok) forfeits.push({ lock: { outpoint: fee.outpoint, fields: fee.fields, entryId: feeEntry.entryId, fee: true }, forfeit: f });
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
    redeems.push({ outpoint: l.outpoint, forfeitFrom: f.from, ...(l.fee ? { fee: true } : {}), ...said });
  }
  return { client, redeems };
}

/**
 * THE ROUND'S SETTLEMENT AS THE SIGNER NODES HOLD IT (GET /lock-settlement, W4): the first
 * signer node whose settlement the guardians ACCEPTED - its txid and what it moved. The
 * guardians check every payout again when it is spent, so a signer node that lies here
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
  return { ok: false, why: `no signer node holds an accepted settlement of this round yet (${said.join('; ')})` };
}

/**
 * THE WINNER COLLECTS ITS PAYOUT (6d, W4): the pre-expired payout contract the
 * signer nodes' one settlement made to this seed's key for this round, spent by Refund
 * under that key - open at once, and only that key can. A loser, or a player the
 * table pays nothing on top of their own stake, finds no payout and is told so;
 * nothing is asked of the lock client then. The winner's own stake comes back by
 * its forfeit (`redeemStake`).
 */
export async function redeemPayout({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  client: given = null, onStep = () => {}, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so it has no payout contract');
  // A PAYOUT THIS TAB ALREADY COLLECTED is answered from the tab's note: after a
  // reload the contract is spent, and asking the federation again could only fail
  // every time the page asks.
  const noted = `${PAYOUT_NOTE}${toHex(roundId)}${orderTag(order)}`;
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) return { ...JSON.parse(kept), amountMsat: BigInt(JSON.parse(kept).amountMsat), ok: true, final: true, kept: true };
  } catch { /* an unreadable note is no note */ }
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const mine = toHex(refundKeyOf(player.pubkey));
  onStep('asking the signer nodes for the round\'s settlement');
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
const PAYOUT_NOTE = 'arena.payout.';

/**
 * A ROUND THAT TAKES ANY FEDERATION'S SETTLEMENTS (2026.0.3 step 7): one transaction per federation, listed by the
 * seats' /lock-settlement as `federations` [{ federation, state, txid, moved: { payouts } }]. The first node that holds them all
 * ACCEPTED answers; else why not.
 */
export async function federationSettlementsOf({ roundId, nodes, fetcher = fetch } = {}) {
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock-settlement?round=${toHex(roundId)}`);
      if (!r.ok) { said.push(`${node}: ${r.status}`); continue; }
      const j = await r.json();
      if (j.state === 'ACCEPTED' && Array.isArray(j.federations) && j.federations.length
        && j.federations.every((f) => f.state === 'ACCEPTED' && f.moved && Array.isArray(f.moved.payouts)))
        return { ok: true, federations: j.federations, from: node };
      said.push(`${node}: ${j.state}`);
    } catch (e) { said.push(`${node}: ${e.message}`); }
  }
  return { ok: false, why: `no signer node holds every federation's settlement of this round accepted yet (${said.join('; ')})` };
}

/**
 * THE WINNER COLLECTS IN EVERY FEDERATION THAT PAID IT (2026.0.3 step 7): a round that takes any federation pays each winner the
 * same fraction of every federation's pot (federation-settlement.js), each a pre-expired payout contract to the same refund key
 * in that federation's own transaction. Each is spent by Refund into the player's wallet OF THAT FEDERATION - `clientFor(fidHex)`
 * the open wallet (the page keeps one per federation) - and noted per federation, so a reload asks only for what is left.
 * Answers { ok, final, collected: [{ federation, txid, outIdx, amountMsat }], waiting: [{ federation, why }], why }.
 */
export async function redeemPayoutsAcross({ round, roundId, seed, curve, storage, nodes, clientFor, fetcher = fetch, onStep = () => {}, order = 0 } = {}) {
  if (typeof clientFor !== 'function') throw new Error('a payout in several federations is collected into each federation\'s own wallet, and none was named');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const mine = toHex(refundKeyOf(player.pubkey));
  onStep('asking the signer nodes for the round\'s settlements');
  const s = await federationSettlementsOf({ roundId, nodes, fetcher });
  if (!s.ok) return { ok: false, final: false, collected: [], waiting: [], why: s.why };
  const collected = [], waiting = [];
  for (const f of s.federations) {
    const at = f.moved.payouts.findIndex((p) => p.kind === 'qualifier' && String(p.pk).toLowerCase() === mine);
    if (at < 0) continue;
    const fid = String(f.federation).toLowerCase();
    const noted = `${PAYOUT_NOTE}${toHex(roundId)}.${fid.slice(0, 16)}${orderTag(order)}`;
    try { const kept = storage && storage.getItem(noted); if (kept) { const k = JSON.parse(kept); collected.push({ ...k, amountMsat: BigInt(k.amountMsat), kept: true }); continue; } } catch { /* no note */ }
    const p = f.moved.payouts[at];
    const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(p.msat), claimPk: mine, refundPk: mine, expiration: 0 };
    onStep(`collecting the payout in federation ${fid.slice(0, 8)}`);
    let said;
    try { said = JSON.parse(await (await clientFor(fid)).refund(f.txid, at, JSON.stringify(fields), toHex(player.secret))); }
    catch (e) { waiting.push({ federation: fid, why: e.message }); continue; }
    const spent = said.accepted !== true && (said.stored_before === null || said.stored_before === undefined);
    if (said.accepted === true || spent) {
      const got = { federation: fid, txid: f.txid, outIdx: at, amountMsat: BigInt(p.msat), spent };
      collected.push(got);
      if (storage) try { storage.setItem(noted, JSON.stringify({ ...got, amountMsat: String(got.amountMsat) })); } catch { /* a reload asks again */ }
    } else waiting.push({ federation: fid, why: said.error || 'the federation did not accept the refund' });
  }
  if (!collected.length && !waiting.length) return { ok: false, final: true, collected, waiting, why: 'the round\'s settlements pay this seed\'s key nothing: no payout to collect' };
  return { ok: !waiting.length, final: !waiting.length, collected, waiting,
    why: waiting.length ? waiting.map((w) => `${w.federation.slice(0, 8)}: ${w.why}`).join('; ') : undefined };
}

/**
 * A SLASH'S PAYOUT (spec §5A.3B: "the arbitration set pegs it into the round's federation and locks each share
 * to its player"): when a node of this round was slashed for this player's entry, the arbitration service lists the share it
 * locked to the player's refund key - the key a settlement payout names - at GET /slash-payouts?round=. It is a pre-expired
 * lock, collected by Refund under that key exactly as a settlement payout is (redeemPayout); nobody else's key can move it.
 */
export async function redeemSlashPayout({ round, roundId, invite, seed, curve, LockClient, storage, arbiter, fetcher = fetch,
  client: given = null, onStep = () => {}, order = 0, listed: given_list = null } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so it has no slash payout');
  if (!arbiter) return { ok: false, final: false, why: 'no arbitration service named' };
  const noted = `${SLASH_PAYOUT_NOTE}${toHex(roundId)}${orderTag(order)}`;
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) return { ...JSON.parse(kept), amountMsat: BigInt(JSON.parse(kept).amountMsat), ok: true, final: true, kept: true };
  } catch { /* an unreadable note is no note */ }
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const mine = toHex(refundKeyOf(player.pubkey));
  onStep('asking the arbitration service for slash payouts');
  let listed = given_list;
  if (!listed) try {
    const r = await fetcher(`${String(arbiter).replace(/\/+$/, '')}/slash-payouts?round=${toHex(roundId)}`);
    if (!r.ok) return { ok: false, final: false, why: `the arbitration service answered ${r.status}` };
    listed = await r.json();
  } catch (e) { return { ok: false, final: false, why: `the arbitration service did not answer: ${e.message}` }; }
  const p = (listed.payouts || []).find((x) => String(x.refundPk).toLowerCase() === mine);
  if (!p) return { ok: false, final: true, why: 'no slash payout of this round names this seed\'s key' };
  const fields = { paymentImage: { kind: 'hash', bytes: '00'.repeat(32) }, amountMsat: String(p.msat), claimPk: mine, refundPk: mine, expiration: 0 };
  const secret = lockSecretFor(seed, roundId);
  const store = storage ? lockStoreFor(storage, roundId, secret) : unkeptLockStore();
  if (!given) onStep('joining the federation');
  const client = given || await LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
  onStep('collecting the slash payout');
  const said = JSON.parse(await client.refund(p.txid, Number(p.outIdx), JSON.stringify(fields), toHex(player.secret)));
  const spent = said.accepted !== true && (said.stored_before === null || said.stored_before === undefined);
  const got = { ok: said.accepted === true, final: said.accepted === true || spent, spent, txid: p.txid, outIdx: Number(p.outIdx), amountMsat: BigInt(p.msat),
    ...said, why: said.accepted === true ? undefined : spent ? 'the slash payout is already spent - by this seed\'s key, the only key that can' : (said.error || 'the federation did not accept the refund') };
  if (got.ok && storage) {
    try { storage.setItem(noted, JSON.stringify({ ...got, amountMsat: String(got.amountMsat) })); } catch { /* unkept: a reload asks again */ }
  }
  return { ...got, client };
}
const SLASH_PAYOUT_NOTE = 'arena.slash-payout.';

/** Whether a slash payout of the arbitration service's list (`listed`, GET /slash-payouts) names this seed's key in the round. */
export function slashPayoutMine(listed, { round, roundId, seed, curve, order = 0 } = {}) {
  const mine = toHex(refundKeyOf(playerFor({ ...round, id: roundId }, { seed, curve, order }).pubkey));
  return ((listed && listed.payouts) || []).find((p) => p.round === toHex(roundId) && String(p.refundPk).toLowerCase() === mine) || null;
}
/** Whether this tab already collected that round's slash payout (its note), so nothing is opened for it again. */
export const slashPayoutKept = (storage, roundId, order = 0) => { try { return !!(storage && storage.getItem(`${SLASH_PAYOUT_NOTE}${toHex(roundId)}${orderTag(order)}`)); } catch { return false; } };

/**
 * A SLASH PAYOUT INTO THE PLAYER WALLET: collected by Refund (redeemSlashPayout) into the wallet every
 * deposit and payout lands in, and written in its history as a slash payout.
 */
export async function collectSlashPayout({ round, roundId, invite, seed, curve, LockClient, storage, arbiter, listed = null, fetcher, order = 0 } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage });
  const before = BigInt(await client.balanceMsat());
  const got = await redeemSlashPayout({ round, roundId, invite, seed, curve, LockClient, storage, arbiter, listed, client, order, ...(fetcher ? { fetcher } : {}) });
  const after = BigInt(await client.balanceMsat());
  const creditedMsat = after > before ? after - before : 0n;
  if (creditedMsat > 0n) ledgerAppend(storage, round.federationId, { kind: 'slash-payout', msat: String(creditedMsat), round: toHex(roundId) });
  return { ...got, creditedMsat };
}

/**
 * AND THE PLAYER'S OWN STAKE BACK, AFTER THE WINDOW (6d, §23.2 row 1). The signer nodes
 * forfeit a qualifier's lock only once its result is FINAL with the window closed;
 * the page asks only once the signer nodes hold an ACCEPTED settlement, which they make
 * only then. Given, the lock is redeemed into the tab's wallet (`redeemStake`) and
 * kept in the tab; refused because the run did not qualify, it is final - that
 * stake went into the round's pool - and the lock client is asked nothing; refused
 * for anything else (the window, a signer node short), asked again.
 */
export async function returnStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  client = null, onStep = () => {}, refused = false, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const noted = `${STAKE_NOTE}${toHex(roundId)}${orderTag(order)}`;
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) { const k = JSON.parse(kept); return { ...k, amountMsat: BigInt(k.amountMsat), ok: true, final: true, kept: true }; }
  } catch { /* an unreadable note is no note */ }
  // A REFUSED ROUND IS NEVER SETTLED (§23.2 REFUSED): its stake comes back by the forfeit alone
  if (!refused) {
    const s = await settlementOf({ roundId, nodes, fetcher });
    if (!s.ok) return { ok: false, final: false, why: s.why };
  }
  let got;
  try {
    got = await redeemStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher, client, onStep, order });
  } catch (e) {
    // NOBODY WON (2026-10-03): a loser's stake comes back at settlement when no winner was paid - a signer node
    // whose settlement is not ACCEPTED yet, or whose round has an entry still in its window, says so, and is asked again
    const lost = /that run is \S+ with score/.test(e.message)
      && !/not ACCEPTED at this signer node|still inside its window|keeps no record of what its settlement moved/.test(e.message);
    return { ok: false, final: lost,
      why: lost ? 'the signer nodes forfeit this seed\'s lock to nobody: the run did not qualify, so its stake went into the round\'s pool' : e.message };
  }
  const rs = got.redeems;
  const ok = rs.length > 0 && rs.every((r) => r.accepted === true);
  // ALREADY BACK: the signer nodes forfeit only a qualifier's lock, and after that only this seed's
  // refund key can spend it (the committee's claim needs P, which only a loser's gives up) -
  // so a lock the guardians no longer hold came back to this key already (another tab, a
  // reload mid-redeem). Final, and said so; measured before: "not back yet - ... No contract
  // found for given ContractId", asked again every 5 s.
  const spent = !ok && rs.length > 0 && rs.every((r) => r.accepted !== true && (r.stored_before === null || r.stored_before === undefined));
  const res = { ok, final: ok || spent, spent, amountMsat: BigInt(rs.reduce((t, r) => t + Number(r.amount_msat || 0), 0)),
    balance_before: rs.length ? rs[0].balance_before : undefined, balance_after: rs.length ? rs[rs.length - 1].balance_after : undefined,
    txid: rs.length ? rs[0].txid : undefined, forfeitFrom: rs.length ? rs[0].forfeitFrom : undefined,
    why: ok ? undefined : spent ? 'the stake lock is already spent - back to this seed\'s key, the only key that can after the signer nodes\' forfeit'
      : (rs.find((r) => r.error) || {}).error || 'the federation did not accept the redeem' };
  if (ok && storage) {
    try { storage.setItem(noted, JSON.stringify({ ...res, amountMsat: String(res.amountMsat) })); } catch { /* unkept: a reload asks again */ }
  }
  return { ...res, client: got.client };
}
const STAKE_NOTE = 'arena.stakeback.';

/**
 * WHAT A TAB STILL HAS TO COLLECT, KEPT IN THE TAB (6d). Measured before: a reload
 * after the signer nodes committed the entry lost the collect's state - the join's lock
 * branch is its only setter, and a reload does not pass it - and 60 s after the
 * settlement the federation still held the winner's 978000 msat payout and 980000
 * msat stake. So the join keeps, per round, what the collect needs (the round, the
 * invite, the signer nodes, the tab's seed, the lock), and the page collects from these
 * records on every load until both answers are final.
 */
// ONE RECORD PER ROUND AND PLAYER (ORDER-2116, measured 2026-10-02 05:5xZ): keyed by round alone, a second player in the
// same browser replaced the first's record, the winner's tab looked up the loser's lock, found nothing owed and marked the
// round done - its pending line went at FINAL and its 96000 msat payout stayed in the federation. The record already
// carries its tab's seed; the key now names it too, and a tab reads and marks only its own.
// AND ONE PER ORDER: a tab's orders in one market round are as many entries, each with its own key - each
// its own record (".o<n>" after the seed; order 0, the round's key, keeps the key it always had), and its own notes
const orderTag = (order) => (order ? `.o${Number(order)}` : '');
const collectKey = (roundIdHex, seed, order = 0) => `${COLLECT_NOTE}${roundIdHex}.${(seed instanceof Uint8Array ? toHex(seed) : String(seed || '')).slice(0, 16)}${orderTag(order)}`;
export function saveCollect(storage, { roundIdHex, round, invite, nodes, seed, stakeLock = null, order = 0 } = {}) {
  try {
    const key = collectKey(roundIdHex, seed, order);
    // a record of this round from before the key named its seed, if it is this seed's, moves under the new key
    let old = order ? null : storage.getItem(`${COLLECT_NOTE}${roundIdHex}`);
    try { if (old && JSON.parse(old).seed === toHex(seed)) storage.removeItem(`${COLLECT_NOTE}${roundIdHex}`); else old = null; } catch { old = null; }
    // only this seed's old record carries over: another player's answers are not this one's
    const was = storage.getItem(key) || old;
    const done = was ? (JSON.parse(was).done || null) : null;
    // THE LOCK IS FOR THE PANEL'S LINE ONLY - the collect finds the lock through the signer nodes.
    // Measured on 0.0.1236: a lock that did not encode threw the whole record away, and
    // with it the collect (978000 + 980000 msat left in the federation). Kept if it encodes.
    let lock = null;
    try {
      if (stakeLock) lock = { outpoint: `${toHex(stakeLock.outpoint.txid)}:${String(stakeLock.outpoint.outIdx)}`, fields: lockFieldsToJson(stakeLock.fields) };
    } catch { lock = null; }
    storage.setItem(key, JSON.stringify({ roundIdHex, round: toHex(encodeRoundContract(round)), invite, nodes, seed: toHex(seed),
      stakeLock: lock, done, savedMs: Date.now(), ...(order ? { order: Number(order) } : {}) }));
    return true;
  } catch { return false; }
}

/** Every collect this tab keeps, oldest first; an unreadable record is skipped. */
export function savedCollects(storage, { seed = null } = {}) {
  const out = [];
  const mine = seed instanceof Uint8Array ? toHex(seed) : null;
  try {
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (!k || !k.startsWith(COLLECT_NOTE)) continue;
      try {
        const r = JSON.parse(storage.getItem(k));
        if (mine && r.seed !== mine) continue;
        const [txid, outIdx] = r.stakeLock ? String(r.stakeLock.outpoint).split(':') : [null, null];
        out.push({ roundIdHex: r.roundIdHex, round: decodeRoundContract(fromHex(r.round)), invite: r.invite, nodes: r.nodes, seed: fromHex(r.seed),
          stakeLock: r.stakeLock ? { outpoint: { txid: fromHex(txid), outIdx: BigInt(outIdx) }, fields: lockFieldsFromJson(r.stakeLock.fields) } : null,
          done: r.done || null, savedMs: Number(r.savedMs) || 0, order: Number(r.order) || 0 });
      } catch { /* an unreadable record is no record */ }
    }
  } catch { /* no storage: nothing kept */ }
  return out.sort((a, b) => a.savedMs - b.savedMs);
}

/**
 * EVERY SAVED PHRASE OF THIS BROWSER, NOT ONLY THE TAB'S (ruled 2026-10-07): a closed tab's round pays
 * into the wallet of the seed that joined it, and a later tab - which may take another kept phrase, the one with the most
 * wallet entries - still collects it. The tab's own phrase first, then the kept list (`arena.seeds`), each once.
 */
export function browserSeedHexes(storage, tabSeed = null) {
  const out = [];
  const add = (h) => { const x = String(h || '').toLowerCase(); if (/^[0-9a-f]{64}$/.test(x) && !out.includes(x)) out.push(x); };
  add(tabSeed instanceof Uint8Array ? toHex(tabSeed) : tabSeed);
  let kept = [];
  try { kept = JSON.parse((storage && storage.getItem('arena.seeds')) || '[]'); } catch { kept = []; }
  for (const k of Array.isArray(kept) ? kept : []) add(typeof k === 'string' ? k : k && k.hex);
  return out;
}

/**
 * THE ROUND RECORDS A TAB COLLECTS: every record whose seed is one of the browser's saved phrases, each
 * collected into its OWN seed's wallet (`seed` on the record, never the tab's), with `own` saying whether it is the tab's
 * phrase; and, apart, the records whose seed no saved phrase holds - no key is left to redeem them, so they are named
 * `uncollectable` and paid into no other wallet.
 */
export function recordsToCollect(storage, { tabSeed = null } = {}) {
  const seeds = browserSeedHexes(storage, tabSeed);
  const mine = tabSeed instanceof Uint8Array ? toHex(tabSeed) : String(tabSeed || '').toLowerCase();
  const collectable = [], uncollectable = [];
  for (const r of savedCollects(storage, {})) {
    const hex = toHex(r.seed);
    if (seeds.includes(hex)) collectable.push(Object.assign(r, { own: hex === mine }));
    else uncollectable.push(Object.assign(r, { own: false, why: 'its seed is not kept in this browser: no key is left to collect it' }));
  }
  return { seeds, collectable, uncollectable };
}

/**
 * THE COLLECT'S LINES FOR THE LOBBY (2026-10-07): at most three, only those that apply, in the words of
 * the collect's records line - another kept seed's records (open / done, collected too; or held by another tab), a failed
 * collect, an uncollectable record. `records` as the page keeps them in ARENA_RECORDS ({ round, seed, own, state });
 * `failed` a Map round -> the error; `held` a Set of rounds another tab holds. Each: { text, kind }.
 */
export function collectLines(records = [], { failed = new Map(), held = new Set() } = {}) {
  const r8 = (x) => String(x || '').slice(0, 8);
  const lines = [];
  const others = records.filter((r) => !r.own && r.state !== 'uncollectable');
  if (others.length) {
    const seeds = [...new Set(others.map((r) => r8(r.seed)))];
    const each = others.map((r) => `${r8(r.round)} ${held.has(r.round) ? 'held by another tab' : r.state === 'done' ? 'done' : 'open'}`);
    const collected = others.some((r) => !held.has(r.round));
    lines.push({ kind: 'other', text: `Other kept seed${seeds.length > 1 ? 's' : ''} ${seeds.join(', ')}: round${others.length > 1 ? 's' : ''} ${each.join(', ')}${collected ? ', collected too' : ''}` });
  }
  const bad = records.filter((r) => failed.has(r.round));
  if (bad.length) {
    const why = String(failed.get(bad[0].round) || '').slice(0, 60);
    lines.push({ kind: 'failed', text: `Collect failed for round${bad.length > 1 ? 's' : ''} ${bad.map((r) => r8(r.round)).join(', ')}: ${why} - tried again` });
  }
  const lost = records.filter((r) => r.state === 'uncollectable');
  if (lost.length) {
    lines.push({ kind: 'uncollectable', text: lost.length > 1
      ? `Uncollectable: rounds ${lost.map((r) => `${r8(r.round)} (seed ${r8(r.seed)})`).join(', ')} - their seeds are not kept in this browser: no key is left to collect them`
      : `Uncollectable: round ${r8(lost[0].round)} (seed ${r8(lost[0].seed)}) - its seed is not kept in this browser: no key is left to collect it` });
  }
  return lines.slice(0, 3);
}

/** A round whose payout and stake answers are both final: the lines kept, and it is not asked again. */
export function markCollectDone(storage, roundIdHex, done, seed = null, order = 0) {
  try {
    let key = seed ? collectKey(roundIdHex, seed, order) : null;
    if (!key || !storage.getItem(key)) {
      // no seed named, or a record from before the seed key: the round's record under the old key, else its only one
      const keys = [];
      for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k === `${COLLECT_NOTE}${roundIdHex}` || (k && k.startsWith(`${COLLECT_NOTE}${roundIdHex}.`))) keys.push(k); }
      key = keys.includes(`${COLLECT_NOTE}${roundIdHex}`) ? `${COLLECT_NOTE}${roundIdHex}` : keys.length === 1 ? keys[0] : null;
      if (!key) return false;
    }
    const r = JSON.parse(storage.getItem(key));
    if (r && seed && r.seed !== toHex(seed)) return false;
    if (!r) return false;
    storage.setItem(key, JSON.stringify({ ...r, done }));
    return true;
  } catch { return false; }
}
const COLLECT_NOTE = 'arena.collect.';

/**
 * A WITHDRAWAL CLAIMED ON ANOTHER DEVICE (spec §24, 2026-09-14: alice plays on her
 * desktop, forgets to withdraw, and two hours later plays on her iPhone). The iPhone holds only
 * the seed. Each signer node lists the rounds it settled since `sinceMs` (/settled), each with the keys
 * its settlement pays and the refund keys of its verified locks; this seed's key for each round
 * is derived here and matched against them - the device asks nothing per round, so no signer node
 * learns which rounds it looks for. A matched round's contract is fetched (/round) and must be
 * its id and name a federation. Nothing is spent. Returns the rounds worth keeping - the page
 * keeps them and looks at them as its own.
 */
export async function findOwedRounds({ seed, seeds = null, curve, nodes = [], fetcher = fetch, sinceMs = 0, known = [], knownBySeed = null } = {}) {
  // EVERY SAVED PHRASE AT ONCE (2026-10-07): each signer node's /settled is read once and matched against
  // every phrase's keys - 7 asks on 7 signer nodes, not 7 per phrase. One `seed` (with `known`) is the one-phrase scan as before.
  const list = Array.isArray(seeds) ? seeds : [seed];
  if (!list.length || !list.every((s) => s instanceof Uint8Array && s.length === 32))
    throw new Error('the rounds owed to a player are found from the player\'s 32-byte seed, and none was given');
  const base = (n) => String(n).replace(/\/+$/, '');
  const skipOf = (s) => new Set(((knownBySeed && knownBySeed.get(toHex(s))) || (list.length === 1 ? known : [])).map((h) => String(h).toLowerCase()));
  const skips = list.map(skipOf);
  const listed = new Map();
  for (const node of nodes) {
    let got = null;
    try { const r = await fetcher(`${base(node)}/settled?since=${Math.max(0, Math.floor(Number(sinceMs) || 0))}`); if (r.ok) got = await r.json(); } catch { got = null; }
    for (const x of (got && Array.isArray(got.rounds) ? got.rounds : [])) {
      const id = String(x.id || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id)) continue;
      const l = listed.get(id) || { payouts: new Set(), refunds: new Set() };
      for (const k of x.payouts || []) l.payouts.add(String(k).toLowerCase());
      for (const k of x.refunds || []) l.refunds.add(String(k).toLowerCase());
      listed.set(id, l);
    }
  }
  const found = [];
  const contracts = new Map();
  for (const [id, l] of listed) {
    for (let i = 0; i < list.length; i++) {
      if (skips[i].has(id)) continue;
      // EVERY ORDER'S KEY TOO: a tab's orders in a market round are keyed 0, 1, 2 ... - read up to ORDER_SCAN (32: a bot places 12 a window)
      for (let order = 0; order <= ORDER_SCAN; order++) {
      const mine = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed: list[i], curve, order }).pubkey));
      const payout = l.payouts.has(mine); const lock = l.refunds.has(mine);
      if (!payout && !lock) continue;
      if (!contracts.has(id)) {
        // A CONTRACT READ ONCE IS KEPT: the id is its hash, so it is the round for good - not read again at every scan
        let round = OWED_ROUNDS.get(id) || null;
        for (const node of round ? [] : nodes) {
          try {
            const r = await fetcher(`${base(node)}/round?id=${id}`);
            if (!r.ok) continue;
            const c = decodeRoundContract(new Uint8Array(await r.arrayBuffer()));
            if (toHex(roundIdOf(c)) === id && roundLocks(c)) { round = c; break; }
          } catch { /* this signer node did not answer, or not with the round */ }
        }
        if (round && !OWED_ROUNDS.has(id)) { OWED_ROUNDS.set(id, round); if (OWED_ROUNDS.size > 2000) OWED_ROUNDS.delete(OWED_ROUNDS.keys().next().value); }
        contracts.set(id, round);
      }
      const round = contracts.get(id);
      if (round) found.push({ roundIdHex: id, round, payout, lock, seed: list[i], order });
      }
    }
  }
  return found;
}
const OWED_ROUNDS = new Map();   // round id -> its contract, read and checked once
export const forgetOwedRounds = () => OWED_ROUNDS.clear();
// how many orders of one market round the seed scan reads keys for (orders 0 ... ORDER_SCAN)
export const ORDER_SCAN = 32;

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
export async function withdrawCollected({ client, invoiceFor, amountMsat = null, gateways = [], onStep = () => {} } = {}) {
  const withdrawable = BigInt(await client.withdrawableMsat());
  if (withdrawable <= 0n) return { ok: false, final: true, withdrawableMsat: 0n, why: 'nothing in this tab\'s wallet to withdraw' };
  // AN AMOUNT THE PLAYER CHOSE (GROSS-INVOICE-2053: the same round tabs under Settings, for withdrawal): n x the stake or a
  // custom amount, never more than the wallet can send after the fees; unnamed, the whole withdrawable balance.
  const asked = amountMsat === null ? withdrawable : BigInt(amountMsat);
  if (asked <= 0n) return { ok: false, final: false, withdrawableMsat: withdrawable, why: 'a withdrawal is more than 0 sat' };
  if (asked > withdrawable) return { ok: false, final: false, withdrawableMsat: withdrawable, why: `the wallet can send ${withdrawable} msat after the fees, less than the ${asked} msat asked` };
  onStep(`asking the player's wallet for an invoice of ${asked} msat`);
  const inv = await invoiceFor(asked);
  if (!inv || !inv.ok) return { ok: false, final: false, withdrawableMsat: withdrawable, why: (inv && inv.why) || 'no invoice to withdraw to' };
  if (amountMsat !== null) {
    let named = null;
    try { named = decodeBolt11(inv.invoice).amountMsat; } catch (e) { return { ok: false, final: false, withdrawableMsat: withdrawable, why: `that is not an invoice (${e.message})` }; }
    if (named !== asked) return { ok: false, final: false, withdrawableMsat: withdrawable,
      why: `the invoice asks ${named === null ? 'any amount' : `${named} msat`}, and ${asked} msat was chosen - nothing was sent` };
  }
  onStep('withdrawing over Lightning');
  // the funded gateway preferred; the lock client never takes the gateway on the invoice's own node
  const said = JSON.parse(await client.withdraw(inv.invoice, depositGateway('', gateways) || undefined));
  const ok = said.state === 'Success';
  return { ok, final: ok, withdrawableMsat: withdrawable, invoiceMsat: said.invoice_msat == null ? null : BigInt(said.invoice_msat),
    state: said.state, gateway: said.gateway, balance_before: said.balance_before, balance_after: said.balance_after,
    preimage: typeof said.preimage === 'string' && /^[0-9a-f]{64}$/i.test(said.preimage) ? said.preimage.toLowerCase() : null,
    why: ok ? undefined : `the withdraw ended ${said.state}${said.state === 'Refunded' ? ' - the money is back in this tab\'s wallet' : ''}${said.why ? ` (${said.why})` : ''}` };
}

/**
 * THE WITHDRAW FROM THE PLAYER WALLET (§24A.1: the player "withdraws from over a Lightning invoice whenever he likes, in
 * any amount"; RULED 2026-09-25). The one wallet per seed and federation, opened as the stake opens it, handed to
 * the same withdraw the round's wallet uses (`withdrawCollected`): its whole withdrawable balance to an invoice from the
 * player's own Lightning wallet. A spend - called from the Withdraw press alone, never on a timer.
 */
export async function withdrawPlayerWallet({ round, invite, seed, LockClient, storage, invoiceFor, amountMsat = null, gateways = [], onStep = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  let out;
  try { out = await withdrawCollected({ client, invoiceFor, amountMsat, gateways, onStep }); } catch (e) {
    // THE STOCK CLIENT'S ANSWER FOR A BALANCE ITS OWN SEND FEES WOULD EAT: nothing to withdraw, and nothing spent.
    if (!/too low to send any amount after fees/i.test(String((e && e.message) || e))) throw e;
    out = { ok: false, final: true, withdrawableMsat: 0n, why: 'nothing in the player wallet to withdraw after the send\'s fees' };
  }
  if (out.ok) ledgerAppend(storage, round.federationId, { kind: 'withdrawal', msat: String(out.invoiceMsat ?? out.withdrawableMsat), state: out.state });
  return { ...out, from: 'the player wallet' };
}

/**
 * A LOCK NO SIGNER NODE WILL SETTLE, BACK BY THE PLAYER'S OWN KEY AFTER ITS EXPIRY (§23.2's default
 * path: nobody acts, the lock expires, the player's key takes it back). W4 / 6d: a player the
 * fee-lock door refused, or a round that never settles - no signer node verified the lock or will
 * forfeit it, so refundStake (which asks the signer nodes where the lock is) finds nothing. The tab's
 * own record (saveLock) holds both locks whole. Each is asked where it stands, spending
 * nothing (lockStatus): gone - nothing to do; before its expiry - not final, and when it comes
 * back; expired - refunded into the tab's wallet, from where the withdraw takes it.
 */
export async function refundKept({ round, roundId, seed, curve, client, storage, kept = null, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so it has no lock to refund');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
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
 * player withdraws: the settlement (the payout to this key), the signer nodes' /stake-lock and
 * /forfeit (the stake back), and the federation's read-only lockStatus (a lock no signer node will
 * settle, after its expiry). `refund` and `redeem` are never called here.
 */
/**
 * A LOCK FOR A ROUND THE SIGNER NODES REFUSE, HANDED TO THEM FOR ITS RETURN (§23.2 REFUSED): POST
 * /refused-lock to every signer node of the round. Each keeps it only on its own record - it refuses the round, the lock
 * stakes no entry there, its image is A0 of a handout it holds for the round. Answers how many kept it, and each one's word.
 */
export async function handRefusedLock({ roundId, lock, nodes, fetcher = fetch } = {}) {
  const body = JSON.stringify({ outpoint: `${toHex(lock.outpoint.txid)}:${lock.outpoint.outIdx}`, fields: lockFieldsToJson(lock.fields) });
  const said = await Promise.all([...new Set(nodes || [])].map(async (node) => {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/refused-lock?round=${toHex(roundId)}`, { method: 'POST', body });
      return { node, status: r.status, why: (await r.text()).trim().slice(0, 160) };
    } catch (e) { return { node, status: 0, why: String(e && e.message || e).slice(0, 160) }; }
  }));
  return { kept: said.filter((x) => x.status === 201).length, said };
}

/**
 * The stake owed back at once for the locks of a refused round - the stake and its node-fee lock, both to this seed's
 * refund key (measured live 07:26Z: 49a50535's stake came back and its 2000 msat fee lock stayed for its expiry) - or null
 * when no signer node keeps them as refused.
 */
async function refusedReturn({ roundId, playerPubkey, locks, nodes, fetcher, client }) {
  const still = [];
  for (const lock of (locks || []).filter((l) => l && l.outpoint)) {
    const st = JSON.parse(await client.lockStatus(toHex(lock.outpoint.txid), Number(lock.outpoint.outIdx)));
    if (st.stored) still.push(lock);
  }
  if (!still.length) return null;
  let kept = 0;
  for (const lock of still) kept += (await handRefusedLock({ roundId, lock, nodes, fetcher })).kept > 0 ? 1 : 0;
  if (!kept) return null;
  const msat = still.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);
  const at = (l) => `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`;
  const named = await findLock({ roundId, playerPubkey, nodes, fetcher });
  const found = still.map((l) => named.find((n) => at(n) === at(l))).filter(Boolean);
  if (!found.length) return { state: 'waiting', how: 'forfeit', refused: true, msat, why: 'handed to the signer nodes, and none names it yet' };
  for (const l of found) {
    const f = await forfeitOf({ roundId, entryId: l.entryId, nodes, fetcher });
    if (!f.ok) return { state: 'waiting', how: 'forfeit', refused: true, msat, why: f.why };
  }
  const owed = found.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);
  return { state: 'owed', how: 'forfeit', refused: true, msat: owed };
}

export async function lookOwed({ round, roundId, seed, curve, nodes, fetcher = fetch, client = null, storage = null, kept = null, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so nothing in it is owed from a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const mine = toHex(refundKeyOf(player.pubkey));
  const rid = toHex(roundId);
  const note = (k) => { try { const v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
  // STILL AT ITS OUTPOINT? The federation's read-only answer; without a wallet it is not asked.
  const held = async (txid, outIdx) => !client || !!JSON.parse(await client.lockStatus(txid, Number(outIdx))).stored;
  const s = await settlementOf({ roundId, nodes, fetcher });
  let payout;
  const paidNote = note(`${PAYOUT_NOTE}${rid}${orderTag(order)}`);
  if (paidNote) payout = { state: 'collected', msat: BigInt(paidNote.amountMsat) };
  else if (!s.ok) payout = { state: 'waiting', why: s.why };
  else {
    const at = s.moved.payouts.findIndex((x) => x.kind === 'qualifier' && String(x.pk).toLowerCase() === mine);
    if (at < 0) payout = { state: 'none' };
    // ALREADY SPENT - only this key can: collected before (another tab, an earlier build's timer).
    else payout = { state: await held(s.txid, at) ? 'owed' : 'gone', msat: BigInt(s.moved.payouts[at].msat) };
  }
  let stake;
  let lockAnswers = null;
  const backNote = note(`${STAKE_NOTE}${rid}${orderTag(order)}`);
  if (backNote) stake = { state: 'collected', msat: BigInt(backNote.amountMsat) };
  else {
    const locks = s.ok ? await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher }) : [];
    lockAnswers = locks.said ? { asked: locks.asked, answered: locks.answered, said: locks.said } : null;
    // NOBODY ANSWERED IS NOT "NO LOCK" (playtest 2026-10-04: a DELIVERED player's 96 sat stake was never
    // asked back - the page's record of the round ended as if nothing were owed): with no signer node answering where
    // the lock is, the stake is still waiting and the round is looked at again.
    if (!locks.length && s.ok && locks.asked > 0 && locks.answered === 0)
      stake = { state: 'waiting', why: `no signer node answered where this seed's lock is (${locks.said.join('; ')})` };
    else if (locks.length) {
      let msat = 0n;
      for (const l of locks) if (await held(toHex(l.outpoint.txid), l.outpoint.outIdx)) msat += BigInt(l.fields.amountMsat);
      const whole = locks.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);
      if (msat === 0n) stake = { state: 'gone', how: 'forfeit', msat: whole };
      else {
        const f = await forfeitOf({ roundId, entryId: locks[0].entryId, nodes, fetcher });
        if (f.ok) stake = { state: 'owed', msat, how: 'forfeit' };
        // NOBODY WON (2026-10-03): a signer node not yet ACCEPTED, or a round entry still in its window, is waiting
        else if (/that run is \S+ with score/.test(f.why)
          && !/not ACCEPTED at this signer node|still inside its window|keeps no record of what its settlement moved/.test(f.why)) stake = { state: 'lost', msat };
        else stake = { state: 'waiting', msat, why: f.why };
      }
    } else {
      // NO SIGNER NODE KNOWS THE LOCK (refused at the door) OR NO SETTLEMENT YET: the tab's own record,
      // asked of the federation without spending - owed back by the player's key after expiry.
      const held = kept || savedLock(storage, { roundId, playerPubkey: player.pubkey });
      const ls = held && held.lock ? [held.lock, held.lock.feeLock].filter(Boolean) : [];
      if (!ls.length) stake = { state: s.ok ? 'none' : 'waiting', why: 'this tab keeps no lock for this round' };
      else if (!client) stake = { state: 'waiting', why: 'the federation was not asked yet' };
      else {
        // §23.2 REFUSED (2026-10-06 08:57: "A round the seats refuse gets an immediate refund"): a lock
        // still in the federation that no signer node knows is handed to them; if they refuse its round they keep it, and
        // its forfeit is the stake owed back now - not after its expiry.
        // the fee lock from the tab's saved lock when the record handed in carries the stake alone (a collect record does)
        const saved = held.lock.feeLock ? null : savedLock(storage, { roundId, playerPubkey: player.pubkey });
        const feeLock = held.lock.feeLock || (saved && saved.lock && saved.lock.feeLock) || null;
        const back = await refusedReturn({ roundId, playerPubkey: player.pubkey, locks: [held.lock, feeLock], nodes, fetcher, client });
        if (back) stake = back;
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
    owedMsat: payoutMsat + owed('forfeit') + owed('refund'), inTabMsat, tabBalanceMsat, final, settled: s.ok,
    settledWhy: s.ok ? null : s.why, lockAnswers };
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
  if (!o.settled) return 'Waiting for the signer nodes\' settlement';
  return 'Waiting for the signer nodes';
}

/**
 * COLLECT WHAT IS OWED, INSIDE THE WITHDRAW ONLY (W4 / 6d): the payout redeemed, the stake back
 * by the signer nodes' forfeit or by the player's key after expiry - all into the one wallet the
 * withdraw pays from, in the same action. Nothing is collected while the player is not there.
 */
export async function collectOwed({ look, client, ...ask } = {}) {
  const got = { payout: null, stake: null, refund: null };
  if (look.payoutMsat > 0n) got.payout = await redeemPayout({ ...ask, client });
  if (look.stakeMsat > 0n) got.stake = await returnStake({ ...ask, client, refused: !!(look.stake && look.stake.refused) });
  if (look.refundMsat > 0n) got.refund = await refundKept({ ...ask, client });
  return got;
}

/**
 * WINNINGS-AUTO (RULED 2026-10-01): WHAT IS OWED GOES INTO THE PLAYER WALLET BY ITSELF - the payout contract
 * redeemed, the stake back by the signer nodes' forfeit or by the player's key after expiry - the moment it exists, with
 * no press. Into the player's own federation wallet (one per seed and federation) and NOTHING out of it: no Lightning,
 * no withdraw. What arrived is written in the history as a "winnings" row, by what the wallet's balance actually grew.
 */
export async function collectIntoPlayerWallet({ look, round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher, order = 0 } = {}) {
  if (!look || !(look.payoutMsat > 0n || look.stakeMsat > 0n || look.refundMsat > 0n)) return { collected: false, creditedMsat: 0n };
  const client = await playerWallet({ round, invite, seed, LockClient, storage });
  const before = BigInt(await client.balanceMsat());
  const got = await collectOwed({ look, client, round, roundId, invite, seed, curve, LockClient, storage, nodes, order, ...(fetcher ? { fetcher } : {}) });
  const after = BigInt(await client.balanceMsat());
  const creditedMsat = after > before ? after - before : 0n;
  // A STAKE THAT ONLY CAME BACK IS A REFUND ROW, NOT WINNINGS (2026-10-03: "the money that comes back must be
  // visible in the TX history"): nobody won, or the round was refunded - no payout, the stake (or its expiry refund) back
  const kind = look.payoutMsat > 0n ? 'winnings' : 'refund';
  if (creditedMsat > 0n) ledgerAppend(storage, round.federationId, { kind, msat: String(creditedMsat), round: toHex(roundId) });
  return { collected: true, got, creditedMsat };
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
  if (withdraw.ok && ask.round) ledgerAppend(ask.storage, ask.round.federationId,
    { kind: 'withdrawal', msat: String(withdraw.invoiceMsat ?? withdraw.withdrawableMsat), state: withdraw.state });
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
  if (p.ok) return `Stake returned: ${String(p.amountMsat)} msat back to this tab's federation wallet by the signer nodes' forfeit`
    + (p.balance_after !== undefined ? ` (balance ${p.balance_before} → ${p.balance_after} msat)` : '');
  if (p.spent) return `Stake already back: ${String(p.amountMsat)} msat - ${p.why}`;
  if (p.final) return `No stake back: ${p.why}`;
  return `Stake: not back yet - ${p.why}`;
}

/** THE PAYOUT AS THE PLAYER SEES IT (6d): collected, none, or still waiting on the signer nodes. */
export function payoutLine(p) {
  if (!p) return '';
  if (p.ok) return `Payout collected: ${String(p.amountMsat)} msat from the round's settlement into this tab's federation wallet`
    + (p.balance_after !== undefined ? ` (balance ${p.balance_before} → ${p.balance_after} msat)` : '');
  if (p.spent) return `Payout already collected: ${String(p.amountMsat)} msat - ${p.why}`;
  if (p.final) return `No payout: ${p.why}`;
  return `Payout: waiting for the signer nodes' settlement - ${p.why}`;
}

/**
 * THE LOCK, HANDED TO EVERY SIGNER NODE (POST /lock). A signer node that verifies it in the
 * federation answers 201 and counts the stake; `ok` is `needed` of them.
 */
export async function handLock({ entryId, fields, nodes, needed, fetcher = fetch, door = 'lock' } = {}) {
  if (!(entryId instanceof Uint8Array) || entryId.length !== 32) throw new Error('a lock is handed over for an entry, by its id');
  // `door`: 'lock' for the stake lock, 'fee-lock' for the fee lock (Pick b).
  if (door !== 'lock' && door !== 'fee-lock') throw new Error('a lock is handed to a signer node\'s /lock or /fee-lock');
  const body = JSON.stringify(lockFieldsToJson(fields));
  // TO EVERY SIGNER NODE AT ONCE (JOIN-TIME-1359, 2026-10-02: "The join takes too long. Cut that time. PLAY to a
  // committed entry is the clock"): handed one node after another, each answering only once it had asked the federation
  // (two or three client runs, ~1.8 s), the stake lock took ~13 s across 7 and the fee lock ~9 s more - 19 of the paid
  // join's 38 s from PLAY to the stake SEEN at 5 of 7 (measured on testnet4, round 1a21b8d0). Each node checks on its own;
  // the answers keep the nodes' order.
  const said = await Promise.all([...new Set(nodes || [])].map(async (node) => {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/${door}?entry=${toHex(entryId)}`, { method: 'POST', body });
      return { node, status: r.status, why: (await r.text()).trim() };
    } catch (e) {
      return { node, status: 0, why: e.message };
    }
  }));
  const committed = said.filter((s) => s.status === 201).length;
  return { ok: committed >= needed, committed, needed, said };
}

/**
 * THE NOTES FOLLOW THE FEDERATION'S SUCCESSOR, BY THEMSELVES (§23A.6 step 3,: "On its next start and at every
 * settlement it sees, a client whose notes are in a DRAINING federation moves them to the successor: a stock LNv2 send
 * from the old federation paying a stock LNv2 receive invoice in the new one ... In chunks, atomic each, no press; the
 * balance shows moving until it is done, then the new federation's name").
 *
 * `record`: the old federation's FederationRecord as this page verified it (federations.js) - nothing moves on a record
 * that is not DRAINING or names no successor, or when `to` is not that successor. `from` / `to`: the player's wallets in
 * the old and the new federation (the same seed). Each chunk is one send of at most `chunkMsat` (all that can be sent,
 * unnamed): an invoice of exactly that amount from the successor's wallet, paid by the old one (withdrawCollected - the
 * stock send; a refused or refunded send leaves the notes where they were), and waited for until claimed. A chunk that
 * fails is tried again, at most `retries` times in a row. `onState({ state: 'moving' | 'moved' | 'stopped', ... })`.
 * Answers { moved, chunks, state, why }.
 */
export const MIGRATE_DUST_MSAT = 10000n;
export async function migrateFromDraining({ from, to, record, toFederationId, chunkMsat = null, retries = 3, maxChunks = 64,
  gateways = [], onState = () => {}, storage = null, fromFederationId = null } = {}) {
  const hex = (b) => (b instanceof Uint8Array ? toHex(b) : String(b || '')).toLowerCase();
  // DRAINING, or CRITICAL with the safe federation the page chose as `successorId` (evacuatePlayerWallet, 2026-10-13)
  if (!record || !['DRAINING', 'CRITICAL'].includes(record.status)) return { moved: 0n, chunks: 0, state: 'not draining' };
  if (!record.successorId || /^0+$/.test(hex(record.successorId))) return { moved: 0n, chunks: 0, state: 'no successor named' };
  if (hex(record.successorId) !== hex(toFederationId)) return { moved: 0n, chunks: 0, state: 'that wallet is not in the successor' };
  let moved = 0n, chunks = 0, failed = 0;
  for (let n = 0; n < maxChunks; n++) {
    let can;
    try { can = BigInt(await from.withdrawableMsat()); } catch (e) {
      if (/too low to send any amount after fees/i.test(String((e && e.message) || e))) can = 0n; else throw e;
    }
    if (can <= MIGRATE_DUST_MSAT) break;
    const amount = chunkMsat !== null && can > BigInt(chunkMsat) ? BigInt(chunkMsat) : can;
    onState({ state: 'moving', leftMsat: can, chunkMsat: amount, movedMsat: moved });
    let made = null;
    const out = await withdrawCollected({ client: from, amountMsat: amount, gateways,
      invoiceFor: async (msat) => { made = JSON.parse(await to.receive(String(msat), '')); return { ok: true, invoice: made.invoice }; } });
    const final = out.ok && made ? await to.awaitReceive(made.operation) : null;
    if (out.ok && final === 'Claimed') {
      moved += amount; chunks++; failed = 0;
      if (storage && fromFederationId) ledgerAppend(storage, fromFederationId, { kind: 'moved-out', msat: String(amount), to: hex(toFederationId) });
      if (storage) ledgerAppend(storage, toFederationId, { kind: 'moved-in', msat: String(amount), from: hex(fromFederationId) });
      continue;
    }
    if (++failed > retries) {
      const why = out.ok ? `the successor's receive ended ${final}` : out.why;
      onState({ state: 'stopped', movedMsat: moved, why });
      return { moved, chunks, state: 'stopped', why };
    }
  }
  onState({ state: 'moved', movedMsat: moved, chunks });
  return { moved, chunks, state: 'moved' };
}

/**
 * THE PLAYER'S NOTES OUT OF A DRAINING FEDERATION (§23A.6 step 3), as the page runs it: `status` is the round
 * federation's record as federations.js checked it, `successor` the successor's (its own record, checked the same way).
 * Nothing unless the first is DRAINING and names the second, and the second is OPEN with its invite. The player's wallet
 * in each (one seed, walletSecretFor per federation) is opened as the stake opens it; then migrateFromDraining.
 */
export async function migratePlayerWallet({ round, invite, seed, LockClient, storage, status, successor, onState = () => {}, chunkMsat = null } = {}) {
  if (!status || status.status !== 'DRAINING' || !status.successorId) return { moved: 0n, chunks: 0, state: 'not draining' };
  if (!successor || successor.status !== 'OPEN' || !successor.invite) return { moved: 0n, chunks: 0, state: 'no open successor to move to' };
  const from = await playerWallet({ round, invite, seed, LockClient, storage });
  const to = await playerWallet({ round: { ...round, federationId: fromHex(status.successorId) }, invite: successor.invite, seed, LockClient, storage });
  return migrateFromDraining({ from, to, record: { status: 'DRAINING', successorId: status.successorId }, toFederationId: fromHex(status.successorId),
    fromFederationId: round.federationId, storage, onState, chunkMsat });
}

/**
 * THE NOTES OUT OF A DRAINING OR CRITICAL FEDERATION, BY THEMSELVES (2026-10-13 ~12:00Z: "When a federation is draining
 * the client has automatically to move it to a safe federation"): not only at a join into the successor (migratePlayerWallet)
 * but as soon as the page has checked the federations' records - into `target` (federations.js safeFederation: the named
 * successor, else the lowest-load OPEN one). `from`: the draining federation's checked status with its invite. Both wallets
 * of this seed are opened as the stake opens them; then the chunks of migrateFromDraining.
 */
export async function evacuatePlayerWallet({ from, target, seed, LockClient, storage, onState = () => {}, chunkMsat = null, gateways = [] } = {}) {
  if (!from || !['DRAINING', 'CRITICAL'].includes(from.status) || !from.invite) return { moved: 0n, chunks: 0, state: 'not draining' };
  if (!target || target.status !== 'OPEN' || !target.invite) return { moved: 0n, chunks: 0, state: 'no safe federation to move to' };
  const fromId = fromHex(String(from.federation)), toId = fromHex(String(target.federation));
  const a = await openPlayerWallet({ federationId: fromId, invite: from.invite, seed, LockClient, storage });
  const b = await openPlayerWallet({ federationId: toId, invite: target.invite, seed, LockClient, storage });
  return migrateFromDraining({ from: a, to: b, record: { status: from.status, successorId: toId }, toFederationId: toId, fromFederationId: fromId,
    storage, onState, chunkMsat, gateways });
}

/**
 * A ROUND IN ANOTHER FEDERATION IS ENTERED BY A SWAP (§23A.3: "Entering a round in another federation is a swap (§23A.6
 * mechanics: the notes leave the one and arrive in the other through a gateway that serves both, stock LNv2, seconds, the
 * routing fee shown) and the client does it on the press with the fee shown - it is not refused, and it is not the
 * default").
 *
 * THE QUOTE, BEFORE THE PRESS: the amount and the fee its two legs cost - the paying wallet's gateway fee rule and the
 * receiving wallet's (each client's feeRule: base msat + ppm, rounded up) - and whether the paying wallet can send it.
 */
const feeRuleOf = async (c) => {
  if (!c || typeof c.feeRule !== 'function') return null;
  try { const r = JSON.parse(await c.feeRule()); return { ppm: BigInt(r.fee_ppm), baseMsat: BigInt(r.fee_base_msat) }; } catch { return null; }
};
export async function swapQuote({ from, to, amountMsat }) {
  const amount = BigInt(amountMsat);
  const out = await feeRuleOf(from), into = await feeRuleOf(to);
  const legFee = (r) => (r ? r.baseMsat + (amount * r.ppm + 999999n) / 1000000n : 0n);
  const feeMsat = legFee(out) + legFee(into);
  let can = 0n; try { can = BigInt(await from.withdrawableMsat()); } catch { can = 0n; }
  return { amountMsat: amount, feeMsat, totalMsat: amount + feeMsat, withdrawableMsat: can, enough: can >= amount, ruleKnown: !!(out || into) };
}

/** THE SWAP ITSELF: `amountMsat` from `from` to `to` - an invoice from the receiving wallet, paid through a gateway by the
 * paying one (withdrawCollected); the fee measured off the paying wallet's balance, both sides in the history. */
/** At most this many gateway pairs per swap: each Refunded try costs seconds of the round's entry window. */
export const SWAP_PAIRS_MAX = 6;
/**
 * THE SWAP'S GATEWAY PAIRS: [receive, pay], the named gateways first, then each federation's list, never the same
 * gateway on both legs; none listed on either side - one pair of the lock client's own picks ('').
 */
export function swapGatewayPairs(named = [], listedTo = [], listedFrom = [], max = SWAP_PAIRS_MAX) {
  const recv = gatewayOrder(named, listedTo), pay = gatewayOrder(named, listedFrom);
  if (!recv.length || !pay.length) return [[recv[0] || '', '']];
  const out = [];
  for (const r of recv) for (const p of pay) if (gwKey(r) !== gwKey(p) && out.length < max) out.push([r, p]);
  return out.length ? out : [[recv[0], '']];
}
export async function swapForRound({ from, to, amountMsat, gateways = [], storage = null, fromFederationId = null, toFederationId = null, onState = () => {} }) {
  const amount = BigInt(amountMsat);
  const hex = (b) => (b instanceof Uint8Array ? toHex(b) : String(b || '')).toLowerCase();
  onState({ state: 'swapping', amountMsat: amount });
  const before = BigInt(await from.balanceMsat());
  // THE INVOICE IS THE RECEIVING WALLET'S OWN, made for exactly the amount, and paid as a withdraw pays; the lock client never
  // takes the gateway on the invoice's own node. TWO GATEWAYS, PAIR BY PAIR (measured 2026-10-18 on testnet4: left
  // to the lock client's pick, the legs landed on gateway C's node twice - once paying, its one channel's 775 sat leaving no
  // outbound, "InsufficientBalance"; once receiving, gw-b's node then finding "NoRoute" - and every swap ended Refunded):
  // receive through one listed gateway, pay through another, and a payment that ends Refunded - the money back - tries the next
  // pair; any other end stops, as money may be on its way.
  // each leg's own federation's seated gateways first (§23A.9), then its list
  const pairs = swapGatewayPairs(gateways, [...await seatedGatewaysOf(to), ...await federationGateways(to)], [...await seatedGatewaysOf(from), ...await federationGateways(from)]);
  const tried = [];
  let made = null, said = null;
  for (const [recv, pay] of pairs) {
    made = JSON.parse(await to.receive(String(amount), recv));
    said = JSON.parse(await from.withdraw(made.invoice, pay || undefined));
    if (said.state !== 'Refunded') break;
    tried.push({ receive: recv, pay, state: said.state });
  }
  const final = said.state === 'Success' ? await to.awaitReceive(made.operation) : null;
  if (!(said.state === 'Success' && final === 'Claimed')) {
    const why = said.state === 'Success' ? `the receive in the round's federation ended ${final}` : `the payment from the other federation ended ${said.state}${said.state === 'Refunded' ? ` - the money is back there (${tried.length} gateway pair${tried.length === 1 ? '' : 's'} tried)` : ''}`;
    onState({ state: 'stopped', why, tried });
    return { ok: false, state: 'stopped', why, tried };
  }
  const feeMsat = before - BigInt(await from.balanceMsat()) - amount;
  if (storage && fromFederationId) ledgerAppend(storage, fromFederationId, { kind: 'swapped-out', msat: String(amount), feeMsat: String(feeMsat), to: hex(toFederationId) });
  if (storage && toFederationId) ledgerAppend(storage, toFederationId, { kind: 'swapped-in', msat: String(amount), from: hex(fromFederationId) });
  onState({ state: 'swapped', amountMsat: amount, feeMsat });
  return { ok: true, state: 'swapped', movedMsat: amount, feeMsat };
}

/**
 * THE JOIN'S SWAP, AS THE PAGE RUNS IT: the player's wallet in the round's federation and its wallet in `fromInvite`'s (one
 * seed, walletSecretFor per federation), opened as the stake opens them. Nothing when the round's wallet already holds
 * `needMsat`; else the shortfall quoted, `confirm(quote)` asked - the fee shown, the press the player's - and swapped.
 */
export async function swapPlayerWalletForRound({ round, toInvite, fromInvite, fromFederationId, seed, LockClient, storage, needMsat, gateways = [],
  confirm = async () => false, onState = () => {}, openWallet = playerWallet } = {}) {
  const to = await openWallet({ round, invite: toInvite, seed, LockClient, storage });
  const have = BigInt(await to.balanceMsat());
  if (have >= BigInt(needMsat)) return { ok: true, state: 'enough', haveMsat: have };
  const from = await openWallet({ round: { ...round, federationId: fromHex(fromFederationId) }, invite: fromInvite, seed, LockClient, storage });
  const quote = await swapQuote({ from, to, amountMsat: BigInt(needMsat) - have });
  if (!quote.enough) return { ok: false, state: 'short', quote, why: `the wallet in federation ${String(fromFederationId).slice(0, 8)} can send ${quote.withdrawableMsat} msat, less than ${quote.amountMsat}` };
  if (!(await confirm(quote))) return { ok: false, state: 'declined', quote };
  const done = await swapForRound({ from, to, amountMsat: quote.amountMsat, gateways, storage, fromFederationId, toFederationId: round.federationId, onState });
  return { ...done, quote };
}

/** The federations this browser keeps a history for (hex): where the player has held notes. */
export function ledgerFederations(storage) {
  const out = [];
  for (const k of storageKeys(storage)) {
    if (!k.startsWith(LEDGER_PREFIX) || k.startsWith(LEDGER_READ_PREFIX)) continue;
    const f = k.slice(LEDGER_PREFIX.length);
    if (/^[0-9a-f]{64}$/.test(f)) out.push(f);
  }
  return out;
}
