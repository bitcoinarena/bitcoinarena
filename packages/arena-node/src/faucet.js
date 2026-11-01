// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE ARENA FAUCET'S RULES (kanban #635, 2026-10-25: testcoins "Automatisch oder geführt", the automatic way an Arena faucet
// from our own testnet4 coins). A new node's installer asks for exactly what its bond step needs, sent to the node's own address. The
// faucet pays an address once, an IP a few times a day, and no more than a daily cap in all; when it says no, the installer shows the
// guided way (public faucets) instead. These are the rules alone - the server (tools/faucet.mjs) pays through its bitcoind wallet.

export const FAUCET_MAX_SATS = 1500000;        // one request: a custody node's whole deposit fits (bond, peg-in, channels, fees)
export const FAUCET_DAY_CAP_SATS = 30000000;    // all requests of one UTC day
export const FAUCET_PER_IP_PER_DAY = 3;
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
export const PLAYER_GRANTS = Object.freeze({ welcome: Object.freeze({ sats: 500, invoiceSats: 500 }), topup: Object.freeze({ sats: 250, invoiceSats: 250 }) });
export const PLAYER_TOPUPS_PER_DAY = 3;          // one account
export const PLAYER_PER_IP_PER_DAY = 10;         // one address, a household or a meetup behind it
export const PLAYER_DAY_CAP_SATS = 200000;       // all players of one UTC day

/** Whether a player's request is paid: { ok, grant } or { ok: false, why }. `book`: { players: [{ account, kind, ip, sats, atMs }] }. Never paid twice as a welcome. */
export function playerGrantDecide({ kind, account, ip = null, invoiceSats, nowMs = Date.now() }, book) {
  const grant = Object.hasOwn(PLAYER_GRANTS, String(kind)) ? PLAYER_GRANTS[kind] : null;
  if (!grant) return { ok: false, why: 'a grant is welcome or topup' };
  if (!/^[0-9a-f]{64}$/.test(String(account || ''))) return { ok: false, why: 'an account is 32 bytes of hex' };
  if (Number(invoiceSats) !== grant.invoiceSats) return { ok: false, why: `this grant pays an invoice of ${grant.invoiceSats} sat` };
  const paid = (book && book.players) || [];
  const day = Math.floor(nowMs / DAY_MS);
  const today = paid.filter((p) => Math.floor(p.atMs / DAY_MS) === day);
  if (today.reduce((n, p) => n + p.sats, 0) + grant.invoiceSats > PLAYER_DAY_CAP_SATS) return { ok: false, why: 'the faucet gave all it gives today: try again tomorrow' };
  if (ip && today.filter((p) => p.ip === ip).length >= PLAYER_PER_IP_PER_DAY) return { ok: false, why: 'this address took all it can today: try again tomorrow' };
  if (kind === 'welcome' && paid.some((p) => p.account === account && p.kind === 'welcome')) return { ok: false, why: 'this account already has its welcome sats' };
  if (kind === 'topup' && today.filter((p) => p.account === account && p.kind === 'topup').length >= PLAYER_TOPUPS_PER_DAY) return { ok: false, why: `the faucet gives an account ${PLAYER_TOPUPS_PER_DAY} top-ups a day: try again tomorrow` };
  return { ok: true, grant };
}

/** WHAT THE PLAYERS' FAUCET GAVE (kanban #926, the owner: tracked, new and returning apart, in the nodes' dashboard): counts and sats, in all and today. No account, no address. */
export function playerGrantTotals(book, nowMs = Date.now()) {
  const day = Math.floor(nowMs / DAY_MS);
  const sum = (rows) => ({ grants: rows.length, sats: rows.reduce((n, p) => n + p.sats, 0), accounts: new Set(rows.map((p) => p.account)).size });
  const paid = (book && book.players) || [];
  const part = (kind) => { const rows = paid.filter((p) => p.kind === kind); return { ...sum(rows), today: sum(rows.filter((p) => Math.floor(p.atMs / DAY_MS) === day)) }; };
  return { newAccounts: part('welcome'), returning: part('topup'), totalSats: paid.reduce((n, p) => n + p.sats, 0), dayCapSats: PLAYER_DAY_CAP_SATS };
}

// WHO SITS ALONE AT A TABLE (kanban #926): the page says which head-to-head round it is looking at; the test opponent reads this. In memory, a few seconds' worth, one row per round.
export const OPPONENT_WANT_MS = 12000, OPPONENT_WANTS_MOST = 64;
export function opponentWant(wants, round, nowMs = Date.now()) {
  if (!/^[0-9a-f]{64}$/.test(String(round || ''))) return { ok: false, why: 'a round is 32 bytes of hex' };
  for (const [k, at] of wants) if (nowMs - at > OPPONENT_WANT_MS) wants.delete(k);
  if (!wants.has(round) && wants.size >= OPPONENT_WANTS_MOST) return { ok: false, why: 'too many tables just now' };
  wants.set(round, nowMs);
  return { ok: true };
}
export const opponentWants = (wants, nowMs = Date.now()) => [...wants].filter(([, at]) => nowMs - at <= OPPONENT_WANT_MS).sort((a, b) => b[1] - a[1]).map(([round, at]) => ({ round, agoMs: nowMs - at }));
