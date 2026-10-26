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
  const player = playerFor(round, { seed: tabSeed({ storage, random }), curve, order });
  const record = { roundId: player.roundId, playerPubkey: player.pubkey, identityPubkey: me.pubkey,
    name: me.custom ? me.name : '', atMs: BigInt(Math.floor(nowMs)) };
  return { record: toHex(encodeLobbyName(record)), sig: toHex(curve.signSchnorr(lobbyNameId(record), player.secret)) };
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
export function checkedNames(items, roundIdHex, verify) {
  const newest = new Map();
  for (const x of Array.isArray(items) ? items : []) {
    let record;
    try {
      record = decodeLobbyName(fromHex(String(x && x.record)));
      if (toHex(record.roundId) !== String(roundIdHex).toLowerCase()) continue;
      if (!verify(fromHex(String(x.sig)), lobbyNameId(record), record.playerPubkey)) continue;
    } catch { continue; }
    const player = toHex(record.playerPubkey);
    const had = newest.get(player);
    if (!had || record.atMs > had.atMs) newest.set(player, record);
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
      if (body && Array.isArray(body.names)) items.push(...body.names);
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
 * use a referrer code and link to testnet.bitcoin-arena.io. He gets 10% of the node's income"): the program's key IS this tab's identity
 * refund key - 02 and the identity key, the key a zap to this player is paid to - so nothing new is kept or backed up: the 24 words make
 * it again. An entry names it as its website key (frontend_pk), the settlement pays it 10 % of the nodes' fee on that entry as it pays a
 * node's program, the seats list the payout under it ('website'), and collectZaps spends it into this wallet with the identity secret.
 * `origin` is the page's own (https://testnet.bitcoin-arena.io). Answers { key, link }.
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
export const ZAPS_COLLECTED_KEY = 'arena.zaps.collected';
export async function collectZaps({ storage, keep = storage, random, curve, clients, seats, fetcher = fetch } = {}) {
  if (!curve || typeof curve.pointX !== 'function') throw new Error('a zap is collected with the identity key, and no curve was injected');
  const secret = identitySecretFor(tabSeed({ storage, random }));
  const pk = toHex(refundKeyOf(curve.pointX(secret)));
  let done = [];
  try { done = JSON.parse((keep && keep.getItem(ZAPS_COLLECTED_KEY)) || '[]'); } catch { done = []; }
  const seen = new Set(Array.isArray(done) ? done : []);
  const found = new Map();
  await Promise.all((seats || []).map(async (s) => {
    try {
      const r = await fetcher(`${String(s).replace(/\/$/, '')}/donations?key=${pk}&since=0`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!r.ok) return;
      for (const d of ((await r.json()).donations || [])) if (d && d.outpoint && !found.has(d.outpoint)) found.set(d.outpoint, d);
    } catch { /* another seat answers for it */ }
  }));
  const collected = [], spent = [], failed = [], waiting = [];
  for (const d of found.values()) {
    if (seen.has(d.outpoint)) continue;
    const client = clients && clients.get ? clients.get(String(d.federationId).toLowerCase()) : null;
    if (!client || typeof client.refund !== 'function') { waiting.push(d); continue; }
    const m = /^([0-9a-f]{64}):(\d+)$/.exec(String(d.outpoint));
    if (!m) continue;
    const image = d.senderOnContract && /^[0-9a-f]{64}$/.test(String(d.playerKey || '')) ? d.playerKey : '00'.repeat(32);
    const fields = JSON.stringify({ paymentImage: { kind: 'hash', bytes: image }, amountMsat: String(d.amountMsat), claimPk: pk, refundPk: pk, expiration: 0 });
    let said;
    try { said = JSON.parse(await client.refund(m[1], Number(m[2]), fields, toHex(secret))); } catch (e) { failed.push({ ...d, why: String(e && e.message || e) }); continue; }
    if (said.accepted === true) collected.push({ outpoint: d.outpoint, federationId: d.federationId, amountMsat: String(d.amountMsat), item: d.item || null, roundId: d.roundId || null });
    else if (said.stored_before === null || said.stored_before === undefined) spent.push(d);
    else { failed.push({ ...d, why: said.error || 'the federation did not accept the collect' }); continue; }
    seen.add(d.outpoint);
  }
  try { if (keep) keep.setItem(ZAPS_COLLECTED_KEY, JSON.stringify([...seen].slice(-500))); } catch { /* not kept: asked again, then found spent */ }
  const web = [...found.values()].filter((d) => d.item === 'website');
  return { key: pk, collected, spent, failed, waiting, totalMsat: String(collected.reduce((t, c) => t + BigInt(c.amountMsat), 0n)),
    referral: { msat: String(web.reduce((t, d) => t + BigInt(d.amountMsat || 0), 0n)), payouts: web.length } };
}
