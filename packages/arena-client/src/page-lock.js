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
import { noteInvite, wholeInvite } from './guardian-invites.js';
import { readInvite } from '../../arena-node/src/invite.js';
import { taggedHash, toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { TAG } from '../../arena-protocol/src/constants.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { feeBpsForRound, stakeOf, splitForRound } from './join.js';
import { refundKeyOf, lockFieldsToJson, lockFieldsFromJson } from '../../arena-protocol/src/stake-lock.js';
import { decodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { lockFromClient } from './lock-result.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { roundLocks, playerFor, sharesNeededFor } from './join.js';
import { encodeRoundContract, decodeRoundContract, roundId as roundIdOf, custodyFieldsAreValid, entryId } from '../../arena-protocol/src/contracts.js';
import { decodeBolt11 } from '../../arena-protocol/src/bolt11.js';
import { takesDeposits } from '../../arena-protocol/src/known-federations.js';
import { splitDonation, donationSetPaysKeys } from '../../arena-protocol/src/donation.js';
import { lockClaimDigest } from '../../arena-protocol/src/lock-claim.js';

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
 * A WRITE THE BROWSER REFUSES FOR ROOM (2026-10-30, order at "locking your stake": a wallet's write that throws QuotaExceededError ends in the lock
 * client's panic, and every wallet call of that page then hangs until a reload): `onStorageFull` frees what it can, and the write is tried once more.
 */
// A WALLET'S KEYS AND VALUES, PACKED (kanban #883, 2026-10-31, iPhone log: 4,992,831 characters in 3,759 keys, a deposit paid and never claimed): the client hands
// hex, two characters a byte, and iOS Safari gives 5 million characters. 15 bits to a character is under a third of that, and nothing has to be deleted for it.
const PACKED = '~';
export function packHex(hex) {
  const s = String(hex);
  if (!s || s[0] === PACKED || s.length % 2 || !/^[0-9a-f]+$/.test(s)) return s;
  const out = []; let acc = 0, bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 4) | parseInt(s[i], 16); bits += 4;
    if (bits >= 15) { bits -= 15; out.push(0x100 + ((acc >> bits) & 0x7fff)); acc &= (1 << bits) - 1; }
  }
  const pad = bits ? 15 - bits : 0;
  if (bits) out.push(0x100 + (acc << pad));
  let r = PACKED + String.fromCharCode(0x100 + pad);
  for (let i = 0; i < out.length; i += 4096) r += String.fromCharCode(...out.slice(i, i + 4096));
  return r;
}
export function unpackHex(s) {
  if (!s || s[0] !== PACKED) return s;
  const pad = s.charCodeAt(1) - 0x100;
  const nibbles = ((s.length - 2) * 15 - pad) / 4;
  const out = new Array(nibbles); let acc = 0, bits = 0, n = 0;
  for (let i = 2; i < s.length; i++) {
    acc = (acc << 15) | (s.charCodeAt(i) - 0x100); bits += 15;
    while (bits >= 4 && n < nibbles) { bits -= 4; out[n++] = ((acc >> bits) & 15).toString(16); }
    acc &= (1 << bits) - 1;
  }
  return out.join('');
}
// AND A LONG VALUE ONCE (measured: a federation's config, 68,888 hex, the same bytes in every wallet of it - 55 % of all values; e-cash itself does not compress, zlib saves 3 %)
const BLOB_PREFIX = 'arena.walletblob.', BLOB_MIN = 2048, BLOB_MARK = '^';
function keptValue(storage, hex) {
  const s = String(hex);
  if (s.length < BLOB_MIN || s.length % 2 || !/^[0-9a-f]+$/.test(s)) return packHex(s);
  const id = toHex(sha256(fromHex(s))).slice(0, 32);
  if (storage.getItem(BLOB_PREFIX + id) === null) putRoomy(storage, BLOB_PREFIX + id, packHex(s));
  return BLOB_MARK + id;
}
// A LONG VALUE WHOSE ENTRY IS BEING WRITTEN IS NOT SWEPT (kanban #1977, state audit 2026-11-12): the entry's write refused for quota runs the
// storage-full handler (ARENA_TIDY_STORAGE -> packWallets) before the entry naming the blob exists; its sweep took the blob as named by no wallet,
// the retried entry then fit and named a blob that was gone - the wallet database no longer opened. Held from keptValue until the entry's write ends.
const blobsWriting = new Map();
function putWalletValue(storage, key, hex) {
  const val = keptValue(storage, hex);
  const id = val[0] === BLOB_MARK ? val.slice(1) : null;
  if (id) blobsWriting.set(id, (blobsWriting.get(id) || 0) + 1);
  try { putRoomy(storage, key, val); } finally {
    if (id) { const n = blobsWriting.get(id) - 1; if (n > 0) blobsWriting.set(id, n); else blobsWriting.delete(id); }
  }
}
function valueOf(storage, s) {
  if (!s || s[0] !== BLOB_MARK) return unpackHex(s);
  const blob = storage.getItem(BLOB_PREFIX + s.slice(1));
  if (blob === null) throw new Error(`the wallet's long value ${s.slice(1, 9)} is gone from this browser`);
  return unpackHex(blob);
}
// AND A KEY WRITTEN PACKED LEAVES NO RAW ROW OF IT (kanban #1978): an older page's unpacked row of the same key would be a second, older value of it
// in entries(), and a packing pass would move it over the newer one. Removed only after the packed write took (as remove() drops both).
function dropRaw(storage, prefix, k) { if (packHex(k) !== String(k)) storage.removeItem(prefix + k); }
const WALLET_KEY = /^(arena\.(?:walletdb|lockdb)\.[0-9a-f]{16}\.[0-9a-f]{16}\.)(.*)$/s;
/** EVERY WALLET THIS BROWSER KEEPS, PACKED IN PLACE: nothing is lost, an entry already packed is left. Answers the characters freed. */
export function packWallets(storage) {
  if (!storage) return 0;
  let freed = 0;
  for (const k of storageKeys(storage)) {
    const m = WALLET_KEY.exec(k); if (!m) continue;
    const v = storage.getItem(k); if (v === null) continue;
    const key = m[1] + packHex(m[2]);
    // ONE KEY, TWO ROWS (kanban #1978): a raw row an older page left beside the packed row the wallet wrote since (a pass stopped by a full browser
    // leaves raw rows, and the wallet writes on under the packed key) - the packed row is the newer value; the raw one goes, never over it
    if (key !== k && storage.getItem(key) !== null) { freed += k.length + v.length; storage.removeItem(k); continue; }
    const val = v[0] === BLOB_MARK || (v[0] === PACKED && unpackHex(v).length < BLOB_MIN) ? v : keptValue(storage, unpackHex(v));
    if (key === k && val === v) continue;
    // the old one first: on a full browser the shorter copy fits only then, and it goes straight back if the browser refuses
    storage.removeItem(k);
    try { storage.setItem(key, val); freed += k.length + v.length - key.length - val.length; } catch (e) { storage.setItem(k, v); throw e; }
  }
  // a long value no wallet names any more
  const named = new Set();
  for (const k of storageKeys(storage)) if (WALLET_KEY.test(k)) { const v = storage.getItem(k); if (v && v[0] === BLOB_MARK) named.add(v.slice(1)); }
  for (const id of blobsWriting.keys()) named.add(id);   // kanban #1977: an entry naming it is being written right now
  for (const k of storageKeys(storage)) if (k.startsWith(BLOB_PREFIX) && !named.has(k.slice(BLOB_PREFIX.length))) { freed += k.length + String(storage.getItem(k) || '').length; storage.removeItem(k); }
  return freed;
}
let storageFull = null;
export function onStorageFull(fn) { storageFull = typeof fn === 'function' ? fn : null; }
// A WRITE STILL REFUSED IS SAID (kanban #883, 2026-10-31: "Du musst den Fehler abfangen damit es nicht silent failed"): the client panics in its own task and nothing reached the player
let storageRefused = null;
export function onStorageRefused(fn) { storageRefused = typeof fn === 'function' ? fn : null; }
export function putRoomy(storage, key, value) {
  try { storage.setItem(key, value); } catch (e) {
    const quota = /quota/i.test(`${e && e.name} ${e && e.message}`);
    if (!storageFull || !quota) { if (quota && storageRefused) storageRefused(e); throw e; }
    storageFull();
    try { storage.setItem(key, value); } catch (e2) { if (storageRefused) storageRefused(e2); throw e2; }
  }
}

/**
 * THE PLAYER'S WALLET KEEPS ITS ROOM (2026-10-30: "Your browser's storage is full", and 1000 sat paid but not claimed: each kept round's lock wallet
 * takes ~150 KB, 50 kept rounds fill the 5 million characters a browser gives, and the next write of the player's wallet then ends its task). Past
 * LOCK_ROOM_CHARS a round's lock wallet goes on in memory: it is the seed's and the round's, and joined anew when needed. Safari gives half of Chrome's room.
 */
const LOCK_ROOM_CHARS = 1500000;
const liveLockDbs = new Set();
const charsRead = new WeakMap();
function storageChars(storage) {
  const seen = charsRead.get(storage);
  if (seen && Date.now() - seen.atMs < 5000) return seen.chars;
  let chars = 0;
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k) chars += k.length + String(storage.getItem(k) || '').length; }
  charsRead.set(storage, { atMs: Date.now(), chars });
  return chars;
}

/**
 * WHERE THE LOCK CLIENT'S WALLET IS KEPT: the tab's storage, one key per
 * database key, under this round and this seed's secret (its hash, never the
 * secret). The shape `lock-client/src/store.rs` reads: `entries()` as JSON.
 */
export function lockStoreFor(storage, roundId, secret) {
  const prefix = `arena.lockdb.${toHex(roundId).slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`;
  liveLockDbs.add(prefix);
  const kept = () => {
    const out = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k && k.startsWith(prefix)) out.push([unpackHex(k.slice(prefix.length)), valueOf(storage, storage.getItem(k))]);
    }
    return out;
  };
  const drop = (k) => { storage.removeItem(prefix + packHex(k)); storage.removeItem(prefix + k); };
  let inMemory = null;   // the whole database or none of it: a part of one left in storage would not open again
  const toMemory = () => { const all = kept(); inMemory = new Map(all); for (const [k] of all) drop(k); };
  return {
    entries() { return JSON.stringify(inMemory ? [...inMemory] : kept()); },
    put(k, v) {
      if (!inMemory && storageChars(storage) >= LOCK_ROOM_CHARS) toMemory();
      if (!inMemory) {
        try { putWalletValue(storage, prefix + packHex(k), v); dropRaw(storage, prefix, k); return; } catch (e) { if (!/quota/i.test(`${e && e.name} ${e && e.message}`)) throw e; toMemory(); }   // kanban #1978: the raw row goes once the packed one is written
      }
      inMemory.set(k, v);
    },
    remove(k) { if (inMemory) inMemory.delete(k); else drop(k); },
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
// A SEAT THAT NEVER ANSWERS IS A SEAT THAT SAID NOTHING (measured 2026-10-27: a market bot's collect waited 13 min on one
// seat that took the connection and never answered): the reads collect makes of every seat give up after 15 s
const SEAT_READ_MS = 15000;
// BLOCKS AS TIME (kanban #827, 2026-10-31: "Sag wann das ist, in Xh 3m ETA"): nobody reads a block height as a moment
export const blocksAsTime = (blocks, secondsPerBlock = 600) => {
  const m = Math.max(1, Math.ceil((Number(blocks) * Number(secondsPerBlock)) / 60));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
export function pendingWindowLine({ closeMs, provisional = false, nowMs = Date.now(), expiration = null, tipHeight = null, secondsPerBlock = 600 }) {
  if (!closeMs) return '';
  const t = new Date(Number(closeMs)).toISOString().slice(11, 19);
  if (nowMs < closeMs) return `window closes ${t} UTC${provisional ? ' \u00b7 provisional' : ''}`;
  if (nowMs < Number(closeMs) + PAYOUT_GRACE_MS) return `window closed ${t} UTC \u00b7 paying out`;
  return `window closed ${t} UTC \u00b7 not paid yet \u2013 the lock returns to your key ${!Number.isInteger(expiration) ? 'when it expires'
    : !Number.isInteger(tipHeight) ? `from block ${expiration}` : expiration > tipHeight ? `in about ${blocksAsTime(expiration - tipHeight, secondsPerBlock)}` : 'now'}`;
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
  const feds = keys.map(ledgerFedOfKey).filter(Boolean);
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
  for (const f of keys.map(ledgerFedOfKey).filter(Boolean))
    for (const make of [walletSecretFor, ancestorWalletSecretFor]) {
      try { ids.add(`arena.walletdb.${f.slice(0, 16)}.${toHex(sha256(make(seed, fromHex(f)))).slice(0, 16)}.`); } catch { /* not this kind */ }
    }
  let n = 0;
  for (const k of keys) if ([...ids].some((p) => k.startsWith(p))) { storage.removeItem(k); n++; }
  if (storage.getItem(recoverMarkKey(seed)) !== null) { storage.removeItem(recoverMarkKey(seed)); n++; }
  return n;
}

/**
 * OLD WALLET DATABASES OUT OF THE BROWSER'S STORAGE (kanban #616, 2026-10-24 playtest: "Order not placed: ... Setting the value of
 * 'arena.lock.saved.42835aaa…' exceeded the quota" - "You need to clean up old storages"). Measured: a player wallet's database is ~115 KB
 * per federation (its config, every guardian's endpoint) and one order adds ~50 KB; a browser that kept phrase after phrase filled its
 * 5 MB. Removed, one federation's database at a time:
 *   - one no phrase this browser keeps can open (`seeds`: every kept phrase, 64 hex) - its secret is gone from here, so are its notes'
 *     keys; nothing in it can be spent from this browser;
 *   - one of a kept phrase other than `current` that its merge emptied - noted empty (arena.wallet.empty.*) with as many entries as it
 *     has now - unless another tab plays with that phrase (`held(hex)`); the phrase is marked to recover, so should money ever reach it,
 *     its next open finds it at the federation (markSeedRecover).
 * A database whose federation is not named here in full (`federations`, 64 hex, and every federation with a history) is left alone.
 * Answers { removed: keys, bytes: what they held (UTF-16), wallets: databases }.
 */
export function tidyStorage(storage, { seeds = [], current = null, federations = [], held = () => false, now = () => Date.now(), pressureChars = 0, archive = null } = {}) {
  if (!storage) return { removed: 0, bytes: 0, wallets: 0 };
  const keys = storageKeys(storage);
  const feds = new Set([...federations.map((f) => String(f).toLowerCase()),
    ...keys.map(ledgerFedOfKey).filter(Boolean)].filter((f) => /^[0-9a-f]{64}$/.test(f)));
  const phrases = [...new Set([...seeds, ...(current ? [current] : [])].map((h) => String(h).toLowerCase()).filter((h) => /^[0-9a-f]{64}$/.test(h)))];
  const cur = current ? String(current).toLowerCase() : null;
  // every database a kept phrase can open: prefix -> { hex, fed, ancestor }
  const owned = new Map();
  for (const f of feds) for (const hex of phrases) for (const ancestor of [false, true]) {
    let secret; try { secret = (ancestor ? ancestorWalletSecretFor : walletSecretFor)(fromHex(hex), fromHex(f)); } catch { continue; }
    owned.set(`arena.walletdb.${f.slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`, { hex, fed: f, ancestor });
  }
  const fed16 = new Set([...feds].map((f) => f.slice(0, 16)));
  const groups = new Map();
  for (const k of keys) {
    const m = /^(arena\.walletdb\.([0-9a-f]{16})\.[0-9a-f]{16}\.)/.exec(k);
    if (m && fed16.has(m[2])) { if (!groups.has(m[1])) groups.set(m[1], []); groups.get(m[1]).push(k); }
  }
  let removed = 0, bytes = 0, wallets = 0;
  // A COLLECTED ROUND'S LOCK WALLET (kanban #625 follow-up, 2026-10-24 ~18:2xZ: "exceeded the quota" again on
  // arena.lock.saved.bd53423e; measured: each round a tab collects opens a lock wallet of its own, arena.lockdb.<round16>.<secret16>.*, 36 entries
  // and ~150 KB, and none was ever removed - a window every 15 min fills a phone's storage within a day): removed once the round's collect is
  // done and an hour old - its money is in the player wallet; a rescan that needs it again joins it anew (its key is the seed's and the round's)
  // ONE WALLET'S RECORDS, NOT ONE ROUND'S (kanban #1265, audit 4 #1257 CLIENT-1): the lock wallet is the phrase's and the round's (every order of the
  // phrase shares it), and it went once ANY record of the round was done - another order's e-cash, collected there and not withdrawn, went with it. A
  // wallet goes only when every collect record that maps to it (its seed and round) is done with the wallet read empty (tabMsat '0'), an hour after it was
  // kept; a round with a record that maps to no wallet here (no seed: an older page's) keeps every wallet of its round
  const walletOfRecord = (r) => { try { return `arena.lockdb.${String(r.roundIdHex).toLowerCase().slice(0, 16)}.${toHex(sha256(lockSecretFor(fromHex(String(r.seed)), fromHex(String(r.roundIdHex))))).slice(0, 16)}.`; } catch { return null; } };
  const recordsOfWallet = new Map(), unmapped = new Set();
  for (const k of keys) {
    if (!k.startsWith('arena.collect.')) continue;
    let r; try { r = JSON.parse(storage.getItem(k)); } catch { continue; }
    if (!r || !r.roundIdHex) continue;
    const w = walletOfRecord(r);
    if (!w) { unmapped.add(String(r.roundIdHex).toLowerCase().slice(0, 16)); continue; }
    if (!recordsOfWallet.has(w)) recordsOfWallet.set(w, []);
    recordsOfWallet.get(w).push(r);
  }
  const emptyWallet = (prefix, { ageMs = 3600000 } = {}) => {
    const rs = recordsOfWallet.get(prefix);
    if (!rs || !rs.length || unmapped.has(prefix.slice('arena.lockdb.'.length, 'arena.lockdb.'.length + 16))) return false;
    return rs.every((r) => r.done && r.done.tabMsat === '0' && now() - Number(r.savedMs || 0) > ageMs);
  };
  const doneRounds = new Set();
  for (const k of keys) {
    if (!k.startsWith('arena.collect.')) continue;
    // (kanban #1163: only a done that read the round's wallet empty - tabMsat '0'; a done an older page wrote goes only when the browser is full, below)
    try { const r = JSON.parse(storage.getItem(k)); if (r && r.done && r.done.tabMsat === '0' && r.roundIdHex && now() - Number(r.savedMs || 0) > 3600000) doneRounds.add(String(r.roundIdHex).toLowerCase().slice(0, 16)); } catch { /* unreadable: kept */ }
  }
  const lockGroups = new Map();
  for (const k of keys) {
    const m = /^(arena\.lockdb\.([0-9a-f]{16})\.[0-9a-f]{16}\.)/.exec(k);
    if (m && doneRounds.has(m[2]) && emptyWallet(m[1])) { if (!lockGroups.has(m[1])) lockGroups.set(m[1], []); lockGroups.get(m[1]).push(k); }
  }
  for (const [, ks] of lockGroups) { for (const k of ks) { bytes += (k.length + String(storage.getItem(k) || '').length) * 2; storage.removeItem(k); removed++; } wallets++; }
  for (const [prefix, ks] of groups) {
    const o = owned.get(prefix);
    let go = !o;
    if (o && o.hex !== cur && !held(o.hex)) {
      const mark = 'arena.wallet.empty.' + (o.ancestor ? 'blwp.' : '') + o.fed.slice(0, 16) + '.' + o.hex.slice(0, 16);
      go = storage.getItem(mark) !== null && storage.getItem(mark) === String(phraseWalletEntries(storage, o.hex, o.fed, { ancestor: o.ancestor }));
      if (go) { storage.removeItem(mark); markSeedRecover(storage, o.hex); }
    }
    if (!go) continue;
    for (const k of ks) { bytes += (k.length + String(storage.getItem(k) || '').length) * 2; storage.removeItem(k); removed++; }
    wallets++;
  }
  // A BROWSER STILL FULL (2026-10-30: "exceeded the quota" on the wallet of federation 4dc88be7 itself, 19 kept phrases: the wallet would not
  // open, a paid deposit could not be claimed, the order hung): above `pressureChars` what can be had again from the seed goes too. A done round's
  // lock wallet at any age, then the database of a kept phrase that no tab plays with, that holds no known balance, has no e-cash on its way and no
  // deposit waiting in its federation; the phrase stays kept and is marked to recover, so its next open reads it back from the federation. The
  // playing phrase is never touched. Oldest words of the rule: nothing here can be spent from a removed database, and nothing is lost by it.
  if (pressureChars) {
    const used = () => storageKeys(storage).reduce((n, k) => n + k.length + String(storage.getItem(k) || '').length, 0);
    let now_ = used();
    const take = (ks) => { for (const k of ks) { if (storage.getItem(k) === null) continue; const c = k.length + String(storage.getItem(k) || '').length; bytes += c * 2; now_ -= c; storage.removeItem(k); removed++; } wallets++; };
    if (now_ > pressureChars) {
      const done = new Set();
      for (const k of storageKeys(storage)) {
        if (!k.startsWith('arena.collect.')) continue;
        try { const r = JSON.parse(storage.getItem(k)); if (r && r.done && r.roundIdHex) done.add(String(r.roundIdHex).toLowerCase().slice(0, 16)); } catch { /* unreadable: kept */ }
      }
      const byDb = new Map();
      for (const k of storageKeys(storage)) { const m = /^(arena\.lockdb\.([0-9a-f]{16})\.[0-9a-f]{16}\.)/.exec(k); if (m && done.has(m[2]) && emptyWallet(m[1], { ageMs: -1 })) { if (!byDb.has(m[1])) byDb.set(m[1], []); byDb.get(m[1]).push(k); } }   // kanban #1265
      for (const [, ks] of byDb) { if (now_ <= pressureChars) break; take(ks); }
    }
    // AND A LOCK WALLET OF A ROUND STILL OPEN, an hour after it was kept and with no client of this page on it: copied to `archive` (the page's IndexedDB) and
    // removed here at once, because a refused write is tried again right after this returns (kanban #803); joined anew from the seed when needed (LOCK_ROOM_CHARS)
    if (now_ > pressureChars && archive) {
      const recent = new Set();
      for (const k of storageKeys(storage)) {
        if (!k.startsWith('arena.collect.')) continue;
        try { const r = JSON.parse(storage.getItem(k)); if (r && r.roundIdHex && now() - Number(r.savedMs || 0) <= 3600000) recent.add(String(r.roundIdHex).toLowerCase().slice(0, 16)); } catch { /* unreadable: its wallet goes as any other */ }
      }
      const byDb = new Map();
      for (const k of storageKeys(storage)) { const m = /^(arena\.lockdb\.([0-9a-f]{16})\.[0-9a-f]{16}\.)/.exec(k); if (m && !recent.has(m[2]) && !liveLockDbs.has(m[1]) && !(recordsOfWallet.get(m[1]) || []).some((r) => !(r.done && r.done.tabMsat === '0')) && !unmapped.has(m[2])) { if (!byDb.has(m[1])) byDb.set(m[1], []); byDb.get(m[1]).push(k); } }   // kanban #1265: no wallet with a record still open
      for (const [, ks] of byDb) {
        if (now_ <= pressureChars) break;
        archive(ks.map((k) => [k, storage.getItem(k)]));
        take(ks);
      }
    }
    if (now_ > pressureChars) {
      const travelling = new Set();
      for (const k of storageKeys(storage)) if (k.startsWith('arena.ecash.pending.')) { try { travelling.add(String(JSON.parse(storage.getItem(k)).fed || '').slice(0, 16)); } catch { /* unreadable: its federation stays */ } }
      // A DEPOSIT WAITING HOLDS ONLY THE WALLET THAT MADE IT (kanban #803: one unclaimed invoice in a federation held all 22 kept phrases' wallets there, so the
      // storage stayed full and the claim could not be written): that wallet's keys name its operation
      const waitingOps = [];
      // (kanban #1179: the old list arena.deposit.pending.<fed> and one key per deposit, arena.deposit.pending.<fed>.<operation>, each a list)
      for (const k of storageKeys(storage)) if (k.startsWith(PENDING_PREFIX)) { try { for (const p of JSON.parse(storage.getItem(k))) waitingOps.push(String(p.operation).toLowerCase()); } catch { travelling.add(k.slice(PENDING_PREFIX.length, PENDING_PREFIX.length + 16)); } }
      for (const [prefix] of groups) {
        if (now_ <= pressureChars) break;
        const o = owned.get(prefix);
        if (!o || o.hex === cur || held(o.hex) || travelling.has(o.fed.slice(0, 16))) continue;
        let known = 0n; try { known = BigInt(storage.getItem(`arena.wallet.known.${o.fed.slice(0, 16)}.${o.hex.slice(0, 16)}`) || 0); } catch { known = 1n; }
        if (known > 0n) continue;
        const ks = storageKeys(storage).filter((k) => k.startsWith(prefix));
        if (!ks.length || ks.some((k) => { const tail = unpackHex(k.slice(prefix.length)).toLowerCase(); return waitingOps.some((op) => tail.includes(op)); })) continue;
        take(ks); markSeedRecover(storage, o.hex);
      }
    }
  }
  return { removed, bytes, wallets };
}

/** WHERE THE PLAYER WALLET IS KEPT: the tab's storage, under the federation and the secret's hash, never the secret. */
export function walletStoreFor(storage, federationId, secret) {
  const prefix = `arena.walletdb.${toHex(federationId).slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`;
  return {
    entries() {
      const out = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k && k.startsWith(prefix)) out.push([unpackHex(k.slice(prefix.length)), valueOf(storage, storage.getItem(k))]);
      }
      return JSON.stringify(out);
    },
    put(k, v) { putWalletValue(storage, prefix + packHex(k), v); dropRaw(storage, prefix, k); },   // kanban #1978
    remove(k) { storage.removeItem(prefix + packHex(k)); storage.removeItem(prefix + k); },
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
// THE OPEN WALLETS OF EACH PHRASE (kanban #1387, audit 2 #1204 CLIENT-15): seed hex (16) -> [{ map, key }] - what forgetPhraseWallets drops
const phraseWallets = new Map();
/**
 * ANOTHER PHRASE'S WALLET CLIENTS LEAVE THE CACHE WITH ITS LOCK (kanban #1387, audit 2 #1204 CLIENT-15): a client this tab opened for a kept phrase it
 * collected or merged under that phrase's lock stayed cached after the lock went; another tab then used the phrase, and the next collect here got the
 * old client back - its in-memory store did not see the other tab's notes (the balance read 0, merges refused). The page calls this in the finally
 * that releases the lock; the next open of that phrase opens it afresh from its store. The client itself is not freed (a call may still hold it).
 */
export function forgetPhraseWallets(seedHex) {
  const k = String(seedHex || '').toLowerCase().slice(0, 16);
  const list = phraseWallets.get(k) || [];
  for (const { map, key } of list) map.delete(key);
  phraseWallets.delete(k);
  return list.length;
}
// THE PAGE'S GATE ON A PHRASE'S WALLETS (kanban #1164): fn(seedHex) -> a promise that resolves once this tab may open that phrase's wallets
let walletGate = null;
export function useWalletGate(fn) { walletGate = typeof fn === 'function' ? fn : null; }
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
  // NOT BEFORE THIS TAB HOLDS ITS PHRASE (kanban #1164): while another tab's collect holds the phrase's lock, a wallet of it opened here ran a
  // second client on the same store - the open waits for the lock (the page's seed keeper, useWalletGate)
  if (walletGate && seed instanceof Uint8Array) {
    let waited = false;
    const said = setTimeout(() => { waited = true; onStep('waiting for another tab of this browser to finish with this phrase'); }, 500);
    if (said.unref) said.unref();
    try { await walletGate(toHex(seed)); } finally { clearTimeout(said); }
    if (waited) onStep('this tab holds its phrase now');
  }
  const round = { federationId };
  if (!ancestor) rememberInvite(storage, federationId, invite);
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
  // A CONFIG NO GUARDIAN OF THE INVITE GAVE (one guardian down): once more, with an invite naming every guardian this client has seen named
  // for the federation (guardian-invites.js)
  const enter = (inv) => (recover ? LockClient.recover : LockClient.join).call(LockClient, inv, toHex(round.federationId), toHex(secret), store);
  const joinOnce = () => enter(invite).catch((e) => {
    const whole = /download client config/i.test(String((e && e.message) || e)) ? wholeInvite(invite) : null;
    if (!whole) throw e;
    onStep('one of the federation\'s guardians did not answer - reading its configuration from the others');
    return enter(whole);
  });
  noteInvite(invite);
  const joining = Promise.race([
    joinOnce(),
    new Promise((_, no) => { timer = setTimeout(() => no(new Error(`the federation did not open the player wallet in ${Math.round(joinWaitMs / 1000)} s - press PLAY again`)), joinWaitMs); }),
  ]).finally(() => clearTimeout(timer));
  joining.then((c) => noteClientFederation(c, toHex(round.federationId)), () => {});
  joining.then((c) => { try { feedTweaks(c); } catch { /* the lock client grinds its own */ } }, () => {});
  if (byStore) {
    const m = open || new Map(); if (!open) byStore.set(storage, m);
    m.set(key, joining);
    joining.catch(() => m.delete(key));
    if (seed instanceof Uint8Array) { const ph = toHex(seed).slice(0, 16); if (!phraseWallets.has(ph)) phraseWallets.set(ph, []); phraseWallets.get(ph).push({ map: m, key }); }
  }
  return joining;
}

// TWEAKS GROUND ON EVERY CORE (kanban #1391, Daniel 2026-11-09: "Yes fork it", "Make sure it is everything fast"): a new wallet's first locks waited
// 18-37 s for change-note tweaks - the lock client grinds them on the page's one wasm thread, about one a second, and a lock takes 7-22. Web Workers
// grind them here (one SHA-256 block each; 18.6 a second a core measured on the Beelink) and hand them to the lock client (addTweaks), which checks
// each against the wallet's own filter before it takes it. They stop at `high` ready and start again under `low`; `high` is the queue's whole 256, so the
// lock client's own grinder - SHA-256 on the page's one thread, 1.84 s a minute profiled on stage UI 604 - waits on a full queue. A client without addTweaks: nothing.
const TWEAK_WORKER_SRC = "// the worker body (kanban #1391): grinds tweaks that pass SHA-256(tweak || filter)[0..2] == 0, one compression each\nconst K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);\nlet F = null, on = false, running = false;\nconst W = new Uint32Array(64), t = new Uint32Array(4);\nconst hex8 = (x) => (x >>> 0).toString(16).padStart(8, '0');\nfunction first(w0, w1, w2, w3) {\n  W[0] = w0; W[1] = w1; W[2] = w2; W[3] = w3;\n  for (let i = 16; i < 64; i++) {\n    const a = W[i - 15], b = W[i - 2];\n    const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);\n    const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);\n    W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;\n  }\n  let A = 0x6a09e667, B = 0xbb67ae85, C = 0x3c6ef372, D = 0xa54ff53a, E = 0x510e527f, G = 0x9b05688c, H = 0x1f83d9ab, I = 0x5be0cd19;\n  for (let i = 0; i < 64; i++) {\n    const S1 = ((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7));\n    const t1 = (I + S1 + ((E & G) ^ (~E & H)) + K[i] + W[i]) | 0;\n    const S0 = ((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10));\n    const t2 = (S0 + ((A & B) ^ (A & C) ^ (B & C))) | 0;\n    I = H; H = G; G = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;\n  }\n  return (A + 0x6a09e667) >>> 0;\n}\nfunction grind(ms) {\n  const found = [];\n  const until = Date.now() + ms;\n  while (Date.now() < until) {\n    crypto.getRandomValues(t);\n    for (let n = 0; n < 65536; n++) {\n      const w3 = (t[3] + n) >>> 0;\n      if ((first(t[0], t[1], t[2], w3) >>> 16) === 0) found.push(hex8(t[0]) + hex8(t[1]) + hex8(t[2]) + hex8(w3));\n    }\n  }\n  return found;\n}\nfunction loop() {\n  if (!on || !F) { running = false; return; }\n  running = true;\n  const found = grind(150);\n  if (found.length) postMessage(found);\n  setTimeout(loop, 0);\n}\nonmessage = (e) => {\n  const d = e.data || {};\n  if (d.filter) { F = d.filter; for (let i = 0; i < 8; i++) W[4 + i] = parseInt(F.slice(8 * i, 8 * i + 8), 16) | 0; W[12] = 0x80000000 | 0; W[13] = 0; W[14] = 0; W[15] = 384; }\n  if ('on' in d) on = !!d.on;\n  if (on && !running) loop();\n};\n";
const tweakFed = new WeakSet();
export function feedTweaks(client, { WorkerCtor = globalThis.Worker, workers = null, high = 256, low = 200, everyMs = 500 } = {}) {
  if (!client || typeof client.tweakFilter !== 'function' || typeof client.addTweaks !== 'function' || typeof client.tweaksReady !== 'function'
    || typeof WorkerCtor !== 'function' || typeof Blob !== 'function' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || tweakFed.has(client)) return null;
  tweakFed.add(client);
  let filter; try { filter = String(client.tweakFilter()); } catch { return null; }
  const n = workers || Math.max(1, Math.min(4, ((globalThis.navigator && navigator.hardwareConcurrency) || 2) - 1));
  const url = URL.createObjectURL(new Blob([TWEAK_WORKER_SRC], { type: 'text/javascript' }));
  const pool = []; let on = null, timer = null, taken = 0;
  const stop = () => { clearInterval(timer); for (const w of pool) { try { w.terminate(); } catch { /* gone */ } } pool.length = 0; try { URL.revokeObjectURL(url); } catch { /* kept */ } };
  const set = (v) => { if (v === on) return; on = v; for (const w of pool) w.postMessage({ on: v }); };
  for (let i = 0; i < n; i++) {
    let w; try { w = new WorkerCtor(url); } catch { break; }
    w.onmessage = (e) => { try { taken += Number(client.addTweaks((e.data || []).join(''))) || 0; } catch { stop(); } };
    w.postMessage({ filter }); pool.push(w);
  }
  if (!pool.length) { stop(); return null; }
  const check = () => { let ready; try { ready = Number(client.tweaksReady()); } catch { stop(); return; } if (ready >= high) set(false); else if (ready < low) set(true); };
  check(); timer = setInterval(check, everyMs);
  return { workers: pool.length, taken: () => taken, stop };
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
  const feeGate = feeLockPays({ contract: { ...round, stakeMsat: stakeOf(round) }, fees: feeRule, feeBps: feeBpsForRound(round), split: splitForRound(round) });
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
  // A FEDERATION WITH NO FEES IS NOT DRY-RUN (kanban #618, measured 2026-10-24 on testnet4 federation 4dc88be7 from Node: the same
  // lockCostMsat(99000) answered in 5 ms, 19 ms and 1712 ms, two in parallel in 28-1180 ms - 2.7 s of a 5.5 s order went to the quote -
  // and every answer was the amount itself): its quote is each lock's amount in whole notes, which is what the floor below already
  // counts (the allowance is ceilNote - amount); a wallet holding less is "insufficient funds" exactly as the dry run says it
  if (zeroFees) {
    const floor = locks.reduce((t, m) => t + ceilNote(m), 0n) + donation;
    let have = null; try { have = BigInt(await client.balanceMsat()); } catch { have = null; }
    const short = have !== null && have < floor;
    return { locks, need: short ? null : floor, floor, quoteWhy: short ? `insufficient funds: the wallet holds ${have} msat, the locks take ${floor}` : null };
  }
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
// THE FEDERATION'S SEATED GATEWAYS FIRST (spec §23A.9: "clients use those two first"; kanban #559, 2026-10-20: "Fix all of it"):
// the page names a lookup - async (federation hex) -> the seated gateways' URLs, as the federation's guardians rank them - and every
// deposit, and both legs of a swap, try those before the lobby's named gateway and the federation's list
let seatedLookup = null;
const federationOfClient = new WeakMap();
/** The page's lookup of a federation's seated gateways (null: none). */
export function useSeatedGateways(lookup) { seatedLookup = typeof lookup === 'function' ? lookup : null; }
/** Which federation a lock client is a wallet of (openPlayerWallet notes it). */
export function noteClientFederation(client, federationHex) { if (client && typeof client === 'object' && federationHex) federationOfClient.set(client, String(federationHex).toLowerCase()); }
/**
 * THE GATEWAYS A GUARDIAN SEAT NAMES (GET /gateway-seats): the seated ones first, then every other that stands. A seat says them from signed claims,
 * so a new tunnel's address reaches the page from there; the site's own list is only what it was when the site was last deployed.
 */
export function gatewayUrlsOfView(view) {
  const g = (view && view.gateways) || {};
  const seated = ((view && view.seated) || []).map((n) => g[n] && g[n].url).filter(Boolean);
  return [...new Set([...seated, ...Object.values(g).map((x) => x && x.url).filter(Boolean)])];
}

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
/**
 * WHERE A ROUND'S STAKE COMES FROM, BEFORE ANY DEPOSIT IS ASKED (2026-10-22 playtest: 2,901 sat shown with ⇄, a 100 sat Up/Down order
 * in a 337ae01a round asked "Not enough sats ... Deposit with Lightning?"; "Deposits from different federations must work"). The balance the
 * page shows counts money still merging in from this browser's other wallets (other phrases, e-cash between a send and its receive), and
 * this phrase's own wallets in other federations. `parts` = the page's [{ federation (64 or 16 hex), sats, merging? }], `roundFederation`
 * 64 hex, `needMsat` what the round takes. Answers:
 *   ownHere    sat this phrase's wallet in the round's federation holds (spendable now)
 *   coveredBy  'here' | 'swap' | 'merge' | null - what pays it without a deposit, in that order: the wallet as it is, a swap from the
 *              player's own notes in other federations, or money still merging in (waited for only then)
 *   mergeFirst the federations (16 hex, the round's first) merged before the round is funded - only when coveredBy is 'merge'
 *   swapFrom   the other federations (16 hex), the fullest first, a shortfall is swapped in from
 *   askEarly   whether the deposit is asked at the press - only when nothing the player holds anywhere covers the round
 */
export function joinFundingPlan({ parts = [], roundFederation, needMsat }) {
  const p16 = (f) => String(f || '').toLowerCase().slice(0, 16);
  const here = p16(roundFederation);
  const need = BigInt(needMsat || 0);
  const sat = (x) => BigInt(Math.max(0, Math.floor(Number(x || 0)))) * 1000n;
  const by = new Map();
  for (const x of parts || []) {
    if (!x || !x.federation) continue;
    const f = p16(x.federation), a = by.get(f) || { own: 0n, merging: 0n };
    const merging = sat(x.merging), all = sat(x.sats);
    a.merging += merging; a.own += all > merging ? all - merging : 0n;
    by.set(f, a);
  }
  const at = by.get(here) || { own: 0n, merging: 0n };
  const others = [...by.entries()].filter(([f]) => f !== here);
  const elsewhere = others.reduce((t, [, a]) => t + a.own + a.merging, 0n);
  const ownElsewhere = others.reduce((t, [, a]) => t + a.own, 0n);
  const swapFrom = others.filter(([, a]) => a.own + a.merging > 0n).sort((x, y) => (y[1].own + y[1].merging > x[1].own + x[1].merging ? 1 : -1)).map(([f]) => f);
  // SPENDABLE MONEY FIRST, THE MERGE ONLY WHEN NOTHING ELSE PAYS (2026-10-22: "Placing a market order takes 10+ seconds" - every order
  // waited for the merge whenever anything was merging): the round's wallet, else a swap from the player's own notes elsewhere, and only
  // then the money still merging in - the federations to merge named only in that case
  const coveredBy = at.own >= need ? 'here' : at.own + ownElsewhere >= need ? 'swap' : at.own + ownElsewhere + at.merging + elsewhere - ownElsewhere >= need ? 'merge' : null;
  const mergeFirst = coveredBy !== 'merge' ? [] : [...(at.merging > 0n ? [here] : []), ...others.filter(([, a]) => a.merging > 0n).map(([f]) => f)];
  return { ownHere: Number(at.own / 1000n), coveredBy, mergeFirst, swapFrom, askEarly: coveredBy === null };
}

/** NOT SPENDABLE YET (the same playtest): this phrase's wallet in the round's federation short of the round, and what is still merging in would
 *  fill the gap - said by name instead of a deposit request. `mergingSat` the page's merging total in sat. */
export function notSpendableYet({ haveMsat, mergingSat, needMsat }) {
  const have = BigInt(haveMsat || 0), need = BigInt(needMsat || 0), merging = BigInt(Math.max(0, Math.floor(Number(mergingSat || 0)))) * 1000n;
  return have < need && merging > 0n && have + merging >= need;
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
// `phrase16`: the depositing phrase's first 16 hex, kept on each pending entry so a scan with another phrase's key never drops it (kanban #1233)
export function depositOffer({ client, stakeMsat, haveMsat = null, needMsat = null, gateways = [], onDeposit = () => {},
  storage = null, federationId = null, restMsat = null, sizeOf = null, choices = null, phrase16 = null } = {}) {
  // THE LAST WORD ON WHERE NEW MONEY GOES (kanban #807): whichever path asked, no invoice is made for a federation that takes no new deposits
  if (federationId && !takesDeposits(federationId)) throw new Error('this federation takes no new deposits');
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
      pendingAdd(storage, federationId, { invoice: d.invoice, operation: x.operation, msat: String(amount), ...(phrase16 ? { phrase16: String(phrase16).toLowerCase() } : {}) });
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
        depositEnded(storage, federationId, x.operation, final, d);
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
// DEPOSITS NOT YET ENDED (arena.deposit.pending.<fed>.<operation>): every invoice made, until its receive ends.
// ONE KEY PER DEPOSIT (kanban #1179, the 2026-11-06 state-machine audit): the list was one key per federation, read, changed and written back,
// and two tabs on two phrases depositing in one federation share the browser's storage: a write of one tab could drop the other's entry,
// and its deposit was never resumed - nor held its wallet against tidyStorage. Now each deposit is its own key, a one-entry list, written
// once and removed once, so no tab ever writes another's. The list a page before this kept (arena.deposit.pending.<fed>) is still read,
// and an entry of it leaves it only when its deposit ends.
//   pending --(its receive ends: Claimed, the history row written first)--> gone
//   pending --(Expired | Failure)--> gone
const PENDING_PREFIX = 'arena.deposit.pending.';
export const DEPOSIT_STATE = Object.freeze({ PENDING: 'pending', CLAIMED: 'Claimed', EXPIRED: 'Expired', FAILED: 'Failure' });
const pendingOpKey = (federationId, operation) => `${PENDING_PREFIX}${fedHexOf(federationId)}.${String(operation)}`;
const readList = (raw) => { const l = raw ? JSON.parse(raw) : []; return Array.isArray(l) ? l : [l]; };
export function pendingDeposits(storage, federationId) {
  if (!storage || !fedHexOf(federationId)) return [];
  const base = PENDING_PREFIX + fedHexOf(federationId), byOp = new Map();
  try { for (const p of readList(storage.getItem(base))) if (p && p.operation) byOp.set(String(p.operation), p); } catch { /* unreadable: the keys below still count */ }
  for (const k of storageKeys(storage)) {
    if (!k.startsWith(`${base}.`)) continue;
    try { for (const p of readList(storage.getItem(k))) if (p && p.operation) byOp.set(String(p.operation), p); } catch { /* that one unreadable */ }
  }
  return [...byOp.values()];
}
const phraseOfSeed = (seed) => (seed instanceof Uint8Array && seed.length ? toHex(seed).slice(0, 16) : (typeof seed === 'string' && /^[0-9a-f]{16,}$/i.test(seed) ? seed.slice(0, 16).toLowerCase() : null));
// ANSWERS WHETHER THE ENTRY LANDED (kanban #2183, refuting #1774): the write is read back, so a refused one (QuotaExceededError on a full
// store, kanban #803) is told apart from a kept one - a Move's receive leg that did not land must stop its payment (moveLegAhead)
function pendingAdd(storage, federationId, p) {
  if (!storage || !fedHexOf(federationId) || !p || !p.operation) return false;
  const kept = () => { try { return pendingDeposits(storage, federationId).some((x) => String(x.operation) === String(p.operation)); } catch { return false; } };
  // A STORE THAT CANNOT LIST ITS KEYS keeps the one list, as before
  // THROUGH putRoomy, AS EVERY WALLET WRITE (kanban #2427 / #2484, refuting #2183): a raw setItem never asked the page's storage relief
  // (onStorageFull -> ARENA_TIDY_STORAGE, kanban #803), so a full browser where one tidy makes room stopped every Move and evacuation.
  // Only a write still refused after the relief stops the move (and putRoomy says so: onStorageRefused -> the page's storage-full alert).
  if (typeof storage.key !== 'function') {
    try { putRoomy(storage, PENDING_PREFIX + fedHexOf(federationId), JSON.stringify([...pendingDeposits(storage, federationId).filter((x) => x.operation !== p.operation), { atMs: Date.now(), ...p }])); } catch { /* not kept */ }
    return kept();
  }
  try { putRoomy(storage, pendingOpKey(federationId, p.operation), JSON.stringify([{ atMs: Date.now(), ...p }])); }
  catch { /* a tab that cannot write keeps no note; the money is not touched */ }
  return kept();
}
function pendingDrop(storage, federationId, operation) {
  if (!storage || !fedHexOf(federationId)) return;
  try { storage.removeItem(pendingOpKey(federationId, operation)); } catch { /* kept */ }
  // AN ENTRY OF THE OLD LIST: that list only ever loses the one entry that ended
  const base = PENDING_PREFIX + fedHexOf(federationId);
  try {
    const raw = storage.getItem(base);
    if (raw === null) return;
    const left = readList(raw).filter((x) => x && String(x.operation) !== String(operation));
    if (left.length) storage.setItem(base, JSON.stringify(left)); else storage.removeItem(base);
  } catch { /* kept as it was */ }
}
/**
 * A DEPOSIT'S RECEIVE ENDED: THE ONE TRANSITION (kanban #1179). Claimed writes its history row before the entry goes, so a page closed between the two
 * keeps the entry and its next resume finds the row there and writes no second; any final state removes the entry, and anything else leaves it. `d`
 * { invoice, amountMsat }, or { operation, amountMsat } for a deposit found at the federation without its invoice. Answers whether a new row was written.
 */
export function depositEnded(storage, federationId, operation, final, d) {
  let added = false;
  if (final === DEPOSIT_STATE.CLAIMED) added = depositRowOnce(storage, federationId, d);
  if (final === DEPOSIT_STATE.CLAIMED || final === DEPOSIT_STATE.EXPIRED || final === DEPOSIT_STATE.FAILED) pendingDrop(storage, federationId, operation);
  return added;
}
/** THE WELCOME THAT CAME AS E-CASH (kanban #1381): one deposit row per e-cash string, however many pages received it. */
export function faucetEcashRowOnce(storage, federationId, { ecash, msat }) {
  if (!storage || !fedHexOf(federationId) || !ecash) return false;
  const id = `dep-faucet-${toHex(taggedHash('arena/faucet/ecash/v1', new TextEncoder().encode(String(ecash)))).slice(0, 32)}`;
  return ledgerAppend(storage, federationId, { kind: 'deposit', msat: String(msat), invoiceHash: null, faucet: true }, id);
}
/** One history row per paid invoice, however many pages saw it claimed. */
function depositRowOnce(storage, federationId, d) {
  if (!storage || !fedHexOf(federationId)) return false;
  let invoiceHash = null;
  try { invoiceHash = toHex(decodeBolt11(d.invoice).paymentHash); } catch { invoiceHash = null; }
  // A MOVE'S RECEIVE LEG (kanban #1774) writes its own row (moved-in / swapped-in, `d.row`), once per invoice as a deposit's
  const row = d.row && typeof d.row.kind === 'string' ? d.row : { kind: 'deposit' };
  if (invoiceHash && ledgerRows(storage, federationId).some((r) => r.kind === row.kind && r.invoiceHash === invoiceHash)) return false;
  // ITS ROW'S KEY IS THE INVOICE'S (kanban #1179), or the operation's for a deposit found without its invoice: two tabs that see one claim write one key
  const id = invoiceHash ? `dep-${invoiceHash}` : d.operation ? `dep-op-${String(d.operation).toLowerCase()}` : null;
  return ledgerAppend(storage, federationId, { ...row, msat: String(d.amountMsat), invoiceHash }, id);
}
/**
 * THE DEPOSITS AN EARLIER PAGE LEFT (2026-09-30: a reload of the deposit page lands on the lobby, and a payment
 * made just before it must still be in the history): the reopened wallet waits on each kept operation; a claimed one
 * gets its row, and every ended one leaves the list. `onClaimed(d)` for each new row. Spends nothing.
 */
export function resumeDeposits({ client, storage, federationId, onClaimed = () => {}, others = async () => [], onLost = () => {} } = {}) {
  const d0 = (p) => ({ invoice: p.invoice, amountMsat: BigInt(p.msat), ...(p.row ? { row: p.row } : {}) });
  const ended = (p, final, from = null) => {
    if (depositEnded(storage, federationId, p.operation, final, d0(p))) onClaimed({ ...d0(p), ...(from ? { from } : {}) });
    return from ? `${final} (in wallet ${from.label})` : final;
  };
  return Promise.all(pendingDeposits(storage, federationId).map((p) => client.awaitReceive(p.operation).then((final) => ended(p, final),
    // A DEPOSIT ANOTHER OF THIS BROWSER'S WALLETS MADE (2026-10-20 17:5xZ: "unknown (operation 3d41502f316a: Operation not found)" - the
    // pending list is per federation, the wallet database per federation and phrase; the invoice was made under another phrase this browser
    // keeps): every other kept wallet of the federation (`others()`: [{ client, label }]) is asked for it, and the one that holds it claims it
    async (e) => {
      const why = String((e && e.message) || e);
      if (/operation not found/i.test(why)) {
        let alts = []; try { alts = (await others()) || []; } catch { alts = []; }
        for (const o of alts) {
          // A CLAIM LEFT TO THAT PHRASE'S OWN TAB (kanban #1285): the wallet holds the operation and its claim did not end while its phrase was held here -
          // not lost; the entry stays
          try { return ended(p, await o.client.awaitReceive(p.operation), o); } catch (e2) { if (e2 && e2.stillWaiting) return `waiting (in wallet ${o.label}: ${String(e2.message).slice(0, 120)})`; }
        }
      }
      // THE REASON A RESUME COULD NOT BE READ, said (17:4xZ: it printed only "unknown"); the entry stays, so the next page tries again
      onLost(p, why);
      return `unknown (operation ${String(p.operation).slice(0, 12)}: ${why.slice(0, 160)})`;
    })));
}
/**
 * THE DEPOSITS THE WALLET'S DATABASE LOST, FOUND AT THE FEDERATION (kanban #883, a full browser: the invoice paid, the operation never written, "Operation not found"). The
 * federation's incoming contracts are read from the start and each is tried against this wallet's key: only a deposit really paid has one, so what this credits is
 * what arrived, and `lost` - invoices that may never have been paid - is dropped once the whole stream was read. The federation holds a read at the stream's end: `timeoutMs` ends it.
 */
// `phrase16`: the scanning wallet's phrase; `dropUnnamed`: an entry that names no phrase may go (the browser keeps one phrase only) - kanban #1233
export async function scanLostDeposits({ client, storage, federationId, lost = [], onClaimed = () => {}, timeoutMs = 15000, phrase16 = null, dropUnnamed = true } = {}) {
  if (typeof client.scanDeposits !== 'function') return { read: false, msat: 0n, found: 0 };
  let next = '0', done = false, msat = 0n, foundN = 0;
  const waits = [];
  const unresolved = new Set();
  while (!done) {
    let got;
    try { got = JSON.parse(await withinMs(client.scanDeposits(next), timeoutMs, 'the federation held the read')); }
    catch { break; }
    next = got.next; done = !!got.done;
    for (const f of got.found) {
      foundN++;
      // BOUNDED, ONE BY ONE (kanban #883, the owner's iPhone: one wait that never ended held the whole scan, so its "done" never came and unpaid invoices stayed in the red line)
      // AND ITS ENTRY GOES WHEN ITS RECEIVE ENDS, not before it (kanban #1179): a page closed meanwhile resumes it
      waits.push(withinMs(client.awaitReceive(f.operation), 60000, 'the claim did not end').then((final) => {
        if (!depositEnded(storage, federationId, f.operation, final, { operation: f.operation, amountMsat: BigInt(f.msat) })) return;
        msat += BigInt(f.msat);
        onClaimed({ amountMsat: BigInt(f.msat), operation: f.operation });
      }, () => { unresolved.add(String(f.operation)); }));
    }
  }
  await Promise.all(waits);
  // THE INVOICES THAT MAY NEVER HAVE BEEN PAID GO ONLY AFTER A WHOLE READ (kanban #1179): before, a read that failed after its first page still dropped every
  // one of them, and a paid one past that page was never looked for again. `read` is false then, and the next page reads again
  if (!done) return { read: false, partial: next !== '0', msat, found: foundN };
  // ONLY WHAT THIS SCAN COULD HAVE FOUND (kanban #1233, audit 3 #1210 FIXES-4): the stream is read with this wallet's key, so another phrase's paid
  // deposit is never found here - its entry stays for its own phrase's scan; and an entry whose claim was found but did not end stays too
  const mine = phrase16 ? String(phrase16).toLowerCase() : null;
  let kept = 0;
  for (const p of lost) {
    const ours = p.phrase16 ? (mine !== null && String(p.phrase16).toLowerCase() === mine) : dropUnnamed;
    if (!ours || unresolved.has(String(p.operation))) { kept++; continue; }
    pendingDrop(storage, federationId, p.operation);
  }
  return { read: true, msat, found: foundN, kept };
}
/** A deposit into the player wallet from Settings: the same tabs, this round's stake, no round to fund. */
export async function settingsDepositOffer({ round, invite, seed, LockClient, storage, gateways = [], donationMsat = 0n, donationRecipients = null, onDeposit = () => {}, onClaimed = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage });
  const locks = await locksFor(round, client, donationMsat, donationRecipients);
  const offer = depositOffer({ phrase16: phraseOfSeed(typeof seed !== 'undefined' ? seed : null), client, stakeMsat: stakeOf(round), haveMsat: BigInt(await client.balanceMsat()), gateways, onDeposit,
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
  if (federationId && !takesDeposits(federationId)) throw new Error('this federation takes no new deposits');   // before a wallet is opened in it (kanban #807)
  const client = await openPlayerWallet({ federationId, invite, seed, LockClient, storage });
  const offer = depositOffer({ phrase16: phraseOfSeed(typeof seed !== 'undefined' ? seed : null), client, stakeMsat: 0n, haveMsat: BigInt(await client.balanceMsat()), gateways, onDeposit, storage, federationId,
    choices: walletDepositChoices() });
  offer.claimed.then((d) => { depositRowOnce(storage, federationId, d); onClaimed(d); offer.decided({ funded: true }); }, () => {});
  offer.client = client;   // the page keeps it with its other wallets: summed, and its pending deposits waited on (2026-10-20)
  return offer;
}
/**
 * TEST SATS FROM THE FAUCET (kanban #926): the invoice `offer` makes for this wallet, paid by the faucet; `offer.claimed` says when it landed. `account` is a
 * hash of the seed, so the faucet can pay a welcome once and learns no key. Throws naming why it gave nothing.
 */
// THE TOP-UP IS 300 (kanban #1088, the owner 2026-11-03: "Get 300 sats, aus dem faucet. Im deposit auch 300. Bis zu 5x faucet am Tag"): the faucet pays it up to 5 times a day per account
export const FAUCET_GRANTS = Object.freeze({ welcome: { sats: 3000, invoiceMsat: 3000000n }, topup: { sats: 300, invoiceMsat: 300000n } });
export const faucetAccountOf = (seed) => toHex(taggedHash('arena/faucet/account/v1', seed instanceof Uint8Array ? seed : fromHex(String(seed))));
// `ecash` (kanban #1381): the federation id in hex - the welcome comes as ready e-cash of that federation when the faucet holds some ({ ok, sats, ecash });
// without an invoice and none ready, the answer is `noEcash` and nothing is given (the page then asks again with an invoice)
export async function askFaucet({ url, kind, invoice, seed, ecash, fetcher = fetch } = {}) {
  const r = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind, account: faucetAccountOf(seed), invoice, ...(ecash ? { ecash } : {}) }), signal: AbortSignal.timeout(45000) });
  const j = await r.json().catch(() => ({ ok: false, why: `the faucet answered ${r.status}` }));
  if (!j.ok && j.noEcash) return j;
  if (!j.ok) throw new Error(j.why || 'the faucet gave nothing');
  return j;
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
/** A donation the player wallet paid, a history row (every deduction is a row - 2026-09-30 16:15). A gift from the page names its
 *  federation transaction and to whom (kanban #682: "I just did a donation and it doesn't show in the user history"). */
export function recordDonation(storage, federationId, { msat, round, txid = null, to = null }) {
  ledgerAppend(storage, federationId, { kind: 'donation', msat: String(msat), round: round ? String(round) : null, ...(txid ? { txid: String(txid) } : {}), ...(to ? { to: String(to) } : {}) });
}
/** WHAT CAME IN TO THIS PLAYER'S KEY, a history row once collected (kanban #681): 'referral' - 10 % of the nodes' fee on an entry its
 *  referral link brought, `round` the round that paid it - or 'zap-in', a zap from another player. `outpoint` is the payout collected. */
export function recordReceived(storage, federationId, { kind, msat, round = null, outpoint = null }) {
  if (kind !== 'referral' && kind !== 'zap-in') return;
  ledgerAppend(storage, federationId, { kind, msat: String(msat), round: round ? String(round) : null, ...(outpoint ? { outpoint: String(outpoint) } : {}) });
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
/** How often a wallet waiting on a deposit is looked at, and what the wait ends with when it covers the round. */
export const LANDED_POLL_MS = 2000;
const LANDED = Object.freeze({ landed: true });
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
  return depositOffer({ phrase16: phraseOfSeed(typeof seed !== 'undefined' ? seed : null), client, stakeMsat: stakeOf(round), haveMsat: have, needMsat: null, gateways, onDeposit, storage, federationId: round.federationId });
}

export async function fundPlayerWallet({ round, invite, seed, LockClient, storage, donationMsat = 0n, donationRecipients = null, gateways = [],
  estimateDeposit = false, askDeposit = null, onDeposit = () => {}, onStep = () => {}, entryClosesMs = null, early = null, onLanded = () => {} } = {}) {
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
      const offer = adopt ? early : depositOffer({ phrase16: phraseOfSeed(typeof seed !== 'undefined' ? seed : null), client, stakeMsat: stakeOf(round), haveMsat: have, needMsat: n.need, gateways, onDeposit,
        storage, federationId: round.federationId, restMsat, sizeOf: (k) => roundsDepositMsat(k, locks, LockClient) });
      if (adopt) { /* already on the screen */ } else if (prev) prev.decided({ funded: false, rest: offer }); else askDeposit(offer);
      onStep(restMsat === null ? 'waiting for the deposit into the player wallet' : `waiting for the rest of this round's fees: ${restMsat} msat`);
      // NOT PAST THE ROUND'S ENTRY (MF 18: a deposit left open was still waiting 30 s and 151 s past the close, the round's
      // clock at 0:00 behind it, no error): at the round's last entry instant the request is closed with the reason - the join is
      // refused by name. Its invoice is still followed: paid later, it lands in the player wallet, for the next round.
      let closeTimer = null;
      // SATS THAT COME ANOTHER WAY END THE WAIT (kanban #1042, measured 2026-11-02 on a fresh wallet: a tap at 47 s, the faucet's 500 sat landing at about 60 s, and the join sat
      // on the invoice until the entry closed): the wallet is looked at while the invoice stands, and once it covers the round the funding goes on
      let stopLook = () => {};
      const landed = new Promise((go) => {
        const look = setInterval(async () => { try { const h = BigInt(await client.balanceMsat()), m = await needFor(client, LockClient, locks); if (m.need !== null && h >= m.need) go(LANDED); } catch { /* the next look */ } }, LANDED_POLL_MS);
        stopLook = () => clearInterval(look);
      });
      let got = null;
      // A DEPOSIT ASKED BECAUSE THE WALLET WAS SHORT IS THE WALLET'S, NOT THE ROUND'S (2026-10-18 playtest, RPS with 0 sat: "No deposit
      // screen comes" - measured on the test host: an RPS round's entry closed 3 s after the press, which closed the offer before it was ever
      // seen): at the round's entry close the join ends by name, and the early offer stays on the screen - its invoice still followed, paid
      // later it lands in the player wallet for the next round
      if (adopt && entryClosesMs !== null && entryClosesMs !== undefined && Number.isFinite(Number(entryClosesMs))) {
        const why = `the round's entry closed at ${new Date(Number(entryClosesMs)).toISOString().slice(11, 19)} UTC before the deposit arrived: nothing was taken for this round; the deposit is still open and goes into your wallet for the next round`;
        const left = Math.max(0, Number(entryClosesMs) - Date.now());
        got = await Promise.race([offer.claimed, landed, new Promise((resolve, reject) => { closeTimer = setTimeout(() => reject(new Error(why)), left); })])
          .finally(() => { if (closeTimer) clearTimeout(closeTimer); stopLook(); });
      } else if (entryClosesMs !== null && entryClosesMs !== undefined && Number.isFinite(Number(entryClosesMs))) {
        const why = `the round's entry closed at ${new Date(Number(entryClosesMs)).toISOString().slice(11, 19)} UTC before the deposit arrived: nothing was taken for this round`;
        const left = Number(entryClosesMs) - Date.now();
        if (left <= 0) offer.close(why); else closeTimer = setTimeout(() => offer.close(why), left);
      }
      const d = got || await Promise.race([offer.claimed, landed]).finally(() => { if (closeTimer) clearTimeout(closeTimer); stopLook(); });
      if (d === LANDED) { onStep('the wallet covers this round now: the invoice is left unpaid'); onLanded(offer); continue; }
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
export async function lockStake(ask = {}) {
  // `keep`: the page's join (kanban #1162) - the lock is written ahead, kept and stepped as one record (keptLockStake); a caller that keeps its
  // own (a bot, a tool) leaves it out, and nothing changes for it
  return ask.keep ? keptLockStake(ask) : lockStakeNow(ask);
}
async function lockStakeNow({ round, roundId, invite, seed, stake, claimKey, playerPubkey, LockClient,
  storage, donationMsat = 0n, donationRecipients = null, onStep = () => {}, onSubmitted = () => {}, onSubmitting = () => {}, submitTag = '' } = {}) {
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
    // THE SUBMISSION MARKED BEFORE IT IS MADE, AND TAGGED (kanban #2459): the lock client hands the transaction to the guardians before it
    // answers, so a tab closed in that window left an intent with no transaction id; the intent now says it was handed on (onSubmitting - a
    // throw here submits nothing), and the 2.0 lock client keeps the submission under `submitTag` in the wallet's operation log
    // (lockSubmittedFor), as sendEcash(msat, key) keeps an e-cash send. An older lock client ignores the extra argument.
    onSubmitting();
    const submitted = JSON.parse(await client.lockSubmit(toHex(stake.stakePoint), String(amount), image ? toHex(image) : '',
      String(feeGate.pays ? feeMsat : 0n), toHex(claimKey.claimPk), toHex(refundPk), delta,
      JSON.stringify(donationShares.map((d) => ({ pk: toHex(d.recipientPk), msat: String(d.amountMsat), image: toHex(playerPubkey) }))),
      ...(submitTag ? [submitTag] : [])));
    onSubmitted(submitted);
    // WHERE THE LOCK'S TIME WENT, AS THE LOCK CLIENT MEASURED IT (kanban #623: a browser lock 0.3-2.7 s, a bot's 60-160 ms on the same
    // federation): the block count (kept or read), building the outputs, finalizing and submitting, the mint outputs' wait, the store
    if (submitted.timing) console.log('[arena] TIMED lock inside: ' + JSON.stringify(submitted.timing));
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
/**
 * ONE KEY PER ROW (kanban #1179, the 2026-11-06 state-machine audit): the history was one list per federation, read, appended to and written back, and the
 * tabs of a browser share it: two tabs appending at once kept one row of the two. Now a row is its own key, arena.ledger.<fed>.<id>, a one-row list written
 * once; a row two tabs may both write (a deposit's, by its invoice) has a key of its own content, so it is one row. The list a page before this kept,
 * arena.ledger.<fed>, is read first and still written by nobody but an older page.
 */
const LEDGER_ROW_RE = /^arena\.ledger\.([0-9a-f]{64})(?:\.([0-9a-z_-]+))?$/i;
/** The federation (hex) a history key belongs to, the list or one row of it; null for any other key. */
export const ledgerFedOfKey = (k) => { const m = LEDGER_ROW_RE.exec(String(k || '')); return m ? m[1].toLowerCase() : null; };
/** This federation's rows, oldest first, as kept: the old list as it was, then each row of its own key by its time. */
export function ledgerRows(storage, federationId) {
  if (!storage) return [];
  const base = ledgerKey(federationId);
  let rows = [];
  try { const raw = storage.getItem(base); const l = raw ? JSON.parse(raw) : []; rows = Array.isArray(l) ? l : []; } catch { rows = []; }
  const own = [];
  for (const k of storageKeys(storage)) {
    if (!k.startsWith(`${base}.`) || !LEDGER_ROW_RE.test(k)) continue;
    try { const l = JSON.parse(storage.getItem(k)); for (const r of Array.isArray(l) ? l : [l]) if (r) own.push({ k, r }); } catch { /* that row unreadable */ }
  }
  own.sort((a, b) => (Number(a.r.atMs) || 0) - (Number(b.r.atMs) || 0) || (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return [...rows, ...own.map((x) => x.r)];
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
let ledgerSeq = 0;
const ledgerRowId = () => {
  const r = new Uint8Array(6);
  try { globalThis.crypto.getRandomValues(r); } catch { for (let i = 0; i < r.length; i++) r[i] = Math.floor(Math.random() * 256); }
  ledgerSeq = (ledgerSeq + 1) % 1296;
  return `${Date.now().toString(36)}-${ledgerSeq.toString(36).padStart(2, '0')}${toHex(r)}`;
};
/** One row, under its own key: `id` names it (a key of the row's content, written once by whoever writes it first), else a fresh one. Answers whether it was written. */
function ledgerAppend(storage, federationId, row, id = null) {
  if (!storage || !fedHexOf(federationId)) return false;
  // A STORE THAT CANNOT LIST ITS KEYS could not read a row of its own key back: the one list, as before
  if (typeof storage.key !== 'function') {
    try { const rows = ledgerRows(storage, federationId); rows.push({ atMs: Date.now(), ...row }); storage.setItem(ledgerKey(federationId), JSON.stringify(rows)); return true; } catch { return false; }
  }
  const key = `${ledgerKey(federationId)}.${id ? String(id).toLowerCase().replace(/[^0-9a-z_-]/g, '') : ledgerRowId()}`;
  try {
    if (id && storage.getItem(key) !== null) return false;
    storage.setItem(key, JSON.stringify([{ atMs: Date.now(), ...row }]));
    return true;
  } catch { return false; /* a tab that cannot write keeps no history; the money is not touched */ }
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
    // EACH ITS OWN ROW (kanban #1179), keyed by its round and player: two tabs reading at once write one
    if (ledgerAppend(storage, federationId, { atMs: null, kind: 'stake', round: m[1], player: m[2], entry: j.committedTo || null, msat: String(lockTotalMsat(j)), read: true }, `read-${m[1]}-${m[2]}`)) added++;
  }
  try { storage.setItem(flag, String(Date.now())); } catch { return 0; }
  return added;
}

const savedLockKey = (roundId, playerPubkey) => `arena.lock.saved.${toHex(roundId)}.${toHex(playerPubkey).slice(0, 16)}`;
const lockIntentKey = (roundId, playerPubkey) => `arena.lock.intent.${toHex(roundId)}.${toHex(playerPubkey).slice(0, 16)}`;

/**
 * ONE STAKE LOCK, ONE RECORD, ONE TRANSITION FUNCTION (kanban #1162, the 2026-11-06 state-machine audit). The lock was made first and kept
 * after, with a raw write: a full browser (QuotaExceededError, #616) or a tab closed between the two left a lock no record names, the join
 * refused, and the next PLAY locked the same round again; a lock the guardians refused was kept anyway and reused on every reload; and the
 * entry it was named in lived only in memory, so a reload reused it under a new entry the seats that took the first refuse.
 *   none --(the intent written, room taken: nothing spent before it)--> intent --(lockSubmit answered)--> submitted
 *   submitted --(the guardians accept it, or a reload reads it stored: lockStatus)--> accepted --(needed seats took it)--> committed
 *   submitted --(a reload reads it stored nowhere, `tries` times)--> refused --(a new PLAY)--> intent
 *   intent --(a lock client that answers only once accepted)--> accepted;  intent --(a new PLAY over one that failed)--> intent
 * Only an accepted or committed lock is reused; a submitted one is read first (keptLockUse 'check', reconcileKeptLock). The entry a lock is
 * named in is written before that entry goes out (bindLockEntry), once; committed is final.
 */
export const LOCK_RECORD_STATES = Object.freeze({ NONE: 'none', INTENT: 'intent', SUBMITTED: 'submitted', ACCEPTED: 'accepted', REFUSED: 'refused', COMMITTED: 'committed' });
const LOCK_RECORD_EDGES = Object.freeze({ none: ['intent'], intent: ['intent', 'submitted', 'accepted'], submitted: ['accepted', 'refused', 'committed'],
  accepted: ['committed'], refused: ['intent'], committed: [] });
/** THE ONE TRANSITION: a record's state `from` to `to`. Throws for a step a lock does not take. */
export function lockRecordStep(from, to) {
  const f = from || 'none';
  if (!(LOCK_RECORD_EDGES[f] || []).includes(to)) throw new Error(`a stake lock goes ${f} -> ${(LOCK_RECORD_EDGES[f] || []).join(' | ') || 'nothing (final)'}, not -> ${to}`);
  return to;
}
/** A kept record's state. A record kept before #1162 names none: committed when it names its entry, else submitted - read before it is reused. */
const lockStateOf = (j) => (j && j.state && j.state !== 'none' && LOCK_RECORD_EDGES[j.state] ? j.state : j && j.committedTo ? 'committed' : 'submitted');
const readJson = (storage, key) => { try { const raw = storage.getItem(key); return raw ? JSON.parse(raw) : null; } catch { return null; } };
/** WHERE A ROUND'S LOCK STANDS FOR THIS PLAYER: the kept record (its state), else the intent, else none. */
export function lockRecordOf(storage, { roundId, playerPubkey }) {
  const saved = storage ? readJson(storage, savedLockKey(roundId, playerPubkey)) : null;
  if (saved) return { state: lockStateOf(saved), record: saved, key: savedLockKey(roundId, playerPubkey) };
  const intent = storage ? readJson(storage, lockIntentKey(roundId, playerPubkey)) : null;
  if (intent) return { state: 'intent', record: intent, key: lockIntentKey(roundId, playerPubkey) };
  return { state: 'none', record: null, key: null };
}
// the state written: compare-and-set on what is kept now, never on what a caller read earlier
function stepLockRecord(storage, who, to, patch = {}, { expect = null } = {}) {
  const now = lockRecordOf(storage, who);
  if (expect && !expect.includes(now.state)) throw new Error(`the stake lock is ${now.state} here, not ${expect.join(' or ')}`);
  lockRecordStep(now.state, to);
  const next = { ...(now.record || {}), ...patch, state: to, stateMs: Date.now() };
  putRoomy(storage, savedLockKey(who.roundId, who.playerPubkey), JSON.stringify(next));
  return next;
}

/** The submission the wallet's operation log kept under `key` (2.0 lock client, kanban #2459): lockSubmit's answer, or null when it holds
 * none; undefined when the wallet cannot say (no lockSubmittedFor, no key, or it failed). */
async function lockSubmittedBy(wallet, key) {
  if (!key || !wallet || typeof wallet.lockSubmittedFor !== 'function') return undefined;
  try { const r = JSON.parse(await wallet.lockSubmittedFor(key)); return r && r.txid ? r : null; } catch { return undefined; }
}

/** An intent younger than this is another tab still asking its lock client; an older one that did not fail is a tab that closed meanwhile. */
export const LOCK_INTENT_LIVE_MS = 120000;
// what a kept record needs beyond its intent's stake: outpoints, the contract's fields, the fee lock, a few donation outputs
const LOCK_RECORD_ROOM = 2400;
// one tab at a time, never waited for: a lock another tab (or a lock client of this one that never answered) holds refuses this PLAY by name
const exclusively = (name, fn) => {
  const locks = typeof navigator !== 'undefined' && navigator ? navigator.locks : null;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request(name, { ifAvailable: true }, (held) => (held ? fn()
    : Promise.reject(new Error('another tab is locking this round\'s stake for this player right now: no second lock is made'))));
};

/**
 * THE PAGE'S LOCK, WRITTEN AHEAD (kanban #1162): one navigator lock per round and player around the steps; the intent (the stake, the net
 * amount, the refund key) written with room taken BEFORE the lock client is asked, so a browser too full to keep it spends nothing; the
 * submitted transaction's id written into it the moment it is answered; then the record (saveLock) and the acceptance stepped behind. A lock
 * made that then cannot be kept is still handed back (the entry goes out and names it), said in `kept` - never a refused join.
 */
async function keptLockStake(ask) {
  const { storage, roundId, playerPubkey, stake, federationId = null } = ask;
  if (!storage || !(roundId instanceof Uint8Array) || !(playerPubkey instanceof Uint8Array)) return lockStakeNow(ask);
  const who = { roundId, playerPubkey };
  const tag = `${toHex(roundId)}.${toHex(playerPubkey).slice(0, 16)}`;
  return exclusively(`arena.lock.${tag}`, async () => {
    const now = lockRecordOf(storage, who);
    if (['submitted', 'accepted', 'committed'].includes(now.state))
      throw new Error(`no second lock is made for this round: this player's stake lock for it is already ${now.state}`);
    const iKey = lockIntentKey(roundId, playerPubkey);
    // kanban #1946: the intent key is read whatever the saved record says - lockRecordOf answers the saved record first, so an intent a dead
    // tab left under a REFUSED record (PLAY 2 after a refused PLAY 1) was invisible and written over, its submitted transaction named nowhere
    const pending = now.state === 'intent' ? now.record : readJson(storage, iKey);
    if (pending) {
      const r = pending;
      if (!r.failed && Date.now() - Number(r.atMs || 0) < LOCK_INTENT_LIVE_MS)
        throw new Error('another tab is locking this round\'s stake for this player right now: no second lock is made');
      // A SUBMISSION NO ANSWER NAMED IS FOUND AGAIN BEFORE A NEW LOCK (kanban #2459): a tab closed after the lock client handed the
      // transaction to the guardians and before it answered left an intent with no transaction id, while the guardians accepted it; copied
      // aside blind, that stake sat under the player's refund key named nowhere and the next PLAY paid again. The wallet's operation log is
      // asked for the submission tagged with this intent (lockSubmittedFor); found, its transaction is named in the orphan copy; not there,
      // nothing was handed on. A wallet that cannot say (an older lock client, an intent written before the tag) refuses this PLAY by name -
      // never a second stake over a first one nobody can find.
      if (!r.failed && !r.txid && (r.submitting || !(Number(r.v) >= 3))) {
        const wallet = await playerWallet({ round: ask.round, invite: ask.invite, seed: ask.seed, LockClient: ask.LockClient, storage, onStep: ask.onStep || (() => {}) });
        const found = await lockSubmittedBy(wallet, r.submitTag);
        if (found === undefined)
          throw new Error('an earlier stake lock for this round was handed to the guardians from a tab that closed before it answered, and this wallet cannot find it: no second lock is made');
        if (found) {
          now.record = { ...r, txid: String(found.txid), operation: String(found.operation || ''), outputs: found.outputs || null, foundMs: Date.now() };
          try { putRoomy(storage, iKey, JSON.stringify(now.record)); } catch { /* the orphan copy below names it */ }
        }
      }
      // a tab closed while its lock client was asked: the transaction it names (if any) may hold the stake - kept aside, never written over
      if (!r.failed) {
        const o = now.record;
        try { putRoomy(storage, `arena.lock.orphan.${tag}.${Number(o.atMs || 0)}`, JSON.stringify(o)); } catch { /* the next intent is refused for room below */ }
        console.warn(`[arena] #1162 an earlier stake lock for this round did not finish (${o.txid ? `transaction ${String(o.txid).slice(0, 16)}… submitted` : 'nothing answered'}): kept as arena.lock.orphan.${tag}.*`);
      }
    }
    // A REFUSED RECORD IS KEPT ASIDE BEFORE THE NEW LOCK WRITES OVER IT (kanban #1584): 'refused' is read from a few "not stored" answers on a
    // reload (reconcileKeptLock), not from the guardians' word - their consensus may still accept that transaction later, and its stake then
    // sits under this player's refund key. Its outpoint, fields and stake stay named in arena.lock.orphan.*; with no room for that copy this
    // PLAY is refused here, before anything is spent.
    if (now.state === 'refused') {
      const r = now.record;
      putRoomy(storage, `arena.lock.orphan.${tag}.${Number(r.refusedMs || r.stateMs || Date.now())}`, JSON.stringify(r));
      console.warn(`[arena] #1584 an earlier stake lock for this round was read "not stored" (transaction ${String((r.outpoint && r.outpoint.txid) || '').slice(0, 16)}…): kept as arena.lock.orphan.${tag}.*`);
    }
    lockRecordStep(now.state, 'intent');
    // ROOM FIRST: the intent holds the record's room (`room`, given back when the record takes its place), so the record written after it
    // fits where it was; refused here, nothing is spent
    const atMs = Date.now();
    const submitTag = `arena.lock.${tag}.${atMs}`;
    putRoomy(storage, iKey, JSON.stringify({ v: 3, state: 'intent', atMs, submitTag, preimage: toHex(stake.preimage), body: toHex(stake.body || new Uint8Array(0)),
      amountMsat: String(lockAmountMsat(ask.round, ask.donationMsat || 0n)), refundPk: toHex(refundKeyOf(playerPubkey)), txid: null, room: '-'.repeat(LOCK_RECORD_ROOM) }));
    let made;
    try {
      made = await lockStakeNow({ ...ask, submitTag, onSubmitting: () => {
        // handed on from here (kanban #2459): written into the intent's own room; a browser that cannot write it submits nothing
        const r = readJson(storage, iKey);
        if (!r) throw new Error('the stake lock\'s intent is gone from this browser: nothing is submitted');
        storage.setItem(iKey, JSON.stringify({ ...r, room: '-'.repeat(LOCK_RECORD_ROOM - 50), submitting: true }));
      }, onSubmitted: (sub) => {
        // the transaction's id the moment it is answered, before anything else can happen to the tab (written into the intent's own room)
        // and its stake and fee outputs with the claim key (kanban #2460): an intent left by a closed tab is refunded from these after its expiry
        try {
          const r = readJson(storage, iKey) || {};
          const outputs = ((sub && sub.outputs) || []).filter((o) => o && (o.role === 'stake' || o.role === 'fee'))
            .map((o) => ({ role: o.role, outIdx: Number(o.out_idx), amountMsat: String(o.amount_msat), expiration: Number(o.computed_expiration) }));
          const more = { txid: String((sub && sub.txid) || ''), operation: String((sub && sub.operation) || ''), outputs, claimPk: ask.claimKey && ask.claimKey.claimPk ? toHex(ask.claimKey.claimPk) : null };
          storage.setItem(iKey, JSON.stringify({ ...r, room: '-'.repeat(Math.max(0, LOCK_RECORD_ROOM - 200 - JSON.stringify(more).length)), ...more }));
        } catch { /* the intent without it */ }
      } });
    } catch (e) {
      // nothing submitted: the intent failed, and the next PLAY writes over it; submitted and then refused by this page: it stays, for the collect
      const r = readJson(storage, iKey);
      if (r && !r.txid) { try { storage.setItem(iKey, JSON.stringify({ ...r, failed: String((e && e.message) || e).slice(0, 200) })); } catch { storage.removeItem(iKey); } }
      throw e;
    }
    let kept = true;
    // the intent gives its room to the record; a record still refused puts the intent (its transaction named) back where it was
    const intentNow = storage.getItem(iKey);
    storage.removeItem(iKey);
    try {
      saveLock(storage, { ...who, stake, lock: made, federationId, state: made.accepted ? 'submitted' : 'accepted' });
    } catch (e) {
      kept = false;
      try { if (intentNow) storage.setItem(iKey, intentNow); } catch { /* nothing left to write it to */ }
      console.error(`[arena] #1162 the stake lock is made and could not be kept in this browser (${e && e.message}): the entry still names it; the intent keeps its transaction`);
    }
    if (made.accepted && kept) {
      made.accepted.then(() => { try { stepLockRecord(storage, who, 'accepted', { acceptedMs: Date.now() }, { expect: ['submitted'] }); } catch { /* committed already */ } }, () => {
        // the lock client's refusal is its word only; the record stays submitted and the next load reads the federation (reconcileKeptLock)
      });
    }
    return Object.assign(made, { kept });
  });
}

/**
 * A LOCK THIS TAB MADE, WITH THE STAKE IT LOCKS - kept so a reload before any
 * signer node has committed it uses the same stake and the same lock. The stake's
 * preimage is kept where the player's seed already is (the tab's storage), and
 * its handout as the bytes the signer nodes took. `state` (kanban #1162): submitted while the guardians' acceptance is still to come.
 */
export function saveLock(storage, { roundId, playerPubkey, stake, lock, federationId = null, state = 'accepted' }) {
  const lockMsat = BigInt(lock.fields && lock.fields.amountMsat ? lock.fields.amountMsat : 0n)
    + BigInt(lock.feeLock && lock.feeLock.fields && lock.feeLock.fields.amountMsat ? lock.feeLock.fields.amountMsat : 0n);
  const was = lockRecordOf(storage, { roundId, playerPubkey }).state;
  // a new lock takes the place of none or of a refused one; a kept lock is never written over by another
  lockRecordStep(was === 'none' || was === 'refused' ? 'intent' : was, state);
  // THE RECORD FIRST, WITH ROOM (kanban #1162: a raw write the browser refused lost a lock already made); the history after it
  putRoomy(storage, savedLockKey(roundId, playerPubkey), JSON.stringify({
    v: 2, state, stateMs: Date.now(),
    preimage: toHex(stake.preimage), body: toHex(stake.body),
    outpoint: { txid: toHex(lock.outpoint.txid), outIdx: String(lock.outpoint.outIdx) },
    fields: lockFieldsToJson(lock.fields), committedTo: null, entry: null,
    // AND ITS FEE LOCK, when one was minted (Pick b): the same reload keeps it.
    feeLock: lock.feeLock ? { preimage: toHex(lock.feeLock.preimage),
      outpoint: { txid: toHex(lock.feeLock.outpoint.txid), outIdx: String(lock.feeLock.outpoint.outIdx) },
      fields: lockFieldsToJson(lock.feeLock.fields) } : null,
    // AND ITS DONATION OUTPUTS (2026-10-03): the entry names them, so a reload names the same
    donations: (lock.donations || []).map((d) => ({ txid: toHex(d.txid), outIdx: String(d.outIdx), recipientPk: toHex(d.recipientPk), amountMsat: String(d.amountMsat) })),
  }));
  if (federationId) ledgerAppend(storage, federationId, { kind: 'stake', round: toHex(roundId), player: toHex(playerPubkey).slice(0, 16),
    entry: null, msat: String(lockMsat) });
  // THE DONATION IN THE WALLET'S HISTORY, paid with the stake
  const donated = (lock.donations || []).reduce((t, d) => t + BigInt(d.amountMsat), 0n);
  if (federationId && donated > 0n) ledgerAppend(storage, federationId, { kind: 'donation', msat: String(donated), round: toHex(roundId) });
}

/** The kept lock for this round and player, rebuilt - or null. `committedTo` names the entry a signer node committed it to; `state` where it stands. */
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
    state: lockStateOf(j), entry: j.entry || j.committedTo || null,
  };
}

/**
 * A KEPT LOCK STILL SUBMITTED, READ WHERE THE GUARDIANS HOLD IT (kanban #1162): stored at its outpoint - accepted, and reused; stored nowhere
 * in `tries` reads `waitMs` apart - refused, and the next PLAY locks anew (a refused lock holds nothing). A read that fails leaves it submitted
 * and throws: a lock that may exist is neither reused nor locked over. Answers the kept lock as savedLock rebuilds it.
 */
export async function reconcileKeptLock(storage, { roundId, playerPubkey, client, tries = 3, waitMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const who = { roundId, playerPubkey };
  const kept = savedLock(storage, who);
  if (!kept || kept.state !== 'submitted') return kept;
  const txid = toHex(kept.lock.outpoint.txid), outIdx = Number(kept.lock.outpoint.outIdx);
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(waitMs);
    const st = JSON.parse(await client.lockStatus(txid, outIdx));
    if (st && st.stored) {
      stepLockRecord(storage, who, 'accepted', { acceptedMs: Date.now(), readFrom: 'lockStatus' }, { expect: ['submitted'] });
      return savedLock(storage, who);
    }
  }
  stepLockRecord(storage, who, 'refused', { refusedMs: Date.now(), readFrom: 'lockStatus' }, { expect: ['submitted'] });
  return savedLock(storage, who);
}

/**
 * WHAT A TAB DOES WITH THE LOCK IT KEPT FOR THIS ROUND, ON A RELOAD (6d, W4 hole 1). None:
 * a new join. One no signer node committed: the same stake and lock, no second deposit (W1b).
 * One a signer node COMMITTED to an entry: that signer node is taken and its stake is locked - measured
 * before: the page dealt a new stake and set out to fund "980000 + 20000 msat of lock",
 * a second deposit for a round the player already stakes. A tab that kept the very entry the lock is committed to
 * plays it again (before the start) or resumes it (until the close); otherwise the join stops, says why, and the
 * payout and stake are still collected from the tab's kept record.
 * BY ITS STATE (kanban #1162): refused - a new join (it holds nothing); submitted - 'check' (reconcileKeptLock) before anything else; named
 * in an entry (bindLockEntry) - only that entry, never another.
 */
export function keptLockUse(kept, { entry = null, beforeStart = false, beforeClose = false } = {}) {
  if (!kept) return { use: 'new' };
  if (kept.state === 'refused') return { use: 'new', refused: true };
  if (kept.state === 'submitted') return { use: 'check', kept };
  let keptId = null;
  // entryId by its own name: the bundle strips imports, and an "as" alias is undefined there (measured: 0.0.2491 refused)
  try { keptId = entry ? toHex(entryId(entry)) : null; } catch { keptId = null; }
  // NAMED IN AN ENTRY, NOT YET COMMITTED (kanban #1162): the seats that took that entry refuse the lock under any other ("one lock is one entry")
  if (!kept.committedTo && kept.entry && keptId !== String(kept.entry)) return { use: 'staked', kept,
    why: `this tab's stake in this round is already locked and named in entry ${String(kept.entry).slice(0, 16)}…: no second deposit - `
      + 'another entry cannot use it, and its stake comes back after the window' };
  if (!kept.committedTo) return { use: 'reuse', kept };
  // UNLESS THE TAB KEPT THAT VERY ENTRY AND THE ROUND HAS NOT STARTED (measured 2026-10-03 13:58:51Z on 0.0.2490: a reload
  // 10 s into a chained join, 84 s before its round's start, refused here - the lock was committed and the kept entry and
  // session key (PAID-NIGHT-2155) were never reached). Before the start there is no run to lose: the same entry is sent
  // again, the seats take it as the one they hold, and the run is played from its start.
  if (beforeStart && keptId && keptId === String(kept.committedTo)) return { use: 'reuse', kept, resumed: true };
  // AND AFTER THE START, UNTIL THE ROUND CLOSES (2026-10-03: "a reload after the round has started ... That run must
  // not be lost"): the same entry, lock and session key, and the run is RESUMED from what the seats hold of it (the bridge
  // replays the transcript and goes on from the adopted mark - blwp.jslib ARENA_RESUME). After the close only the collect.
  if (!beforeStart && beforeClose && keptId && keptId === String(kept.committedTo)) return { use: 'reuse', kept, resumed: 'running' };
  return { use: 'staked', kept,
    why: `this tab's stake in this round is already locked and committed to entry ${String(kept.committedTo).slice(0, 16)}…: `
      + 'no second deposit - the run cannot be resumed after a reload, and its payout and stake are collected after the window' };
}

/**
 * THE ENTRY A KEPT LOCK IS NAMED IN, WRITTEN BEFORE THAT ENTRY GOES OUT (kanban #1162): once - the same entry again is fine, another one
 * throws, and the entry is then not sent with it. Nothing kept (a tab that could not keep its lock): nothing to check, false.
 */
export function bindLockEntry(storage, { roundId, playerPubkey, entryId: eid }) {
  const now = lockRecordOf(storage, { roundId, playerPubkey });
  if (now.state === 'none' || now.state === 'intent') return false;
  const id = toHex(eid);
  const named = now.record.entry || now.record.committedTo || null;
  if (named && named !== id) throw new Error(`this stake lock is named in entry ${named.slice(0, 16)}…, and one lock is one entry: entry ${id.slice(0, 16)}… is not sent with it`);
  if (now.state === 'refused') throw new Error('this stake lock was refused by the guardians: no entry is sent with it');
  if (named === id) return true;
  putRoomy(storage, now.key, JSON.stringify({ ...now.record, entry: id }));
  return true;
}

/**
 * AN ENTRY NO SEAT TOOK DOES NOT HOLD THE LOCK FOR GOOD (kanban #1254, audit 3 FIXES-13): bindLockEntry names the entry before it is posted, and a post that
 * failed (a seat 503, the round full, offline) left the lock "staked" in an entry no seat holds - a new tab, which has no copy of that entry, could never
 * use it again. `locks` is findLock's answer for this seed in the round: when every seat asked answered and none names the kept lock under the entry,
 * the entry is let go of (never one a seat committed to). Answers true when it was.
 */
export function releaseUntakenEntry(storage, { roundId, playerPubkey, locks }) {
  const now = lockRecordOf(storage, { roundId, playerPubkey });
  if (now.state === 'none' || now.state === 'intent' || now.record.committedTo || !now.record.entry) return false;
  if (!locks || !(locks.asked > 0) || locks.answered !== locks.asked) return false;
  const at = now.record.outpoint ? `${String(now.record.outpoint.txid)}:${String(now.record.outpoint.outIdx)}` : null;
  const named = (locks || []).some((l) => String(l.entryId || '').toLowerCase() === String(now.record.entry).toLowerCase()
    || (at && l.outpoint && `${toHex(l.outpoint.txid)}:${String(l.outpoint.outIdx)}` === at));
  if (named) return false;
  const { entry: _gone, ...rest } = now.record;
  putRoomy(storage, now.key, JSON.stringify(rest));
  return true;
}

/** A signer node committed the kept lock to `entryId`: from now on it is that entry's stake, not one to reuse. Final: never another entry. */
export function markLockCommitted(storage, { roundId, playerPubkey, entryId }) {
  const who = { roundId, playerPubkey };
  const now = lockRecordOf(storage, who);
  if (now.state === 'none' || now.state === 'intent') return;
  const id = toHex(entryId);
  const named = now.state === 'committed' ? now.record.committedTo : now.record.entry;
  if (named && named !== id) { console.error(`[arena] #1162 the stake lock is ${now.state === 'committed' ? 'committed to' : 'named in'} entry ${String(named).slice(0, 16)}…; a commit to ${id.slice(0, 16)}… is not written`); return; }
  if (now.state === 'committed') return;
  try { stepLockRecord(storage, who, 'committed', { committedTo: id, entry: id }); } catch (e) { console.error(`[arena] #1162 ${e.message}`); return; }
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
// (kanban #1531) a player has one stake lock in a round, a few versions of it at most (kanban #1273): what one seat's answer and all of them may name
export const LOCKS_PER_SEAT = 8;
export const LOCKS_FOUND_MAX = 64;
// ONE SEAT, ONE ENTRY (kanban #1876, #1531 skeptic 2, #1489): the node list's spellings of one seat ("http://evil", "http://evil/",
// "http://EVIL//") were asked and counted as that many seats. The fetch base: the origin (URL lower-cases the host, drops a default
// port) and the path with repeated and trailing slashes folded; the origin is what the per-host budget counts
const seatBaseOf = (node) => {
  const s = String(node);
  try {
    const u = new URL(s);
    if (/^https?:$/.test(u.protocol) && !u.search && !u.hash && !u.username && !u.password)
      return { base: (u.origin + u.pathname.replace(/\/{2,}/g, '/')).replace(/\/+$/, ''), origin: u.origin };
  } catch { /* not a URL: its own spelling */ }
  const base = s.replace(/\/+$/, '');
  // THE BUDGET IS WHERE THE FETCH GOES, NEVER A RAW SPELLING (kanban #2013, #1876, #1531 skeptic 3, #1489): a spelling with a fragment,
  // a query or a user ("http://evil#1" ... "http://evil#63", "http://evil?x", "http://u@evil") was not folded above and fell back to
  // its raw string as its "origin" - 64 of them took 64 budgets, though fetch asks the one seat http://evil for every one, and the
  // made-up locks they named outranked the honest seats' real lock. The origin is the one of the URL actually requested (resolved
  // against the page as fetch does); a spelling with no such origin (not a URL, data:, ...) names no lock that counts
  let origin;
  try { origin = new URL(`${base}/stake-lock`, globalThis.location && globalThis.location.href || undefined).origin; } catch { origin = undefined; }
  return { base, origin: origin && origin !== 'null' ? origin : undefined };
};
export async function findLock({ roundId, playerPubkey, nodes, fetcher = fetch } = {}) {
  const refund = toHex(refundKeyOf(playerPubkey));
  // WHO ANSWERED: the list carries how many signer nodes were asked, answered and named a lock, and each
  // one's reply in short - an empty list nobody answered is not "no lock".
  const asked = [];
  { const seen = new Set();
    for (const node of nodes || []) { const at = seatBaseOf(node); if (!seen.has(at.base)) { seen.add(at.base); asked.push({ node, ...at }); } } }
  // EVERY SIGNER NODE AT ONCE (kanban #593: one after another, 35 nodes and dead ones among them, a look took minutes and the
  // collect never reached the round owed): the answers in the nodes' order
  const answers = await Promise.all(asked.map(async ({ node, base, origin }) => {
    const name = String(node).replace(/^https?:\/\//, '').slice(0, 40);
    try {
      const r = await fetcher(`${base}/stake-lock?round=${toHex(roundId)}&refund=${refund}`, { signal: AbortSignal.timeout(SEAT_READ_MS) });
      if (!r.ok) return { said: `${name} ${r.status}`, got: [] };
      const raw = await r.json();
      // ONE SEAT'S MALFORMED ANSWER STAYS ITS OWN (kanban #1489, audit WF1489 CLIENT-1): `{}` or `[null]` from one seat threw for the
      // whole look, outside this try, and every honest seat's lock was dropped - no payout, stake or refund collected while it answered so.
      // A seat's answer must be a list; an item that is not a lock (an object, a txid:index outpoint, fields the lock client reads) is skipped
      if (!Array.isArray(raw)) return { said: `${name} malformed`, got: [] };
      const got = [];
      for (const l of raw) {
        // EVERY FIELD USED LATER IS CHECKED HERE, IN THIS SEAT'S OWN TRY (kanban #1671, refute of #1489 CLIENT-1): an outpoint or entryId
        // String() cannot convert ({"toString":0,"valueOf":0}) threw in the merge key below, outside any try, and dropped every honest
        // seat's lock. The outpoint must be text, the entryId absent or text; the merge key is built here from the checked values
        if (!l || typeof l !== 'object' || typeof l.outpoint !== 'string' || !/^[0-9a-f]{64}:\d+$/.test(l.outpoint)) continue;
        if (l.entryId !== undefined && l.entryId !== null && typeof l.entryId !== 'string') continue;
        const [txid, outIdx] = l.outpoint.split(':');
        let lock, key;
        try {
          lock = { outpoint: { txid: fromHex(txid), outIdx: BigInt(outIdx) }, fields: lockFieldsFromJson(l.fields), entryId: l.entryId };
          key = `${l.outpoint}|${JSON.stringify(l.fields)}|${(l.entryId || '').toLowerCase()}`;
        } catch { continue; }
        got.push({ key, lock });
        if (got.length >= LOCKS_PER_SEAT) break;   // kanban #1531: no more of one seat's answer counts
      }
      return { said: `${name} ${got.length}`, got, node, base, origin };
    } catch (e) { return { said: `${name} ${String(e && e.message || e).slice(0, 40)}`, got: [] }; }
  }));
  const said = answers.map((a) => a.said);
  // WHAT ONE SEAT CAN ADD IS BOUNDED (kanban #1531, audit #1489 r2 client-3): one seat answered thousands of made-up locks under the
  // player's refund key, every one was kept, and the collect asked each a forfeit of every seat in turn (redeemStake) or a lockStatus of
  // the federation (heldByGuardians) - hours of requests. A seat's first LOCKS_PER_SEAT entries count, taken round-robin over the seats
  // (each seat's first lock before any seat's second), and the whole list stops at LOCKS_FOUND_MAX
  // EVERY SEAT'S VERSION OF AN OUTPOINT, NOT ONLY THE FIRST (kanban #1273, audit 4 #1257 seats-5): one seat listed first answered the real
  // outpoint with a field changed (or a made-up entry id), and the honest copies were dropped - the stake read "gone" for good, or waited for
  // its expiry. Each distinct version is kept; the federation's stored contract (heldByGuardians) and the forfeit check pick the real one
  // (kanban #1671) each version's key is built inside its seat's own try above: nothing here can throw for the whole look
  // THE BUDGET IS THE HOST'S, NOT THE LIST ENTRY'S (kanban #1876, #1531 skeptic 2): one operator behind one host named 64 path-prefixed
  // "seats" (or one seat under 64 spellings) ahead of the honest seats, each took a round-robin slot, and LOCKS_FOUND_MAX cut the player's
  // real lock off the list - redeemStake and refundStake then worked only on made-up locks. All the seats of one origin now share one
  // LOCKS_PER_SEAT budget of distinct locks (taken round-robin over that origin's seats)
  const byOrigin = new Map();
  for (const a of answers) if (Array.isArray(a.got) && a.got.length && a.origin !== undefined) {
    if (!byOrigin.has(a.origin)) byOrigin.set(a.origin, []);
    byOrigin.get(a.origin).push(a);
  }
  const named = new Map();   // key -> { lock, origins, seats, rank }
  const perOrigin = [];
  for (const [origin, seats] of byOrigin) {
    const keys = [];
    for (let i = 0; i < LOCKS_PER_SEAT; i++) for (const a of seats) {
      if (i >= a.got.length) continue;
      const { key, lock } = a.got[i];
      if (!keys.includes(key)) { if (keys.length >= LOCKS_PER_SEAT) continue; keys.push(key); }
      if (!named.has(key)) named.set(key, { lock, origins: new Set(), seats: new Set(), rank: Infinity });
      named.get(key).origins.add(origin); named.get(key).seats.add(a.base);
    }
    perOrigin.push(keys);
  }
  // each origin's first lock before any origin's second (kanban #1531)
  let rank = 0;
  for (let i = 0; i < LOCKS_PER_SEAT; i++) for (const keys of perOrigin) if (i < keys.length && named.get(keys[i]).rank === Infinity) named.get(keys[i]).rank = rank++;
  // A LOCK SEVERAL HOSTS AGREE ON IS NOT CUT FOR ONE HOST'S INVENTIONS (kanban #1876): the locks most distinct origins name come first
  // (then most distinct seats, then the round-robin order), and only then does the list stop at LOCKS_FOUND_MAX. To push out a lock k
  // origins name, made-up locks would need more than k origins each on all 64 slots - more than 8k hosts of the round's own node list
  const ranked = [...named.values()].sort((x, y) => (y.origins.size - x.origins.size) || (y.seats.size - x.seats.size) || (x.rank - y.rank));
  const out = ranked.slice(0, LOCKS_FOUND_MAX).map((x) => x.lock);
  out.asked = asked.length;
  out.answered = said.filter((x) => /\s\d+$/.test(x) && !/\s[45]\d\d$/.test(x)).length;
  out.said = said;
  // WHICH SEATS ANSWERED (kanban #1355, audit 4 fixesB-6 / CLIENT-5): a "none" counts only the round's own seats' answers
  out.answeredBy = answers.filter((a) => a.node !== undefined).map((a) => String(a.node).replace(/\/+$/, ''));
  return out;
}

// (kanban #1163) the stock lock's read; the 1.9 line has no Arena lock
const lockStatusOf = (client, fields, txid, outIdx) => client.lockStatus(txid, outIdx);
// the contract id the guardians hold at a lock's outpoint (a forfeit's message, kanban #1163), or null when no wallet can ask
async function storedIdAt(client, l) {
  if (!client || !l || !l.outpoint) return null;
  try { const st = JSON.parse(await lockStatusOf(client, l.fields, toHex(l.outpoint.txid), Number(l.outpoint.outIdx))); return st && st.stored ? String(st.stored.contract_id || '') : null; } catch { return null; }
}
// a stock lock's contract id computed by the lock client's own code (its static outgoingContractId), when the lock client has it
const contractIdVia = (LockClient) => (LockClient && typeof LockClient.outgoingContractId === 'function'
  ? (f) => LockClient.outgoingContractId(JSON.stringify(lockFieldsToJson(f))) : null);
// THE LOCKS THE GUARDIANS HOLD, OF THE ONES THE SEATS NAME (kanban #1238, audit 2 CLIENT-1): findLock is the union of every seat's answer,
// and one seat's invented lock (its own claim key, a made-up outpoint) was forfeited in place of the real one - the stake read "owed by
// forfeit" for good and its expiry refund was never asked. A named lock counts only when the federation holds it at its outpoint under the
// id its fields compute (when the lock client can compute one). Without a wallet nothing can be asked: the list stands as named.
async function heldByGuardians(client, locks, contractIdOf = null) {
  if (!client) return [...(locks || [])];
  const out = [];
  for (const l of locks || []) {
    if (!l || !l.outpoint || !l.fields) continue;
    // a wallet with no read of a lock's status cannot be asked: the lock stands as named, as with no wallet
    if (typeof (client.lockStatus) !== 'function') { out.push(l); continue; }
    let st; try { st = JSON.parse(await lockStatusOf(client, l.fields, toHex(l.outpoint.txid), Number(l.outpoint.outIdx))); } catch { continue; }
    if (!st || !st.stored) continue;
    if (typeof contractIdOf === 'function') {
      let c = null; try { c = String(contractIdOf(l.fields) || '').toLowerCase(); } catch { c = null; }
      const stored = String(st.stored.contract_id || '').toLowerCase();
      if (/^[0-9a-f]{64}$/.test(c) && /^[0-9a-f]{64}$/.test(stored) && c !== stored) continue;
    }
    out.push(l);
  }
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
  // ONLY THE VERSIONS THE FEDERATION HOLDS (kanban #1273): findLock keeps every seat's version of an outpoint; a changed one is not refunded
  // (asked only when two seats named one outpoint differently: one version per outpoint is refunded as before, no status read added)
  let held = locks;
  const at = (l) => `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`;
  if (new Set(locks.map(at)).size < locks.length) { try { const h = await heldByGuardians(client, locks, contractIdVia(LockClient)); if (h.length) held = h; } catch { held = locks; } }
  const refunds = [];
  for (const l of held) {
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
// `check` (kanban #1163, forfeitCheck): an answer whose signature does not verify here is no forfeit - the next signer node is asked
export async function forfeitOf({ roundId, entryId, nodes, fetcher = fetch, lock = 'stake', check = null } = {}) {
  const refused = [];
  const verified = async (j) => { if (typeof check !== 'function') return true; const v = await check(j); return v !== false; };
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/forfeit?round=${toHex(roundId)}&entry=${entryId}${lock === 'fee' ? '&lock=fee' : ''}`, { signal: AbortSignal.timeout(SEAT_READ_MS) });
      if (!r.ok) { refused.push(`${node}: ${r.status} ${(await r.text()).trim()}`); continue; }
      const j = await r.json();
      if (!/^[0-9a-f]{128}$/.test(String(j.signature))) { refused.push(`${node}: answered no signature`); continue; }
      if (!(await verified(j))) { refused.push(`${node}: its forfeit's signature does not verify`); continue; }
      return { ok: true, signature: j.signature, contractId: j.contractId, claimPk: j.claimPk, from: node };
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
  const named = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher });
  if (!named.length) throw new Error('no signer node knows a stake lock that refunds to this seed\'s key in this round');
  // EVERY NAMED LOCK'S FORFEIT FIRST, nothing asked of the lock client when none is given (a loser's page); then only the locks the federation
  // holds are redeemed, each with its forfeit checked again against the id stored at its outpoint (kanban #1238: one seat's invented lock,
  // listed first and forfeited by that seat, stood in for the real one and the real one's refused forfeit threw for ever)
  const asked = [];
  for (const l of named) {
    onStep('asking the signer nodes for the forfeit of the lock');
    asked.push({ lock: l, forfeit: await forfeitOf({ roundId, entryId: l.entryId, nodes, fetcher,
      check: forfeitCheck({ curve, fields: l.fields, contractIdOf: contractIdVia(LockClient) }) }) });
  }
  if (!asked.some((a) => a.forfeit.ok)) throw new Error(asked[0].forfeit.why);
  const secret = lockSecretFor(seed, roundId);
  const store = storage ? lockStoreFor(storage, roundId, secret) : unkeptLockStore();
  // THE WALLET THE PAYOUT WAS JUST COLLECTED INTO, when there is one (6d): one client over the tab's store, not a second opened beside it
  if (!given) onStep('joining the federation');
  const client = given || await LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
  const cid = contractIdVia(LockClient || (client && client.constructor));
  const locks = await heldByGuardians(client, named, cid);
  if (!locks.length) throw new Error('the federation holds none of the locks the signer nodes name for this seed in this round');
  // EACH OUTPOINT ONCE, BY ANY OF ITS VERSIONS WHOSE FORFEIT STANDS (kanban #2029, #2056; as lookOwed and refusedReturn do, #1273): a seat
  // lists a refused round's lone lock under its handout's id and under its own id, and two seats may name it by different ids - one
  // version's refused forfeit (an alias that names another lock at one seat) never throws while another version's forfeit stands,
  // and the lock is redeemed once, never once per version
  const forfeits = [];
  const atOf = (l) => `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`;
  const bad = new Map();
  for (const l of locks) {
    const k = atOf(l);
    if (forfeits.some((x) => atOf(x.lock) === k)) continue;
    const a = asked.find((x) => x.lock === l);
    if (!a.forfeit.ok) { if (!bad.has(k)) bad.set(k, a.forfeit.why); continue; }
    const check = forfeitCheck({ curve, fields: l.fields, storedId: await storedIdAt(client, l), contractIdOf: cid });
    if (check && check(a.forfeit) === false) { if (!bad.has(k)) bad.set(k, 'the forfeit given for this lock does not verify against the contract the federation holds at its outpoint'); continue; }
    forfeits.push({ lock: l, forfeit: a.forfeit });
  }
  for (const l of locks) if (!forfeits.some((x) => atOf(x.lock) === atOf(l))) throw new Error(bad.get(atOf(l)));
  // AND THE ORDER'S FEE LOCK (measured 2026-10-11 by the bots on the regtest Up/Down market: an order the book
  // never filled came back without its 1 % - 54,450 of 55,000 msat, 55,440 of 56,000 - because only stake locks were ever
  // looked up). The tab's own record of it (this order's saved lock, under its own key); the seats give its forfeit only
  // when the order was not filled (or was cancelled, or the market refunded) - a fee they claim at resolution is refused,
  // and left alone.
  const kept = storage ? savedLock(storage, { roundId, playerPubkey: player.pubkey }) : null;
  const fee = kept && kept.lock && kept.lock.feeLock;
  // the fee lock's forfeit asked under the entry of a stake version whose own forfeit verified (kanban #1872): never a stranger's made-up entryId
  const feeEntry = forfeits.map((x) => x.lock).find((l) => l.entryId) || null;
  if (fee && feeEntry) {
    onStep('asking the signer nodes for the forfeit of the fee lock');
    const f = await forfeitOf({ roundId, entryId: feeEntry.entryId, nodes, fetcher, lock: 'fee',
      check: forfeitCheck({ curve, fields: fee.fields, contractIdOf: contractIdVia(LockClient) }) });
    if (f.ok) forfeits.push({ lock: { outpoint: fee.outpoint, fields: fee.fields, entryId: feeEntry.entryId, fee: true }, forfeit: f });
  }
  // (the wallet the payout was just collected into, when there is one (6d): one client over the tab's store, not a second opened beside it)
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
 * THE ROUND'S SETTLEMENT AS THE SIGNER NODES HOLD IT (GET /lock-settlement, W4): the
 * settlement the guardians ACCEPTED - its txid and what it moved. The
 * guardians check every payout again when it is spent, so a signer node that lies here
 * points at nothing this key can take.
 * ONE SEAT'S WORD NEVER FINALISES IT (kanban #1163): `needed` seats must answer the same txid and the same payouts for the answer to say
 * who is paid (`agreeing`); short of that, an answer that pays `payee` is still handed back (`short`: the federation checks it at the spend),
 * and one that pays it nothing is no answer - a seat omitting the player made the payout "none" and the round final. When `needed` seats
 * agree, their settlement is the answer, whatever a lone seat says.
 */
// a settlement's payout list as the page reads it (kanban #1489): each an object with a string pk and an integer msat
// (kanban #1671) and a kind that is text or absent, and an msat that is text or a number: nothing String() could throw on is kept
const wellFormedPayouts = (payouts) => Array.isArray(payouts) && payouts.every((p) => p && typeof p === 'object'
  && typeof p.pk === 'string' && (p.kind === undefined || p.kind === null || typeof p.kind === 'string')
  && (typeof p.msat === 'string' || typeof p.msat === 'number') && /^\d+$/.test(String(p.msat)));
// a settlement's txid as the page reads it (kanban #1671): 64 hex characters, or the answer is not counted
const wellFormedTxid = (txid) => typeof txid === 'string' && /^[0-9a-f]{64}$/i.test(txid);
// A SEAT'S PAYOUTS AS THE PAGE READS THEM (kanban #2014, refute #3 of #1489 CLIENT-1): the same values the settlement's group key is
// built from - an absent kind is 'qualifier', the pk lower case, the msat text. A group answers with its first member's copy; a seat
// listed first that left the kinds out joined the honest group under the same key and its copy made the winner's payout "none" (final).
// Every consumer reads this normalised copy, so whichever member stands for the group reads the same.
const payoutKind = (p) => p.kind || 'qualifier';
const normalPayouts = (payouts) => payouts.map((p) => ({ ...p, kind: payoutKind(p), pk: p.pk.toLowerCase(), msat: String(p.msat) }));
// the player's payout in a settlement (kanban #2014): its kind read as the group key reads it
const isQualifierTo = (p, pk) => payoutKind(p) === 'qualifier' && String(p.pk).toLowerCase() === String(pk).toLowerCase();
export async function settlementOf({ roundId, nodes, fetcher = fetch, needed = 1, payee = null } = {}) {
  // EVERY SIGNER NODE AT ONCE (kanban #593)
  const answers = await Promise.all([...new Set(nodes || [])].map(async (node) => {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock-settlement?round=${toHex(roundId)}`, { signal: AbortSignal.timeout(SEAT_READ_MS) });
      if (!r.ok) return { said: `${node}: ${r.status}` };
      const j = await r.json();
      if (j && j.state === 'ACCEPTED' && j.moved && Array.isArray(j.moved.payouts)) {
        // EVERY PAYOUT WELL FORMED, OR THE ANSWER IS NOT COUNTED (kanban #1489, audit WF1489 CLIENT-1): a `null` payout threw in keyOf for
        // every seat's answer, and the honest seats' agreeing settlement was lost with it
        if (!wellFormedPayouts(j.moved.payouts)) return { said: `${node}: malformed` };
        // A TXID THAT IS NOT TEXT IS THIS SEAT'S OWN MALFORMED ANSWER (kanban #1671, refute of #1489 CLIENT-1): `{"toString":0}` threw in
        // keyOf below, outside this try, for every seat's answer. The settlement's key is built here, inside this seat's try
        if (!wellFormedTxid(j.txid)) return { said: `${node}: malformed` };
        // (kanban #2014) normalised here, in this seat's try: the answer kept is the key's own values
        const payouts = normalPayouts(j.moved.payouts), txid = j.txid.toLowerCase();
        const key = `${txid}|${JSON.stringify(payouts.map((p) => [p.kind, p.pk, p.msat]))}`;
        return { ok: true, txid, moved: { ...j.moved, payouts }, from: node, key };
      }
      return { said: `${node}: ${j && typeof j.state === 'string' ? j.state : 'malformed'}` };
    } catch (e) { return { said: `${node}: ${e.message}` }; }
  }));
  const accepted = answers.filter((a) => a.ok);
  // the same settlement: its txid and its payouts in their order (an output's index is its place in the list)
  // (kanban #1671) each answer's key was built in its own seat's try
  const groups = new Map();
  for (const a of accepted) { const k = a.key; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  const ranked = [...groups.values()].sort((x, y) => y.length - x.length);
  const need = Math.max(1, Number(needed) || 1);
  const pays = (a) => !!payee && a.moved.payouts.some((p) => isQualifierTo(p, payee));
  const agreed = ranked.find((g) => g.length >= need) || null;
  // `seats`: the seats that answered this settlement (kanban #1355): the round's own, whose word a stake's "none" may rest on
  const seatsOf = (g) => g.map((a) => String(a.from).replace(/\/+$/, ''));
  if (agreed) return { ...agreed[0], agreeing: agreed.length, needed: need, seats: seatsOf(agreed) };
  const paying = ranked.find((g) => g.some(pays));
  if (paying) return { ...paying[0], agreeing: paying.length, needed: need, short: true, seats: seatsOf(paying) };
  const said = answers.filter((a) => !a.ok).map((a) => a.said);
  if (ranked.length) return { ok: false, agreeing: ranked[0].length, needed: need,
    why: `only ${ranked[0].length} of the ${need} signer nodes needed agree on this round's settlement yet${said.length ? ` (${said.join('; ')})` : ''}` };
  return { ok: false, agreeing: 0, needed: need, why: `no signer node holds an accepted settlement of this round yet (${said.join('; ')})` };
}
/** HOW MANY SEATS MUST AGREE ON A ROUND'S SETTLEMENT (kanban #1163): its settlement threshold, never more than the seats asked. */
export const settlementAgreement = (round, nodes = []) => {
  let t = 1; try { t = sharesNeededFor(round); } catch { t = 1; }
  return Math.max(1, Math.min(Number(t) || 1, new Set(nodes || []).size || 1));
};

/**
 * A FORFEIT IS BELIEVED ONLY WHEN IT VERIFIES HERE (kanban #1163, the 1.9 line: stock locks only: the first 128-hex answer was taken - a fake signature made the stake "owed
 * by forfeit", the redeem failed, it was tried for ever and the expiry refund was never reached). The message is the lock's contract id: an
 * Arena lock's computed here from its fields (and refused when the guardians hold another id at its outpoint), a stock lock's the id the
 * guardians hold there (`storedId`, or `contractIdOf(fields)`); the key the claim key - a stock lock's claim_pk, an Arena lock's BIP-327 KeyAgg
 * of the named signers' keys (each 02 || x, index order). Answers check(answer) -> true | false, or null when nothing can be checked here
 * (no curve, no id): then the lock client's own check at the spend is all there is.
 */
export function forfeitCheck({ curve, fields, storedId = null, contractIdOf = null } = {}) {
  if (!curve || typeof curve.verify !== 'function' || !fields) return null;
  const stored = /^[0-9a-f]{64}$/i.test(String(storedId || '')) ? String(storedId).toLowerCase() : null;
  return (j) => {
    let sig; try { sig = fromHex(String(j.signature)); } catch { return false; }
    if (sig.length !== 64) return false;
    let id = stored ? fromHex(stored) : null;
    if (!id && typeof contractIdOf === 'function') { try { const c = String(contractIdOf(fields)); if (/^[0-9a-f]{64}$/i.test(c)) id = fromHex(c); } catch { id = null; } }
    if (!id || !(fields.claimPk instanceof Uint8Array) || fields.claimPk.length !== 33) return null;
    return !!curve.verify(sig, id, fields.claimPk.slice(1));
  };
}
const concatBytes = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };

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
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const mine = toHex(refundKeyOf(player.pubkey));
  const noted = noteKeyOf(PAYOUT_NOTE, roundId, mine, order);
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) return { ...JSON.parse(kept), amountMsat: BigInt(JSON.parse(kept).amountMsat), ok: true, final: true, kept: true };
  } catch { /* an unreadable note is no note */ }
  onStep('asking the signer nodes for the round\'s settlement');
  const s = await settlementOf({ roundId, nodes, fetcher, needed: settlementAgreement(round, nodes), payee: mine });
  if (!s.ok) return { ok: false, final: false, why: s.why };
  const at = s.moved.payouts.findIndex((p) => isQualifierTo(p, mine));
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
// A NOTE IS THE PHRASE'S (kanban #1220, audit 3 #1210 PAGE-1): keyed by round and order only, a second phrase of this browser in the same round
// (two tabs are two players) read the first phrase's note as its own - its payout and stake "collected", its record closed while both stayed
// in their contracts. Now every note names the phrase's refund key too; a note of the old shape is not read (a phrase that did collect is
// told so by the federation: already spent, only its key could).
const noteKeyOf = (prefix, roundId, mineHex, order, extra = '') => `${prefix}${toHex(roundId)}.${String(mineHex).slice(0, 16)}${extra}${orderTag(order)}`;

/**
 * A ROUND THAT TAKES ANY FEDERATION'S SETTLEMENTS (2026.0.3 step 7): one transaction per federation, listed by the
 * seats' /lock-settlement as `federations` [{ federation, state, txid, moved: { payouts } }]. The first node that holds them all
 * ACCEPTED answers; else why not.
 */
export async function federationSettlementsOf({ roundId, nodes, fetcher = fetch } = {}) {
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock-settlement?round=${toHex(roundId)}`, { signal: AbortSignal.timeout(SEAT_READ_MS) });
      if (!r.ok) { said.push(`${node}: ${r.status}`); continue; }
      const j = await r.json();
      // (kanban #1489) a null federation or payout is a malformed answer, not a throw: the next seat is asked
      if (j && j.state === 'ACCEPTED' && Array.isArray(j.federations) && j.federations.length
        && j.federations.every((f) => f && f.state === 'ACCEPTED' && f.moved && wellFormedPayouts(f.moved.payouts)
          // (kanban #1671) the federation and txid are read with String() by the collect, outside any try: text only
          && typeof f.federation === 'string' && wellFormedTxid(f.txid)))
        // (kanban #2014) each federation's payouts and txid normalised as settlementOf's are
        return { ok: true, federations: j.federations.map((f) => ({ ...f, txid: f.txid.toLowerCase(), moved: { ...f.moved, payouts: normalPayouts(f.moved.payouts) } })), from: node };
      said.push(`${node}: ${j && typeof j.state === 'string' ? j.state : 'malformed'}`);
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
    const at = f.moved.payouts.findIndex((p) => isQualifierTo(p, mine));
    if (at < 0) continue;
    const fid = String(f.federation).toLowerCase();
    const noted = noteKeyOf(PAYOUT_NOTE, roundId, mine, order, `.${fid.slice(0, 16)}`);
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
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const noted = noteKeyOf(SLASH_PAYOUT_NOTE, roundId, toHex(refundKeyOf(player.pubkey)), order);
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) return { ...JSON.parse(kept), amountMsat: BigInt(JSON.parse(kept).amountMsat), ok: true, final: true, kept: true };
  } catch { /* an unreadable note is no note */ }
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
// `who` { round, seed, curve }: the phrase whose note it is (kanban #1220); without it no note is this phrase's
export const slashPayoutKept = (storage, roundId, order = 0, who = null) => { try {
  if (!who || !who.seed || !who.round) return false;
  const player = playerFor({ ...who.round, id: roundId }, { seed: who.seed, curve: who.curve, order });
  return !!(storage && storage.getItem(noteKeyOf(SLASH_PAYOUT_NOTE, roundId, toHex(refundKeyOf(player.pubkey)), order))); } catch { return false; } };

/**
 * A SLASH PAYOUT INTO THE PLAYER WALLET: collected by Refund (redeemSlashPayout) into the wallet every
 * deposit and payout lands in, and written in its history as a slash payout.
 */
export async function collectSlashPayout({ round, roundId, invite, seed, curve, LockClient, storage, arbiter, listed = null, fetcher, order = 0 } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage });
  const got = await redeemSlashPayout({ round, roundId, invite, seed, curve, LockClient, storage, arbiter, listed, client, order, ...(fetcher ? { fetcher } : {}) });
  // WHAT THE REFUND BROUGHT, NOT WHAT THE WALLET GREW WHILE IT RAN (kanban #2350, as collectIntoPlayerWallet): the page can lock the next
  // stake from this same wallet, or an earlier lock's change finish issuing, while the arbitration service and the federation are asked.
  // The refund's own two reads count; one another spend or issue cut counts the payout's amount; a payout read off its kept note came before.
  const creditedMsat = got.ok && !got.kept ? broughtOf(got.amountMsat, got.balance_before, got.balance_after) : 0n;
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
  client = null, onStep = () => {}, refused = false, forfeited = false, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const noted = noteKeyOf(STAKE_NOTE, roundId, toHex(refundKeyOf(playerFor({ ...round, id: roundId }, { seed, curve, order }).pubkey)), order);
  try {
    const kept = storage && storage.getItem(noted);
    if (kept) { const k = JSON.parse(kept); return { ...k, amountMsat: BigInt(k.amountMsat), ok: true, final: true, kept: true }; }
  } catch { /* an unreadable note is no note */ }
  // A REFUSED ROUND IS NEVER SETTLED (§23.2 REFUSED): its stake comes back by the forfeit alone - and so does a stake the
  // look already found forfeited by the signer nodes (kanban #593, playtest 2026-10-23: round 8464c5fd never settled, its seats
  // had signed the forfeit of the unfilled order's locks, and the collect asked for a settlement first - nothing was redeemed)
  if (!refused && !forfeited) {
    const s = await settlementOf({ roundId, nodes, fetcher, needed: settlementAgreement(round, nodes) });
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
    // NEVER FINAL ON THEIR WORDS (kanban #1163): a stake the round's settlement claimed is read gone in the federation; one it did not claim
    // comes back by the player's key at its expiry - a record closed here on the seats' error text left it in its lock for good
    return { ok: false, final: false, lostSaid: lost,
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
    // what each accepted redeem brought, by its own balance reads (kanban #2350)
    broughtMsat: rs.filter((r) => r.accepted === true).reduce((t, r) => t + broughtOf(r.amount_msat, r.balance_before, r.balance_after), 0n),
    balance_before: rs.length ? rs[0].balance_before : undefined, balance_after: rs.length ? rs[rs.length - 1].balance_after : undefined,
    txid: rs.length ? rs[0].txid : undefined, forfeitFrom: rs.length ? rs[0].forfeitFrom : undefined,
    why: ok ? undefined : spent ? 'the stake lock is already spent - back to this seed\'s key, the only key that can after the signer nodes\' forfeit'
      : (rs.find((r) => r.error) || {}).error || 'the federation did not accept the redeem' };
  if (ok && storage) {
    try { storage.setItem(noted, JSON.stringify({ ...res, amountMsat: String(res.amountMsat), broughtMsat: String(res.broughtMsat) })); } catch { /* unkept: a reload asks again */ }
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
    // THROUGH putRoomy, AS THE LOCK BESIDE IT (kanban #1251, audit 3 FIXES-14): a raw setItem refused for quota left a saved stake lock with no collect
    // record - no expiry refund and no forfeit redeem ran on its own; the storage-full handler frees room and the write is tried again
    putRoomy(storage, key, JSON.stringify({ roundIdHex, round: toHex(encodeRoundContract(round)), invite, nodes, seed: toHex(seed),
      stakeLock: lock, done, savedMs: Date.now(), ...(order ? { order: Number(order) } : {}) }));
    return true;
  } catch { return false; }
}

// ONLY THE INVITE OF A KEPT RECORD IS REWRITTEN (kanban #2104): its done, lock and savedMs (the order records are collected in) stay
function repairCollectInvite(storage, r, invite) {
  try {
    for (const key of [collectKey(r.roundIdHex, r.seed, r.order), ...(r.order ? [] : [`${COLLECT_NOTE}${r.roundIdHex}`])]) {
      const was = storage.getItem(key);
      if (!was) continue;
      const rec = JSON.parse(was);
      if (rec.roundIdHex !== r.roundIdHex || rec.seed !== toHex(r.seed)) continue;
      rec.invite = invite;
      putRoomy(storage, key, JSON.stringify(rec));
      return true;
    }
  } catch { /* repaired at the next read */ }
  return false;
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
export function recordsToCollect(storage, { tabSeed = null, loads = null } = {}) {
  const seeds = browserSeedHexes(storage, tabSeed);
  const mine = tabSeed instanceof Uint8Array ? toHex(tabSeed) : String(tabSeed || '').toLowerCase();
  const collectable = [], uncollectable = [];
  for (const r of savedCollects(storage, {})) {
    // A RECORD KEPT WITH ANOTHER FEDERATION'S INVITE IS REPAIRED (kanban #2104): one the 24 h scan wrote before the fix (the lobby's invite for a round of
    // another federation) gets its round's own federation's invite once one is known (inviteForRound), so its wallet opens and the payout is collected
    if (r.invite) {
      const good = inviteForRound({ round: r.round, lobby: r.invite, loads, storage });
      if (good && good !== r.invite && repairCollectInvite(storage, r, good)) r.invite = good;
    }
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

/**
 * WHERE A ROUND'S COLLECT STANDS AFTER A LOOK AND WHAT ITS COLLECT GOT (kanban #1163: a collect of the payout with the stake still in its lock
 * marked the record done, it was never looked at again, and an hour later tidyStorage removed the round's wallet). One answer, from every
 * part's own state: the payout none, gone or collected (or owed and its redeem final); the stake gone, none or collected (or owed and its
 * redeem or refund final); and this tab's round wallet empty. Anything else is open, and the record is looked at again.
 */
export const COLLECT_STATES = Object.freeze({ OPEN: 'open', DONE: 'done' });
const PAYOUT_TERMINAL = new Set(['none', 'gone', 'collected']);
const STAKE_TERMINAL = new Set(['gone', 'none', 'collected']);
export function collectState(look, co = null) {
  if (!look || !look.payout || !look.stake) return { state: 'open', why: 'not looked at' };
  const got = (co && co.got) || {};
  const ok = (x) => !!(x && (x.ok || x.final));
  const payoutDone = PAYOUT_TERMINAL.has(look.payout.state) || (look.payout.state === 'owed' && ok(got.payout));
  const stakeDone = STAKE_TERMINAL.has(look.stake.state)
    || (look.stake.state === 'owed' && (look.stake.how === 'refund' ? ok(got.refund) : ok(got.stake)));
  // A KEPT FEE LOCK STILL STORED AFTER THE COLLECT (kanban #2149, #2215): the look before the collect said the stake alone was owed, and the
  // collect brought it back while the order's fee lock stayed in the federation - never done on that look; the next look owes the fee
  if (got.feeHeld) return { state: 'open', why: 'this tab\'s fee lock is still in the federation' };
  // AND ANY LOCK THE TAB MADE (kanban #2451, #2497): its stake lock still stored after the collect keeps the record open the same way
  if (got.keptHeld) return { state: 'open', why: 'a lock this tab made is still in the federation' };
  const tabEmpty = look.inTabMsat === undefined || (look.inTabMsat !== null && BigInt(look.inTabMsat) === 0n);   // null: not read (kanban #1265)
  if (payoutDone && stakeDone && tabEmpty) return { state: 'done' };
  return { state: 'open', why: [!payoutDone && `payout ${look.payout.state}`, !stakeDone && `stake ${look.stake.state}`, !tabEmpty && 'this tab\'s round wallet holds money'].filter(Boolean).join(', ') };
}

/**
 * A round whose payout and stake answers are both final: the lines kept, and it is not asked again. `look` (and `co`, what its collect got):
 * written only when collectState says done (kanban #1163), with the round wallet's balance read 0 (`tabMsat`), which tidyStorage asks for.
 */
/**
 * A DONE WRITTEN BEFORE #1163 IS LOOKED AT ONCE MORE (kanban #1255, audit 3 #1210 FIXES-15): the older page wrote a record done when its collect
 * redeemed the payout while the stake's forfeit was not signed yet, and the passes skip a done record - that stake stayed in its lock until a
 * manual Rescan. A done without `tabMsat` (which only a done read by collectState carries) is opened again, once per record (`doneRechecked`):
 * the next pass looks at it, and markCollectDone writes it done again only when collectState says so. Answers how many were opened.
 */
export function reopenUncheckedDone(storage, { now = () => Date.now() } = {}) {
  let opened = 0;
  try {
    const keys = [];
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(COLLECT_NOTE)) keys.push(k); }
    for (const k of keys) {
      try {
        const r = JSON.parse(storage.getItem(k));
        if (!r || !r.done) continue;
        const unchecked = !r.doneRechecked && !(typeof r.done === 'object' && r.done.tabMsat !== undefined);
        // A DONE WRITTEN BEFORE THE KEPT LOCKS WERE READ AFTER THE COLLECT (kanban #2451, #2497; the bug of #2149 ran live as audit44, 90d57151a):
        // that page wrote done from the look BEFORE its collect, with the order's fee lock (or the tab's own stake lock) still in the federation,
        // and it carries tabMsat, so the #1255 check leaves it; nothing in it tells the two pages apart. Each done record whose round still keeps a
        // saved lock of the tab's is opened once (`doneKeptRechecked`, kept on the record): the next look reads every kept lock, and markCollectDone
        // writes it done again only when collectState says so - one more look per record, never a loop.
        const keptUnread = !r.doneKeptRechecked && r.roundIdHex && hasSavedLockOf(storage, r.roundIdHex);
        if (!unchecked && !keptUnread) continue;
        storage.setItem(k, JSON.stringify({ ...r, done: null, ...(unchecked ? { doneRechecked: now() } : {}), ...(keptUnread ? { doneKeptRechecked: now() } : {}) }));
        opened++;
      } catch { /* a record that does not read is left as it is */ }
    }
  } catch { /* storage refused */ }
  return opened;
}

// does this round keep a lock this tab saved (any seed of it)? (kanban #2451)
function hasSavedLockOf(storage, roundIdHex) {
  const pre = `arena.lock.saved.${String(roundIdHex).toLowerCase()}.`;
  for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(pre)) return true; }
  return false;
}

export function markCollectDone(storage, roundIdHex, done, seed = null, order = 0, { look = null, co = null } = {}) {
  if (look && collectState(look, co).state !== 'done') return false;
  if (look && done && typeof done === 'object') done = { ...done, tabMsat: '0' };
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
// A ROUND'S KEY FOR A PHRASE, DERIVED ONCE (kanban #1391, Daniel 2026-11-09 "Make sure it is everything fast"; profiled on live UI 604: 3.1 s of every minute
// of an RPS page went to the curve here - every scan derived 33 keys for every settled round each signer node listed, the same rounds as the scan before):
// kept by phrase, round and order; the oldest let go past OWED_KEYS_MAX
const OWED_KEYS = new Map(), OWED_KEYS_MAX = 200000;
const owedKeyOf = (seed, id, order, curve) => {
  const k = toHex(seed) + id + ':' + order;
  let v = OWED_KEYS.get(k);
  if (v === undefined) {
    v = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve, order }).pubkey));
    if (OWED_KEYS.size >= OWED_KEYS_MAX) OWED_KEYS.delete(OWED_KEYS.keys().next().value);
    OWED_KEYS.set(k, v);
  }
  return v;
};
// ONE READ OF THE OWED SCAN, GIVEN UP AFTER SEAT_READ_MS (kanban #1489): null when the seat failed, refused or did not answer in time
const OWED_LIST_MAX = 500, OWED_NEXT_MS = 2000, OWED_ROUND_READS = 4;
// a valid /round?id= answer within OWED_FAST_MS puts its seat first in the owed scan's order; a slower one sends it back (kanban #2041, #2061)
const OWED_FAST_MS = 250;
// ONE SEAT'S LIST, NEWEST cap ENTRIES IN ONE PASS (kanban #1772, #1489 refute 14): the cap was taken after the whole list was
// copied, mapped and sorted - a seat listing a million entries cost the page an O(n log n) sort at every load. Now one pass keeps
// the newest `cap` (a min-heap on madeMs, then position), and only those are sorted. Same entries, same order as before.
const owedNewest = (rounds, cap) => {
  const heap = [];   // min-heap of { x, i, ms }: heap[0] is the oldest kept
  const older = (a, b) => (a.ms - b.ms) || (a.i - b.i);
  const up = (k) => { while (k > 0) { const p = (k - 1) >> 1; if (older(heap[k], heap[p]) >= 0) break; [heap[k], heap[p]] = [heap[p], heap[k]]; k = p; } };
  const down = (k) => {
    for (;;) {
      const l = 2 * k + 1, r = l + 1; let m = k;
      if (l < heap.length && older(heap[l], heap[m]) < 0) m = l;
      if (r < heap.length && older(heap[r], heap[m]) < 0) m = r;
      if (m === k) return;
      [heap[k], heap[m]] = [heap[m], heap[k]]; k = m;
    }
  };
  let n = 0;
  for (let i = 0; i < rounds.length; i++) {
    const x = rounds[i];
    if (!x || typeof x !== 'object') continue;
    const e = { x, i: n++, ms: Number(x.madeMs) || 0 };
    if (heap.length < cap) { heap.push(e); up(heap.length - 1); } else if (cap > 0 && older(heap[0], e) < 0) { heap[0] = e; down(0); }
  }
  // fewer than cap objects: the list as sent (as before); else newest first
  if (n <= cap) return heap.sort((a, b) => a.i - b.i).map((y) => y.x);
  return heap.sort((a, b) => -older(a, b)).map((y) => y.x);
};
const owedRead = (read) => {
  const signal = AbortSignal.timeout(SEAT_READ_MS);
  let t;
  const late = new Promise((resolve) => { t = setTimeout(() => resolve(null), SEAT_READ_MS); });
  return Promise.race([read(signal).catch(() => null), late]).finally(() => clearTimeout(t));
};
// THE SITE A NODE URL IS COUNTED BY IN THE OWED SCAN (kanban #1966): one machine or one domain is one site, however it is spelled
export const owedSiteOf = (n) => {
  let h;
  try { h = new URL(String(n)).hostname.toLowerCase(); } catch { return String(n).toLowerCase(); }
  h = h.replace(/\.+$/, '');
  if (h.startsWith('[') && h.endsWith(']')) {
    const v6 = h.slice(1, -1);
    const [head, tail = null] = v6.split('::');
    const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
    const groups = tail === null ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    const g = groups.map((x) => parseInt(x || '0', 16) || 0);
    // ::ffff:a.b.c.d (URL writes it ::ffff:hhhh:hhhh) is the IPv4 a.b.c.d
    if (g.length === 8 && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff)
      h = [g[6] >> 8, g[6] & 255, g[7] >> 8].join('.');
    else return 'v6:' + g.slice(0, 3).map((x) => x.toString(16)).join(':');
  } else if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) h = h.split('.').slice(0, 3).join('.');
  else return h.split('.').slice(-2).join('.');
  return 'v4:' + h;
};
export async function findOwedRounds({ seed, seeds = null, curve, nodes = [], fetcher = fetch, sinceMs = 0, known = [], knownBySeed = null } = {}) {
  // EVERY SAVED PHRASE AT ONCE (2026-10-07): each signer node's /settled is read once and matched against
  // every phrase's keys - 7 asks on 7 signer nodes, not 7 per phrase. One `seed` (with `known`) is the one-phrase scan as before.
  const list = Array.isArray(seeds) ? seeds : [seed];
  if (!list.length || !list.every((s) => s instanceof Uint8Array && s.length === 32))
    throw new Error('the rounds owed to a player are found from the player\'s 32-byte seed, and none was given');
  const base = (n) => String(n).replace(/\/+$/, '');
  const skipOf = (s) => new Set(((knownBySeed && knownBySeed.get(toHex(s))) || (list.length === 1 ? known : [])).map((h) => String(h).toLowerCase()));
  const skips = list.map(skipOf);
  // KNOWN BY ROUND AND ORDER (kanban #2106): an entry is '<round>:<order>' (a plain round id is its order 0, as older callers pass it). Skipping
  // the whole round while one order's record was kept left another order of it whose record was lost (a full browser, a tab that died between
  // the lock and the record) found by nothing and collected by nothing; now only the kept (round, order) pairs are skipped.
  const isKnown = (i, id, order) => skips[i].has(id + ':' + order) || (order === 0 && skips[i].has(id));
  // ONE SEAT'S WORD COSTS THE PAGE NO UNBOUNDED WORK (kanban #1489): every listed id costs ORDER_SCAN + 1 key derivations per kept
  // phrase on the page's thread - one seat answering /settled with 3000 made-up ids froze the page 16.7 s at every load (99,033
  // derivations). Now a seat's list is taken newest first up to OWED_SETTLED_MAX ids (a seat answers at most 500, round.js settledSince),
  // each id once, and OWED_KEYS_PER_ROUND keys of a round: one seat costs the page at most OWED_SETTLED_MAX x (ORDER_SCAN + 1) a phrase.
  const listed = new Map();
  // EVERY SIGNER NODE AT ONCE, EACH WITHIN SEAT_READ_MS (kanban #1489): read one after another with no timeout, one seat that took
  // the request and never answered stalled the scan for good - a winner whose tab closed was never shown what the honest seats list.
  // The deadline holds the answer's body too, and holds even for a fetcher that ignores the signal.
  const since = Math.max(0, Math.floor(Number(sinceMs) || 0));
  // ONE SITE IS ONE SEAT'S ALLOWANCE, HOWEVER MANY node= ENTRIES OR HOSTNAMES NAME IT (kanban #1832, #1966, #2002, #1489
  // v1-refute-10): a lobby link's node= list has no cap and no dedup (lobby.js lobbyQuery, join.js joinQuery), and the scan runs as
  // soon as the link opens. Eight path spellings of one liar host were eight seats with 500 made-up ids each (132,000 derivations);
  // then one machine named as liar.example, liar.example., its IPv4 literal and its ::ffff: IPv4-mapped literal was still four
  // "hosts" (66,000), and wildcard subdomains as many as the scan-wide budget held (#1966). Each node string is read once, at most
  // OWED_NODES_MAX of them, and every node is counted by its SITE (owedSiteOf): the hostname without trailing dots, an IPv4-mapped
  // IPv6 literal as its IPv4, an IPv4 by its /24, another IPv6 by its /48, a name by its last two labels - every subdomain of one
  // domain is one site. A site gives at most OWED_SETTLED_MAX ids, newest first.
  const scanNodes = [...new Set(nodes.map(base))].slice(0, OWED_NODES_MAX);
  nodes = scanNodes;
  const lists = await Promise.all(nodes.map((node) => owedRead(async (signal) => {
    const r = await fetcher(`${base(node)}/settled?since=${since}`, { signal });
    return r.ok ? r.json() : null;
  })));
  // AT MOST OWED_SETTLED_MAX ROUNDS FROM ONE SITE, NEWEST FIRST, EACH ID ONCE PER SEAT (kanban #1489, #1832, #1966)
  const bySite = new Map();
  lists.forEach((got, n) => {
    // the seat's newest entries in one pass, objects only (owedNewest, kanban #1772): no sort of a seat's whole list
    const all = got && Array.isArray(got.rounds) ? owedNewest(got.rounds, Math.min(OWED_SETTLED_MAX, OWED_LIST_MAX)) : null;
    if (!all) return;
    const h = owedSiteOf(nodes[n]);
    if (!bySite.has(h)) bySite.set(h, []);
    const seen = new Set(), rows = bySite.get(h);
    all.forEach((x, i) => {
      const id = String(x.id || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id) || seen.has(id)) return;
      seen.add(id);
      rows.push({ x, id, n, i, ms: Number(x.madeMs) || 0 });
    });
  });
  const cap = Math.min(OWED_SETTLED_MAX, OWED_LIST_MAX);
  const queues = [...bySite.values()].map((rows) => {
    rows.sort((a, b) => (b.ms - a.ms) || (a.n - b.n) || (b.i - a.i));
    const ids = [], keep = new Set();
    for (const r of rows) { if (keep.size >= cap) break; if (!keep.has(r.id)) { keep.add(r.id); ids.push(r.id); } }
    return { ids, rows: rows.filter((r) => keep.has(r.id)) };
  });
  // THE SCAN'S WHOLE BUDGET GOES FIRST TO THE ROUNDS MOST SITES AGREE ON (kanban #2002): one budget of OWED_SCAN_IDS_MAX ids shared
  // "site by site in turn" let four liar spellings cut an honest seat's 500 to 400 and hide the player's oldest round. Now an id
  // is ranked by how many distinct sites list it: every round the seats of a federation all list (7-14 sites) is taken before any
  // round fewer sites list, and a round only one site lists comes last - a liar's made-up ids are derived only with what is left.
  // Among ids that equally many sites list, the sites take turns, newest first within each.
  const agree = new Map();
  for (const q of queues) for (const id of q.ids) agree.set(id, (agree.get(id) || 0) + 1);
  const taken = new Set();
  const tiers = [...new Set(agree.values())].sort((a, b) => b - a);
  for (const c of tiers) {
    if (taken.size >= OWED_SCAN_IDS_MAX) break;
    const tier = queues.map((q) => q.ids.filter((id) => agree.get(id) === c && !taken.has(id)));
    for (let k = 0; taken.size < OWED_SCAN_IDS_MAX && tier.some((t) => k < t.length); k++)
      for (const t of tier) { if (k < t.length && taken.size < OWED_SCAN_IDS_MAX) taken.add(t[k]); }
  }
  // in the order the seats listed them (seat by seat, as before): only which ids are kept is chosen by agreement and age
  for (const { x, id } of queues.flatMap((q) => q.rows).filter((r) => taken.has(r.id)).sort((a, b) => (a.n - b.n) || (a.i - b.i))) {
    const l = listed.get(id) || { payouts: new Set(), refunds: new Set() };
    for (const k of (Array.isArray(x.payouts) ? x.payouts : []).slice(0, OWED_KEYS_PER_ROUND)) l.payouts.add(String(k).toLowerCase());
    for (const k of (Array.isArray(x.refunds) ? x.refunds : []).slice(0, OWED_KEYS_PER_ROUND)) l.refunds.add(String(k).toLowerCase());
    listed.set(id, l);
  }
  // WHICH ROUNDS ARE THIS PAGE'S, FROM THE KEYS ALONE - no seat is asked anything yet
  const matches = [];
  for (const [id, l] of listed) {
    for (let i = 0; i < list.length; i++) {
      // EVERY ORDER'S KEY TOO: a tab's orders in a market round are keyed 0, 1, 2 ... - read up to ORDER_SCAN (32: a bot places 12 a window)
      for (let order = 0; order <= ORDER_SCAN; order++) {
        if (isKnown(i, id, order)) continue;   // kanban #2106: this order's record is kept, not the round's
        const mine = owedKeyOf(list[i], id, order, curve);
        const payout = l.payouts.has(mine); const lock = l.refunds.has(mine);
        if (payout || lock) matches.push({ id, payout, lock, seed: list[i], order });
      }
    }
  }
  // A SILENT SEAT COSTS ONE SCAN OWED_NEXT_MS ONCE, NOT ONCE PER ROUND (kanban #1772, #1489 refute 14): the contracts were read one
  // round after another, each asking the signer nodes in list order - one seat first in the list that took /round?id= and never
  // answered cost OWED_NEXT_MS for every owed round (12 rounds: 24.3 s before anything was kept; a reload paid it all again).
  // Now a seat that has not answered a read within OWED_NEXT_MS goes to the back of this scan's order for every later read, and the
  // rounds' contracts are read OWED_ROUND_READS at a time. Still one read per round from seats that answer at once.
  // A SEAT THAT ANSWERS USELESSLY IS DEMOTED TOO, AND THE SEAT THAT SERVED GOES FIRST (kanban #1907, #1489 refute 14 skeptic 3): only
  // silence sent a seat back, so one that answered every /round?id= with a 404 - or with a contract that is not the round - at
  // 1.9 s, just inside OWED_NEXT_MS, kept its front place and cost every owed round again (3 such seats of 7: 12 rounds 17.3 s;
  // one seat: 48 rounds 23.2 s, all before the page saved anything). Now any read that did not yield the round - silence, an error,
  // a refusal, a wrong or unlockable contract - sends the seat to the back of this scan's order, a seat that returned a valid
  // contract moves to the front, and each read picks its next seat from the scan's order as it stands then (not a copy taken at
  // its start), so reads already under way profit at once. A useless seat costs a scan its delay for the first reads only.
  // ONLY A FAST WINNER GOES FIRST (kanban #2041, #2061, #1489 refute 14 skeptic 4): any valid contract moved its seat to the front,
  // whatever its latency and even after the read was over. The contract is public bytes (its id is its hash), so one seat that
  // copied it and answered every /round?id= at 1.9 s stayed first and cost every owed round 1.9 s again (48 rounds: 23.3 s), and
  // one that answered at 2.1 s was demoted by the OWED_NEXT_MS timer and then promoted back by its late answer (48 rounds: 25.9 s).
  // Now a seat goes to the front only when its valid answer came within OWED_FAST_MS, before this read's OWED_NEXT_MS timer moved
  // on, and won the read; a valid answer slower than OWED_FAST_MS sends the seat to the back like a useless one. Honest seats that
  // all answer slowly only take turns at the front; each read still asks one seat while it answers within OWED_NEXT_MS.
  const order = nodes.slice();
  const slow = (node) => { const k = order.indexOf(node); if (k >= 0 && k < order.length - 1) { order.splice(k, 1); order.push(node); } };
  const good = (node) => { const k = order.indexOf(node); if (k > 0) { order.splice(k, 1); order.unshift(node); } };
  const readContract = (id) => new Promise((resolve) => {
    const asked = new Set();
    let open = 0, done = false, t = null;
    const ask = () => {
      clearTimeout(t);
      if (done) return;
      const node = order.find((n) => !asked.has(n));
      if (node === undefined) { if (!open) { done = true; resolve(null); } return; }
      asked.add(node); open += 1;
      let answered = false, timedOut = false;
      const askedAt = Date.now();
      t = setTimeout(() => { if (!answered) { timedOut = true; slow(node); } ask(); }, OWED_NEXT_MS);
      owedRead(async (signal) => {
        const r = await fetcher(`${base(node)}/round?id=${id}`, { signal });
        if (!r.ok) return null;
        const c = decodeRoundContract(new Uint8Array(await r.arrayBuffer()));
        return toHex(roundIdOf(c)) === id && roundLocks(c) ? c : null;
      }).then((c) => {
        answered = true; open -= 1;
        const fast = !timedOut && Date.now() - askedAt <= OWED_FAST_MS;
        if (c && fast && !done) good(node); else if (!c || !fast) slow(node);
        if (done) return;
        if (c) { done = true; clearTimeout(t); resolve(c); } else ask();
      });
    };
    ask();
  });
  const contracts = new Map();
  // A CONTRACT READ ONCE IS KEPT: the id is its hash, so it is the round for good - not read again at every scan
  const wanted = [...new Set(matches.map((m) => m.id))].filter((id) => { const c = OWED_ROUNDS.get(id); if (c) contracts.set(id, c); return !c; });
  let at = 0;
  await Promise.all(Array.from({ length: Math.min(OWED_ROUND_READS, wanted.length) }, async () => {
    while (at < wanted.length) {
      const id = wanted[at++];
      const round = await readContract(id);
      if (round && !OWED_ROUNDS.has(id)) { OWED_ROUNDS.set(id, round); if (OWED_ROUNDS.size > 2000) OWED_ROUNDS.delete(OWED_ROUNDS.keys().next().value); }
      contracts.set(id, round);
    }
  }));
  const found = [];
  for (const m of matches) {
    const round = contracts.get(m.id);
    if (round) found.push({ roundIdHex: m.id, round, payout: m.payout, lock: m.lock, seed: m.seed, order: m.order });
  }
  return found;
}
const OWED_ROUNDS = new Map();   // round id -> its contract, read and checked once
export const forgetOwedRounds = () => OWED_ROUNDS.clear();
// how many orders of one market round the seed scan reads keys for (orders 0 ... ORDER_SCAN)
export const ORDER_SCAN = 32;
// how many rounds of one seat's /settled one owed scan derives keys for (newest first), and keys of one round it takes from one seat (kanban #1489)
export const OWED_SETTLED_MAX = 500, OWED_KEYS_PER_ROUND = 4096;
// how many node= entries one owed scan reads (each distinct node string once), and how many ids the whole scan derives keys for,
// over every site, the ids most sites list first (kanban #1832, #2002): a federation lobby names 7-14 seats, and they list the same
// settled rounds
export const OWED_NODES_MAX = 32, OWED_SCAN_IDS_MAX = 2000;

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
// `given`: the locks to take back as the signer nodes named them (expiredBack) - for a lock this tab keeps no record of
export async function refundKept({ round, roundId, seed, curve, client, storage, kept = null, order = 0, locks: given = null } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so it has no lock to refund');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  let locks;
  if (given && given.length) locks = given.map((l, i) => ({ kind: i ? 'lock' : 'stake', outpoint: l.outpoint, fields: l.fields }));
  else {
    const held = kept || savedLock(storage, { roundId, playerPubkey: player.pubkey });
    if (!held || !held.lock) return { ok: false, final: true, locks: [], why: 'this tab keeps no lock for this round' };
    locks = [{ kind: 'stake', outpoint: held.lock.outpoint, fields: held.lock.fields }];
    if (held.lock.feeLock) locks.push({ kind: 'fee', outpoint: held.lock.feeLock.outpoint, fields: held.lock.feeLock.fields });
  }
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
// once per stake and page: the looks repeat every few seconds, the handout needs handing only once
const HANDOUT_HANDED = new Set();
// EXPIRED AND NOBODY FORFEITS IT (kanban #593, playtest 2026-10-23: round 07e4f3fa's 90 + 4 sat lay in federation 337ae01a past their
// expiry, 157,403, and Rescan said "waiting - no signer node gave a forfeit of this lock: ... that run is VOID with score 0" forever): the
// signer nodes name the lock but sign no forfeit, so §23.2's default path takes it - after its expiry the player's own key takes it back.
// Owed by refund when every lock still stored is past its expiry; null while any is before it (or no wallet to ask).
async function expiredBack(client, locks) {
  if (!client) return null;
  const back = [];
  for (const l of locks || []) {
    const st = JSON.parse(await client.lockStatus(toHex(l.outpoint.txid), Number(l.outpoint.outIdx)));
    if (!st.stored) continue;
    if (Number(st.stored.blocks_left) > 0) return null;
    back.push({ outpoint: l.outpoint, fields: l.fields });
  }
  if (!back.length) return null;
  return { state: 'owed', how: 'refund', msat: back.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n), locks: back };
}

async function refusedReturn({ roundId, playerPubkey, locks, nodes, fetcher, client, handoutBody = null, curve = null, contractIdOf = null }) {
  const still = [];
  for (const lock of (locks || []).filter((l) => l && l.outpoint)) {
    const st = JSON.parse(await client.lockStatus(toHex(lock.outpoint.txid), Number(lock.outpoint.outIdx)));
    if (st.stored) still.push(lock);
  }
  if (!still.length) return null;
  // THE STAKE'S HANDOUT HANDED AGAIN FIRST (kanban #593): a seat keeps the lock only against a handout it holds for the round,
  // and an order cut off mid-join (a seat restarting) may have reached a seat with its lock and without its handout. The tab
  // kept the handout's bytes with the lock; a seat that holds it already answers so
  const handKey = `${toHex(roundId)}:${toHex(playerPubkey)}`;
  // WITH ITS STAKE LOCK SHOWN (kanban #2415, #2481): a stranger's junk handouts can push a never-entered handout out of a full round (#2136),
  // and a seat refuses a new handout for a round it refuses; the lock the federation holds (x-arena-stake-lock, the header a lock-first
  // client sends, #1596) is what lets the seat take this one back - and keeps it from being pushed out again
  if (handoutBody && !HANDOUT_HANDED.has(handKey)) {
    HANDOUT_HANDED.add(handKey);
    const stake = still.find((l) => l.fields && l.fields.paymentImage && l.fields.paymentImage.kind === 'point');
    const shown = stake ? { headers: { 'x-arena-stake-lock': JSON.stringify({ outpoint: `${toHex(stake.outpoint.txid)}:${stake.outpoint.outIdx}`, fields: lockFieldsToJson(stake.fields) }) } } : {};
    await Promise.all([...new Set(nodes || [])].map((node) => fetcher(`${String(node).replace(/\/+$/, '')}/handout`, { method: 'POST', body: handoutBody, ...shown }).catch(() => null)));
  }
  let kept = 0;
  for (const lock of still) kept += (await handRefusedLock({ roundId, lock, nodes, fetcher })).kept > 0 ? 1 : 0;
  if (!kept) return null;
  const msat = still.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);
  const at = (l) => `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`;
  const named = await findLock({ roundId, playerPubkey, nodes, fetcher });
  // every version the seats name for each outpoint (kanban #1273): a changed one listed first does not stand in for the real one
  const versions = still.map((l) => named.filter((n) => at(n) === at(l))).filter((v) => v.length);
  const found = versions.map((v) => v[0]);
  if (!found.length) return (await expiredBack(client, still)) || { state: 'waiting', how: 'forfeit', refused: true, msat, why: 'handed to the signer nodes, and none names it yet' };
  for (const v of versions) {
    let f = null;
    for (const l of v) {
      f = await forfeitOf({ roundId, entryId: l.entryId, nodes, fetcher,
        check: forfeitCheck({ curve, fields: l.fields, storedId: await storedIdAt(client, l), contractIdOf }) });
      if (f.ok) break;
    }
    if (!f.ok) return (await expiredBack(client, still)) || { state: 'waiting', how: 'forfeit', refused: true, msat, why: f.why };
  }
  const owed = found.reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);
  return { state: 'owed', how: 'forfeit', refused: true, msat: owed };
}

// THE ORDER'S FEE LOCK AS THIS TAB KEPT IT (kanban #2149): the given record's, else this seed's saved lock's; null when none
async function keptFeeLock({ kept, storage, roundId, player }) {
  let k = null;
  try { k = kept && kept.lock && kept.lock.feeLock ? kept : (storage ? savedLock(storage, { roundId, playerPubkey: player.pubkey }) : null); } catch { k = null; }
  const fee = k && k.lock && k.lock.feeLock;
  return fee && fee.outpoint && fee.fields ? fee : null;
}

// EVERY LOCK THIS TAB MADE FOR THE ROUND (kanban #2451, #2497): the stake lock and the order's fee lock, as the given record or this seed's
// saved lock keeps them, each { outpoint, fields, fee }. The seats' word decides nothing here - one seat may name the fee lock as the stake lock.
async function keptLocksOf({ kept, storage, roundId, player }) {
  const out = [];
  const add = (l, fee) => { if (l && l.outpoint && l.fields && !out.some((o) => lockAt(o) === lockAt(l))) out.push({ outpoint: l.outpoint, fields: l.fields, fee }); };
  let k = null;
  try { k = kept && kept.lock ? kept : (storage ? savedLock(storage, { roundId, playerPubkey: player.pubkey }) : null); } catch { k = null; }
  if (k && k.lock) add(k.lock, false);
  add((k && k.lock && k.lock.feeLock) || await keptFeeLock({ kept: null, storage, roundId, player }), true);
  return out;
}
const lockAt = (l) => `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`;

// THE TAB'S KEPT FEE LOCK, WHILE THE FEDERATION STILL HOLDS IT (kanban #1642): null when there is none or it is spent; else the fee's own
// state, read the way the stake's is - { state: 'owed', how: 'refund', locks } past its expiry, { state: 'owed', how: 'forfeit', entryId } when
// the seats give its forfeit, { state: 'waiting' } otherwise. `fee: true` marks it: collectOwed redeems it alone (redeemFee), never the stake again.
async function keptFeeHeld({ round, roundId, player, kept, storage, client, nodes, fetcher, curve, contractIdOf }) {
  let k = null;
  try {
    k = kept && kept.lock && kept.lock.feeLock ? kept : savedLock(storage, { roundId, playerPubkey: player.pubkey });
  } catch { k = null; }
  const fee = k && k.lock && k.lock.feeLock;
  if (!fee || !fee.outpoint || !fee.fields) return null;
  let st; try { st = JSON.parse(await lockStatusOf(client, fee.fields, toHex(fee.outpoint.txid), Number(fee.outpoint.outIdx))); } catch { return { state: 'waiting', fee: true, msat: BigInt(fee.fields.amountMsat), why: 'the federation was not read for the fee lock' }; }
  if (!st || !st.stored) return null;
  const msat = BigInt(fee.fields.amountMsat);
  const left = Number(st.stored.blocks_left);
  if (!(left > 0)) return { state: 'owed', how: 'refund', fee: true, msat, locks: [{ outpoint: fee.outpoint, fields: fee.fields }] };
  // the entry its forfeit is asked under: the kept record's, else the one the seats name for this seed's stake lock
  let entryId = (k && k.entry) || null;
  if (!entryId) { try { const named = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher }); entryId = (named.find((l) => l.entryId) || {}).entryId || null; } catch { entryId = null; } }
  const waiting = { state: 'waiting', how: 'forfeit', fee: true, msat, blocksLeft: left, blockCount: Number(st.block_count), expiration: Number(fee.fields.expiration) };
  if (!entryId) return { ...waiting, why: 'no signer node names this seed\'s entry, so the fee lock\'s forfeit cannot be asked yet' };
  const f = await forfeitOf({ roundId, entryId, nodes, fetcher, lock: 'fee',
    check: forfeitCheck({ curve, fields: fee.fields, storedId: st.stored.contract_id || null, contractIdOf }) });
  if (f.ok) return { state: 'owed', how: 'forfeit', fee: true, msat, entryId };
  return { ...waiting, why: f.why };
}

/** THE KEPT FEE LOCK ALONE, REDEEMED BY ITS FORFEIT (kanban #1642): the stake already came back; the fee forfeit the seats give now. */
export async function redeemFee({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch, client: given = null,
  entryId = null, kept = null, onStep = () => {}, order = 0 } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its fee is not a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const k = kept && kept.lock && kept.lock.feeLock ? kept : (storage ? savedLock(storage, { roundId, playerPubkey: player.pubkey }) : null);
  const fee = k && k.lock && k.lock.feeLock;
  if (!fee) return { ok: false, final: false, why: 'this tab keeps no fee lock for this round' };
  let eid = entryId || (k && k.entry) || null;
  if (!eid) { const named = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher }); eid = (named.find((l) => l.entryId) || {}).entryId || null; }
  if (!eid) return { ok: false, final: false, why: 'no signer node names this seed\'s entry, so the fee lock\'s forfeit cannot be asked yet' };
  onStep('asking the signer nodes for the forfeit of the fee lock');
  const client = given || await LockClient.join(invite, toHex(round.federationId), toHex(lockSecretFor(seed, roundId)),
    storage ? lockStoreFor(storage, roundId, lockSecretFor(seed, roundId)) : unkeptLockStore());
  const cid = contractIdVia(LockClient || (client && client.constructor));
  const f = await forfeitOf({ roundId, entryId: eid, nodes, fetcher, lock: 'fee',
    check: forfeitCheck({ curve, fields: fee.fields, storedId: await storedIdAt(client, fee), contractIdOf: cid }) });
  if (!f.ok) return { ok: false, final: false, why: f.why, client };
  onStep('redeeming the fee lock');
  const said = JSON.parse(await client.redeem(toHex(fee.outpoint.txid), Number(fee.outpoint.outIdx),
    JSON.stringify(lockFieldsToJson(fee.fields)), f.signature, toHex(player.secret)));
  const ok = said.accepted === true;
  return { ok, final: ok, fee: true, amountMsat: BigInt(said.amount_msat || 0), forfeitFrom: f.from,
    balance_before: said.balance_before, balance_after: said.balance_after,
    why: ok ? undefined : said.error || 'the federation did not accept the fee lock\'s redeem', client };
}

/**
 * EVERY OTHER LOCK THIS BROWSER SUBMITTED FOR THE ROUND (kanban #2460, state audit 2026-11-12 SM1 page-4): a refused record kept aside
 * (arena.lock.orphan.*, #1584), an intent left by a closed tab (#1162, copied there too) and an intent still kept with its transaction named.
 * 'refused' was read from a few "not stored" answers, not from the guardians' word, so such a lock may be stored after all, under this
 * player's refund key. Each lock: { outpoint, fields } - fields null when the record cannot rebuild them (an intent from before #2460).
 */
function orphanLocksOf(storage, { roundId, playerPubkey, seed }) {
  if (!storage) return [];
  const tag = `${toHex(roundId)}.${toHex(playerPubkey).slice(0, 16)}`;
  const records = [];
  try {
    for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(`arena.lock.orphan.${tag}.`)) records.push(readJson(storage, k)); }
  } catch { /* storage refused */ }
  const intent = readJson(storage, lockIntentKey(roundId, playerPubkey));
  if (intent && intent.txid) records.push(intent);
  const locks = [];
  for (const r of records.filter(Boolean)) {
    try {
      if (r.outpoint && r.fields) {
        locks.push({ outpoint: { txid: fromHex(r.outpoint.txid), outIdx: BigInt(r.outpoint.outIdx) }, fields: lockFieldsFromJson(r.fields) });
        if (r.feeLock && r.feeLock.outpoint && r.feeLock.fields)
          locks.push({ outpoint: { txid: fromHex(r.feeLock.outpoint.txid), outIdx: BigInt(r.feeLock.outpoint.outIdx) }, fields: lockFieldsFromJson(r.feeLock.fields) });
        continue;
      }
      if (!r.txid) continue;
      const outs = Array.isArray(r.outputs) && r.outputs.length ? r.outputs : [{ role: 'stake', outIdx: 0 }];
      for (const o of outs) {
        let fields = null;
        if (r.claimPk && r.refundPk && o.amountMsat !== undefined && Number.isFinite(o.expiration)) {
          const paymentImage = o.role === 'fee' ? { kind: 'hash', bytes: sha256(feeSecretFor(seed, roundId)) }
            : { kind: 'point', bytes: decodeHandout(fromHex(r.body)).commitments[0] };
          fields = { paymentImage, amountMsat: BigInt(o.amountMsat), claimPk: fromHex(r.claimPk), refundPk: fromHex(r.refundPk), expiration: o.expiration };
        }
        locks.push({ outpoint: { txid: fromHex(r.txid), outIdx: BigInt(o.outIdx) }, fields });
      }
    } catch { /* a record that does not read is left as it is */ }
  }
  return locks;
}
/** THE ORPHANED LOCKS THE FEDERATION STILL HOLDS (kanban #2460): null when none is; waiting while any is before its expiry (or cannot be
 * rebuilt); else owed by the player's refund key, the locks named for refundKept. Outpoints in `except` (the kept record's) are not counted twice. */
async function orphansHeld(client, locks, except = new Set()) {
  const at = (l) => `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`;
  const seen = new Set(except);
  const back = [];
  let waiting = null; let msat = 0n;
  for (const l of locks) {
    if (seen.has(at(l))) continue;
    seen.add(at(l));
    const st = JSON.parse(await client.lockStatus(toHex(l.outpoint.txid), Number(l.outpoint.outIdx)));
    if (!st || !st.stored) continue;
    if (l.fields) msat += BigInt(l.fields.amountMsat);
    if (Number(st.stored.blocks_left) > 0 || !l.fields) {
      waiting = waiting || { state: 'waiting', how: 'refund', orphan: true, blockCount: Number(st.block_count),
        ...(l.fields ? { expiration: Number(l.fields.expiration) } : { why: `an earlier lock of this round (transaction ${at(l).slice(0, 16)}…) is still stored, and this browser keeps too little of it to refund it` }) };
      continue;
    }
    back.push({ outpoint: l.outpoint, fields: l.fields });
  }
  if (waiting) return { ...waiting, msat };
  if (!back.length) return null;
  return { state: 'owed', how: 'refund', orphan: true, msat, locks: back };
}

export async function lookOwed({ round, roundId, seed, curve, nodes, fetcher = fetch, client = null, storage = null, kept = null, order = 0, LockClient = null } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so nothing in it is owed from a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve, order });
  const mine = toHex(refundKeyOf(player.pubkey));
  const rid = toHex(roundId);
  const note = (k) => { try { const v = storage && storage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } };
  // STILL AT ITS OUTPOINT? The federation's read-only answer; without a wallet it is not asked.
  // (an Arena lock is read with its own call: `fields` says which; a payout output is a stock contract)
  const held = async (txid, outIdx, fields = null) => !client || !!JSON.parse(await lockStatusOf(client, fields, txid, Number(outIdx))).stored;
  // THE SETTLEMENT THE ROUND'S THRESHOLD OF SEATS AGREES ON (kanban #1163): "none" only on their word, never one seat's
  const s = await settlementOf({ roundId, nodes, fetcher, needed: settlementAgreement(round, nodes), payee: mine });
  const contractIdOf = contractIdVia(LockClient || (client && client.constructor));
  let payout;
  const paidNote = note(noteKeyOf(PAYOUT_NOTE, roundId, mine, order));
  if (paidNote) payout = { state: 'collected', msat: BigInt(paidNote.amountMsat) };
  else if (!s.ok) payout = { state: 'waiting', why: s.why };
  else {
    const at = s.moved.payouts.findIndex((x) => isQualifierTo(x, mine));
    if (at < 0) payout = { state: 'none' };
    // ALREADY SPENT - only this key can: collected before (another tab, an earlier build's timer).
    else payout = { state: await held(s.txid, at) ? 'owed' : 'gone', msat: BigInt(s.moved.payouts[at].msat) };
  }
  let stake;
  let lockAnswers = null;
  const backNote = note(noteKeyOf(STAKE_NOTE, roundId, mine, order));
  if (backNote) stake = { state: 'collected', msat: BigInt(backNote.amountMsat) };
  else {
    // ASKED WITH OR WITHOUT A SETTLEMENT (kanban #593, playtest 2026-10-23: round 8464c5fd never ran - no settlement - and its
    // seats had already signed the forfeit of the player's unfilled order; the page asked them nothing and said the 100 sat came
    // back only at the lock's expiry, 1834 blocks on, and showed it nowhere): the signer nodes name the lock and sign its
    // forfeit whenever they owe it, settled or not
    const locks = await findLock({ roundId, playerPubkey: player.pubkey, nodes, fetcher });
    lockAnswers = locks.said ? { asked: locks.asked, answered: locks.answered, said: locks.said } : null;
    // NOBODY ANSWERED IS NOT "NO LOCK" (playtest 2026-10-04: a DELIVERED player's 96 sat stake was never
    // asked back - the page's record of the round ended as if nothing were owed): with no signer node answering where
    // the lock is, the stake is still waiting and the round is looked at again.
    // ONLY THE NAMED LOCKS THE FEDERATION HOLDS (kanban #1238; the seats already answer by this seed's refund key, the guardians check it at the spend)
    const named = [...locks];
    const real = await heldByGuardians(client, named, contractIdOf);
    // none of the named locks is held while this tab's own lock still is: the seats named a lock that is not this stake's
    const ownHeld = async () => {
      if (!client) return false;
      let k = null; try { k = kept || savedLock(storage, { roundId, playerPubkey: player.pubkey }); } catch { k = null; }
      return !!(k && k.lock) && (await heldByGuardians(client, [k.lock], contractIdOf)).length > 0;
    };
    if (!named.length && s.ok && locks.asked > 0 && locks.answered === 0)
      stake = { state: 'waiting', why: `no signer node answered where this seed's lock is (${locks.said.join('; ')})` };
    else if (named.length && (real.length || !(await ownHeld()))) {
      const whole = [...new Map(named.map((l) => [`${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`, l])).values()].reduce((t, l) => t + BigInt(l.fields.amountMsat), 0n);   // each outpoint once (kanban #1273)
      if (!real.length) stake = { state: 'gone', how: 'forfeit', msat: whole };
      else {
        // ONE OUTPOINT, ITS AMOUNT ONCE, AND ONE GOOD FORFEIT FROM ANY OF ITS VERSIONS (kanban #1273): findLock keeps every seat's version of an outpoint
        const byOutpoint = new Map();
        for (const l of real) { const k = `${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`; if (!byOutpoint.has(k)) byOutpoint.set(k, []); byOutpoint.get(k).push(l); }
        const msat = [...byOutpoint.values()].reduce((t, v) => t + BigInt(v[0].fields.amountMsat), 0n);
        // A FORFEIT FOR EVERY LOCK HELD, never the first one named alone (kanban #1238)
        let f = { ok: true };
        for (const v of byOutpoint.values()) {
          for (const l of v) {
            f = await forfeitOf({ roundId, entryId: l.entryId, nodes, fetcher,
              check: forfeitCheck({ curve, fields: l.fields, storedId: await storedIdAt(client, l), contractIdOf }) });
            if (f.ok) break;
          }
          if (!f.ok) break;
        }
        if (f.ok) stake = { state: 'owed', msat, how: 'forfeit' };
        // NOBODY WON (2026-10-03) - SAID, NEVER FINAL (kanban #1163: "lost" was decided by a regex over the seats' error text and closed the
        // record with the stake still in its lock): a stake the settlement claimed reads gone above; one still held comes back at its expiry
        else {
          const lostSaid = /that run is \S+ with score/.test(f.why)
            && !/not ACCEPTED at this signer node|still inside its window|keeps no record of what its settlement moved/.test(f.why);
          stake = (await expiredBack(client, real)) || { state: 'waiting', msat, why: f.why, ...(lostSaid ? { lostSaid: true } : {}) };
          // AND EVERY LOCK THE TAB MADE, PAST ITS EXPIRY TOO (kanban #2149, #2215; #2451, #2497): the seats' names decide only which locks the
          // refund starts from - they name the stake lock alone, or one seat names the tab's FEE lock as its stake lock and no seat names the stake
          // lock. Each kept lock (the stake lock and the order's fee lock) still stored past its expiry is refunded in the same pass, beside them
          if (stake.state === 'owed' && stake.how === 'refund') {
            const statusOf = async (l) => { try { return JSON.parse(await lockStatusOf(client, l.fields, toHex(l.outpoint.txid), Number(l.outpoint.outIdx))); } catch { return null; } };
            // the same contract the guardians hold is the same money, at whatever outpoint it was named
            const cids = new Set();
            for (const l of stake.locks) { const st = await statusOf(l); if (st && st.stored && st.stored.contract_id) cids.add(String(st.stored.contract_id)); }
            for (const kl of await keptLocksOf({ kept, storage, roundId, player })) {
              if (stake.locks.some((l) => lockAt(l) === lockAt(kl))) continue;
              const st = await statusOf(kl);
              if (st && st.stored && st.stored.contract_id && cids.has(String(st.stored.contract_id))) continue;
              if (st && st.stored && !(Number(st.stored.blocks_left) > 0))
                stake = { ...stake, msat: stake.msat + BigInt(kl.fields.amountMsat), locks: [...stake.locks, { outpoint: kl.outpoint, fields: kl.fields }] };
            }
          }
        }
      }
    } else {
      // NO SIGNER NODE KNOWS THE LOCK (refused at the door) OR NO SETTLEMENT YET: the tab's own record,
      // asked of the federation without spending - owed back by the player's key after expiry.
      const held = kept || savedLock(storage, { roundId, playerPubkey: player.pubkey });
      const ls = held && held.lock ? [held.lock, held.lock.feeLock].filter(Boolean) : [];
      // "NONE" IS FINAL ONLY ON ENOUGH SEATS' WORD (kanban #1250, audit 3 FIXES-16): one seat that never sat on the round answering [] while its own
      // seats timed out closed the record with a winner's stake still in its lock; it is waiting until the round's settlement threshold answered
      if (!ls.length) {
        // AND ONLY THE ROUND'S OWN SEATS COUNT (kanban #1355, audit 4 fixesB-6 / CLIENT-5): a seat of the lobby's list that never sat on the round
        // answers [] at once; only the seats that answered the agreed settlement and also where the lock is make the threshold
        const own = new Set(s.seats || []);
        const ownAnswered = (locks.answeredBy || []).filter((n) => own.has(n)).length;
        const enough = ownAnswered >= settlementAgreement(round, nodes);
        stake = { state: s.ok && enough ? 'none' : 'waiting', why: enough ? 'this tab keeps no lock for this round'
          : `this tab keeps no lock for this round, and only ${ownAnswered} of the ${settlementAgreement(round, nodes)} seats of the round's settlement needed answered where its lock is` };
      }
      else if (!client) stake = { state: 'waiting', why: 'the federation was not asked yet' };
      else {
        // §23.2 REFUSED (2026-10-06 08:57: "A round the seats refuse gets an immediate refund"): a lock
        // still in the federation that no signer node knows is handed to them; if they refuse its round they keep it, and
        // its forfeit is the stake owed back now - not after its expiry.
        // the fee lock from the tab's saved lock when the record handed in carries the stake alone (a collect record does)
        const saved = held.lock.feeLock ? null : savedLock(storage, { roundId, playerPubkey: player.pubkey });
        const feeLock = held.lock.feeLock || (saved && saved.lock && saved.lock.feeLock) || null;
        const handoutBody = (held.stake && held.stake.body) || (saved && saved.stake && saved.stake.body) || null;
        const back = await refusedReturn({ roundId, playerPubkey: player.pubkey, locks: [held.lock, feeLock], nodes, fetcher, client, handoutBody, curve, contractIdOf });
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
  // THE ORDER'S FEE LOCK HAS ITS OWN STATE (kanban #1642, state audit 2026-11-12 SM2 page-1): the seats' /stake-lock names the stake lock
  // only; the fee lock is known from the tab's saved lock alone, and redeemStake asked its forfeit once, beside the stake's. A fee forfeit
  // missed on that one ask (the seats' MuSig for it did not form, a peer timed out) was left out, the stake note was written, and from then
  // on the stake read 'collected' and the round final - the fee lock was never asked again, by forfeit or by the player's key after its
  // expiry. Once the stake is back (or gone), a kept fee lock the federation still holds is what is owed: by its forfeit when the seats
  // give one (asked on every look), by refund once it is past its expiry, waiting before that. A lock the tab made that is still stored
  // is never final.
  if (client && (stake.state === 'collected' || stake.state === 'gone')) {
    const fee = await keptFeeHeld({ round, roundId, player, kept, storage, client, nodes, fetcher, curve, contractIdOf });
    if (fee) stake = fee;
  }
  // AN ORPHANED LOCK IS COLLECTED TOO (kanban #2460, state audit 2026-11-12 SM1 page-4): the round's own lock answered (gone, collected,
  // none, lost), a lock this browser submitted earlier for the round and kept aside (arena.lock.orphan.*, #1584 / #1162) or still names in
  // an intent is read where the guardians hold it. Measured before: the first lock, read "not stored" 3x on a reload, was accepted late;
  // the round's collect refunded the second lock, the look read FINAL with nothing owed, the record was marked done, and the first lock's
  // 950,000 msat stayed stored past its expiry for good. Still stored now: waiting before its expiry, owed by refund after - never final.
  if (client && storage && ['collected', 'gone', 'none', 'lost'].includes(stake.state)) {
    const own = new Set();
    try {
      const k = savedLock(storage, { roundId, playerPubkey: player.pubkey });
      for (const l of k && k.lock ? [k.lock, k.lock.feeLock].filter(Boolean) : []) own.add(`${toHex(l.outpoint.txid)}:${l.outpoint.outIdx}`);
    } catch { /* no kept record */ }
    const orphan = await orphansHeld(client, orphanLocksOf(storage, { roundId, playerPubkey: player.pubkey, seed }), own);
    if (orphan) stake = orphan;
  }
  const owed = (how) => (stake.state === 'owed' && stake.how === how ? stake.msat : 0n);
  const payoutMsat = payout.state === 'owed' ? payout.msat : 0n;
  // WHAT THIS TAB'S WALLET HOLDS - read, not spent (the stock client throws on an empty one).
  // A WALLET NOT READ IS NOT EMPTY (kanban #1265, audit 4 #1257 CLIENT-1 path e): a look with no client, or a client that cannot read its balance (a Rescan's
  // `{ lockStatus }` wrapper for a round another tab holds), read 0 - and the record was marked done with the wallet's 0, so the tidy removed the wallet that
  // held the round's collected e-cash. Unread is null now: collectState reads it as not empty
  let inTabMsat = null;
  // (the wallet's own "Balance is too low to send any amount after fees" is a read of an empty wallet: 0, as before)
  if (client && typeof client.withdrawableMsat === 'function') { try { inTabMsat = BigInt(await client.withdrawableMsat()); } catch (e) { inTabMsat = /too low/i.test(String(e && e.message || e)) ? 0n : null; } }
  let tabBalanceMsat = null;
  if (client && typeof client.balanceMsat === 'function') { try { tabBalanceMsat = BigInt(await client.balanceMsat()); } catch { tabBalanceMsat = null; } }
  // FINAL: the federation holds nothing more of this seed's in this round. The tab's own balance is apart.
  const final = ['none', 'gone', 'collected'].includes(payout.state) && ['lost', 'gone', 'none', 'collected'].includes(stake.state);
  return { payout, stake, payoutMsat, stakeMsat: owed('forfeit'), refundMsat: owed('refund'), stakeLost: stake.state === 'lost' || !!stake.lostSaid,
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
  // the kept fee lock alone, its stake already back (kanban #1642): never the stake's collect again, whose note answers at once
  if (look.stakeMsat > 0n && look.stake && look.stake.fee) got.stake = await redeemFee({ ...ask, client, entryId: look.stake.entryId || null });
  else if (look.stakeMsat > 0n) got.stake = await returnStake({ ...ask, client, refused: !!(look.stake && look.stake.refused),
    forfeited: !!(look.stake && look.stake.state === 'owed' && look.stake.how === 'forfeit') });
  if (look.refundMsat > 0n) got.refund = await refundKept({ ...ask, client, locks: (look.stake && look.stake.locks) || null });
  // THE FEE LOCK READ AGAIN AFTER THE COLLECT (kanban #2149, #2215): the page marks the record done from the look taken BEFORE this collect,
  // and a fee forfeit missed on its one ask beside the stake's (or a fee lock the stake's refund did not take) stayed in the federation while
  // that look read the stake alone - the record was closed and the fee never asked again. A kept fee lock still stored (or not read) keeps it open.
  if (got.payout || got.stake || got.refund) {
    try {
      if (ask.round && roundLocks(ask.round) && client && typeof client.lockStatus === 'function') {
        const player = playerFor({ ...ask.round, id: ask.roundId }, { seed: ask.seed, curve: ask.curve, order: ask.order || 0 });
        // EVERY KEPT LOCK, NOT ONLY THE FEE LOCK (kanban #2451, #2497): a refund that took the lock a seat named and left the tab's own stake lock
        for (const kl of await keptLocksOf({ kept: ask.kept || null, storage: ask.storage || null, roundId: ask.roundId, player })) {
          let st = null; try { st = JSON.parse(await lockStatusOf(client, kl.fields, toHex(kl.outpoint.txid), Number(kl.outpoint.outIdx))); } catch { st = null; }
          if (!st || st.stored) { if (kl.fee) got.feeHeld = true; else got.keptHeld = true; }
        }
      }
    } catch { /* no player key here: nothing is read, nothing changed */ }
  }
  return got;
}

/**
 * WINNINGS-AUTO (RULED 2026-10-01): WHAT IS OWED GOES INTO THE PLAYER WALLET BY ITSELF - the payout contract
 * redeemed, the stake back by the signer nodes' forfeit or by the player's key after expiry - the moment it exists, with
 * no press. Into the player's own federation wallet (one per seed and federation) and NOTHING out of it: no Lightning,
 * no withdraw. What arrived is written in the history as a "winnings" row, by what each redeem reports it credited (kanban #2038).
 */
/**
 * WHAT ONE ACCEPTED REDEEM BROUGHT INTO THE WALLET (kanban #2350, live 2026-11-12 05:39Z, round 4e1c1615 never entered: the seats forfeited
 * its 94,000 msat, the federation accepted both redeems, and the history said "Refund +25 of 100 sat"). The row was what the wallet grew by
 * over the whole collect - 24 s of asking seats - and the page's next join locked 100,000 msat out of the same wallet meanwhile, while
 * 31,072 msat of an earlier lock's change finished issuing: 94,000 - 100,000 + 31,072 = 25,072. Each redeem's own two reads (the lock
 * client's, right before its transaction and once it is accepted) are what it brought - the lock's amount less the federation's fee; a
 * read another spend or issue cut (no growth, or more than the lock, or under 90 % of it) is counted at the lock's amount.
 */
export function broughtOf(amountMsat, before, after) {
  const amount = BigInt(amountMsat || 0);
  if (before === undefined || before === null || after === undefined || after === null) return amount;
  const grew = BigInt(after) - BigInt(before);
  return grew > 0n && grew <= amount && grew * 10n >= amount * 9n ? grew : amount;
}
/** What a collect brought (kanban #2350): the parts the federation accepted in this call, each by broughtOf; a part read off its kept note came before. */
export function collectBrought(got) {
  let t = 0n;
  const p = got && got.payout;
  if (p && p.ok && !p.kept) t += broughtOf(p.amountMsat, p.balance_before, p.balance_after);
  const s = got && got.stake;
  if (s && s.ok && !s.kept) t += s.fee ? broughtOf(s.amountMsat, s.balance_before, s.balance_after) : (s.broughtMsat !== undefined ? BigInt(s.broughtMsat) : BigInt(s.amountMsat || 0));
  const r = got && got.refund;
  if (r && Array.isArray(r.locks)) for (const e of r.locks) if (e.state === 'refunded') t += broughtOf(e.amountMsat, e.balance_before, e.balance_after);
  return t;
}

export async function collectIntoPlayerWallet({ look, round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher, order = 0 } = {}) {
  if (!look || !(look.payoutMsat > 0n || look.stakeMsat > 0n || look.refundMsat > 0n)) return { collected: false, creditedMsat: 0n };
  const client = await playerWallet({ round, invite, seed, LockClient, storage });
  const got = await collectOwed({ look, client, round, roundId, invite, seed, curve, LockClient, storage, nodes, order, ...(fetcher ? { fetcher } : {}) });
  // WHAT THE REDEEMS BROUGHT, NOT WHAT THE WALLET GREW WHILE THEY RAN (kanban #2350, #2038): the page locks the next stake from this same wallet meanwhile
  const creditedMsat = collectBrought(got);
  // and the contracts redeemed in THIS call, the row's key (kanban #2038); an answer from the tab's note (kept) names none
  const parts = [];
  if (got.payout && got.payout.ok && !got.payout.kept) parts.push(`p:${got.payout.txid}:${got.payout.outIdx}`);
  if (got.stake && got.stake.ok && !got.stake.kept) parts.push('s');
  if (got.refund) for (const e of got.refund.locks || []) if (e.state === 'refunded') parts.push(`r:${e.kind}`);
  // A STAKE THAT ONLY CAME BACK IS A REFUND ROW, NOT WINNINGS (2026-10-03: "the money that comes back must be
  // visible in the TX history"): nobody won, or the round was refunded - no payout, the stake (or its expiry refund) back
  const kind = look.payoutMsat > 0n ? 'winnings' : 'refund';
  // ONE ROW PER REDEEMED CONTRACT SET (kanban #2038): keyed by the round, this phrase's key, the order and the contracts redeemed (the payout's
  // outpoint, the stake's redeem, the refunded locks), so two collects that both get an accepted answer for the same contracts write one row
  const mine = toHex(refundKeyOf(playerFor({ ...round, id: roundId }, { seed, curve, order }).pubkey));
  const rowId = `col-${toHex(sha256(new TextEncoder().encode(`${toHex(roundId)}|${mine}|${order}|${parts.join('|')}`))).slice(0, 40)}`;
  if (creditedMsat > 0n) ledgerAppend(storage, round.federationId, { kind, msat: String(creditedMsat), round: toHex(roundId) }, rowId);
  // COLLECTED ONLY WHEN SOMETHING WAS (kanban #593: this said `collected: true` whatever came of the redeems - the record of round
  // 8464c5fd was marked done with its 100 sat still in the federation, the redeem never tried): a payout, stake or refund the
  // federation accepted, or money that reached the wallet
  const collected = creditedMsat > 0n || [got.payout, got.stake, got.refund].some((x) => x && x.ok);
  return { collected, got, creditedMsat, why: collected ? null : [got.payout, got.stake, got.refund].filter((x) => x && !x.ok).map((x) => x.why).filter(Boolean).join('; ') || null };
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
// THE PLAYER'S CLAIM ON THE LOCKS ITS ENTRY NAMES (kanban #1897, #1938; protocol lock-claim.js): a BIP-340 signature by the stake point over
// the entry id, made with the stake preimage the page alone holds. A seat that holds it hands the entry's locks to a claimed entry only, so a
// copy of the entry under another session key (posted by anyone who saw it) can never take the player's stake or fee lock - whatever any seat's
// clock says. `lockClaimer(curve, stake)`: the signer the page puts on its stakeLock (`claimFor`), or null when the curve cannot sign.
export function lockClaimer(curve, stake) {
  if (!curve || typeof curve.signSchnorr !== 'function' || !stake || !(stake.preimage instanceof Uint8Array) || stake.preimage.length !== 32) return null;
  const preimage = stake.preimage;
  return (entryIdBytes) => curve.signSchnorr(lockClaimDigest(entryIdBytes), preimage);
}
// The claim to one seat, right after its entry (POST /lock-claim). Never fatal: a seat that missed it still learns it from the seats that took it.
export async function postLockClaim({ node, entryId: eid, claimFor, fetcher = fetch } = {}) {
  if (typeof claimFor !== 'function') return { node, status: 0, why: 'no claim' };
  try {
    const sig = claimFor(eid);
    const r = await fetcher(`${String(node).replace(/\/+$/, '')}/lock-claim?entry=${toHex(eid)}`, { method: 'POST', body: sig });
    return { node, status: r.status, why: r.status === 201 ? null : (await r.text()).trim() };
  } catch (e) { return { node, status: 0, why: e.message }; }
}

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
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/${door}?entry=${toHex(entryId)}`, { method: 'POST', body, signal: AbortSignal.timeout(30000) });   // a seat that never answers is a seat that refused
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
 * Answers { moved, chunks, state, why }; a stop because this browser could not keep a receive leg (storage full, kanban #2427) answers
 * { moved, movedChunks, leftMsat, state: 'unkept', why } - no `chunks`, so it never reads as a federation found empty.
 */
export const MIGRATE_DUST_MSAT = 10000n;
export async function migrateFromDraining({ from, to, record, toFederationId, chunkMsat = null, retries = 3, maxChunks = 64,
  gateways = [], onState = () => {}, storage = null, fromFederationId = null, phrase16 = null } = {}) {
  const hex = (b) => (b instanceof Uint8Array ? toHex(b) : String(b || '')).toLowerCase();
  const inRow = { kind: 'moved-in', from: hex(fromFederationId) };
  // DRAINING, or CRITICAL with the safe federation the page chose as `successorId` (evacuatePlayerWallet, 2026-10-13); or CLOSED
  // (kanban #1982: a player away for the whole drain still holds notes in a federation whose record turned CLOSED)
  if (!record || !['DRAINING', 'CRITICAL', 'CLOSED'].includes(record.status)) return { moved: 0n, chunks: 0, state: 'not draining' };
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
    let made = null, unkept = false;
    // A LEG THAT DID NOT LAND (kanban #2183: a full store refused it): no invoice, so withdrawCollected pays nothing, and the move stops
    const out = await withdrawCollected({ client: from, amountMsat: amount, gateways,
      invoiceFor: async (msat) => { made = JSON.parse(await to.receive(String(msat), ''));
        if (!moveLegAhead(storage, toFederationId, made, msat, inRow, phrase16)) { unkept = true; return { ok: false, why: MOVE_UNKEPT_WHY }; }
        return { ok: true, invoice: made.invoice }; } });
    // A STOP FOR STORAGE IS NOT AN EMPTY FEDERATION (kanban #2427 / #2484): { moved: 0n, chunks: 0 } is what the page reads as "found empty"
    // (ARENA_EVACUATE's evacuatedEmpty - never tried again that page) while `can` msat stay in the DRAINING / CRITICAL federation. This stop
    // answers state 'unkept' with the msat left and no chunk count (the run did not end), so the page tries again at a later status read.
    if (unkept) { onState({ state: 'unkept', movedMsat: moved, leftMsat: can, why: MOVE_UNKEPT_WHY }); return { moved, movedChunks: chunks, leftMsat: can, state: 'unkept', why: MOVE_UNKEPT_WHY }; }
    // NOTHING PAID (no payment made, or Refunded - the money back in the old wallet): the leg written ahead goes
    if (made && !out.ok && (!out.state || out.state === 'Refunded')) pendingDrop(storage, toFederationId, made.operation);
    const final = out.ok && made ? await to.awaitReceive(made.operation) : null;
    if (out.ok && final === 'Claimed') {
      moved += amount; chunks++; failed = 0;
      if (storage && fromFederationId) ledgerAppend(storage, fromFederationId, { kind: 'moved-out', msat: String(amount), to: hex(toFederationId) });
      if (storage) depositEnded(storage, toFederationId, made.operation, final, { invoice: made.invoice, operation: made.operation, amountMsat: amount, row: inRow });
      continue;
    }
    // THE RECEIVE ENDED Expired / Failure: its entry goes; any other answer keeps it for the next page's resume
    if (made && final) depositEnded(storage, toFederationId, made.operation, final, null);
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
    fromFederationId: round.federationId, storage, onState, chunkMsat, phrase16: phraseOfSeed(seed) });
}

/**
 * THE NOTES OUT OF A DRAINING OR CRITICAL FEDERATION, BY THEMSELVES (2026-10-13 ~12:00Z: "When a federation is draining
 * the client has automatically to move it to a safe federation"): not only at a join into the successor (migratePlayerWallet)
 * but as soon as the page has checked the federations' records - into `target` (federations.js safeFederation: the named
 * successor, else the lowest-load OPEN one). `from`: the draining federation's checked status with its invite. Both wallets
 * of this seed are opened as the stake opens them; then the chunks of migrateFromDraining.
 */
export async function evacuatePlayerWallet({ from, target, seed, LockClient, storage, onState = () => {}, chunkMsat = null, gateways = [] } = {}) {
  // AND OUT OF A CLOSED ONE (kanban #1982): the seats close a drain by its clock, not by the players' notes being out, so a player who
  // did not open the page during the drain still holds notes there - they go to its successor (safeFederation) as a DRAINING one's do
  if (!from || !['DRAINING', 'CRITICAL', 'CLOSED'].includes(from.status) || !from.invite) return { moved: 0n, chunks: 0, state: 'not draining' };
  if (!target || target.status !== 'OPEN' || !target.invite) return { moved: 0n, chunks: 0, state: 'no safe federation to move to' };
  // NO NEW MONEY WHERE NONE IS TAKEN (kanban #2433, after #807): the move invoices the target, so a target that takes no new deposits is refused
  // before a wallet is opened in it - unless the guardians named it as the draining federation's successor
  const named = from.successorId && String(from.successorId).toLowerCase() === String(target.federation).toLowerCase();
  if (!named && !takesDeposits(String(target.federation))) return { moved: 0n, chunks: 0, state: 'no safe federation to move to', why: 'that federation takes no new deposits' };
  const fromId = fromHex(String(from.federation)), toId = fromHex(String(target.federation));
  const a = await openPlayerWallet({ federationId: fromId, invite: from.invite, seed, LockClient, storage });
  const b = await openPlayerWallet({ federationId: toId, invite: target.invite, seed, LockClient, storage });
  return migrateFromDraining({ from: a, to: b, record: { status: from.status, successorId: toId }, toFederationId: toId, fromFederationId: fromId,
    storage, onState, chunkMsat, gateways, phrase16: phraseOfSeed(seed) });
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
// A MOVE'S RECEIVE LEG, WRITTEN BEFORE ITS PAYMENT (kanban #1774): the invoice and operation of the receiving wallet as a pending entry of its
// federation, with the history row its claim writes (`row`); `phrase16` the moving phrase's, so another phrase's scan never drops it (kanban #1233)
// ANSWERS WHETHER THE LEG IS KEPT (kanban #2183): false only when a store was given and the entry did not land in it (a full store) -
// the caller then pays nothing. No store or no federation named: nothing could be kept, as before.
const MOVE_UNKEPT_WHY = 'this browser could not keep the move (storage full) - nothing was sent';
function moveLegAhead(storage, federationId, made, msat, row, phrase16 = null) {
  if (!storage || !fedHexOf(federationId)) return true;
  if (!made || !made.operation) return false;
  return pendingAdd(storage, federationId, { invoice: made.invoice, operation: made.operation, msat: String(msat), kind: 'move', row,
    ...(phrase16 ? { phrase16: String(phrase16).toLowerCase() } : {}) });
}
// `rows`: the history's two kinds - a join's swap, or the player's own Move (movePlayerWallet)
export async function swapForRound({ from, to, amountMsat, gateways = [], storage = null, fromFederationId = null, toFederationId = null, onState = () => {},
  rows = ['swapped-out', 'swapped-in'], phrase16 = null }) {
  const amount = BigInt(amountMsat);
  const hex = (b) => (b instanceof Uint8Array ? toHex(b) : String(b || '')).toLowerCase();
  const inRow = { kind: rows[1], from: hex(fromFederationId) };
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
    // THE RECEIVE LEG IS WRITTEN AHEAD OF THE PAYMENT (kanban #1774, state audit 2026-11-12, SM-C5): a tab closed after the payment left `from`
    // and before the claim in `to` kept nothing naming `to` - the next page never opened its wallet and the paid invoice was never claimed.
    // Now the receive is a pending entry of `to` (arena.deposit.pending, as a deposit's): ledgerFederations names it, resumeDeposits claims it
    // A LEG THAT DID NOT LAND (kanban #2183: a full store refused it) is never paid - a tab closed after the payment would name `to` nowhere
    if (!moveLegAhead(storage, toFederationId, made, amount, inRow, phrase16)) {
      onState({ state: 'stopped', why: MOVE_UNKEPT_WHY, tried });
      return { ok: false, state: 'stopped', why: MOVE_UNKEPT_WHY, tried };
    }
    said = JSON.parse(await from.withdraw(made.invoice, pay || undefined));
    if (said.state !== 'Refunded') break;
    pendingDrop(storage, toFederationId, made.operation);   // Refunded: nothing paid into that invoice
    tried.push({ receive: recv, pay, state: said.state });
  }
  const final = said.state === 'Success' ? await to.awaitReceive(made.operation) : null;
  // THE RECEIVE ENDED Expired / Failure: its entry goes; Claimed ends below, with its row; anything else keeps it for the next page's resume
  if (final && final !== 'Claimed') depositEnded(storage, toFederationId, made.operation, final, null);
  if (!(said.state === 'Success' && final === 'Claimed')) {
    const why = said.state === 'Success' ? `the receive in the round's federation ended ${final}` : `the payment from the other federation ended ${said.state}${said.state === 'Refunded' ? ` - the money is back there (${tried.length} gateway pair${tried.length === 1 ? '' : 's'} tried)` : ''}`;
    onState({ state: 'stopped', why, tried });
    return { ok: false, state: 'stopped', why, tried };
  }
  const feeMsat = before - BigInt(await from.balanceMsat()) - amount;
  if (storage && fromFederationId) ledgerAppend(storage, fromFederationId, { kind: rows[0], msat: String(amount), feeMsat: String(feeMsat), to: hex(toFederationId) });
  // the row and the end of the entry written ahead: one transition (depositEnded), the row once per invoice
  if (storage && toFederationId) depositEnded(storage, toFederationId, made.operation, final, { invoice: made.invoice, operation: made.operation, amountMsat: amount, row: inRow });
  onState({ state: 'swapped', amountMsat: amount, feeMsat });
  return { ok: true, state: 'swapped', movedMsat: amount, feeMsat };
}

/**
 * THE PLAYER'S OWN MOVE (kanban #598, the owner 2026-10-23: "Move from Federation X to Federation Y mit einem amount, standardmässig alles von
 * der Federation"): `from` / `to` as { federation (hex), invite }. Both wallets of this seed are opened as the stake opens them; `amountMsat`
 * null moves all that `from` can send after the fees. The swap's two legs (swapForRound), its history rows moved-out / moved-in.
 */
export async function moveCanMsat({ from, seed, LockClient, storage } = {}) {
  const a = await openPlayerWallet({ federationId: fromHex(String(from.federation)), invite: from.invite, seed, LockClient, storage });
  try { return BigInt(await a.withdrawableMsat()); } catch (e) {
    if (/too low to send any amount after fees/i.test(String((e && e.message) || e))) return 0n;
    throw e;
  }
}
export async function movePlayerWallet({ from, to, seed, LockClient, storage, amountMsat = null, gateways = [], onState = () => {} } = {}) {
  if (!from || !to || !from.invite || !to.invite) return { ok: false, state: 'refused', why: 'both federations need their invite' };
  if (String(from.federation).toLowerCase() === String(to.federation).toLowerCase()) return { ok: false, state: 'refused', why: 'choose two different federations' };
  const fromId = fromHex(String(from.federation)), toId = fromHex(String(to.federation));
  const a = await openPlayerWallet({ federationId: fromId, invite: from.invite, seed, LockClient, storage });
  const b = await openPlayerWallet({ federationId: toId, invite: to.invite, seed, LockClient, storage });
  let can;
  try { can = BigInt(await a.withdrawableMsat()); } catch (e) {
    if (/too low to send any amount after fees/i.test(String((e && e.message) || e))) can = 0n; else throw e;
  }
  const amount = amountMsat === null ? can : BigInt(amountMsat);
  if (amount <= 0n) return { ok: false, state: 'refused', canMsat: can, why: can <= 0n ? 'nothing to send from that federation after the fees' : 'a move is more than 0 sat' };
  if (amount > can) return { ok: false, state: 'refused', canMsat: can, why: `that federation can send ${can / 1000n} sat after the fees, less than the ${amount / 1000n} sat asked` };
  const done = await swapForRound({ from: a, to: b, amountMsat: amount, gateways, storage, fromFederationId: fromId, toFederationId: toId, onState, rows: ['moved-out', 'moved-in'], phrase16: phraseOfSeed(seed) });
  return { ...done, canMsat: can };
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
  const done = await swapForRound({ from, to, amountMsat: quote.amountMsat, gateways, storage, fromFederationId, toFederationId: round.federationId, onState, phrase16: phraseOfSeed(seed) });
  return { ...done, quote };
}

/** The federations this browser keeps a history for (hex): where the player has held notes. */
export function ledgerFederations(storage) {
  const out = [];
  for (const k of storageKeys(storage)) {
    // AND EVERY FEDERATION A DEPOSIT IS STILL PENDING IN (2026-10-20 16:46Z: 1,000 sat paid into b18947f0 "was not reflected" -
    // the gateway funded the incoming contract, but a deposit gets its ledger row only once claimed, and a page reloaded or
    // suspended before the claim opened wallets only where the ledger had rows: the pending deposit was never resumed, claimed or
    // summed). A federation this browser made a deposit invoice in is one it holds a wallet in.
    // (kanban #1179: a pending deposit's key and a history row's name the federation before a dot)
    const f = k.startsWith(PENDING_PREFIX) ? k.slice(PENDING_PREFIX.length).split('.')[0]
      : k.startsWith(LEDGER_PREFIX) && !k.startsWith(LEDGER_READ_PREFIX) ? ledgerFedOfKey(k) : null;
    if (f && /^[0-9a-f]{64}$/.test(f) && !out.includes(f)) out.push(f);
  }
  return out;
}
// THE INVITE EACH WALLET WAS OPENED WITH (arena.federation.invite.<fed>): a held federation's wallet opens from it when no verified
// status names an invite (a CRITICAL or not-yet-listed federation), so its funds are still read and summed
const INVITE_PREFIX = 'arena.federation.invite.';
export function rememberedInvite(storage, federationId) {
  try { return (storage && storage.getItem(INVITE_PREFIX + fedHexOf(federationId))) || null; } catch { return null; }
}
function rememberInvite(storage, federationId, invite) {
  // NEVER ANOTHER FEDERATION'S INVITE (kanban #2104, state audit 2026-11-12 SM7-PAGE-1): a record kept with the lobby's invite (federation A) for a round of
  // federation B opened B's wallet with A's invite - the join was refused, but this line had already written A's invite as B's remembered one, and every
  // later read of B that fell back on it broke too. An invite that reads as another federation's is not remembered.
  try { if (storage && fedHexOf(federationId) && invite && !inviteNamesAnother(invite, fedHexOf(federationId))) storage.setItem(INVITE_PREFIX + fedHexOf(federationId), String(invite)); } catch { /* not kept */ }
}
// the invite is readable and names a federation other than `fidHex` (an unreadable one proves nothing and is left to the lock client's own check)
function inviteNamesAnother(invite, fidHex) {
  let f; try { f = readInvite(invite).federationId; } catch { return false; }
  return !!f && String(f).toLowerCase() !== String(fidHex).toLowerCase();
}
const inviteNames = (invite, fidHex) => { try { const f = readInvite(invite).federationId; return !!f && String(f).toLowerCase() === String(fidHex).toLowerCase(); } catch { return false; } };

/**
 * THE INVITE A COLLECT RECORD OF `round` IS KEPT WITH (kanban #2104, state audit 2026-11-12 SM7-PAGE-1): the round's own federation's, chosen as the join
 * chooses it (index.html joinTheRoundIfOneWasNamed) - `lobby` when it names the round's federation, else the verified status of that federation the page
 * read (`loads`, ARENA_FED_LOADS: fid -> { invite }), else the invite this browser opened that federation's wallet with before. The 24 h scan kept every round
 * it found with the lobby's invite: a round of another federation was a record whose wallet never opened (the lock client refuses an invite to federation A
 * for a stake in B), collected by no pass, and never written again. `null` when `lobby` names another federation and no invite of the round's is known
 * yet (the record is not written, and the next scan finds the round again); `lobby` unchanged when the round names no federation or `lobby` is unreadable.
 */
export function inviteForRound({ round, lobby = null, loads = null, storage = null } = {}) {
  const fid = round && round.federationId instanceof Uint8Array && round.federationId.length === 32 ? toHex(round.federationId) : null;
  if (!fid || !lobby || !inviteNamesAnother(lobby, fid)) return lobby || null;
  let st = null;
  try { st = loads && typeof loads.get === 'function' ? loads.get(fid) : null; } catch { st = null; }
  if (st && st.invite && inviteNames(st.invite, fid)) return st.invite;
  const kept = rememberedInvite(storage, fid);
  if (kept && inviteNames(kept, fid)) return kept;
  return null;
}
