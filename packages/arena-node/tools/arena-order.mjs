// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * ONE MARKET ORDER FROM A SCRIPT'S OWN WALLET (kanban #736): what market-bot.mjs does for each rung, as a module with no environment of
 * its own - the wallet (the page's wasm lock client, its notes in a file), the order (the stake and fee locks in the federation, the
 * handout to the seated signer nodes, the entry with its pick and limit handed to the round's seats), its cancel (the entry's session
 * key over cancelId, POST /cancel at every seat) and what it won (page-lock.js lookOwed / collectOwed). The Polymarket adapter
 * (polymarket-adapter.mjs) places every order through this; market-bot.mjs keeps its own copy of the same steps.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { feldmanGroup } from '../src/curve.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { attestedClaimKey, playerFor, feeBpsForRound } from '../../arena-client/src/join.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { pageCurve } from '../../arena-client/src/page-curve.js';
import { clientSettlementSignerNodes } from '../../arena-client/src/committee.js';
import { decodeRoundContract, roundId, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { feeLockPays } from '../../arena-protocol/src/lock-settlement.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { cancelId } from '../../arena-protocol/src/order-book.js';
import { lockEntry } from './entry-locks.mjs';
import { saveLock, lookOwed, collectOwed } from '../../arena-client/src/page-lock.js';

const rand = (n) => new Uint8Array(randomBytes(n));

/** A file-backed storage with the page's localStorage shape (page-lock.js saveLock reads and writes it). */
export function fileStorage(file) {
  const kv = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const write = () => { const t = `${file}.tmp`; writeFileSync(t, JSON.stringify(kv), { mode: 0o600 }); renameSync(t, file); };
  return { getItem: (k) => (Object.prototype.hasOwnProperty.call(kv, k) ? kv[k] : null), setItem: (k, v) => { kv[k] = String(v); write(); }, removeItem: (k) => { delete kv[k]; write(); } };
}

/**
 * THE WALLET: the wasm lock client joined to the invite's federation, its notes in `dir`/wallet.json (written once per turn of the
 * event loop, as market-bot.mjs writes them - kanban #601), its seed in `dir`/seed.hex. Answers { lc, LockClient, seed, federation (hex),
 * invite, storage, balanceMsat() }.
 */
export async function openWallet({ dir, invitePath, wasmPkg }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
  const esm = join(tmpdir(), `arena-lock-client-${process.pid}.mjs`);
  copyFileSync(`${wasmPkg}/blwp_lock_client.js`, esm);
  const wasmMod = await import(esm);
  await wasmMod.default({ module_or_path: readFileSync(`${wasmPkg}/blwp_lock_client_bg.wasm`) });
  const { LockClient } = wasmMod;
  const file = join(dir, 'wallet.json');
  const held = new Map(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);
  let due = false;
  const write = () => { due = false; const t = `${file}.tmp`; writeFileSync(t, JSON.stringify([...held]), { mode: 0o600 }); renameSync(t, file); };
  const later = () => { if (!due) { due = true; setImmediate(write); } };
  const store = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); later(); }, remove: (k) => { held.delete(k); later(); } };
  const seedFile = join(dir, 'seed.hex');
  if (!existsSync(seedFile)) writeFileSync(seedFile, toHex(rand(32)), { mode: 0o600 });
  const seed = Uint8Array.from(Buffer.from(readFileSync(seedFile, 'utf8').trim(), 'hex'));
  const invite = readFileSync(invitePath, 'utf8').replace(/["\s]/g, '');
  const federation = String(LockClient.federationIdOf(invite)).toLowerCase();
  const lc = await LockClient.join(invite, federation, toHex(seed), store);
  return { lc, LockClient, seed, federation, invite, storage: fileStorage(join(dir, 'storage.json')), balanceMsat: async () => BigInt(await lc.balanceMsat()) };
}

/** The round's contract from the first seat that answers it, checked to hash to its id. */
export async function fetchRound(nodes, roundHex) {
  let why = 'no seat answered';
  for (const n of nodes) {
    try {
      const r = await fetch(`${n}/round?id=${roundHex}`, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) { why = `${n} answered ${r.status}`; continue; }
      const c = decodeRoundContract(new Uint8Array(await r.arrayBuffer()));
      const rid = roundId(c);
      if (toHex(rid) !== roundHex) throw new Error(`${n} answered another round`);
      return { c, rid };
    } catch (e) { why = e.message; }
  }
  throw new Error(`round ${roundHex.slice(0, 16)}: ${why}`);
}

/**
 * PLACE ONE ORDER (market-bot.mjs placeOrder, kanban #581/#601/#605): `outcome` 0 or 1, `price` on PRICE_SCALE, `stakeMsat` the whole
 * stake (fee included), `orderIndex` this wallet's order number in the round (the order's own key derives from it), `expiryMs` 0 for
 * GTC. The claim key and the seated signer nodes are read once per round (`kept`, a Map the caller holds). Answers
 * { entry (hex), session (hex secret), player (hex), took, needed, ms } or throws with the seats' reason.
 */
export async function placeOrder({ nodes, wallet, roundHex, outcome, price, stakeMsat, orderIndex, expiryMs = 0n, bot = true, kept = new Map(), seatLimitMs = 30000, log = () => {} }) {
  const t0 = Date.now();
  const { c, rid } = kept.get(`${roundHex}:round`) || await fetchRound(nodes, roundHex);
  kept.set(`${roundHex}:round`, { c, rid });
  if (BigInt(Date.now()) >= c.entryCloseMs) throw new Error(`the market closed at ${new Date(Number(c.entryCloseMs)).toISOString()}`);
  // seated before anything is paid (§5A.7): the seating certificate's settlement committee, not the contract's nodes
  let seated = kept.get(`${roundHex}:seated`);
  if (!seated) { seated = await clientSettlementSignerNodes(roundHex, c, nodes, { curve: pageCurve }); kept.set(`${roundHex}:seated`, seated); }
  const signers = seated.signerNodes;
  if (!signers || !signers.length) throw new Error('that round has no signer nodes yet');
  let att = kept.get(`${roundHex}:claim`);
  if (!att) { att = await attestedClaimKey({ round: { ...c, id: rid }, signerNodes: signers, nodes, curve: pageCurve }); if (att.ok) kept.set(`${roundHex}:claim`, att); }
  if (!att.ok) throw new Error(`claim key: ${att.why}`);
  const r = { ...c, orderStakeMsat: stakeMsat };
  const feeBps = feeBpsForRound(r);
  const feeMsat = entryFeeMsat(stakeMsat, feeBps);
  const split = { feeMsat, donationMsat: 0n, netMsat: netStakeMsat({ stakeMsat, feeMsat, donationMsat: 0n }), shares: [], reserveKey: null };
  const rule = JSON.parse(await wallet.lc.feeRule());
  const gate = feeLockPays({ contract: c, fees: { ppm: BigInt(rule.fee_ppm), baseMsat: BigInt(rule.fee_base_msat) }, feeBps });
  const have = await wallet.balanceMsat();
  if (have < stakeMsat + 200000n) throw new Error(`the wallet holds ${have} msat and this order needs ${stakeMsat + 200000n} (stake and the federation's fee): deposit first`);
  const player = playerFor({ ...r, id: rid }, { seed: wallet.seed, curve: feldmanGroup, order: orderIndex }).pubkey;
  const p = (() => { for (;;) { const s = rand(32); const v = scalarFrom32(s); if (v > 0n && v < FIELD) return s; } })();
  const point = feldmanGroup.pointFromScalar(scalarFrom32(p) % FIELD);
  const locks = await lockEntry({ lc: wallet.lc, c: { ...c, stakeMsat }, split, stakePoint: point, player, claimPk: att.claimPk, gate, rand, expiry: Number(c.stakeExpiryBlocks), submitOnly: true });
  const needed = receiptsNeeded(signers.length), e = rand(32);
  const dealt = await dealHandout({ preimage: p, signerNodes: signers, roundId: rid, playerPubkey: player, ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e),
    coefficients: Array.from({ length: needed - 1 }, () => scalarFrom32(rand(32)) % FIELD), needed, curve: feldmanGroup });
  saveLock(wallet.storage, { roundId: rid, playerPubkey: player, stake: { preimage: p, body: encodeHandout(dealt.handout) }, lock: { outpoint: locks.stake.outpoint,
    fields: locks.stake.fields, feeLock: locks.fee ? { preimage: locks.fee.preimage, outpoint: locks.fee.outpoint, fields: locks.fee.fields } : null } });
  const session = ed25519.utils.randomSecretKey();
  const entry = { roundId: rid, playerPubkey: player, sessionPubkey: ed25519.getPublicKey(session), stakeCommitment: sha256(p), stakeMsat,
    feeMsat: split.feeMsat, donationMsat: split.donationMsat, joinTick: 0, worldSecret: new Uint8Array(32), vssSharesRef: handoutId(dealt.handout),
    stakePoint: dealt.handout.commitments[0], ...locks.entryFields, claimKeyAttestationRef: att.ref,
    pick: Number(outcome), limitPrice: Number(price), orderExpiryMs: BigInt(expiryMs || 0), bot: !!bot };
  const eid = entryId(entry);
  // EVERY SEAT AT ONCE, the order standing once `needed` hold its lock (market-bot.mjs, kanban #605)
  const accepted = (locks.accepted || Promise.resolve());
  const limit = () => AbortSignal.timeout(seatLimitMs);
  const said = [];
  let held = 0, enough;
  const enoughHeld = new Promise((ok) => { enough = ok; });
  const all = Promise.all(nodes.map(async (n) => {
    try {
      await fetch(`${n}/handout`, { method: 'POST', body: encodeHandout(dealt.handout), signal: limit() });
      const en = await fetch(`${n}/entry`, { method: 'POST', body: encodeEntryContract(entry), signal: limit() });
      if (en.status < 200 || en.status >= 300) { said.push({ seat: n, entry: en.status, why: (await en.text()).trim().slice(0, 200) }); return; }
      await accepted;
      if (locks.fee) await fetch(`${n}/fee-lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(locks.fee.fields)), signal: limit() });
      const l = await fetch(`${n}/lock?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(locks.stake.fields)), signal: limit() });
      said.push({ seat: n, entry: en.status, lock: l.status, ...(l.ok ? {} : { why: (await l.text()).trim().slice(0, 200) }) });
      if (l.ok && ++held >= needed) enough();
    } catch (x) { said.push({ seat: n, why: x.message.slice(0, 120) }); }
  }));
  await Promise.race([enoughHeld, all]);
  all.catch(() => {});
  const took = said.filter((x) => x.lock >= 200 && x.lock < 300).length;
  log({ step: 'order', round: roundHex.slice(0, 16), entry: toHex(eid).slice(0, 16), took, needed, ms: Date.now() - t0, said });
  if (took < needed) throw new Error(`the seats did not take the order: ${took} of ${needed} needed took its lock; ${(said.find((x) => x.why) || {}).why || 'no reason given'}`);
  return { entry: toHex(eid), session: toHex(session), player: toHex(player), took, needed, ms: Date.now() - t0, windowEndMs: Number(c.entryCloseMs) };
}

/** CANCEL AN ORDER: the entry's session key over cancelId, POST /cancel?entry= at every seat; answers the seats that took it. */
export async function cancelOrder({ nodes, roundHex, entryHex, session }) {
  const sig = ed25519.sign(cancelId({ roundId: fromHex(roundHex), entryId: fromHex(entryHex) }), fromHex(session));
  const said = await Promise.all(nodes.map((n) => fetch(`${n}/cancel?entry=${entryHex}`, { method: 'POST', body: sig, signal: AbortSignal.timeout(10000) })
    .then(async (r) => ({ seat: n, status: r.status, why: r.ok ? '' : (await r.text()).trim().slice(0, 160) })).catch((e) => ({ seat: n, status: 0, why: e.message.slice(0, 80) }))));
  const took = said.filter((x) => x.status >= 200 && x.status < 300).length;
  return { ok: took > 0, took, said };
}

/** WHAT AN ORDER WON, COLLECTED into the wallet (page-lock.js lookOwed / collectOwed): { final, payoutMsat, stakeMsat, refundMsat }. */
export async function collectOrder({ nodes, wallet, roundHex, orderIndex, kept = new Map() }) {
  const { c, rid } = kept.get(`${roundHex}:round`) || await fetchRound(nodes, roundHex);
  kept.set(`${roundHex}:round`, { c, rid });
  const ask = { round: c, roundId: rid, invite: wallet.invite, seed: wallet.seed, curve: feldmanGroup, LockClient: wallet.LockClient, storage: wallet.storage, nodes, order: orderIndex };
  const look = await lookOwed({ ...ask, client: wallet.lc });
  if (look.payoutMsat > 0n || look.stakeMsat > 0n || look.refundMsat > 0n) await collectOwed({ look, client: wallet.lc, ...ask });
  return { final: !!look.final, payoutMsat: look.payoutMsat || 0n, stakeMsat: look.stakeMsat || 0n, refundMsat: look.refundMsat || 0n };
}
