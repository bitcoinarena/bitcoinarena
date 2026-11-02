#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
/*
 * THE FOUNDING TESTER BADGE (kanban #926 item 8, plan #922): a NIP-58 badge for anyone who finished a round and gave feedback.
 *
 * Feedback: the page's Feedback box, with the box ticked that sends the player's public key (faucet.mjs keeps it in FOUNDING_FILE).
 * A finished round: the player's row on a network board (GET /season?scope=network), the same reading tools/weekly-testers.mjs counts.
 * A key a player typed in wrong gets no badge unless that key also finished a round, and then the worst case is a badge for a real player.
 *
 * One account gives them: its secret in BADGE_KEY_FILE, published under a name (NIP-05 badges@bitcoinarena.io) so people can find it. It publishes
 * its profile and the badge's definition, then one award per key, once. With no key waiting nothing is asked of the seats.
 *
 *   BADGE_KEY_FILE=<file> FOUNDING_FILE=<file> FOUNDING_STATE=<file> SEAT=<url> [GAMES=a,b,c] [DAYS=90] [RELAYS=wss://..,wss://..] [DRY=1] node tools/founding-badges.mjs
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { schnorr } from '@noble/curves/secp256k1.js';
import { buildDefinitionEvent, buildAwardEvent, isNostrKey } from '../src/nostr-badges.js';
import { eventId } from '../src/nostr-relay.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

export const FOUNDING_BADGE = Object.freeze({ d: 'arena-founding-tester', name: 'Founding Tester',
  description: 'Finished a round of Bitcoin Arena on testnet4 and gave feedback.', image: '/img/founding-tester.svg' });
export const NIP05 = 'badges@bitcoinarena.io';
const IMAGE_BASE = 'https://bitcoinarena.io';
/** The definition's date: fixed, so the same key gives the same event. */
const DEFINED_AT_S = Math.floor(Date.UTC(2026, 10, 2) / 1000);
export const DEFAULT_RELAYS = ['wss://relay.bitcoin-arena.io', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];

/** Who is due: a key that gave feedback, finished a round, and holds no award yet, in the order feedback came. */
export function dueKeys({ feedback, boards, awarded = {} }) {
  const played = new Set();
  for (const b of boards) for (const r of b.rows || []) if (Number(r.rounds) > 0) played.add(String(r.player).toLowerCase());
  const seen = new Set(), out = [];
  for (const f of feedback) {
    const k = String(f.player || '').toLowerCase();
    if (seen.has(k) || awarded[k] || !played.has(k) || !isNostrKey(k)) continue;
    seen.add(k); out.push(k);
  }
  return out;
}

export const readFeedback = (text) => String(text).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });

const profileEvent = (secret) => {
  const e = { pubkey: toHex(schnorr.getPublicKey(secret)), created_at: DEFINED_AT_S, kind: 0, tags: [],
    content: JSON.stringify({ name: 'Bitcoin Arena Badges', about: 'Gives the Founding Tester badge: finish a round of Bitcoin Arena on testnet4 and send feedback with your key.', nip05: NIP05, website: 'https://bitcoinarena.io', picture: `${IMAGE_BASE}${FOUNDING_BADGE.image}` }) };
  e.id = eventId(e); e.sig = toHex(schnorr.sign(fromHex(e.id), secret, new Uint8Array(32)));
  return e;
};

/** One event to one relay: its OK, or why not. */
function sendTo(relay, event, ms = 8000) {
  return new Promise((done) => {
    let ws; const end = (r) => { clearTimeout(t); try { ws.close(); } catch { /* gone */ } done(r); };
    const t = setTimeout(() => end({ relay, ok: false, why: 'no answer' }), ms);
    try { ws = new WebSocket(relay); } catch (e) { clearTimeout(t); return done({ relay, ok: false, why: e.message }); }
    ws.onopen = () => ws.send(JSON.stringify(['EVENT', event]));
    ws.onmessage = (m) => { let a; try { a = JSON.parse(m.data); } catch { return; } if (a[0] === 'OK' && a[1] === event.id) end({ relay, ok: !!a[2], why: a[3] || null }); };
    ws.onerror = () => end({ relay, ok: false, why: 'no connection' });
    return undefined;
  });
}
const publish = async (event, relays) => Promise.all(relays.map((r) => sendTo(r, event)));

if (import.meta.url === `file://${process.argv[1]}`) {
  const env = process.env;
  const secret = fromHex(readFileSync(env.BADGE_KEY_FILE, 'utf8').trim());
  const pubkey = toHex(schnorr.getPublicKey(secret));
  const stateFile = env.FOUNDING_STATE, relays = String(env.RELAYS || '').split(',').filter(Boolean);
  const to = relays.length ? relays : DEFAULT_RELAYS;
  const dry = !!env.DRY;
  const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { awarded: {} };
  const keep = () => { if (dry || !stateFile) return; writeFileSync(`${stateFile}.new`, `${JSON.stringify(state, null, 1)}\n`); renameSync(`${stateFile}.new`, stateFile); };
  const say = (o) => console.log(JSON.stringify(o));
  if (!state.announced && !dry) {
    const p = await publish(profileEvent(secret), to);
    const d = await publish(buildDefinitionEvent({ badge: FOUNDING_BADGE, secret, imageBase: IMAGE_BASE, createdAt: DEFINED_AT_S }), to);
    say({ step: 'announced', pubkey, profile: p, definition: d });
    if (p.some((x) => x.ok) && d.some((x) => x.ok)) { state.announced = true; keep(); }
  }
  const feedback = env.FOUNDING_FILE && existsSync(env.FOUNDING_FILE) ? readFeedback(readFileSync(env.FOUNDING_FILE, 'utf8')) : [];
  const waiting = feedback.filter((f) => !state.awarded[String(f.player || '').toLowerCase()]);
  if (!waiting.length) { say({ step: 'nobody waits', pubkey, awarded: Object.keys(state.awarded).length }); process.exit(0); }
  const seat = String(env.SEAT || '').replace(/\/+$/, '');
  const boards = [];
  for (const game of String(env.GAMES || 'nextblock,rock-paper-scissors,btc-updown-15m').split(',').filter(Boolean)) {
    const r = await fetch(`${seat}/season?game=${encodeURIComponent(game)}&days=${Number(env.DAYS || 90)}&scope=network`, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) { say({ step: 'stopped', game, status: r.status }); process.exit(1); }
    boards.push({ ...(await r.json()), game });
  }
  const due = dueKeys({ feedback, boards, awarded: state.awarded });
  say({ step: 'read', waiting: waiting.length, due: due.length, players: boards.map((b) => [b.game, (b.rows || []).length]) });
  for (const player of due) {
    const award = { d: FOUNDING_BADGE.d, player, game: 'bitcoin-arena', evidence: null };
    const event = buildAwardEvent({ award, secret, atMs: Date.now(), catalogue: [FOUNDING_BADGE] });
    if (dry) { say({ step: 'would award', player: player.slice(0, 16), id: event.id, a: event.tags[0][1] }); continue; }
    const sent = await publish(event, to);
    if (!sent.some((x) => x.ok)) { say({ step: 'not published', player: player.slice(0, 16), sent }); continue; }
    state.awarded[player] = { event: event.id, atMs: Date.now() }; keep();
    say({ step: 'awarded', player: player.slice(0, 16), event: event.id, relays: sent.filter((x) => x.ok).length });
  }
}
