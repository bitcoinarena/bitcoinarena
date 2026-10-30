// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/**
 * THE PLAYER'S DONATION, PAID (M3.2 item 6e; §22A, §24A.2, §27A.4; ruled
 * 2026-09-13).
 *
 * "Donations are paid: LNURL per recipient, by share, from the player's wallet
 * directly at entry - never through the federation" (§24A.2). Two halves:
 *
 * `fetchDonationSet` - the set the round names, as EVERY signer node of the round
 * serves it (a signer node that serves another, or none, is a refusal), signed by the
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
  decodeDonationSetBody, donationSetBodyId, decodeAuthorityRotation, authorityRotationId, authorityAt, donationSetInForce,
  DONATION_SIGNATURE_BYTES,
} from '../../arena-protocol/src/authority.js';
import { donationSetMatchesRound, donationSetId, decodeDonationSet, vestedShares } from '../../arena-protocol/src/donation.js';
import { decodeDonationProposal, decodeDonationApproval, approvedDonationSets } from '../../arena-protocol/src/donation-vote.js';
import { gameDonationSetIdOf } from '../../arena-protocol/src/known-game.js';
import { donationKeysForNetworkId } from '../../arena-protocol/src/donation-keys.js';
import { urlOfLnurl } from '../../arena-protocol/src/bech32.js';
import { roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { playerFor, TAB_SEED_KEY } from './join.js';
import { movedKey } from './storage-keys.js';

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
const DONATION_PAID_PREFIX = 'arena-donation-paid:';   // was blwp-donation-paid: (moved once by movedKey, kanban #522)
export const donationPaidKey = ({ roundId, playerPubkey }) => `${DONATION_PAID_PREFIX}${toHex(roundId)}:${toHex(playerPubkey)}`;

export function donationPaidRecord(storage, whose) {
  let raw;
  try { raw = storage && storage.getItem(movedKey(storage, donationPaidKey(whose))); } catch { return null; }
  if (!raw) return null;
  try { const o = JSON.parse(raw); return o && o.shares && typeof o.shares === 'object' ? o : null; } catch { return null; }
}

/** Answers false when the tab could not keep the note - and then the wallet must not be asked. */
export function noteDonationShare(storage, whose, lnurl, { amountMsat, ...note }) {
  try {
    const was = donationPaidRecord(storage, whose) || { shares: {} };
    was.shares[lnurl] = { ...note, amountMsat: String(amountMsat) };
    storage.setItem(movedKey(storage, donationPaidKey(whose)), JSON.stringify(was));
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
  // PAID WITH THE STAKE, IN THE FEDERATION (2026-10-03): a set of keys has no Lightning share to report one by one
  if (said.inLock) return { state: 'paid', inLock: true, paidMsat: said.paidMsat, unpaidMsat: 0n, shares: [], why: said.why };
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
  // PAID IN THE LOCK (a key-set round): no Lightning share to list, and paid all the same. Measured before this line: the
  // empty share list fell through to "Donation not paid: paid in the federation, in the same transaction as the stake".
  if (p.inLock && p.state === 'paid') return `Donation: ${msatOrSat(BigInt(p.paidMsat || 0n))} paid, ${p.why || 'in the stake lock'}`;
  if (!Array.isArray(p.shares) || !p.shares.length) return `Donation not paid: ${p.why || 'no answer'}`;
  const each = p.shares.map((s) => `${msatOrSat(s.amountMsat)} ${SHARE_WORD[s.state]} to ${s.url}`
    + (s.state === 'paid' ? '' : ` (${s.why})`));
  const kept = p.unpaidMsat > 0n ? ` · ${msatOrSat(p.unpaidMsat)} unpaid stays in your wallet, sent nowhere else` : '';
  return `Donation: ${each.join(' · ')}${kept}`;
}

const SHARE_OF_NOTE = { paid: 'paid', unpaid: 'unpaid', asked: 'unknown' };
const UNKNOWN_WHY = 'this tab asked its wallet for it before a reload and never heard the answer, so it is not asked again';

/**
 * THE DONATION AS THE TAB'S NOTES HAVE IT - NO SIGNER NODE, NO SET (M3.2 6e). Measured
 * before, on the daily page: a reload whose round link failed to fetch showed
 * the loading screen's refusal and nothing else - no wallet panel, no line -
 * while the notes held "paid 1334, unpaid 666". The line was painted only after
 * `payDonation`, which needs a signer node. The notes are what the wallet was asked and
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
const toHexOf = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
export function donationRecipientsLine(set) {
  // A ROUND'S TWO SETS: what the fetched answer carries as `gameSet` beside the network's
  if (set && set.set && Array.isArray(set.gameSet))
    return `Protocol devs (half): ${donationRecipientsLine(set.set).replace(/^Recipients: /, '')}; game dev (half): `
      + donationRecipientsLine({ recipients: set.gameSet }).replace(/^Recipients: /, '');
  if (!set || !Array.isArray(set.recipients)) return 'no donation set';
  return 'Recipients: ' + set.recipients.map((r) => {
    // A KEY IN THE FEDERATION (2026-10-03): its label and the key's first characters
    if (r.recipientPk instanceof Uint8Array) return `${(r.shareBps / 100).toFixed(2)}% to ${r.label || 'a dev'} (key ${toHexOf(r.recipientPk).slice(0, 12)}…, in the round's federation)`;
    let where;
    try { where = urlOfLnurl(r.lnurl); } catch { where = r.lnurl; }
    return `${(r.shareBps / 100).toFixed(2)}% to ${where}`;
  }).join(', ');
}

/**
 * THE DONATION SET THIS ROUND NAMES, AS ALL OF ITS SIGNER NODES SERVE IT, CHECKED.
 * `verifyEd25519(sig, msg, pub)` may be async (the browser's crypto.subtle);
 * every answer is awaited here before `authorityAt` sees a settled boolean.
 * `keys` overrides the network's donation keys (tests only).
 */
const DONATION_SETS_FETCHED = new Map();      // donation set id hex -> the answers that passed every check
const DONATION_ANSWER_MS = 6000;
const GAME_SETS_FETCHED = new Map();   // a game's donation set by its id: it proves itself, so it is read once a page
/** Forgets the game sets read (a test that serves a stray one). */
export const forgetGameSets = () => GAME_SETS_FETCHED.clear();
export const QUORUM_GRACE_MS = 250;
/** Every node's answer, or - once more than half served the same bytes and none refused - those in by QUORUM_GRACE_MS later, the rest
 *  as late ({ node, why, late: true }). An answer that refuses (not late) still waits for all, so the refusal is said as before. */
export function firstMajority(promises, names, { graceMs = QUORUM_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    const got = new Array(promises.length).fill(null);
    let left = promises.length, timer = null, done = false;
    const finish = () => { if (done) return; done = true; clearTimeout(timer); resolve(got.map((a, i) => a || { node: names[i], why: `no answer within ${graceMs} ms of the others`, late: true })); };
    const check = () => {
      if (left === 0) return finish();
      const served = got.filter((a) => a && a.bytes);
      if (timer || got.some((a) => a && !a.bytes && !a.late) || served.length * 2 <= promises.length) return;
      const first = served[0].bytes;
      const same = (x) => x.length === first.length && x.every((v, i) => v === first[i]);
      if (served.every((a) => same(a.bytes))) timer = setTimeout(finish, graceMs);
    };
    promises.forEach((p, i) => p.then((a) => { got[i] = a; left--; check(); }, (e) => { got[i] = { node: names[i], why: String(e && e.message ? e.message : e) }; left--; check(); }));
  });
}
const donationWithinMs = (p, ms) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(`no answer in ${ms} ms`), { late: true })), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

// a recipient's ballot signature (§27A.4.1): secp256k1 ECDSA over the tagged digest, by the developers' own keys - the page's curve
// bundle (page-curve.js verifyEcdsa, window.ARENA_CURVE), as every curve operation of this client is injected
const pageSecp256k1Verify = (sig, digest, key) => { const c = globalThis.ARENA_CURVE; try { return !!(c && c.verifyEcdsa && c.verifyEcdsa(sig, digest, key)); } catch { return false; } };

export async function fetchDonationSet({ round, nodes, fetcher = (u) => fetch(u), verifyEd25519, keys, keepBySet = false, verifySecp256k1 = pageSecp256k1Verify } = {}) {
  if (!round || !(round.donationSetId instanceof Uint8Array)) return { ok: false, why: 'there is no round to fetch a donation set for' };
  if (typeof verifyEd25519 !== 'function') return { ok: false, why: 'checking a donation set needs an Ed25519 verifier, and none was injected' };
  const networkKeys = keys || donationKeysForNetworkId(round.networkId);
  if (!networkKeys) return { ok: false, why: 'this round\'s network has no donation authority this page knows' };
  if (!Array.isArray(nodes) || !nodes.length) return { ok: false, why: 'the round names no signer nodes to ask for its donation set' };
  const rid = toHex(round.id instanceof Uint8Array && round.id.length === 32 ? round.id : roundId(round));
  // ONE FETCH PER DONATION SET, AND NO NODE HOLDS THE JOIN (measured 2026-10-14 04:26Z on testnet4): every round
  // of a network names the same set, yet each join asked all 14 seats again and waited for the slowest - 30 s, past an
  // 8 s RPS table. A set fetched and checked is kept by its id when the page asks for that (keepBySet; every check below still runs against each round); a node
  // that does not answer in ANSWER_MS is left out, as long as at least half the nodes answered and every answer agrees.
  const setKey = toHex(round.donationSetId);
  const kept = keepBySet ? DONATION_SETS_FETCHED.get(setKey) : null;
  // AND NO WAIT FOR THE SLOWEST (kanban #625, measured 2026-10-24 19:10Z: one seat stalled 3-5 s and every order waited for it - the
  // explorer showed fetchDonationSet 2.7 s, 4.5 s and 5.0 s of orders whose seats all answered in ms): once more than half the nodes
  // served the same set, the rest get QUORUM_GRACE_MS more and whoever has not answered by then is left out as late
  const answers = kept || (await firstMajority(nodes.map(async (node) => {
    const base = String(node).replace(/\/+$/, '');
    try {
      const r = await donationWithinMs(fetcher(`${base}/donation-set?round=${rid}`), DONATION_ANSWER_MS);
      if (r.status !== 200) return { node: base, why: `${r.status} ${(await r.text()).trim().slice(0, 100)}` };
      const bytes = new Uint8Array(await r.arrayBuffer());
      let rotations = [];
      try {
        const rr = await donationWithinMs(fetcher(`${base}/donation-rotations?round=${rid}`), DONATION_ANSWER_MS);   // bounded too: a set read, then a hung rotations read, held a join 38 s+ (04:11Z)
        if (rr.status === 200) rotations = (await rr.json()).rotations || [];
      } catch { rotations = []; }
      return { node: base, bytes, rotations };
    // A READ THAT NEVER GOT AN ANSWER (kanban #803: "Load failed" on a phone) is a node that did not answer, as one past ANSWER_MS is
    } catch (e) { return { node: base, why: e.message, late: true }; }
  }), nodes.map((node) => String(node).replace(/\/+$/, '')))).filter((a) => a.bytes || !a.late);
  const missing = answers.filter((a) => !a.bytes);
  if (missing.length)
    return { ok: false, why: `not every signer node of this round serves its donation set: ${missing.map((a) => `${a.node}: ${a.why}`).join('; ')}` };
  if (!kept && answers.length * 2 < nodes.length)
    return { ok: false, why: `only ${answers.length} of ${nodes.length} nodes served this round's donation set in ${DONATION_ANSWER_MS} ms` };
  const served = toHex(answers[0].bytes);
  if (answers.some((a) => toHex(a.bytes) !== served)) return { ok: false, why: 'the signer nodes of this round serve different donation sets' };
  // A SET ITS DEVELOPERS APPROVED (§27A.4.1): the nodes serve, as JSON, the admin key's set it replaces (signed,
  // checked below as any set) and the proposals and approvals since; this page tallies them itself
  let approval = null;
  let bytes = answers[0].bytes;
  if (bytes.length && bytes[0] === 0x7b) {
    try { approval = JSON.parse(new TextDecoder().decode(bytes)); } catch { approval = null; }
    if (!approval || approval.approved !== true || typeof approval.root !== 'string' || !Array.isArray(approval.chain))
      return { ok: false, why: 'the nodes serve a set its developers approved, and not the proof of it' };
    try { bytes = fromHex(approval.root); } catch { return { ok: false, why: 'the admin key\'s set behind the approved set is not hex' }; }
  }
  if (bytes.length <= DONATION_SIGNATURE_BYTES) return { ok: false, why: 'that is no signed donation set' };
  let set;
  try { set = { ...decodeDonationSetBody(bytes.slice(0, -DONATION_SIGNATURE_BYTES)), signature: bytes.slice(-DONATION_SIGNATURE_BYTES) }; }
  catch (e) { return { ok: false, why: `that is no donation set: ${e.message}` }; }
  if (toHex(set.networkId) !== toHex(round.networkId)) return { ok: false, why: 'that donation set is for another network' };
  if (!approval) {
    const named = donationSetMatchesRound(round, set.recipients);
    if (!named.ok) return { ok: false, why: named.why };
  }
  if (!(set.validFrom <= round.censusHeight)) return { ok: false, why: 'that donation set is not in force at the round\'s height' };

  // EVERY SIGNER NODE'S ROTATIONS, EACH CHECKED HERE against the network's recovery
  // key: a signer node that hides a rotation cannot hide it from the other signer nodes.
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
  if (approval) {
    // the ballots oldest first, each checked against the set it replaces; the set in force at the round's height must be the one it names
    let ballots;
    try {
      ballots = approval.chain.slice().reverse().map((c) => {
        const pb = fromHex(String(c.proposal));
        return { proposal: { ...decodeDonationProposal(pb.slice(0, -64)), signature: pb.slice(-64) },
          approvals: (c.approvals || []).map((h) => { const ab = fromHex(String(h)); return { ...decodeDonationApproval(ab.slice(0, -64)), signature: ab.slice(-64) }; }) };
      });
    } catch (e) { return { ok: false, why: `the developers' ballots served do not decode: ${e.message}` }; }
    const got = await approvedDonationSets({ networkId: round.networkId, known: [set], ballots, verifySecp256k1 });
    const now = donationSetInForce({ networkId: round.networkId, authority: inForce.authority, recovery: networkKeys.recovery, sets: [set], rotations: [],
      height: round.censusHeight, verify: (sig) => toHex(sig) === toHex(set.signature), approved: got.sets });
    if (!now.ok || !now.approvedBy) return { ok: false, why: `the developers' approvals served do not make a set in force at the round's height${got.refused.length ? ': ' + got.refused[0] : ''}` };
    const named = donationSetMatchesRound(round, now.recipients);
    if (!named.ok) return { ok: false, why: named.why };
    set = { networkId: set.networkId, serial: now.serial, validFrom: now.validFrom, recipients: now.recipients, approvedBy: now.approvedBy };
  }

  // AND THE GAME DEV'S SET (§0A.8): every signer node serves the one its round's game's manifest names, and it
  // is taken only if it hashes to the game_donation_set this page's own known-games list carries for that game - so a node
  // cannot route the game dev's half anywhere the developer did not sign.
  const wantGame = gameDonationSetIdOf(round.gameId);
  if (!wantGame) return { ok: false, why: 'this page knows no donation set of the round\'s game, so it pays no donation into the round' };
  // THE FIRST NODE WHOSE ANSWER HASHES TO IT (kanban #625, measured 2026-10-24 19:56Z: an order's fetchDonationSet took 11.3 s, every node
  // asked for the game's set and all of them waited on, unbounded): the set proves itself by its id, so one answer that hashes to
  // the id this page carries is the set - kept per game for the page's life; each node is asked within DONATION_ANSWER_MS
  let gameSet = GAME_SETS_FETCHED.get(wantGame) || null;
  if (!gameSet) {
    const tried = [];
    gameSet = await new Promise((resolve) => {
      let left = nodes.length;
      if (!left) resolve(null);
      for (const node of nodes) {
        const base = String(node).replace(/\/+$/, '');
        (async () => {
          const r = await donationWithinMs(fetcher(`${base}/game-donation-set?round=${rid}`), DONATION_ANSWER_MS);
          if (r.status !== 200) throw new Error(`${r.status} ${(await r.text()).trim().slice(0, 100)}`);
          const g = decodeDonationSet(new Uint8Array(await r.arrayBuffer()));
          if (toHex(donationSetId(g)) !== wantGame) throw new Error(`serves ${toHex(donationSetId(g)).slice(0, 16)}, not the set the game's manifest names (${wantGame.slice(0, 16)})`);
          return g;
        })().then((g) => resolve(g), (e) => { tried.push(`${base}: ${e.message}`); if (--left === 0) resolve(null); });
      }
    });
    if (!gameSet) return { ok: false, why: `no signer node of this round serves its game's donation set: ${tried.join('; ')}` };
    GAME_SETS_FETCHED.set(wantGame, gameSet);
  }
  if (keepBySet && !kept) DONATION_SETS_FETCHED.set(setKey, answers);
  // A SET THAT VESTS (§27A.4.1) pays its shares at the round's census height, as the seats split it
  return { ok: true, set, gameSet, target: { network: vestedShares(set.recipients, round.censusHeight), game: gameSet }, signerNodes: answers.length, rotated: inForce.rotated,
    why: `${answers.length} signer node(s) serve the set this round names, signed by its donation authority, and the game's set its manifest names` };
}
