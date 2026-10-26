// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DONATION TO THE DEVELOPERS FROM THE PAGE (2026-10-17: "donate to developer, a popup opens with an amount to choose
// from 100, 500, 1000, 5000 satoshis or custom"; "B e cash"): the player's wallet pays the amount split over a donation set's keys in
// one federation transaction (paySubmit, the item shop's payment), the donor signs the record (protocol donation-gift.js) and the
// first seat that keeps it hands it on to every other. Nothing is paid before the split stands; every step that fails says which.
import { encodeDonationGift, donationGiftId, giftOutputs, GIFT_TO_GAME, GIFT_TO_NETWORK, GIFT_TO_PLAYER, GIFT_TO_BOTH, playerGiftRecipients, GIFT_MIN_SAT, GIFT_MAX_SAT } from '../../arena-protocol/src/donation-gift.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { recordDonation } from './page-lock.js';

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
  let submitted, accepted;
  try {
    submitted = JSON.parse(await wallet.paySubmit(JSON.stringify(outs.map((o) => ({ pk: toHex(o.pk), msat: String(o.msat), image: toHex(donor.pubkey) })))));
    accepted = JSON.parse(await wallet.lockAccepted(JSON.stringify(submitted)));
  } catch (e) { return no('payment', String(e && e.message || e)); }
  const held = accepted.donations || [];
  if (held.length !== outs.length || !held.every((d) => d.ids_match)) return no('payment', 'the federation does not hold the outputs as they were built');
  if (storage) recordDonation(storage, federationId, { msat: totalMsat, txid: submitted.txid, to: player ? 'player:' + toHex(player) : game ? 'app:' + game.gameName : 'network' });
  const record = { target: player ? GIFT_TO_PLAYER : both ? GIFT_TO_BOTH : game ? GIFT_TO_GAME : GIFT_TO_NETWORK, gameDevPubkey: player || (game ? game.gameDevPubkey : new Uint8Array(32)), gameName: !player && game ? game.gameName : '',
    ...(!player && origin ? { origin: String(origin).slice(0, 64) } : {}),
    donor: donor.pubkey, federationId: fromHex(federationId), txid: fromHex(submitted.txid), totalMsat,
    outputs: held.map((d) => ({ outIdx: Number(d.out_idx), pk: fromHex(d.recipient_pk), msat: BigInt(d.amount_msat) })), atMs: BigInt(nowMs()) };
  const id = donationGiftId(record);
  const body = JSON.stringify({ gift: toHex(encodeDonationGift(record)), signature: toHex(donor.sign(id)) });
  let keptBy = null, last = 'no seat to hand it to';
  for (const s of seats || []) {
    try {
      const r = await fetch(`${String(s).replace(/\/$/, '')}/donation-gift`, { method: 'POST', body, signal: AbortSignal.timeout(60000) });
      if (r.ok) { keptBy = s; break; }
      last = `${s}: ${r.status} ${(await r.text()).trim().slice(0, 200)}`;
    } catch (e) { last = `${s}: ${e.message}`; }
  }
  if (!keptBy) return { ok: false, step: 'record', why: `paid (transaction ${submitted.txid}), but no seat kept the record yet: ${last}`, txid: submitted.txid, retry: body };
  return { ok: true, id: toHex(id), txid: submitted.txid, sat: amt.sat, outputs: outs.length, keptBy };
}

/**
 * A ZAP FROM THE SEASON BOARD (2026-10-17: "zaps in the leaderboard go to the federation's account of the user not an
 * external lightning payment, remove the configuration setting"): `sat` from this wallet in `federationId` to the player whose identity
 * key the board names (32 bytes, `player`), as one payout contract to that key's refund key, recorded on the seats like a gift.
 */
export const zapPlayer = ({ player, sat, wallet, federationId, donor, seats, fetch, storage, nowMs }) => giftDonation({ player, sat, wallet, federationId, donor, seats, fetch, storage, nowMs });
