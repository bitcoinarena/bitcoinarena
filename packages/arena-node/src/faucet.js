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
