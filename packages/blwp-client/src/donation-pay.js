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
import { playerFor, TAB_SEED_KEY } from './join.js';

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

/**
 * EACH SHARE OF THE DONATION, AS THE PLAYER SEES IT (M3.2 6e): paid, unpaid
 * with its why, or outcome unknown - off `payDonation`'s answer, which on a
 * reload is read back from the tab's notes, so the screen says what the notes
 * say. In the set's order; a share that floored to 0 msat was owed nothing and
 * has no row. Measured before: the page kept `{ state, paidMsat, unpaid }` on
 * `window` and painted none of it - 0 of 2 shares on screen in every case.
 */
export function donationPaidState(set, said) {
  if (!said) return null;
  const recipients = set && Array.isArray(set.recipients) ? set.recipients : [];
  const noted = new Map();
  for (const p of said.paid || []) noted.set(p.lnurl, { state: 'paid', amountMsat: p.amountMsat });
  for (const f of said.failed || []) noted.set(f.lnurl, { state: 'unpaid', amountMsat: f.amountMsat, why: f.why });
  for (const u of said.unknown || []) noted.set(u.lnurl, { state: 'unknown', amountMsat: u.amountMsat, why: u.why });
  const shares = [];
  for (const r of recipients) {
    const s = noted.get(r.lnurl);
    if (!s) continue;
    let url;
    try { url = urlOfLnurl(r.lnurl); } catch { url = r.lnurl; }
    shares.push({ url, lnurl: r.lnurl, shareBps: r.shareBps, ...s });
  }
  const of = (st) => shares.filter((s) => s.state === st);
  const sum = (list) => list.reduce((t, s) => t + s.amountMsat, 0n);
  const paid = of('paid').length;
  const state = !shares.length ? (said.ok ? 'none' : 'error')
    : paid === shares.length ? 'paid'
      : paid ? 'part'
        : of('unpaid').length ? 'unpaid' : 'unknown';
  return { state, shares, paidMsat: sum(of('paid')), unpaidMsat: sum(of('unpaid')), unknownMsat: sum(of('unknown')), why: said.why };
}

const msatOrSat = (msat) => (msat % 1000n === 0n ? `${msat / 1000n} sat` : `${msat} msat`);
const SHARE_WORD = { paid: 'paid', unpaid: 'UNPAID', unknown: 'outcome unknown' };

/**
 * THE DONATION AS ONE LINE, so the page renders and does not compute. What is
 * unpaid stays in the player's wallet (ruled 2026-09-13: never sent to the
 * operator or the other recipient); an unknown share is said to be unknown.
 */
export function donationPaidLine(p) {
  if (!p || p.state === 'none') return '';
  if (p.state === 'paying') return 'Donation: paying each recipient its share…';
  if (!Array.isArray(p.shares) || !p.shares.length) return `Donation not paid: ${p.why || 'no answer'}`;
  const each = p.shares.map((s) => `${msatOrSat(s.amountMsat)} ${SHARE_WORD[s.state]} to ${s.url}`
    + (s.state === 'paid' ? '' : ` (${s.why})`));
  const kept = p.unpaidMsat > 0n ? ` · ${msatOrSat(p.unpaidMsat)} unpaid stays in your wallet, sent nowhere else` : '';
  return `Donation: ${each.join(' · ')}${kept}`;
}

const SHARE_OF_NOTE = { paid: 'paid', unpaid: 'unpaid', asked: 'unknown' };
const UNKNOWN_WHY = 'this tab asked its wallet for it before a reload and never heard the answer, so it is not asked again';

/**
 * THE DONATION AS THE TAB'S NOTES HAVE IT - NO SEAT, NO SET (M3.2 6e). Measured
 * before, on the daily page: a reload whose round link failed to fetch showed
 * the loading screen's refusal and nothing else - no wallet panel, no line -
 * while the notes held "paid 1334, unpaid 666". The line was painted only after
 * `payDonation`, which needs a seat. The notes are what the wallet was asked and
 * what it answered, so they are enough to say it. Null when the tab has none.
 */
export function donationNotedState(storage, whose) {
  const noted = donationPaidRecord(storage, whose);
  if (!noted) return null;
  const said = { ok: true, paid: [], failed: [], unknown: [] };
  const recipients = [];
  for (const [lnurl, n] of Object.entries(noted.shares)) {
    let amountMsat;
    try { amountMsat = BigInt(n.amountMsat); } catch { continue; }
    const as = SHARE_OF_NOTE[n.state];
    if (!as) continue;
    recipients.push({ lnurl });
    if (as === 'paid') said.paid.push({ lnurl, amountMsat });
    else if (as === 'unpaid') { said.failed.push({ lnurl, amountMsat, why: n.why || 'unpaid' }); said.ok = false; }
    else { said.unknown.push({ lnurl, amountMsat, why: UNKNOWN_WHY }); said.ok = false; }
  }
  if (!recipients.length) return null;
  return { ...donationPaidState({ recipients }, said), from: 'notes' };
}

/**
 * AND FOR THE ROUND A LINK NAMES, when the round itself cannot be reached: the
 * round id off the link, this tab's key for it from the tab's own seed (read,
 * never minted - a tab with no seed has donated nothing), and that key's notes.
 * Nothing is asked of a node or a wallet.
 */
export function notedDonationForLink(search, { storage, curve } = {}) {
  let hex = null;
  try { hex = new URLSearchParams(String(search || '')).get('round'); } catch { return null; }
  if (!hex || !/^[0-9a-f]{64}$/i.test(hex) || !storage) return null;
  let seedHex = null;
  try { seedHex = storage.getItem(TAB_SEED_KEY); } catch { return null; }
  if (!seedHex || !/^[0-9a-f]{64}$/i.test(seedHex)) return null;
  let player;
  try { player = playerFor({ id: fromHex(hex.toLowerCase()) }, { seed: fromHex(seedHex.toLowerCase()), curve }); } catch { return null; }
  return donationNotedState(storage, { roundId: player.roundId, playerPubkey: player.pubkey });
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
  if (!Array.isArray(nodes) || !nodes.length) return { ok: false, why: 'the round names no signer nodes to ask for its donation set' };
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
    return { ok: false, why: `not every signer node of this round serves its donation set: ${missing.map((a) => `${a.node}: ${a.why}`).join('; ')}` };
  const served = toHex(answers[0].bytes);
  if (answers.some((a) => toHex(a.bytes) !== served)) return { ok: false, why: 'the signer nodes of this round serve different donation sets' };
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
    why: `${answers.length} signer node(s) serve the set this round names, signed by its donation authority` };
}
