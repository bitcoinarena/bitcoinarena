// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHO THIS TAB IS IN THE LOBBY (M3.3-34): a key the page generated, a name
// made from that key, and the name the player chose instead, if they did.
//
// THE KEY COMES FROM THE TAB'S SEED - the seed every round's player key is
// derived from (§24, F2) - under its own tag (`identitySecretFor`), so it is
// never a round's key, and the seed backup the page already shows is the backup
// of this key too. The private half never leaves this module: the page is
// handed the public key and its fingerprint. Two tabs are two players, as they
// always were, because the seed is kept per tab.
//
// THE NAME DECIDES NOTHING. It is in no entry, no mark and no result; nothing a
// node replays reads it. The generated name is a function of the public key, so
// one key always shows one name, and a custom name is kept in the tab beside
// the seed - cleared, the generated one comes back.
//
// AND THE OTHER PLAYERS OF A ROUND ARE SHOWN IT: once joined, the tab hands the
// round's signer nodes one record - this round, the round key it is joined under, its
// identity key, the name it chose (empty for none) - signed with that round key
// (lobby-name.js). The other pages check each record before they draw its name,
// so a signer node can leave a name out but cannot write one, and nobody is shown a
// key in place of a name: no record, no name, only a count.
import { tabSeed, playerFor } from './join.js';
import { identitySecretFor } from '../../arena-protocol/src/player-key.js';
import { matchProofId, presenceId } from '../../arena-protocol/src/match.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { encodeLobbyName, decodeLobbyName, lobbyNameId, lobbyNameIsValid, LOBBY_NAME_MAX } from '../../arena-protocol/src/lobby-name.js';
import { displayNameFromKey } from '../../arena-protocol/src/display-name.js';
import { signEvent } from './nwc.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { encodeReferralName, referralNameId } from '../../arena-protocol/src/referral-name.js';

/** Where a tab keeps the name its player chose. */
export const CUSTOM_NAME_KEY = 'arena.player.name';

/** The longest name a player may choose, in characters - the signer nodes' rule too. */
export const PLAYER_NAME_MAX = LOBBY_NAME_MAX;

/**
 * THE NAME MADE FROM A PLAYER'S IDENTITY KEY: §0.12's one default,
 * adjective-animal-NNNN from display-name.js - the only wordlist that names a
 * player (ruled 2026-09-12: a second list here named one player twice). Made
 * from the tab's stable identity key, never a round key, so one player shows
 * one generated name in the lobby, on the board and in every round.
 */
export const generatedName = (identityPubkey) => displayNameFromKey(identityPubkey);

/** 64 bits of the identity key, grouped, for a player to recognise it by. */
export const identityFingerprint = (pubkey) => toHex(pubkey.subarray(0, 8)).match(/.{4}/g).join('-');

/**
 * WHETHER A CHOSEN NAME STANDS, and the name as it is kept: the protocol's
 * rule (lobby-name.js), so a signer node keeps exactly the names a page lets through.
 */
export const playerNameIsValid = lobbyNameIsValid;

/**
 * THE PLAYER'S OWN NAME, OVER THE GENERATED ONE - or, blank, back to the
 * generated one. A name that does not stand is refused and nothing is kept.
 */
export function setPlayerName(text, { storage } = {}) {
  if (!storage) throw new Error('a name is kept in the tab, and no storage was given');
  if (String(text == null ? '' : text).trim() === '') { storage.removeItem(CUSTOM_NAME_KEY); return { ok: true, custom: false }; }
  const checked = playerNameIsValid(text);
  if (!checked.ok) return checked;
  storage.setItem(CUSTOM_NAME_KEY, checked.name);
  return { ok: true, custom: true, name: checked.name };
}

/**
 * WHO THIS TAB IS: the identity key's public half and fingerprint, the
 * generated name, and the name shown - the player's own if they chose one.
 * The curve is injected, as everywhere in this bundle.
 */
export function tabIdentity({ storage, random, curve } = {}) {
  if (!curve || typeof curve.pointX !== 'function') throw new Error('an identity is a key on a curve, and none was injected');
  const seed = tabSeed({ storage, random });
  const pubkey = curve.pointX(identitySecretFor(seed));
  const generated = generatedName(pubkey);
  const kept = storage ? storage.getItem(CUSTOM_NAME_KEY) : null;
  const chosen = kept ? playerNameIsValid(kept) : null;
  const custom = !!(chosen && chosen.ok);
  return { pubkey, pubkeyHex: toHex(pubkey), fingerprint: identityFingerprint(pubkey), generated,
    name: custom ? chosen.name : generated, custom };
}

/**
 * A NOSTR EVENT SIGNED BY THIS TAB'S IDENTITY KEY: a zap request to another player, or the profile
 * (kind 0) that says where this player takes zaps. The key the season board and the badges name signs it, and its private
 * half still never leaves this module: the page hands a template `{ kind, tags, content }` and gets the signed event.
 */
export async function identitySignEvent(template, { storage, random, curve, now } = {}) {
  if (!curve || typeof curve.signSchnorr !== 'function') throw new Error('an event is signed with the identity key, and no signer was injected');
  const secret = identitySecretFor(tabSeed({ storage, random }));
  return signEvent({ kind: template.kind, tags: template.tags || [], content: String(template.content || ''), secret, curve, now });
}

/**
 * THE NAME THIS TAB HANDS THE SIGNER NODES OF A ROUND IT IS JOINED IN: the round, the
 * round key it is joined under, its identity key, the name the player chose -
 * empty for none, and the others are then shown the generated one - and now,
 * signed with that round key. The others are shown what this tab shows itself.
 */
// `order`: an order's own round key is the order-th the seed makes for the round (playerFor) - each order of a market is
// named under its own key, so the season counts every order under the player's identity
export function nameRecordFor(round, { storage, random, curve, nowMs = Date.now(), order = 0 } = {}) {
  if (!curve || typeof curve.signSchnorr !== 'function') throw new Error('a name is signed with the round key, and no signer was injected');
  const me = tabIdentity({ storage, random, curve });
  const seed = tabSeed({ storage, random });
  const player = playerFor(round, { seed, curve, order });
  const record = { roundId: player.roundId, playerPubkey: player.pubkey, identityPubkey: me.pubkey,
    name: me.custom ? me.name : '', atMs: BigInt(Math.floor(nowMs)) };
  // AND THE IDENTITY'S OWN CONSENT (kanban #1278, RULED #1276): the identity key over (round id, round key) - matchProofId with the round key in place of
  // the entry id. A round books to an identity on the season only with it; a record alone (signed by the round key) no longer books a round to anyone
  const identitySig = toHex(curve.signSchnorr(matchProofId({ roundId: player.roundId, entryId: player.pubkey, identityKey: me.pubkey }), identitySecretFor(seed)));
  return { record: toHex(encodeLobbyName(record)), sig: toHex(curve.signSchnorr(lobbyNameId(record), player.secret)), identitySig };
}

/** The signed record, handed to every signer node (POST /name); what each answered. */
export async function postName(signed, nodes, { fetcher = fetch } = {}) {
  const said = [];
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/name`, { method: 'POST', body: JSON.stringify(signed) });
      said.push({ node, status: r.status });
    } catch (e) { said.push({ node, status: 0, why: e.message }); }
  }
  return said;
}

/** The name a checked record shows: the one its player chose, or the one made from its identity key. */
export const shownNameOf = (record) => record.name || generatedName(record.identityPubkey);

/**
 * ONE ROUND'S PLAYERS BY NAME, CHECKED: each record decodes, is for THIS round,
 * and verifies under the player key it names; a player's newest record wins.
 * Anything else is dropped, never shown. `verify` is BIP-340, injected.
 * @returns {{ player: string, name: string, chosen: boolean }[]} by player key
 */
// THE SIGNATURE CHECKS ONE ROUND'S NAMES MAY COST, BOUNDED (kanban #1864, attacker audit r8): the lobby builds every row
// synchronously and re-reads every few seconds, and one seat's /rounds or /names answer was kept whole - 50,000 forged
// records for this round were 50,000 BIP-340 checks on the main thread each paint (a forgery is dropped only after its
// check). A round holds at most MAX_PLAYERS_PER_ROUND (64) players: a seat's list is cut to NAMES_PER_SEAT before it is
// merged, the same record from several seats is checked once, a record no newer than the one kept for its player is not
// checked at all, and one round's render runs at most NAME_CHECKS_MAX checks whatever the seats hand it.
export const NAMES_PER_SEAT = 128;
export const NAME_CHECKS_MAX = 512;

// A READ'S SHARE (kanban #2259, #2276): `budget`, when given, is { left } shared by every round of one lobby read - each check
// spends one, and none is run once it is spent - so the rounds one seat makes up cannot add NAME_CHECKS_MAX each per paint;
// with { perSeat: Map, share } too, each seat (an item's `by`) runs at most `share` of them (kanban #2342)
export function checkedNames(items, roundIdHex, verify, budget = null) {
  const newest = new Map();
  const seen = new Set();
  let checks = 0;
  for (const x of Array.isArray(items) ? items : []) {
    let record;
    try {
      const same = `${String(x && x.record)}|${String(x && x.sig)}`;
      if (seen.has(same)) continue;
      record = decodeLobbyName(fromHex(String(x && x.record)));
      if (toHex(record.roundId) !== String(roundIdHex).toLowerCase()) { seen.add(same); continue; }
      const had = newest.get(toHex(record.playerPubkey));
      if (had && record.atMs <= had.atMs) { seen.add(same); continue; }
      if (checks >= NAME_CHECKS_MAX) break;
      if (budget && !(budget.left > 0)) break;
      // A SEAT'S SHARE (kanban #2342): with `budget.perSeat` and `budget.share`, a name is charged to the seat that supplied it (`x.by`);
      // once that seat's share is spent its names are passed over unchecked - and not marked seen, so the same record from another seat
      // is still checked on that seat's share
      const by = budget && budget.perSeat && x && x.by !== undefined ? String(x.by) : null;
      if (by !== null && (budget.perSeat.get(by) || 0) >= budget.share) continue;
      seen.add(same);
      checks++;
      if (budget) budget.left--;
      if (by !== null) budget.perSeat.set(by, (budget.perSeat.get(by) || 0) + 1);
      if (!verify(fromHex(String(x.sig)), lobbyNameId(record), record.playerPubkey)) continue;
    } catch { continue; }
    newest.set(toHex(record.playerPubkey), record);
  }
  return [...newest.entries()].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([player, r]) => ({ player, name: shownNameOf(r), chosen: r.name !== '' }));
}

/**
 * The names a round's signer nodes keep (GET /names), checked as above. A signer node that
 * does not answer is one of several; when NONE answers that is an error, not
 * an empty round - a page that drew "nobody named" there would wipe the names
 * it had (measured: a busy page whose every ask timed out lost them).
 */
export async function namesOf({ roundId, nodes, fetcher = fetch, verify } = {}) {
  if (typeof verify !== 'function') throw new Error('names are checked against the players\' keys, and no verify was injected');
  const id = typeof roundId === 'string' ? roundId.toLowerCase() : toHex(roundId);
  const items = [];
  const refused = [];
  let answered = 0;
  for (const node of [...new Set(nodes || [])]) {
    try {
      const r = await fetcher(`${String(node).replace(/\/+$/, '')}/names?round=${id}`);
      if (!r.ok) { refused.push(`${node}: ${r.status}`); continue; }
      const body = await r.json();
      answered++;
      if (body && Array.isArray(body.names)) items.push(...body.names.slice(0, NAMES_PER_SEAT));   // kanban #1864: one seat's share, bounded
    } catch (e) { refused.push(`${node}: ${e.name === 'TimeoutError' ? 'no answer in time' : e.message}`); }
  }
  if (!answered) throw new Error(`no signer node answered for the names: ${refused.join('; ') || 'no signer nodes named'}`);
  return checkedNames(items, id, verify);
}

/**
 * A BOARD'S ROWS WITH THE NAME TO DRAW BESIDE EACH - presentation only. The
 * board (leaderboard.js) is built from signed finals and carries no name; this
 * puts each row's checked display name (`checkedNames`: the custom name, or the
 * generated one from the identity key its record carries) beside it by the
 * row's player key. A row whose player published no record gets none - never a
 * name made from its round key, which would rename that player every round.
 */
export function boardNames(rows, names) {
  const byPlayer = new Map((Array.isArray(names) ? names : []).map((n) => [n.player, n.name]));
  return (Array.isArray(rows) ? rows : []).map((row) => ({ row,
    name: (row && row.playerPubkey instanceof Uint8Array && byPlayer.get(toHex(row.playerPubkey))) || null }));
}

/**
 * THIS TAB'S IDENTITY ON A HEAD-TO-HEAD ENTRY: its identity key and that key's signature over (round, entry,
 * key) - handed to the seats with the reveal, so the rounds this tab plays against the same opponent count one score.
 * Without it a round counts for itself alone.
 */
export function identityProofFor({ roundIdHex, entryIdHex, storage, random, curve } = {}) {
  if (!curve || typeof curve.signSchnorr !== 'function') throw new Error('an identity proof is signed with the identity key, and no signer was injected');
  const secret = identitySecretFor(tabSeed({ storage, random }));
  const key = curve.pointX(secret);
  const id = matchProofId({ roundId: fromHex(roundIdHex), entryId: fromHex(entryIdHex), identityKey: key });
  return { key: toHex(key), sig: toHex(curve.signSchnorr(id, secret)) };
}

/**
 * THIS TAB AT A HEAD-TO-HEAD ROUND'S TABLE: its identity key and that key's signature over (round, key) - said
 * to the round's seats while the tab sits at the table, so the other player sees someone is there before any move is in.
 */
export function presenceProofFor({ roundIdHex, storage, random, curve } = {}) {
  if (!curve || typeof curve.signSchnorr !== 'function') throw new Error('a presence is signed with the identity key, and no signer was injected');
  const secret = identitySecretFor(tabSeed({ storage, random }));
  const key = curve.pointX(secret);
  return { key: toHex(key), sig: toHex(curve.signSchnorr(presenceId({ roundId: fromHex(roundIdHex), identityKey: key }), secret)) };
}

/**
 * A PLAYER'S OWN REFERRAL PROGRAM (kanban #681, 2026-10-26: "Add user support for referrer program, not just websites. A user may also
 * use a referrer code and link to testnet.bitcoinarena.io. He gets 10% of the node's income"): the program's key IS this tab's identity
 * refund key - 02 and the identity key, the key a zap to this player is paid to - so nothing new is kept or backed up: the 24 words make
 * it again. An entry names it as its website key (frontend_pk), the settlement pays it 10 % of the nodes' fee on that entry as it pays a
 * node's program, the seats list the payout under it ('website'), and collectZaps spends it into this wallet with the identity secret.
 * `origin` is the page's own (https://testnet.bitcoinarena.io). Answers { key, link }.
 */
export function referralOf({ storage, random, curve, origin = '' } = {}) {
  if (!curve || typeof curve.pointX !== 'function') throw new Error('a referral key is the identity key, and no curve was injected');
  const key = toHex(refundKeyOf(curve.pointX(identitySecretFor(tabSeed({ storage, random })))));
  return { key, link: `${String(origin).replace(/\/$/, '')}/?ref=${key}` };
}

/**
 * ITS NAME, SAID BY ITS KEY (protocol referral-name.js, as a node's program says its own): { record, signature } in hex for POST
 * /referral-name - the explorer and Health then name the program, not its key. Signed with the identity secret, which never leaves here.
 */
export function referralNameFor({ name, storage, random, curve, nowMs = Date.now() } = {}) {
  if (!curve || typeof curve.signSchnorr !== 'function') throw new Error('a program\'s name is signed with the identity key, and no signer was injected');
  const secret = identitySecretFor(tabSeed({ storage, random }));
  const rec = { site: refundKeyOf(curve.pointX(secret)), name: String(name || '').trim(), atMs: BigInt(nowMs) };
  return { record: toHex(encodeReferralName(rec)), signature: toHex(curve.signSchnorr(referralNameId(rec), secret)) };
}

/**
 * THE ZAPS THIS PLAYER WAS SENT, COLLECTED INTO ITS OWN WALLET (2026-10-17: "zaps in the leaderboard go to the
 * federation's account of the user"): every seat asked what was paid to this tab's identity refund key (GET /donations?key=), merged
 * by outpoint; each one in a federation this page holds a wallet client of (`clients`: Map federation id hex -> lock client) is spent
 * by `Refund` under the identity secret - which never leaves this module - into that wallet. A contract the federation no longer
 * holds was spent by this key, the only one that can, and is final. Collected outpoints are noted in `storage` (arena.zaps.collected)
 * and not asked again. Answers { key, collected: [{ outpoint, federationId, amountMsat, item, roundId }], spent, failed, waiting, totalMsat,
 * referral }.
 * AND WHAT THIS PLAYER'S REFERRAL LINK EARNED (kanban #681): the website payouts under the same key ('website' rows, referralOf) are
 * collected the same way; `referral` is every one the seats list - { msat, payouts } - collected or not.
 */
// kanban #2133, #2195: [outpoint, byVersion] in the order the Refund budget is spent - most distinct seats first, then round-robin
// by the lowest-index seat that listed each outpoint (Map order is the order rows were read, so a seat's own rows keep their order).
function fairOrder(found, seen) {
  const tiers = new Map(); // distinct seats -> first seat -> [entries]
  for (const e of found) {
    if (seen.has(e[0])) continue;
    const seatsOf = new Set();
    for (const v of e[1].values()) for (const si of v.seats) seatsOf.add(si);
    const n = seatsOf.size, owner = Math.min(...seatsOf);
    if (!tiers.has(n)) tiers.set(n, new Map());
    const byOwner = tiers.get(n);
    if (!byOwner.has(owner)) byOwner.set(owner, []);
    byOwner.get(owner).push(e);
  }
  const out = [];
  for (const n of [...tiers.keys()].sort((a, b) => b - a)) {
    const queues = [...tiers.get(n).keys()].sort((a, b) => a - b).map((o) => tiers.get(n).get(o));
    for (let i = 0, more = true; more; i++) {
      more = false;
      for (const q of queues) if (i < q.length) { out.push(q[i]); more = true; }
    }
  }
  return out;
}
export const ZAPS_COLLECTED_KEY = 'arena.zaps.collected';
export const ZAPS_ROWS_PER_SEAT = 200;
export const ZAPS_REFUNDS_PER_PASS = 50;
export async function collectZaps({ storage, keep = storage, random, curve, clients, seats, fetcher = fetch } = {}) {
  if (!curve || typeof curve.pointX !== 'function') throw new Error('a zap is collected with the identity key, and no curve was injected');
  const secret = identitySecretFor(tabSeed({ storage, random }));
  const pk = toHex(refundKeyOf(curve.pointX(secret)));
  let done = [];
  try { done = JSON.parse((keep && keep.getItem(ZAPS_COLLECTED_KEY)) || '[]'); } catch { done = []; }
  const seen = new Set(Array.isArray(done) ? done : []);
  // kanban #1557: a /donations row is not signed, so one seat answering first with the real outpoint and a changed amountMsat /
  // playerKey / senderOnContract must not stand for that outpoint. Every distinct version is kept (outpoint -> version -> the seats
  // that said it; one version per seat and outpoint, so a seat cannot flood an outpoint), and each is tried - most seats first - until
  // one is collected or reads as spent, as lookOwed keeps every version since #1273.
  const found = new Map();
  const versionOf = (d) => JSON.stringify([String(d.federationId).toLowerCase(), String(d.amountMsat), !!d.senderOnContract, String(d.playerKey || ''), String(d.item || '')]);
  await Promise.all((seats || []).map(async (s, si) => {
    try {
      const r = await fetcher(`${String(s).replace(/\/$/, '')}/donations?key=${pk}&since=0`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      // kanban #1618: one seat's list is read only to its first ZAPS_ROWS_PER_SEAT well-formed rows (outpoint txid:vout, a 64-hex
      // federation id, a positive whole msat amount) - a seat listing 20,000 made-up outpoints no longer drives 20,000 Refund calls.
      let taken = 0;
      const list = (await r.json()).donations;
      for (const d of (Array.isArray(list) ? list : [])) {
        if (taken >= ZAPS_ROWS_PER_SEAT) break;
        if (!d || !/^[0-9a-f]{64}:\d+$/.test(String(d.outpoint)) || !/^[0-9a-f]{64}$/i.test(String(d.federationId))
          || !/^[1-9]\d{0,20}$/.test(String(d.amountMsat))) continue;
        taken++;
        let byVersion = found.get(d.outpoint);
        if (!byVersion) found.set(d.outpoint, byVersion = new Map());
        if ([...byVersion.values()].some((v) => v.seats.has(si))) continue;
        const k = versionOf(d);
        if (!byVersion.has(k)) byVersion.set(k, { d, seats: new Set() });
        byVersion.get(k).seats.add(si);
      }
    } catch { /* another seat answers for it */ }
  }));
  const collected = [], spent = [], failed = [], waiting = [];
  const accepted = new Map(); // outpoint -> the version a refund accepted
  let asked = 0;
  // kanban #2133, #2195 (refute of #1618): the ZAPS_REFUNDS_PER_PASS budget is spent fairly, not in the order the seats' answers
  // arrived - else one fast seat with 200 fresh made-up rows a pass took every call and a real zap every honest seat lists waited
  // for ever. Outpoints listed by more distinct seats go first; among those listed by as many, the seats that listed them take turns
  // (round-robin by the lowest-index seat that listed each), so one seat's rows alone never use the budget other seats' rows need.
  for (const [outpoint, byVersion] of fairOrder(found, seen)) {
    const versions = [...byVersion.values()].sort((a, b) => b.seats.size - a.seats.size).map((v) => v.d);
    const tried = [], waits = [];
    let settled = false;
    for (const d of versions) {
      const r = await collectOne(d);
      if (r === 'waiting') { waits.push(d); continue; }
      if (r === 'skip') continue;
      if (r && r.why !== undefined) { tried.push(r); continue; }
      if (r === 'collected') accepted.set(outpoint, d);
      seen.add(outpoint);
      settled = true;
      break;
    }
    if (!settled) { failed.push(...tried); if (waits.length) waiting.push(waits[0]); }
  }
  async function collectOne(d) {
    const client = clients && clients.get ? clients.get(String(d.federationId).toLowerCase()) : null;
    if (!client || typeof client.refund !== 'function') return 'waiting';
    // kanban #1618: at most ZAPS_REFUNDS_PER_PASS Refund calls a pass; the rest wait for the next pass (the page runs one a minute).
    if (asked >= ZAPS_REFUNDS_PER_PASS) return 'waiting';
    asked++;
    const m = /^([0-9a-f]{64}):(\d+)$/.exec(String(d.outpoint));
    if (!m || !/^\d+$/.test(String(d.amountMsat))) return 'skip';
    const image = d.senderOnContract && /^[0-9a-f]{64}$/.test(String(d.playerKey || '')) ? d.playerKey : '00'.repeat(32);
    const fields = JSON.stringify({ paymentImage: { kind: 'hash', bytes: image }, amountMsat: String(d.amountMsat), claimPk: pk, refundPk: pk, expiration: 0 });
    let said;
    try { said = JSON.parse(await client.refund(m[1], Number(m[2]), fields, toHex(secret))); } catch (e) { return { ...d, why: String(e && e.message || e) }; }
    if (said.accepted === true) { collected.push({ outpoint: d.outpoint, federationId: d.federationId, amountMsat: String(d.amountMsat), item: d.item || null, roundId: d.roundId || null }); return 'collected'; }
    if (said.stored_before === null || said.stored_before === undefined) { spent.push(d); return 'spent'; }
    return { ...d, why: said.error || 'the federation did not accept the collect' };
  }
  try { if (keep) keep.setItem(ZAPS_COLLECTED_KEY, JSON.stringify([...seen].slice(-500))); } catch { /* not kept: asked again, then found spent */ }
  // kanban #1557: the referral total counts an outpoint's row only when a refund accepted that version or every seat that listed the
  // outpoint gave the same one - a seat's changed amount neither inflates nor hides it.
  const web = [];
  for (const [outpoint, byVersion] of found) {
    const d = accepted.get(outpoint) || (byVersion.size === 1 ? [...byVersion.values()][0].d : null);
    if (d && d.item === 'website' && /^\d+$/.test(String(d.amountMsat))) web.push(d);
  }
  return { key: pk, collected, spent, failed, waiting, totalMsat: String(collected.reduce((t, c) => t + BigInt(c.amountMsat), 0n)),
    referral: { msat: String(web.reduce((t, d) => t + BigInt(d.amountMsat || 0), 0n)), payouts: web.length } };
}
