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

/**
 * What an entry of round `c` pays: { feeMsat, donationMsat, netMsat, shares, reserveKey }. From protocol 11 the reserve key is the one
 * at least `needed` seats name for the round's federation (GET /reserves), and the developers' part is split over the round's network
 * and game donation sets (GET /donation-set, /game-donation-set).
 */
export async function entrySplit({ c, roundHex, nodes, needed = 5, fetcher = fetch }) {
  const stake = BigInt(c.stakeMsat);
  if (!paysReserves(c)) {
    const feeMsat = entryFeeMsat(stake);
    return { feeMsat, donationMsat: 0n, netMsat: netStakeMsat({ stakeMsat: stake, feeMsat, donationMsat: 0n }), shares: [], reserveKey: null };
  }
  const split = roundSplit(stake);
  const fed = toHex(c.federationId);
  const said = new Map();
  await Promise.all(nodes.map(async (n) => {
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
export async function lockEntry({ lc, c, split, stakePoint, player, claimPk, gate, expiry = 150, rand }) {
  const refundPk = refundKeyOf(player);
  const zero = { txid: new Uint8Array(32), outIdx: 0n };
  const F = gate.pays ? rand(32) : null;
  if (!split.shares.length) {
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
  await lc.lockAccepted(JSON.stringify(sub));
  const stake = { outpoint: at(so), fields: { paymentImage: { kind: 'point', bytes: stakePoint }, amountMsat: BigInt(so.amount_msat), claimPk, refundPk, expiration: so.computed_expiration } };
  const fee = fo ? { outpoint: at(fo), fields: { paymentImage: { kind: 'hash', bytes: sha256(F) }, amountMsat: BigInt(fo.amount_msat), claimPk, refundPk, expiration: fo.computed_expiration }, preimage: F } : null;
  // the reserve share is the last (donationKeyShares puts it there, marked)
  const ri = split.shares.findIndex((d) => d.reserve);
  return { stake, fee, txid: sub.txid, entryFields: { stakeLockOutpoint: stake.outpoint, feeLockOutpoint: fee ? fee.outpoint : zero, feePreimage: fee ? F : new Uint8Array(32),
    ...(dons.filter((_, i) => i !== ri).length ? { donationOutpoints: dons.filter((_, i) => i !== ri).map(at) } : {}),
    ...(ri >= 0 ? { reserveOutpoint: at(dons[ri]) } : {}) } };
}
