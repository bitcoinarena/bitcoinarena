/**
 * THE PLAYER'S DONATION, PAID (M3.2 item 6e; §22A, §24A.2, §27A.4; ruled
 * 2026-09-13).
 *
 * "Donations are paid: LNURL per recipient, by share, from the player's wallet
 * directly at entry - never through the federation" (§24A.2). Two halves:
 *
 * `fetchDonationSet` - the set the round names, as EVERY seat of the round
 * serves it (a seat that serves another, or none, is a refusal), signed by the
 * network's donation authority at the round's height with rotations included,
 * checked with Ed25519 (the authority's scheme). The page shows every
 * recipient from it before the wallet approves (§22A).
 *
 * `Client.payDonation(entry, set)` (client.js, beside `payStake`) - AN ENTRY AND
 * A SET, NEVER AN INVOICE. The amounts
 * come from `splitDonation` over the entry's own donation; each recipient's
 * endpoint is asked for its pay request and then for an invoice of exactly its
 * share, and only an invoice that is that share under the endpoint's own
 * metadata hash (LUD-06) reaches the wallet, through the same `payInvoice` the
 * stake uses. A failed share is reported and never redirected to the others
 * (§22A); the entry stands either way. A 0% entry pays nothing and asks nobody.
 *
 * MEASURED BEFORE: no LNURL, bech32 or BOLT11 code existed; `splitDonation`
 * had no caller; `pay_invoice` had one call site, the stake; a 2% donor's 2000
 * msat was taken by nobody.
 */
import {
  decodeDonationSetBody, donationSetBodyId, decodeAuthorityRotation, authorityRotationId, authorityAt,
  DONATION_SIGNATURE_BYTES,
} from '../../protocol/src/authority.js';
import { donationSetMatchesRound } from '../../protocol/src/donation.js';
import { donationKeysForNetworkId } from '../../protocol/src/donation-keys.js';
import { urlOfLnurl } from '../../protocol/src/bech32.js';
import { roundId } from '../../protocol/src/contracts.js';
import { toHex, fromHex } from '../../protocol/src/hash.js';

/**
 * WHAT THIS TAB HAS ALREADY ASKED ITS WALLET TO DONATE, per round and player
 * key, share by share (M3.2 6e). Measured before: the page's once-only flag
 * and its spend log were page memory while the lock, the chosen donation and
 * the wallet survived a reload in sessionStorage, so a reload over a kept lock
 * paid every share again.
 *
 * KEYED BY ROUND AND PLAYER, NOT BY ENTRY ID: a reload keeps the player's key
 * and draws a NEW entry (client.js, `join`), so an entry-id key would miss the
 * very reload it is for. One donation per player per round.
 *
 * A share's note is `asked` (written BEFORE the wallet is asked, so a tab that
 * dies mid-payment never asks twice), then `paid` or `unpaid`. Any note at all
 * means the share is not asked again.
 */
const DONATION_PAID_PREFIX = 'blwp-donation-paid:';
export const donationPaidKey = ({ roundId, playerPubkey }) => `${DONATION_PAID_PREFIX}${toHex(roundId)}:${toHex(playerPubkey)}`;

export function donationPaidRecord(storage, whose) {
  let raw;
  try { raw = storage && storage.getItem(donationPaidKey(whose)); } catch { return null; }
  if (!raw) return null;
  try { const o = JSON.parse(raw); return o && o.shares && typeof o.shares === 'object' ? o : null; } catch { return null; }
}

/** Answers false when the tab could not keep the note - and then the wallet must not be asked. */
export function noteDonationShare(storage, whose, lnurl, { amountMsat, ...note }) {
  try {
    const was = donationPaidRecord(storage, whose) || { shares: {} };
    was.shares[lnurl] = { ...note, amountMsat: String(amountMsat) };
    storage.setItem(donationPaidKey(whose), JSON.stringify(was));
    return true;
  } catch { return false; }
}

/** Every recipient of a set, with its share and where it is paid - what the page shows before the wallet approves. */
export function donationRecipientsLine(set) {
  if (!set || !Array.isArray(set.recipients)) return 'no donation set';
  return 'Recipients: ' + set.recipients.map((r) => {
    let where;
    try { where = urlOfLnurl(r.lnurl); } catch { where = r.lnurl; }
    return `${(r.shareBps / 100).toFixed(2)}% to ${where}`;
  }).join(', ');
}

/**
 * THE DONATION SET THIS ROUND NAMES, AS ALL OF ITS SEATS SERVE IT, CHECKED.
 * `verifyEd25519(sig, msg, pub)` may be async (the browser's crypto.subtle);
 * every answer is awaited here before `authorityAt` sees a settled boolean.
 * `keys` overrides the network's donation keys (tests only).
 */
export async function fetchDonationSet({ round, nodes, fetcher = (u) => fetch(u), verifyEd25519, keys } = {}) {
  if (!round || !(round.donationSetId instanceof Uint8Array)) return { ok: false, why: 'there is no round to fetch a donation set for' };
  if (typeof verifyEd25519 !== 'function') return { ok: false, why: 'checking a donation set needs an Ed25519 verifier, and none was injected' };
  const networkKeys = keys || donationKeysForNetworkId(round.networkId);
  if (!networkKeys) return { ok: false, why: 'this round\'s network has no donation authority this page knows' };
  if (!Array.isArray(nodes) || !nodes.length) return { ok: false, why: 'the round names no seats to ask for its donation set' };
  const rid = toHex(roundId(round));
  const answers = await Promise.all(nodes.map(async (node) => {
    const base = String(node).replace(/\/+$/, '');
    try {
      const r = await fetcher(`${base}/donation-set?round=${rid}`);
      if (r.status !== 200) return { node: base, why: `${r.status} ${(await r.text()).trim().slice(0, 100)}` };
      const bytes = new Uint8Array(await r.arrayBuffer());
      let rotations = [];
      try {
        const rr = await fetcher(`${base}/donation-rotations?round=${rid}`);
        if (rr.status === 200) rotations = (await rr.json()).rotations || [];
      } catch { rotations = []; }
      return { node: base, bytes, rotations };
    } catch (e) { return { node: base, why: e.message }; }
  }));
  const missing = answers.filter((a) => !a.bytes);
  if (missing.length)
    return { ok: false, why: `not every seat of this round serves its donation set: ${missing.map((a) => `${a.node}: ${a.why}`).join('; ')}` };
  const served = toHex(answers[0].bytes);
  if (answers.some((a) => toHex(a.bytes) !== served)) return { ok: false, why: 'the seats of this round serve different donation sets' };
  const bytes = answers[0].bytes;
  if (bytes.length <= DONATION_SIGNATURE_BYTES) return { ok: false, why: 'that is no signed donation set' };
  let set;
  try { set = { ...decodeDonationSetBody(bytes.slice(0, -DONATION_SIGNATURE_BYTES)), signature: bytes.slice(-DONATION_SIGNATURE_BYTES) }; }
  catch (e) { return { ok: false, why: `that is no donation set: ${e.message}` }; }
  if (toHex(set.networkId) !== toHex(round.networkId)) return { ok: false, why: 'that donation set is for another network' };
  const named = donationSetMatchesRound(round, set.recipients);
  if (!named.ok) return { ok: false, why: named.why };
  if (!(set.validFrom <= round.censusHeight)) return { ok: false, why: 'that donation set is not in force at the round\'s height' };

  // EVERY SEAT'S ROTATIONS, EACH CHECKED HERE against the network's recovery
  // key: a seat that hides a rotation cannot hide it from the other seats.
  const offered = new Map();
  for (const a of answers) for (const r of a.rotations) {
    try { offered.set(`${r.body}:${r.signature}`, { ...decodeAuthorityRotation(fromHex(String(r.body))), signature: fromHex(String(r.signature)) }); }
    catch { /* not a rotation: nothing to apply */ }
  }
  const rotations = [...offered.values()];
  const signedRotations = new Set();
  for (const rot of rotations)
    if (await verifyEd25519(rot.signature, authorityRotationId(rot), networkKeys.recovery) === true) signedRotations.add(toHex(rot.signature));
  const inForce = authorityAt({ networkId: round.networkId, authority: networkKeys.authority, recovery: networkKeys.recovery,
    rotations, height: round.censusHeight, verify: (sig) => signedRotations.has(toHex(sig)) });
  if (await verifyEd25519(set.signature, donationSetBodyId(set), inForce.authority) !== true)
    return { ok: false, why: 'that donation set is not signed by the network\'s donation authority at the round\'s height' };
  return { ok: true, set, seats: answers.length, rotated: inForce.rotated,
    why: `${answers.length} seat(s) serve the set this round names, signed by its donation authority` };
}
