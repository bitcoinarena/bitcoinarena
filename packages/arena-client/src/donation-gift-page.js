// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DONATION TO THE DEVELOPERS FROM THE PAGE (2026-10-17: "donate to developer, a popup opens with an amount to choose
// from 100, 500, 1000, 5000 satoshis or custom"; "B e cash"): the player's wallet pays the amount split over a donation set's keys in
// one federation transaction (paySubmit, the item shop's payment), the donor signs the record (protocol donation-gift.js) and the
// first seat that keeps it hands it on to every other. Nothing is paid before the split stands; every step that fails says which.
import { encodeDonationGift, donationGiftId, giftOutputs, GIFT_TO_GAME, GIFT_TO_NETWORK, GIFT_TO_PLAYER, GIFT_TO_BOTH, playerGiftRecipients, GIFT_MIN_SAT, GIFT_MAX_SAT } from '../../arena-protocol/src/donation-gift.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { recordDonation } from './page-lock.js';
import { handToSeats } from './item-buy.js';
import { PAID_GIFT_PREFIX, paidRecordGet, paidRecordPut, paidRecordDrop } from './paid-records.js';

/** Whether a typed amount is one the popup may pay: a whole number of sat from 1 to 10,000,000. Answers { ok, sat } or { ok: false, why }. */
export function giftAmountOf(typed) {
  const s = String(typed == null ? '' : typed).trim().replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(s)) return { ok: false, why: 'type a whole number of sat' };
  const sat = Number(s);
  if (sat < GIFT_MIN_SAT) return { ok: false, why: `at least ${GIFT_MIN_SAT} sat` };
  if (sat > GIFT_MAX_SAT) return { ok: false, why: `at most ${GIFT_MAX_SAT.toLocaleString('en-US')} sat at once` };
  return { ok: true, sat };
}

/** The recipients line the popup shows: each key's label and share, as the set names them. */
export const giftRecipientsLine = (set) => (Array.isArray(set) ? set : []).map((r) => `${r.label || toHex(r.recipientPk).slice(0, 10)} ${(Number(r.shareBps) / 100).toFixed(2).replace(/\.00$/, '')} %`).join(' · ');

/**
 * PAY AND RECORD ONE GIFT. `game` { gameDevPubkey, gameName } for a game's developers, or null for the protocol developers (the
 * network's set); `recipients` that set; `sat` the amount; `wallet` the player wallet's lock client in `federationId` (hex);
 * `donor` { pubkey, sign }; `seats` the base URLs. Answers { ok, id, txid, sat, outputs, keptBy } or { ok: false, step, why }.
 * A GIFT INSIDE AN APP (kanban #672: "If it's within an app 50% to protocol devs, 50% to game devs"): `game` with `networkSet` - the
 * protocol developers' set beside the app's `recipients` - pays half over each. `origin` tags where it was given ("site", "app:<name>").
 * `storage` the page's vault: once the federation holds the outputs, the wallet's history gets its row (kanban #682), whether a seat
 * keeps the record or not - the sats left the wallet either way.
 */
export async function giftDonation({ game = null, player = null, recipients, networkSet = null, origin = '', sat, wallet, federationId, donor, seats, fetch, storage = null, nowMs = () => Date.now() }) {
  const no = (step, why) => ({ ok: false, step, why });
  // A ZAP: the player's identity key is the target and the whole set
  if (player) { if (!(player instanceof Uint8Array) || player.length !== 32) return no('player', 'a zap names its player by a 32-byte identity key'); recipients = playerGiftRecipients(player); }
  const amt = giftAmountOf(sat); if (!amt.ok) return no('amount', amt.why);
  const totalMsat = BigInt(amt.sat) * 1000n;
  let outs;
  const both = !player && game && Array.isArray(networkSet);
  try { outs = both ? giftOutputs({ totalMsat, networkSet, gameSet: recipients }) : giftOutputs({ totalMsat, recipients }); } catch (e) { return no('split', e.message); }
  if (!wallet || typeof wallet.paySubmit !== 'function') return no('wallet', 'this page\'s wallet cannot pay keys (its lock client has no paySubmit)');
  // THE SAME GIFT PAID BEFORE AND ITS RECORD NOT KEPT (kanban #2274): this donor's next press of the same gift (target and amount) hands that
  // record again and pays nothing; any other gift is paid as before. Kept under arena.gift.<donor16>.<to>.<sat> from the payment's answer on.
  const to = player ? 'player:' + toHex(player) : game ? 'app:' + game.gameName : 'network';
  const keptKey = `${PAID_GIFT_PREFIX}${toHex(donor.pubkey).slice(0, 16)}.${to}.${amt.sat}`;
  const kept = paidRecordGet(storage, keptKey);
  if (kept && kept.submitted) return finishGift({ rec: kept, keptKey, storage, wallet, federationId, donor, fetch, again: true });
  if (kept) {   // written ahead, the page gone before the federation answered: the wallet history says whether it paid, so said once
    paidRecordDrop(storage, keptKey);
    return no('payment', `an earlier gift had no answer (the page closed while paying, ${new Date(Number(kept.atMs)).toISOString()}): look at the wallet history before giving again`);
  }
  const rec = { seats: [...(seats || [])], federationId, sat: amt.sat, outputs: outs.length, atMs: String(nowMs()), submitted: null, body: null,
    target: player ? GIFT_TO_PLAYER : both ? GIFT_TO_BOTH : game ? GIFT_TO_GAME : GIFT_TO_NETWORK, gameDevPubkey: toHex(player || (game ? game.gameDevPubkey : new Uint8Array(32))),
    gameName: !player && game ? game.gameName : '', origin: !player && origin ? String(origin).slice(0, 64) : '', to };
  try { paidRecordPut(storage, keptKey, rec); } catch (e) { return no('payment', `nothing paid: the gift could not be written ahead (${e && e.message || e})`); }
  try {
    rec.submitted = JSON.parse(await wallet.paySubmit(JSON.stringify(outs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image: toHex(donor.pubkey) })))));
  } catch (e) { paidRecordDrop(storage, keptKey); return no('payment', String(e && e.message || e)); }
  try { paidRecordPut(storage, keptKey, rec); } catch { /* the payment stands; the record is built and handed below */ }
  return finishGift({ rec, keptKey, storage, wallet, federationId, donor, fetch, again: false });
}

// THE PAID GIFT FINISHED (kanban #2274): its acceptance read back (the history row written once, then), the record signed and kept with its
// body, handed to every seat (kept when two keep it, #2420), and dropped only then. A gift kept from an earlier press goes on from where it stood.
async function finishGift({ rec, keptKey, storage, wallet, federationId, donor, fetch, again }) {
  const no = (step, why) => ({ ok: false, step, why });
  const txid = rec.submitted.txid;
  if (!rec.body) {
    if (rec.federationId !== federationId) return no('record', `an earlier gift was paid (transaction ${txid}) from federation ${rec.federationId.slice(0, 8)}: open that federation's wallet to finish its record, nothing is paid again`);
    let accepted;
    try { accepted = JSON.parse(await wallet.lockAccepted(JSON.stringify(rec.submitted))); } catch (e) { return no('record', `paid (transaction ${txid}), its acceptance not read yet (${String(e && e.message || e)}): pressed again, it is read again, never paid again`); }
    const held = accepted.donations || [];
    if (held.length !== rec.outputs || !held.every((d) => d.ids_match)) return no('payment', 'the federation does not hold the outputs as they were built');
    const totalMsat = BigInt(rec.sat) * 1000n;
    if (storage) recordDonation(storage, rec.federationId, { msat: totalMsat, txid, to: rec.to });
    const record = { target: rec.target, gameDevPubkey: fromHex(rec.gameDevPubkey), gameName: rec.gameName, ...(rec.origin ? { origin: rec.origin } : {}),
      donor: donor.pubkey, federationId: fromHex(rec.federationId), txid: fromHex(txid), totalMsat,
      outputs: held.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), atMs: BigInt(rec.atMs) };
    const id = donationGiftId(record);
    rec.id = toHex(id);
    rec.body = JSON.stringify({ gift: toHex(encodeDonationGift(record)), signature: toHex(donor.sign(id)) });
    try { paidRecordPut(storage, keptKey, rec); } catch { /* handed below; a failed hand-over is then kept in nothing but this answer's retry */ }
  }
  // TO EVERY SEAT, KEPT WHEN TWO KEEP IT (kanban #2420): one seat answering 200 first no longer buries the paid gift's record
  const { keptBy, last } = await handToSeats({ seats: rec.seats, door: 'donation-gift', body: rec.body, fetch });
  if (!keptBy) return { ok: false, step: 'record', paid: true, why: `${again ? 'an earlier gift was ' : ''}paid (transaction ${txid}), but no seat kept the record yet: ${last} - it is handed again, never paid again`, txid, retry: rec.body };
  paidRecordDrop(storage, keptKey);
  return { ok: true, id: rec.id, txid, sat: rec.sat, outputs: rec.outputs, keptBy, ...(again ? { earlier: true } : {}) };
}

/**
 * A ZAP FROM THE SEASON BOARD (2026-10-17: "zaps in the leaderboard go to the federation's account of the user not an
 * external lightning payment, remove the configuration setting"): `sat` from this wallet in `federationId` to the player whose identity
 * key the board names (32 bytes, `player`), as one payout contract to that key's refund key, recorded on the seats like a gift.
 */
export const zapPlayer = ({ player, sat, wallet, federationId, donor, seats, fetch, storage, nowMs }) => giftDonation({ player, sat, wallet, federationId, donor, seats, fetch, storage, nowMs });
