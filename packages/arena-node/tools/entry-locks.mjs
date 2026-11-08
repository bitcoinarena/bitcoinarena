// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE LOCKS A HEADLESS ENTRY PAYS, AS THE PAGE MAKES THEM: the live tools tn4-live-run.mjs and tn4-rps-paid.mjs
// built every entry the pre-11 way - a 5 % fee, no donation - and on the first protocol-11 day every seat refused it ("entry refused:
// reserves: on protocol version 11 the node fee is 4000 msat (4 %), not 5000"). Below protocol 11: the stake lock and, when the round
// mints one, the fee lock. From 11 (reserves.js paysReserves): one transaction - stake, fee lock, the developers' outputs over the
// round's two donation sets and 2 % to the federation's reserve key - as page-lock.js's lockSubmit, and the entry names its outputs.
import { lockFromClient } from '../../arena-client/src/lock-result.js';
import { donationKeyShares } from '../../arena-client/src/page-lock.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { paysReserves, roundSplit } from '../../arena-protocol/src/reserves.js';
import { decodeDonationSet } from '../../arena-protocol/src/donation.js';
import { decodeDonationSetBody } from '../../arena-protocol/src/authority.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { namedClaims, namedClaimKeys, arenaLockFor, arenaLockFieldsToJson, arenaLockContractId, lockStallBlocks, fallbackAfterFor } from '../../arena-protocol/src/arena-lock.js';
import { networkOf } from '../../arena-protocol/src/constants.js';
import { roundId as roundIdOf } from '../../arena-protocol/src/contracts.js';

/**
 * What an entry of round `c` pays: { feeMsat, donationMsat, netMsat, shares, reserveKey }. From protocol 11 the reserve key is the one
 * at least `needed` seats name for the round's federation (GET /reserves), and the developers' part is split over the round's network
 * and game donation sets (GET /donation-set, /game-donation-set).
 */
export async function entrySplit({ c, roundHex, nodes, needed = 5, fetcher = fetch, reserveKeyHex = null }) {
  const stake = BigInt(c.stakeMsat);
  if (!paysReserves(c)) {
    const feeMsat = entryFeeMsat(stake);
    return { feeMsat, donationMsat: 0n, netMsat: netStakeMsat({ stakeMsat: stake, feeMsat, donationMsat: 0n }), shares: [], reserveKey: null };
  }
  const split = roundSplit(stake);
  const fed = toHex(c.federationId);
  const said = new Map();
  // A KEY READ BEFORE (the caller's own, kept per federation) saves asking every seat for it again
  if (reserveKeyHex) said.set(reserveKeyHex, needed);
  else await Promise.all(nodes.map(async (n) => {
    try {
      const f = ((await (await fetcher(`${n}/reserves`)).json()).federations || []).find((x) => x.federationId === fed && (x.key || x.reserveKey));
      if (f) said.set(f.key || f.reserveKey, (said.get(f.key || f.reserveKey) || 0) + 1);
    } catch { /* that seat says nothing */ }
  }));
  const best = [...said.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] < needed) throw new Error(`fewer than ${needed} seats name the reserve key of federation ${fed.slice(0, 16)}`);
  const reserveKey = fromHex(best[0]);
  const netBytes = new Uint8Array(await (await fetcher(`${nodes[0]}/donation-set?round=${roundHex}`)).arrayBuffer());
  const network = decodeDonationSetBody(netBytes.subarray(0, netBytes.length - 64)).recipients;
  const game = decodeDonationSet(new Uint8Array(await (await fetcher(`${nodes[0]}/game-donation-set?round=${roundHex}`)).arrayBuffer()));
  const devs = split.protocolDevsMsat + split.gameDevsMsat;
  const donationMsat = devs + split.reservesMsat;
  const shares = donationKeyShares(donationMsat, { network, game, reserve: { recipientPk: reserveKey, amountMsat: split.reservesMsat } });
  return { feeMsat: split.nodesMsat, donationMsat, netMsat: netStakeMsat({ stakeMsat: stake, feeMsat: split.nodesMsat, donationMsat }), shares, reserveKey };
}

/**
 * The entry's locks, made by the lock client `lc`: { stake: { outpoint, fields }, fee: { outpoint, fields, preimage } | null, entryFields }.
 * `entryFields` are what the entry names of them (stakeLockOutpoint, feeLockOutpoint, feePreimage, and from 11 donationOutpoints and
 * reserveOutpoint). `gate` is feeLockPays' answer; `expiry` the lock's blocks.
 */
// `submitOnly` (kanban #601: an order submitted before the guardians agree): the locks sent in one transaction and answered at once, with
// `accepted` the promise of the federation's acceptance - the caller hands the entry to the seats meanwhile, the locks after it
export async function lockEntry({ lc, c, split, stakePoint, player, claimPk, gate, expiry = 150, rand, submitOnly = false }) {
  const refundPk = refundKeyOf(player);
  const zero = { txid: new Uint8Array(32), outIdx: 0n };
  const F = gate.pays ? rand(32) : null;
  if (namedClaims(c)) return lockArena({ lc, c, split, stakePoint, player, refundPk, F, zero, submitOnly });
  if (!split.shares.length && !(submitOnly && typeof lc.lockSubmit === 'function')) {
    // THE STAKE AND THE FEE IN ONE TRANSACTION when the client has `lockBoth` (as the page's join, page-lock.js): one transaction
    // for the guardians to agree on, not two - kanban #576, measured 2026-10-23 10:3xZ: with 20 market bots, federation A's 7
    // guardians at ~0.7 core each and ~4 threads waiting on disk at any time, the work scaling with the transactions agreed
    if (F && typeof lc.lockBoth === 'function') {
      const both = JSON.parse(await lc.lockBoth(toHex(stakePoint), String(split.netMsat), toHex(sha256(F)), String(split.feeMsat), toHex(claimPk), toHex(refundPk), expiry));
      const stake = lockFromClient(both.stake, { point: stakePoint, claimPk, refundPk });
      const got = lockFromClient(both.fee, { hash: sha256(F), claimPk, refundPk });
      if (stake.fields.amountMsat !== split.netMsat) throw new Error(`the lock client locked ${stake.fields.amountMsat} msat of stake, not ${split.netMsat}`);
      if (got.fields.amountMsat !== split.feeMsat) throw new Error(`the lock client locked ${got.fields.amountMsat} msat as the fee, not ${split.feeMsat}`);
      const fee = { outpoint: got.outpoint, fields: got.fields, preimage: F };
      return { stake, fee, entryFields: { stakeLockOutpoint: stake.outpoint, feeLockOutpoint: fee.outpoint, feePreimage: F } };
    }
    const stake = lockFromClient(await lc.lock(toHex(stakePoint), String(split.netMsat), toHex(claimPk), toHex(refundPk), expiry),
      { point: stakePoint, claimPk, refundPk });
    let fee = null;
    if (F) {
      const got = lockFromClient(await lc.lockHash(toHex(sha256(F)), String(split.feeMsat), toHex(claimPk), toHex(refundPk), expiry), { hash: sha256(F), claimPk, refundPk });
      fee = { outpoint: got.outpoint, fields: got.fields, preimage: F };
    }
    return { stake, fee, entryFields: { stakeLockOutpoint: stake.outpoint, feeLockOutpoint: fee ? fee.outpoint : zero, feePreimage: fee ? F : new Uint8Array(32) } };
  }
  const sub = JSON.parse(await lc.lockSubmit(toHex(stakePoint), String(split.netMsat), F ? toHex(sha256(F)) : '', String(F ? split.feeMsat : 0n), toHex(claimPk),
    toHex(refundPk), Number(c.stakeExpiryBlocks), JSON.stringify(split.shares.map((d) => ({ pk: toHex(d.recipientPk), msat: String(d.amountMsat), image: toHex(player) })))));
  const outs = sub.outputs || [];
  const at = (o) => ({ txid: fromHex(sub.txid), outIdx: BigInt(o.out_idx) });
  const so = outs.find((o) => o.role === 'stake'), fo = outs.find((o) => o.role === 'fee');
  const dons = outs.filter((o) => o.role === 'donation');
  if (!so || BigInt(so.amount_msat) !== split.netMsat) throw new Error(`the lock client built ${so ? so.amount_msat : 'no'} msat of stake, not ${split.netMsat}`);
  if (dons.length !== split.shares.length) throw new Error(`the lock client built ${dons.length} donation outputs for ${split.shares.length} shares`);
  const accepted = lc.lockAccepted(JSON.stringify(sub));
  if (submitOnly) accepted.catch(() => {}); else await accepted;
  const stake = { outpoint: at(so), fields: { paymentImage: { kind: 'point', bytes: stakePoint }, amountMsat: BigInt(so.amount_msat), claimPk, refundPk, expiration: so.computed_expiration } };
  const fee = fo ? { outpoint: at(fo), fields: { paymentImage: { kind: 'hash', bytes: sha256(F) }, amountMsat: BigInt(fo.amount_msat), claimPk, refundPk, expiration: fo.computed_expiration }, preimage: F } : null;
  // the reserve share is the last (donationKeyShares puts it there, marked)
  const ri = split.shares.findIndex((d) => d.reserve);
  return { stake, fee, txid: sub.txid, ...(submitOnly ? { accepted } : {}), entryFields: { stakeLockOutpoint: stake.outpoint, feeLockOutpoint: fee ? fee.outpoint : zero, feePreimage: fee ? F : new Uint8Array(32),
    ...(dons.filter((_, i) => i !== ri).length ? { donationOutpoints: dons.filter((_, i) => i !== ri).map(at) } : {}),
    ...(ri >= 0 ? { reserveOutpoint: at(dons[ri]) } : {}) } };
}

/**
 * A PROTOCOL-27 ENTRY'S LOCKS (kanban #1044 B1, rulings #1131, #1134), as the page's lockArenaStake makes them: Arena locks naming the round, its
 * settlement seats' node keys in seat order and its threshold, stake and fee lock and the donations in one transaction (arenaLockSubmit), each
 * output checked against the id computed here. The fields carry `arena: true`, so the seats are handed an Arena lock.
 */
async function lockArena({ lc, c, split, stakePoint, player, refundPk, F, zero, submitOnly }) {
  if (typeof lc.arenaLockSubmit !== 'function') throw new Error('this round locks to an Arena lock (protocol 27), and this lock client has no arenaLockSubmit');
  const roundId = roundIdOf(c);
  const { seatKeys, threshold } = namedClaimKeys(c);
  const entry = { playerPubkey: player };
  const stakeFields = { ...arenaLockFor({ kind: 'stake', entry, roundId, seatKeys, threshold, amountMsat: split.netMsat, imageBytes: stakePoint }), refundPk };
  const feeFields = F ? { ...arenaLockFor({ kind: 'fee', entry, roundId, seatKeys, threshold, amountMsat: split.feeMsat, imageBytes: sha256(F) }), refundPk } : null;
  // THE FALLBACK HEIGHT (spec §23.2, kanban #1281): the lock client adds the round's network's stall_blocks to the guardians' count, as the page does
  const stallBlocks = lockStallBlocks(networkOf(c.networkId));
  if (!Number.isInteger(stallBlocks)) throw new Error('this round\'s network names no stall_blocks: no Arena lock is made for it');
  const asJson = (f) => { const j = arenaLockFieldsToJson({ ...f, expiration: 0, fallbackAfter: 0 }); delete j.expiration; delete j.fallbackAfter; j.stallBlocks = stallBlocks; return JSON.stringify(j); };
  const sub = JSON.parse(await lc.arenaLockSubmit(asJson(stakeFields), feeFields ? asJson(feeFields) : '', Number(c.stakeExpiryBlocks),
    JSON.stringify(split.shares.map((d) => ({ pk: toHex(d.recipientPk), msat: String(d.amountMsat), image: toHex(player) })))));
  if (sub.arena !== true) throw new Error('the lock client answered a stock lock for a round that locks to an Arena lock');
  const outs = sub.outputs || [];
  const at = (o) => ({ txid: fromHex(sub.txid), outIdx: BigInt(o.out_idx) });
  const built = (o, fields, what) => {
    if (!o) throw new Error(`the lock client built no ${what} lock`);
    const f = { ...fields, expiration: Number(o.computed_expiration), fallbackAfter: Number(o.computed_fallback_after), arena: true };
    if (f.fallbackAfter !== fallbackAfterFor(f.expiration, stallBlocks, Number(c.stakeExpiryBlocks))) throw new Error(`the lock client built another fallback height for the Arena ${what} lock than the count plus stall_blocks`);
    if (BigInt(o.amount_msat) !== f.amountMsat) throw new Error(`the lock client built ${o.amount_msat} msat of ${what}, not ${f.amountMsat}`);
    if (String(o.computed_contract_id).toLowerCase() !== toHex(arenaLockContractId(f))) throw new Error(`the lock client built another Arena ${what} lock than computed here`);
    return { outpoint: at(o), fields: f };
  };
  const stake = built(outs.find((o) => o.role === 'stake'), stakeFields, 'stake');
  const feeMade = feeFields ? built(outs.find((o) => o.role === 'fee'), feeFields, 'fee') : null;
  const fee = feeMade ? { ...feeMade, preimage: F } : null;
  const dons = outs.filter((o) => o.role === 'donation');
  if (dons.length !== split.shares.length) throw new Error(`the lock client built ${dons.length} donation outputs for ${split.shares.length} shares`);
  const accepted = lc.arenaLockAccepted(JSON.stringify(sub));
  if (submitOnly) accepted.catch(() => {}); else await accepted;
  const ri = split.shares.findIndex((d) => d.reserve);
  return { stake, fee, txid: sub.txid, ...(submitOnly ? { accepted } : {}), entryFields: { stakeLockOutpoint: stake.outpoint, feeLockOutpoint: fee ? fee.outpoint : zero, feePreimage: fee ? F : new Uint8Array(32),
    ...(dons.filter((_, i) => i !== ri).length ? { donationOutpoints: dons.filter((_, i) => i !== ri).map(at) } : {}),
    ...(ri >= 0 ? { reserveOutpoint: at(dons[ri]) } : {}) } };
}
