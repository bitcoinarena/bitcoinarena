// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE HUB'S RETURN CHANNEL (2026-10-18: "On testnet4, LND C opens one channel back to each new gateway that has
// just opened its channel to LND C" - "Add a small watcher"): a gateway's outside channel to the hub gives it outbound only; the
// hub's channel back is its inbound from outside, the part a gateway seat's deposit minimum counts. Testnet bootstrap for the
// install rehearsal, not a mainnet policy. Once per peer, RETURN_SATS each, funded only from the hub's own wallet: when it cannot
// pay RETURN_SATS it says so and opens nothing smaller.
export const RETURN_SATS = 100000;

/**
 * One look: `channels()` the hub's open and pending channels, `funds()` its wallet, `openTo({ pubkey, sats })`, `state` { returned:
 * { pubkey: { fundingTxid, atMs } } }. A peer qualifies with an active channel it opened (not the hub) of at least `minSats`.
 * Answers { opened: [pubkey], short: [pubkey], why }.
 */
export async function hubReturnTick({ channels, funds, openTo, state, minSats = RETURN_SATS, sats = RETURN_SATS, nowMs = Date.now(), log = () => {} }) {
  const ch = await channels();
  if (!ch.ok) return { opened: [], short: [], why: `the hub's channels did not answer: ${ch.why}` };
  const ours = new Set([...ch.open, ...ch.pending].filter((x) => x.initiator).map((x) => x.peer));   // a channel this hub opened
  const due = [...new Set(ch.open.filter((x) => !x.initiator && x.active && x.capacitySats >= minSats).map((x) => x.peer))]
    .filter((pk) => !ours.has(pk) && !(state.returned || {})[pk]);
  const opened = [], short = [];
  for (const pubkey of due) {
    const f = await funds();
    if (!f.ok) return { opened, short, why: `the hub's wallet did not answer: ${f.why}` };
    if (f.onchainSats < sats + 1000) { short.push(pubkey); log(`no return channel to ${pubkey.slice(0, 16)}…: the hub holds ${f.onchainSats} sat, needs ${sats} + fees`); continue; }
    const o = await openTo({ pubkey, sats });
    if (!o.ok) { log(`return channel to ${pubkey.slice(0, 16)}… not opened: ${o.why}`); continue; }
    state.returned = { ...(state.returned || {}), [pubkey]: { fundingTxid: o.fundingTxid, sats, atMs: nowMs } };
    opened.push(pubkey);
    log(`return channel of ${sats} sat to ${pubkey.slice(0, 16)}…: ${o.fundingTxid}`);
  }
  return { opened, short, why: due.length ? `${opened.length} opened, ${short.length} short of funds` : 'no new gateway' };
}
