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
import { taggedHash, toHex, fromHex, sha256 } from '../../protocol/src/hash.js';
import { TAG } from '../../protocol/src/constants.js';
import { netStakeMsat } from '../../protocol/src/payout.js';
import { entryFeeMsat } from '../../protocol/src/fee.js';
import { refundKeyOf, lockFieldsToJson, lockFieldsFromJson } from '../../protocol/src/stake-lock.js';
import { decodeHandout, handoutId } from '../../protocol/src/handout.js';
import { lockFromClient } from './lock-result.js';
import { feeLockPays } from '../../protocol/src/lock-settlement.js';
import { roundLocks, playerFor } from './join.js';
import { encodeRoundContract, decodeRoundContract, roundId as roundIdOf, custodyFieldsAreValid } from '../../protocol/src/contracts.js';
import { decodeBolt11 } from '../../protocol/src/bolt11.js';

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
 * donation (§22A) - the same net the signer node's stake-lock check wants. It assumed
 * 0 before the page could write a donation (M3.2 6e): a 2% donor's lock would
 * have held 98000 msat where the signer node wants 96000.
 */
export const lockAmountMsat = (round, donationMsat = 0n) => {
  const stakeMsat = BigInt(round.stakeMsat || 0n);
  return netStakeMsat({ stakeMsat, feeMsat: entryFeeMsat(stakeMsat), donationMsat });
};

/**
 * THE PLAYER WALLET'S SECRET (§24A.1, v4.6.3; RULED the owner 2026-09-25): one e-cash wallet per player seed and
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

/** WHERE THE PLAYER WALLET IS KEPT: the tab's storage, under the federation and the secret's hash, never the secret. */
export function walletStoreFor(storage, federationId, secret) {
  const prefix = `blwp.walletdb.${toHex(federationId).slice(0, 16)}.${toHex(sha256(secret)).slice(0, 16)}.`;
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
 * THE CHECKS A PAYING ROUND'S STAKE IS HELD TO, before the player wallet is even opened: a round that names a
 * federation, custody fields in full (M3 W7, §23), an invite to reach it, a lock client to reach it with.
 */
function paysIntoALock(round, invite, LockClient) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const custody = custodyFieldsAreValid(round);
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
// ONE OPEN WALLET PER LOCK CLIENT, TAB STORE AND WALLET SECRET (INSTANT-1527, the owner 2026-09-30 15:23: the slow steps do
// not sit in front of the user). The page opens the player wallet in the lobby, before PLAY - joining the federation is
// the slowest step of a paying join - and the deposit, the lock and the withdraw use that same open client rather than
// joining again on the same store. A join that failed is not kept.
const openWallets = new WeakMap();
export async function playerWallet({ round, invite, seed, LockClient, storage, onStep = () => {} } = {}) {
  paysIntoALock(round, invite, LockClient);
  const secret = walletSecretFor(seed, round.federationId);
  const key = `${toHex(round.federationId)}:${toHex(secret)}`;
  const byStore = storage && (openWallets.get(LockClient) || openWallets.set(LockClient, new WeakMap()).get(LockClient));
  const open = byStore && byStore.get(storage);
  if (open && open.has(key)) { onStep('the player wallet is open'); return open.get(key); }
  const store = storage ? walletStoreFor(storage, round.federationId, secret) : unkeptLockStore();
  const kept = JSON.parse(store.entries()).length;
  onStep(kept ? 'reopening the player wallet this tab keeps for this federation' : 'joining the federation with the player wallet');
  const joining = LockClient.join(invite, toHex(round.federationId), toHex(secret), store);
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
async function locksFor(round, client, donationMsat) {
  const amount = lockAmountMsat(round, donationMsat);
  let feeRule = null;
  if (typeof client.feeRule === 'function') {
    try { const r = JSON.parse(await client.feeRule()); feeRule = { ppm: BigInt(r.fee_ppm), baseMsat: BigInt(r.fee_base_msat) }; }
    catch { feeRule = null; }
  }
  if (feeRule && feeRule.baseMsat > 0n)
    throw new Error(`no stake is locked to this round: its federation charges a base fee of ${feeRule.baseMsat} msat `
      + 'on every input and output - a federation for BLWP runs with disable_base_fees (FEDERATION.md)');
  const feeGate = feeLockPays({ contract: round, fees: feeRule });
  return { amount, feeGate, feeMsat: feeGate.pays ? feeGate.lockMsat : 0n };
}

/**
 * WHAT THE PLAYER WALLET MUST HOLD FOR THIS ROUND'S LOCKS, each quoted on its own (two locks are two transactions, each
 * with its own fees), and the fee lock's stock allowance again as its margin: the fee lock is quoted a second time over
 * the notes the stake lock leaves (measured in a real browser, 0.0.1236: 21504 msat left for a 20000 msat fee lock that
 * then cost more). `null` quotes: the wallet holds too little to be quoted at all (the stock dry run).
 */
async function needFor(client, LockClient, { amount, feeMsat }) {
  const locks = feeMsat > 0n ? [amount, feeMsat] : [amount];
  let quoted = 0n;
  for (const m of locks) {
    try { quoted += BigInt(await client.lockCostMsat(String(m))); } catch (e) {
      if (!/insufficient funds/i.test(String((e && e.message) || e))) throw e;
      quoted = null;
      break;
    }
  }
  const margin = feeMsat > 0n ? BigInt(LockClient.lockAllowanceMsat(String(feeMsat))) : 0n;
  const allowance = locks.reduce((t, m) => t + BigInt(LockClient.lockAllowanceMsat(String(m))), 0n);
  return { locks, need: quoted === null ? null : quoted + margin, floor: locks.reduce((t, m) => t + m, 0n) + allowance + margin };
}

/**
 * THE TOP-UP: a Lightning deposit INTO THE PLAYER WALLET, its own act and never inside a stake (§24A.1: "if short, a
 * Lightning deposit via any listed gateway"; RULED 2026-09-25: no Lightning between the players). Deposits only what
 * the wallet is short of this round's locks - nothing when it already holds them. `onDeposit({ invoice, amountMsat,
 * creditsMsat })` is told each invoice the player's own Lightning wallet must pay. Returns the deposits made.
 */
/**
 * THE GATEWAY A DEPOSIT GOES THROUGH (the owner 2026-09-30 14:30: "A deposit goes only to a gateway that holds e-cash ...
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

// THE DEPOSIT IS THE GROSS ROUND AMOUNT, IN ROUNDS (the owner 2026-09-30 20:53, GROSS-INVOICE-2053: "A 10000 sat round
// invoices 10000 sat, not 9906. Fee and donation are not subtracted from the invoice ... The tabs are '1 round', '2
// rounds', '5 rounds', '10 rounds', and 'Custom' ... The amount is this round's stake times the count"). The gateway's
// receive fee and the lock allowance come out of what the wallet is credited: measured on testnet4, a gross 10000 sat
// invoice credits 9968 sat, more than one round's locks; a gross 100 sat one credits 97.7 sat, 0.6 sat short of one
// 100 sat round with the 2% donation - the page then says the wallet cannot fund the round, and two rounds cover.
export const DEPOSIT_ROUNDS = [1, 2, 5, 10];
export const DEPOSIT_INSUFFICIENT = 'insufficient funds to play this round. Do you want to do a lightning deposit?';
/** The deposit tabs for a round of `stakeMsat`: n rounds at n x the stake, then Custom (an amount the player names). */
export function depositChoices(stakeMsat) {
  const stake = BigInt(stakeMsat || 0n);
  return [...DEPOSIT_ROUNDS.map((n) => ({ key: String(n), label: n === 1 ? '1 round' : `${n} rounds`, rounds: n, msat: stake * BigInt(n) })),
    { key: 'custom', label: 'Custom', rounds: null, msat: null }];
}
/**
 * ONE DEPOSIT OFFER: `invoice(msat)` asks the wallet's gateway for a gross invoice of exactly that amount (a new one at
 * every tab switch); `claimed` resolves with whichever invoice was paid first, `close()` rejects it. Every invoice made
 * stays payable: one paid after another was claimed is credited to the same wallet.
 */
export function depositOffer({ client, stakeMsat, haveMsat = null, needMsat = null, gateways = [], onDeposit = () => {} } = {}) {
  let settle; let fail;
  const claimed = new Promise((res, rej) => { settle = res; fail = rej; });
  claimed.catch(() => {});
  const made = [];
  const invoice = async (msat) => {
    const amount = BigInt(msat);
    if (amount <= 0n) throw new Error('a deposit is more than 0 sat');
    const got = JSON.parse(await client.receive(String(amount), depositGateway('', gateways)));
    const d = { invoice: got.invoice, amountMsat: amount, creditsMsat: null };
    made.push(d);
    onDeposit(d);
    client.awaitReceive(got.operation).then((final) => { if (final === 'Claimed') settle(d); }, () => {});
    return d;
  };
  return { stakeMsat: BigInt(stakeMsat || 0n), haveMsat, needMsat, choices: depositChoices(stakeMsat), invoice, claimed, made,
    close: (why) => fail(new Error(why || 'the deposit was closed: nothing was paid')) };
}
/** A deposit into the player wallet from Settings: the same tabs, this round's stake, no round to fund. */
export async function settingsDepositOffer({ round, invite, seed, LockClient, storage, gateways = [], onDeposit = () => {}, onClaimed = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage });
  const offer = depositOffer({ client, stakeMsat: round.stakeMsat, haveMsat: BigInt(await client.balanceMsat()), gateways, onDeposit });
  offer.claimed.then((d) => { depositRow(storage, round, d); onClaimed(d); }, () => {});
  return offer;
}
function depositRow(storage, round, d) {
  let invoiceHash = null;
  try { invoiceHash = toHex(decodeBolt11(d.invoice).paymentHash); } catch { invoiceHash = null; }
  ledgerAppend(storage, round.federationId, { kind: 'deposit', msat: String(d.amountMsat), invoiceHash });
}
export const DEPOSIT_MARGIN_PPM = 6000n;
export const DEPOSIT_MARGIN_MSAT = 10000n;
export async function fundPlayerWallet({ round, invite, seed, LockClient, storage, donationMsat = 0n, gateways = [],
  estimateDeposit = false, askDeposit = null, onDeposit = () => {}, onStep = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  const locks = await locksFor(round, client, donationMsat);
  const deposits = [];
  for (let tries = 0; ; tries++) {
    const have = BigInt(await client.balanceMsat());
    const n = await needFor(client, LockClient, locks);
    onStep(`the player wallet holds ${have} msat; this round's locks need ${n.need === null ? 'more than that' : `${n.need} msat`}`);
    if (n.need !== null && have >= n.need) break;
    // THE PLAYER CHOOSES THE DEPOSIT (GROSS-INVOICE-2053): the page shows the offer - the tabs, the invoice, a close - and
    // this waits for whichever invoice is paid, then looks again; still short, the offer is shown again.
    if (askDeposit) {
      const offer = depositOffer({ client, stakeMsat: round.stakeMsat, haveMsat: have, needMsat: n.need, gateways, onDeposit });
      askDeposit(offer);
      onStep('waiting for the deposit into the player wallet');
      const d = await offer.claimed;
      deposits.push(d);
      depositRow(storage, round, d);
      continue;
    }
    if (tries >= 3) throw new Error(`after ${tries} deposits the player wallet holds ${have} msat and cannot fund this round's locks`);
    const shortBy = n.need !== null ? n.need - have : n.floor - have;
    // NEVER A DEPOSIT SMALLER THAN THE LOCKS' ALLOWANCE: a Lightning receive that small is refused (measured, 556 msat).
    const least = n.locks.reduce((t, m) => t + BigInt(LockClient.lockAllowanceMsat(String(m))), 0n);
    const asked = shortBy > least ? shortBy : least;
    // THE INVOICE AT ONCE (INSTANT-1527, the owner 2026-09-30 15:23: "PLAY to the deposit invoice is a Lightning payment").
    // Measured in a page on testnet4: the lock client's depositFor took 256.8 s - it searches the invoice amount with a
    // receive-fee quote over the network at every step - against 1.3 s for the receive itself. With `estimateDeposit`
    // the invoice is sized from the fees here: measured, gateway B's receive plus the claim took 31698 msat of 9899474
    // (0.32%); DEPOSIT_MARGIN_PPM and DEPOSIT_MARGIN_MSAT cover that with room, and what is over stays in the player's
    // own wallet. A credit that still falls short is topped up by this loop's next deposit.
    // GROSS (GROSS-INVOICE-2053): the invoice is the round's stake, never the shortfall less fee and donation
    const plan = estimateDeposit
      ? { invoice_msat: String(BigInt(round.stakeMsat || 0n) > 0n ? BigInt(round.stakeMsat) : asked), credited_msat: String(asked), gateway: '' }
      : JSON.parse(await client.depositFor(String(asked)));
    const invoice = JSON.parse(await client.receive(String(plan.invoice_msat), depositGateway(plan.gateway, gateways)));
    const d = { invoice: invoice.invoice, amountMsat: BigInt(plan.invoice_msat), creditsMsat: BigInt(plan.credited_msat) };
    deposits.push(d);
    onDeposit(d);
    onStep('waiting for the deposit into the player wallet');
    const final = await client.awaitReceive(invoice.operation);
    if (final !== 'Claimed') throw new Error(`the deposit into the player wallet was not claimed: ${final}`);
    depositRow(storage, round, d);
  }
  return { client, deposits, heldMsat: BigInt(await client.balanceMsat()) };
}

/**
 * THE STAKE, SPENT FROM THE PLAYER WALLET INTO THE ROUND'S LOCK (§24A.1, §23.1 steps 3-5). Opens the player wallet for
 * the round's federation - never a per-round wallet - and locks the net stake (and the fee lock, when Pick b's gate
 * says it pays) from its notes. It asks for NO deposit: a wallet short of the round's locks is refused by name, and
 * the top-up is `fundPlayerWallet`, before. Returns the outpoint and the contract (`lockFromClient`), the client that
 * holds it, and the wallet's balance before and after.
 */
export async function lockStake({ round, roundId, invite, seed, stake, claimKey, playerPubkey, LockClient,
  storage, donationMsat = 0n, onStep = () => {} } = {}) {
  paysIntoALock(round, invite, LockClient);
  if (!stake || namesNothing(stake.stakePoint)) throw new Error('a lock is to the stake\'s point, and this stake names none');
  if (!claimKey || !claimKey.ok || namesNothing(claimKey.claimPk))
    throw new Error('no claim key has its signer nodes\' attestation: a client must refuse to lock to a key without it (23.1 step 0)');
  if (!(playerPubkey instanceof Uint8Array) || playerPubkey.length !== 32)
    throw new Error('a lock refunds to the player\'s key, and that is 32 bytes');

  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  const { amount, feeGate, feeMsat } = await locksFor(round, client, donationMsat);
  const before = BigInt(await client.balanceMsat());
  const n = await needFor(client, LockClient, { amount, feeMsat });
  if (n.need === null || before < n.need)
    throw new Error(`no stake is locked to this round: the player wallet holds ${before} msat and this round's locks need `
      + `${n.need === null ? `at least ${n.floor}` : n.need} msat - top the player wallet up first; the stake itself asks for no deposit`);

  onStep(`the player wallet holds ${before} msat; locking ${amount} msat (and ${feeMsat} msat of node fee after it) from it`);
  onStep('locking the stake');
  const refundPk = refundKeyOf(playerPubkey);
  // A LOCK IS MADE FOR EXACTLY stake_expiry_blocks (§23.1 step 4, RULED the owner 2026-09-24: no margin).
  const delta = Number(round.stakeExpiryBlocks);
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

// THE WALLET'S HISTORY (the owner 2026-09-30 16:15: "Settings, under the balances, shows a transaction history. Every deposit,
// every withdrawal, and every deduction for a game stake. A stake row names the round"). APPEND-ONLY, ONE LIST PER
// FEDERATION, in the tab's vault under blwp.ledger.<federation id hex>: a deposit row once its receive is claimed
// (fundPlayerWallet), a stake row when saveLock keeps the lock (markLockCommitted adds its entry), a withdrawal row when a
// withdraw succeeds. Rows are what this tab did; nothing here asks the federation.
const LEDGER_PREFIX = 'blwp.ledger.';
const LEDGER_READ_PREFIX = 'blwp.ledger.read.';
const fedHexOf = (f) => (f instanceof Uint8Array ? toHex(f) : String(f || '')).toLowerCase();
export const ledgerKey = (federationId) => `${LEDGER_PREFIX}${fedHexOf(federationId)}`;
/** This federation's rows, oldest first, as kept. */
export function ledgerRows(storage, federationId) {
  try { const raw = storage && storage.getItem(ledgerKey(federationId)); const rows = raw ? JSON.parse(raw) : []; return Array.isArray(rows) ? rows : []; }
  catch { return []; }
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
 * THE STAKES THIS TAB KEPT BEFORE THE HISTORY EXISTED, READ ONCE (per federation): every blwp.lock.saved.<round>.<player>
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
    const m = /^blwp\.lock\.saved\.([0-9a-f]{64})\.([0-9a-f]{16})$/.exec(k);
    if (!m || rows.some((r) => r.kind === 'stake' && r.round === m[1] && r.player === m[2])) continue;
    let j; try { j = JSON.parse(storage.getItem(k)); } catch { continue; }
    rows.push({ atMs: null, kind: 'stake', round: m[1], player: m[2], entry: j.committedTo || null, msat: String(lockTotalMsat(j)), read: true });
    added++;
  }
  try { storage.setItem(ledgerKey(federationId), JSON.stringify(rows)); storage.setItem(flag, String(Date.now())); } catch { return 0; }
  return added;
}

const savedLockKey = (roundId, playerPubkey) => `blwp.lock.saved.${toHex(roundId)}.${toHex(playerPubkey).slice(0, 16)}`;

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
  }));
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
        fields: lockFieldsFromJson(j.feeLock.fields) } : null },
    committedTo: j.committedTo || null,
  };
}

/** A signer node committed the kept lock to `entryId`: from now on it is that entry's stake, not one to reuse. */
/**
 * WHAT A TAB DOES WITH THE LOCK IT KEPT FOR THIS ROUND, ON A RELOAD (6d, W4 hole 1). None:
 * a new join. One no signer node committed: the same stake and lock, no second deposit (W1b).
 * One a signer node COMMITTED to an entry: that signer node is taken and its stake is locked - measured
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
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/stake-lock?round=${toHex(roundId)}&refund=${refund}`);
      if (!r.ok) continue;
      for (const l of await r.json()) {
        const [txid, outIdx] = String(l.outpoint).split(':');
        if (!found.has(l.outpoint))
          found.set(l.outpoint, { outpoint: { txid: fromHex(txid), outIdx: BigInt(outIdx) }, fields: lockFieldsFromJson(l.fields), entryId: l.entryId });
      }
    } catch { /* a signer node that does not answer is one of several */ }
  }
  return [...found.values()];
}

/**
 * THE PLAYER'S REFUND, FROM THE SEED ALONE (§23.2: the default path - nobody
 * acts, the lock expires, the player's key takes it back). The seed gives the
 * round's player key and the lock client's secret; the signer nodes say where the lock
 * is; a fresh wallet under the seed's secret spends it with the player's key.
 * The guardians refuse it before the lock's expiration - reported, not thrown.
 */
export async function refundStake({ round, roundId, invite, seed, curve, LockClient, storage, nodes, fetcher = fetch,
  onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve });
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
  client: given = null, onStep = () => {} } = {}) {
  if (!round || !roundLocks(round)) throw new Error('this round names no federation, so its stake is not a lock');
  const player = playerFor({ ...round, id: roundId }, { seed, curve });
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
const PAYOUT_NOTE = 'blwp.payout.';

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
const STAKE_NOTE = 'blwp.stakeback.';

/**
 * WHAT A TAB STILL HAS TO COLLECT, KEPT IN THE TAB (6d). Measured before: a reload
 * after the signer nodes committed the entry lost the collect's state - the join's lock
 * branch is its only setter, and a reload does not pass it - and 60 s after the
 * settlement the federation still held the winner's 978000 msat payout and 980000
 * msat stake. So the join keeps, per round, what the collect needs (the round, the
 * invite, the signer nodes, the tab's seed, the lock), and the page collects from these
 * records on every load until both answers are final.
 */
export function saveCollect(storage, { roundIdHex, round, invite, nodes, seed, stakeLock = null } = {}) {
  try {
    const key = `${COLLECT_NOTE}${roundIdHex}`;
    const was = storage.getItem(key);
    const done = was ? (JSON.parse(was).done || null) : null;
    // THE LOCK IS FOR THE PANEL'S LINE ONLY - the collect finds the lock through the signer nodes.
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
 * A WITHDRAWAL CLAIMED ON ANOTHER DEVICE (spec §24, the owner 2026-09-14: alice plays on her
 * desktop, forgets to withdraw, and two hours later plays on her iPhone). The iPhone holds only
 * the seed. Each signer node lists the rounds it settled since `sinceMs` (/settled), each with the keys
 * its settlement pays and the refund keys of its verified locks; this seed's key for each round
 * is derived here and matched against them - the device asks nothing per round, so no signer node
 * learns which rounds it looks for. A matched round's contract is fetched (/round) and must be
 * its id and name a federation. Nothing is spent. Returns the rounds worth keeping - the page
 * keeps them and looks at them as its own.
 */
export async function findOwedRounds({ seed, curve, nodes = [], fetcher = fetch, sinceMs = 0, known = [] } = {}) {
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new Error('the rounds owed to a player are found from the player\'s 32-byte seed, and none was given');
  const base = (n) => String(n).replace(/\/+$/, '');
  const skip = new Set(known.map((h) => String(h).toLowerCase()));
  const listed = new Map();
  for (const node of nodes) {
    let got = null;
    try { const r = await fetcher(`${base(node)}/settled?since=${Math.max(0, Math.floor(Number(sinceMs) || 0))}`); if (r.ok) got = await r.json(); } catch { got = null; }
    for (const x of (got && Array.isArray(got.rounds) ? got.rounds : [])) {
      const id = String(x.id || '').toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(id) || skip.has(id)) continue;
      const l = listed.get(id) || { payouts: new Set(), refunds: new Set() };
      for (const k of x.payouts || []) l.payouts.add(String(k).toLowerCase());
      for (const k of x.refunds || []) l.refunds.add(String(k).toLowerCase());
      listed.set(id, l);
    }
  }
  const found = [];
  for (const [id, l] of listed) {
    const mine = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve }).pubkey));
    const payout = l.payouts.has(mine); const lock = l.refunds.has(mine);
    if (!payout && !lock) continue;
    let round = null;
    for (const node of nodes) {
      try {
        const r = await fetcher(`${base(node)}/round?id=${id}`);
        if (!r.ok) continue;
        const c = decodeRoundContract(new Uint8Array(await r.arrayBuffer()));
        if (toHex(roundIdOf(c)) === id && roundLocks(c)) { round = c; break; }
      } catch { /* this signer node did not answer, or not with the round */ }
    }
    if (round) found.push({ roundIdHex: id, round, payout, lock });
  }
  return found;
}

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
export async function withdrawCollected({ client, invoiceFor, amountMsat = null, onStep = () => {} } = {}) {
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
  const said = JSON.parse(await client.withdraw(inv.invoice));
  const ok = said.state === 'Success';
  return { ok, final: ok, withdrawableMsat: withdrawable, invoiceMsat: said.invoice_msat == null ? null : BigInt(said.invoice_msat),
    state: said.state, gateway: said.gateway, balance_before: said.balance_before, balance_after: said.balance_after,
    why: ok ? undefined : `the withdraw ended ${said.state}${said.state === 'Refunded' ? ' - the money is back in this tab\'s wallet' : ''}` };
}

/**
 * THE WITHDRAW FROM THE PLAYER WALLET (§24A.1: the player "withdraws from over a Lightning invoice whenever he likes, in
 * any amount"; RULED the owner 2026-09-25). The one wallet per seed and federation, opened as the stake opens it, handed to
 * the same withdraw the round's wallet uses (`withdrawCollected`): its whole withdrawable balance to an invoice from the
 * player's own Lightning wallet. A spend - called from the Withdraw press alone, never on a timer.
 */
export async function withdrawPlayerWallet({ round, invite, seed, LockClient, storage, invoiceFor, amountMsat = null, onStep = () => {} } = {}) {
  const client = await playerWallet({ round, invite, seed, LockClient, storage, onStep });
  let out;
  try { out = await withdrawCollected({ client, invoiceFor, amountMsat, onStep }); } catch (e) {
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
 * player withdraws: the settlement (the payout to this key), the signer nodes' /stake-lock and
 * /forfeit (the stake back), and the federation's read-only lockStatus (a lock no signer node will
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
      // NO SIGNER NODE KNOWS THE LOCK (refused at the door) OR NO SETTLEMENT YET: the tab's own record,
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
