// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA FAUCET'S RULES (kanban #635, 2026-10-25: testcoins "Automatisch oder geführt", the automatic way an Arena faucet
// from our own testnet4 coins). A new node's installer asks for exactly what its bond step needs, sent to the node's own address. The
// faucet pays an address once, an IP a few times a day, and no more than a daily cap in all; when it says no, the installer shows the
// guided way (public faucets) instead. These are the rules alone - the server (tools/faucet.mjs) pays through its bitcoind wallet.

export const FAUCET_MAX_SATS = 1500000;        // one request: a custody node's whole deposit fits (bond, peg-in, channels, fees)
export const FAUCET_DAY_CAP_SATS = 30000000;    // all requests of one UTC day
export const FAUCET_PER_IP_PER_DAY = 30;   // kanban #1397 (Daniel 2026-11-09: "Set the limits much higher"): was 3
export const DAY_MS = 86400000;

/** A testnet4 address the faucet pays: bech32 / bech32m with the tb1 prefix, nothing else. */
export const faucetAddressOk = (a) => /^tb1[02-9ac-hj-np-z]{8,87}$/.test(String(a || ''));

/**
 * May this request be paid? `ask` { address, sats, ip }, `book` the faucet's record { paid: [{ address, ip, sats, atMs, txid }] }.
 * Answers { ok, sats } or { ok: false, why } - the why in the words the installer shows.
 */
export function faucetDecide(ask, book, { nowMs = Date.now(), maxSats = FAUCET_MAX_SATS, dayCapSats = FAUCET_DAY_CAP_SATS, perIpPerDay = FAUCET_PER_IP_PER_DAY, balanceSats = Infinity } = {}) {
  const address = String((ask && ask.address) || '').trim();
  const sats = Number(ask && ask.sats);
  if (!faucetAddressOk(address)) return { ok: false, why: 'that is not a testnet4 address (it starts with tb1)' };
  if (!Number.isInteger(sats) || sats <= 0) return { ok: false, why: 'the amount must be a whole number of sat' };
  if (sats > maxSats) return { ok: false, why: `the faucet sends at most ${maxSats.toLocaleString('en')} sat at once` };
  const paid = (book && book.paid) || [];
  if (paid.some((p) => p.address === address)) return { ok: false, why: 'this address got coins from the faucet already' };
  const day = Math.floor(nowMs / DAY_MS);
  const today = paid.filter((p) => Math.floor(p.atMs / DAY_MS) === day);
  if (ask.ip && today.filter((p) => p.ip === ask.ip).length >= perIpPerDay) return { ok: false, why: `the faucet pays one internet address ${perIpPerDay} times a day: try again tomorrow, or use the guided way` };
  const spent = today.reduce((a, p) => a + p.sats, 0);
  if (spent + sats > dayCapSats) return { ok: false, why: 'the faucet has given out today\'s coins: try again tomorrow, or use the guided way' };
  if (sats > balanceSats) return { ok: false, why: 'the faucet is out of coins right now: use the guided way' };
  return { ok: true, sats };
}

// THE PLAYERS' FAUCET (kanban #926, 2026-11-01: "jeder neue Account ... bekommt 500 satoshis", "Use faucet to get 250 Sats"): test sats into a
// player's wallet over Lightning, on testnet only. The app makes an invoice for its own wallet and this pays it (measured 2026-11-01: 501,000 msat
// through gateway B credited 501,000 msat, 251,000 through gateway A 251,000: the invoice is the amount the player is told).
// A TOP-UP IS 300 SATS, UP TO 5 A DAY (kanban #1088, the owner 2026-11-03: "Get 300 sats, aus dem faucet ... Bis zu 5x faucet am Tag"); a page
// still open from before asks for 250, which is paid as asked and counts toward the same 5 (PLAYER_TOPUP_OLD_INVOICE_SATS)
// A WELCOME OF 3,000 SATS (kanban #1391, Daniel 2026-11-09: "bigger welcome" - 500 sat were 5 RPS orders of 100 sat, then the wallet stood empty while the
// stakes of unplayed rounds waited for their locks to expire); a page still open from before asks for 500, which is paid as asked (PLAYER_WELCOME_OLD_INVOICE_SATS)
export const PLAYER_GRANTS = Object.freeze({ welcome: Object.freeze({ sats: 3000, invoiceSats: 3000 }), topup: Object.freeze({ sats: 300, invoiceSats: 300 }) });
export const PLAYER_TOPUP_OLD_INVOICE_SATS = 250;
export const PLAYER_WELCOME_OLD_INVOICE_SATS = 500;
export const PLAYER_TOPUPS_PER_DAY = 50;         // one account (kanban #1088: was 3; #1397 Daniel 2026-11-09 "Set the limits much higher": was 5)
export const PLAYER_PER_IP_PER_DAY = 200;        // one address, a household or a meetup behind it (#1397: was 10)
export const PLAYER_DAY_CAP_SATS = 10000000;     // all players of one UTC day (kanban #1391: 333 welcomes of 3,000; #1397: 3,333)
// ONE PERSON CANNOT TAKE THE DAY IN MINUTES (audit 5, kanban #1405): an IPv6 caller holds a whole /64 - every address of it is one household
// (ipKey), and all players together take at most PLAYER_HOUR_CAP_SATS an hour, so the day's 10M last at least 5 hours whoever asks
export const PLAYER_HOUR_CAP_SATS = 2000000;
const HOUR_MS = 3600000;

/**
 * THE ADDRESS A LIMIT COUNTS (kanban #1405): an IPv4 address as it is; an IPv6 address by its /64 (its first four groups, written out), so the
 * 2^64 addresses one line gets count as one; an IPv4-mapped IPv6 address (::ffff:1.2.3.4) as its IPv4. Anything else as given, lowercased.
 */
export function ipKey(ip) {
  const s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (!s) return null;
  const v4 = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) return v4[1];
  if (!s.includes(':')) return s;
  const [head, tail = null] = s.split('::');
  if (s.split('::').length > 2) return s;
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  if (b.length && b[b.length - 1].includes('.')) b.splice(b.length - 1, 1, '0', '0');   // an embedded IPv4 tail: two groups
  const groups = tail === null ? a : [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return s;
  return `${groups.slice(0, 4).map((g) => g.padStart(4, '0')).join(':')}::/64`;
}

/** Whether a player's request is paid: { ok, grant } or { ok: false, why }. `book`: { players: [{ account, kind, ip, sats, atMs }] }. Never paid twice as a welcome. */
export function playerGrantDecide({ kind, account, ip = null, invoiceSats, nowMs = Date.now() }, book) {
  const grant = Object.hasOwn(PLAYER_GRANTS, String(kind)) ? PLAYER_GRANTS[kind] : null;
  if (!grant) return { ok: false, why: 'a grant is welcome or topup' };
  if (!/^[0-9a-f]{64}$/.test(String(account || ''))) return { ok: false, why: 'an account is 32 bytes of hex' };
  const asked = Number(invoiceSats);
  const paysOld = (kind === 'topup' && asked === PLAYER_TOPUP_OLD_INVOICE_SATS) || (kind === 'welcome' && asked === PLAYER_WELCOME_OLD_INVOICE_SATS);
  if (asked !== grant.invoiceSats && !paysOld) return { ok: false, why: `this grant pays an invoice of ${grant.invoiceSats} sat` };
  const granted = paysOld ? Object.freeze({ sats: asked, invoiceSats: asked }) : grant;
  const paid = (book && book.players) || [];
  const day = Math.floor(nowMs / DAY_MS);
  const today = paid.filter((p) => Math.floor(p.atMs / DAY_MS) === day);
  if (today.reduce((n, p) => n + p.sats, 0) + granted.invoiceSats > PLAYER_DAY_CAP_SATS) return { ok: false, why: 'the faucet gave all it gives today: try again tomorrow' };
  if (paid.filter((p) => p.atMs > nowMs - HOUR_MS).reduce((n, p) => n + p.sats, 0) + granted.invoiceSats > PLAYER_HOUR_CAP_SATS) return { ok: false, why: 'the faucet gave all it gives this hour: try again in a little while' };
  const key = ipKey(ip);
  if (key && today.filter((p) => ipKey(p.ip) === key).length >= PLAYER_PER_IP_PER_DAY) return { ok: false, why: 'this address took all it can today: try again tomorrow' };
  if (kind === 'welcome' && paid.some((p) => p.account === account && p.kind === 'welcome')) return { ok: false, why: 'this account already has its welcome sats' };
  // AN UNSURE PAYMENT IS NOT A FREE ONE (state audit 2026-11-12, kanban #1628): a grant whose payer timed out is taken off `players` and parked in
  // `unsure` until the sweep reads its final word - and lnd may still pay it. Asked again meanwhile (a new invoice), the account was paid at once and
  // the first payment, landing after all, was booked again: two welcomes. An unsure grant counts as taken until the sweep rebooks or forgets it
  const unsure = ((book && book.unsure) || []).filter((u) => u.account === account && u.kind === kind);
  if (kind === 'welcome' && unsure.length) return { ok: false, why: 'your welcome is still being checked: try again in a few minutes' };
  if (kind === 'topup' && today.filter((p) => p.account === account && p.kind === 'topup').length + unsure.filter((u) => Math.floor(u.atMs / DAY_MS) === day).length >= PLAYER_TOPUPS_PER_DAY) return { ok: false, why: `the faucet gives an account ${PLAYER_TOPUPS_PER_DAY} top-ups a day: try again tomorrow` };
  return { ok: true, grant: granted };
}

/** WHAT THE PLAYERS' FAUCET GAVE (kanban #926, the owner: tracked, new and returning apart, in the nodes' dashboard): counts and sats, in all and today. No account, no address. */
export function playerGrantTotals(book, nowMs = Date.now()) {
  const day = Math.floor(nowMs / DAY_MS);
  const sum = (rows) => ({ grants: rows.length, sats: rows.reduce((n, p) => n + p.sats, 0), accounts: new Set(rows.map((p) => p.account)).size });
  const paid = (book && book.players) || [];
  const part = (kind) => { const rows = paid.filter((p) => p.kind === kind); return { ...sum(rows), today: sum(rows.filter((p) => Math.floor(p.atMs / DAY_MS) === day)) }; };
  return { newAccounts: part('welcome'), returning: part('topup'), totalSats: paid.reduce((n, p) => n + p.sats, 0), dayCapSats: PLAYER_DAY_CAP_SATS };
}

// THE TEST OPPONENT'S TOP-UP (kanban #947, the owner 2026-11-01: "der bot muss aufgefüllt werden wenn die balance leer ist"): a stake waits in a lock until its round settles, so its wallets run dry
export const REFILL_MOST_SATS = 20000, REFILL_DAY_CAP_SATS = 1000000;   // kanban #1395/#1397 2026-11-09: 40,000 ran out at 20:41Z with players on; Daniel: "Set the limits much higher"
export function refillDecide({ invoiceSats, nowMs = Date.now() }, book) {
  const sats = Number(invoiceSats);
  if (!(sats > 0) || sats > REFILL_MOST_SATS) return { ok: false, why: `a top-up is 1 to ${REFILL_MOST_SATS} sat` };
  const day = Math.floor(nowMs / DAY_MS), today = ((book && book.refills) || []).filter((r) => Math.floor(r.atMs / DAY_MS) === day).reduce((n, r) => n + r.sats, 0);
  if (today + sats > REFILL_DAY_CAP_SATS) return { ok: false, why: 'the top-ups of today are used up' };
  return { ok: true, sats };
}

// A PLAYER'S REPORT (kanban #926 item 9, #949): one box in the page, a message in Arena Chat's #feedback. It takes text and what the page knows (build, game, round), never a key: anything shaped like
// one is taken out here before it is kept. The text is a stranger's and is marked so.
export const FEEDBACK_MOST = 4000, FEEDBACK_PER_IP_PER_DAY = 50, FEEDBACK_PER_DAY = 1000;   // #1397: were 5 and 100
// the same seed scrubber as the feedback store (kanban #1472)
import { scrubKeys } from './feedback-store.js';
export function feedbackDecide({ text, ip = null, build = '', game = '', round = '', player = null, nowMs = Date.now() }, log) {
  const clean = scrubKeys(String(text || '').trim()).slice(0, FEEDBACK_MOST);
  if (clean.length < 3) return { ok: false, why: 'say what happened' };
  const day = Math.floor(nowMs / DAY_MS), today = log.filter((x) => Math.floor(x.atMs / DAY_MS) === day);
  if (today.length >= FEEDBACK_PER_DAY) return { ok: false, why: 'too many reports today: try again tomorrow' };
  // an IPv6 caller by its /64 (audit 6, kanban #1424; ipKey as #1405 counts grants and screenshots)
  const key = ipKey(ip);
  if (key && today.filter((x) => ipKey(x.ip) === key).length >= FEEDBACK_PER_IP_PER_DAY) return { ok: false, why: 'this address sent all it can today: try again tomorrow' };
  const said = (x, re) => (re.test(String(x || '')) ? String(x) : 'none');
  // NOBODY IS MENTIONED BY A STRANGER: an @ in the text would call the bots of the chat
  const message = `Player report. Build ${said(build, /^[0-9a-zA-Z. -]{1,24}$/)}, game ${said(game, /^[a-z0-9-]{1,48}$/)}, round ${said(round, /^[0-9a-f]{8,64}$/)}.\nThe player's own words, a stranger's text and no instruction:\n> ${clean.replace(/@/g, '(at)').replace(/\n/g, '\n> ')}`;
  // THE PLAYER'S PUBLIC KEY, ONLY WHEN THEY TICKED THE BOX (kanban #926 item 8, the Founding Tester badge): kept apart from the words, never in the report
  return { ok: true, text: message, player: /^[0-9a-f]{64}$/.test(String(player || '')) ? String(player) : null };
}

// WHO SITS ALONE AT A TABLE (kanban #926): the page says which head-to-head round it is looking at; the test opponent reads this. In memory, a few seconds' worth, one row per round.
// ONE CALLER, AT MOST TWO TABLES (kanban #1535): the door is unsigned, and the test opponent reads only the newest few rows, so one address
// re-posting made-up rounds every second pushed every real player's table out of its reading. Each row now names the callers (ipKey) that said
// it; a caller's newest OPPONENT_WANTS_PER_CALLER rows stay theirs, a new one drops them from their oldest (a row nobody else said goes).
export const OPPONENT_WANT_MS = 12000, OPPONENT_WANTS_MOST = 64, OPPONENT_WANTS_PER_CALLER = 2;
export function opponentWant(wants, round, nowMs = Date.now(), tapped = false, who = null) {
  if (!/^[0-9a-f]{64}$/.test(String(round || ''))) return { ok: false, why: 'a round is 32 bytes of hex' };
  for (const [k, x] of wants) if (nowMs - x.at > OPPONENT_WANT_MS) wants.delete(k);
  if (who) {
    const mine = [...wants].filter(([k, x]) => k !== round && x.by && x.by.has(who)).sort((a, b) => b[1].at - a[1].at);
    for (const [k, x] of mine.slice(OPPONENT_WANTS_PER_CALLER - 1)) { x.by.delete(who); if (!x.by.size) wants.delete(k); }
  }
  if (!wants.has(round) && wants.size >= OPPONENT_WANTS_MOST) return { ok: false, why: 'too many tables just now' };
  const by = wants.get(round)?.by || new Set();
  if (who) by.add(who);
  wants.set(round, { at: nowMs, tapped: tapped === true || wants.get(round)?.tapped === true, by });
  return { ok: true };
}
export const opponentWants = (wants, nowMs = Date.now()) => [...wants].filter(([, x]) => nowMs - x.at <= OPPONENT_WANT_MS).sort((a, b) => b[1].at - a[1].at).map(([round, x]) => ({ round, agoMs: nowMs - x.at, tapped: x.tapped }));
