// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE INSTALLER'S MINIMUM BOND (spec §23A.3a, kanban #543, 2026-10-19: "new installs should increase their minimum so the new
// node remains useful from the start"): max(bond_min_guardian, B*_net) rounded up to 10,000 sat, as the seats compute it from the
// census and the federation records (GET /capacity: network.installMinimumBondSats). Asked of two seats; when they differ, the larger
// (a node bonded above the network's target loses nothing); when no seat answers, the floor - said by name, never silently.
import { BOND_MIN_SATS } from './bond.js';
import { reachSeats } from './reach.js';

/** { sats (number), from: [seat], said: [{ seat, sats }], why } - `want` seats asked until that many answered. */
export async function installMinimum({ seats, fetcher = fetch, want = 2, floor = Number(BOND_MIN_SATS) } = {}) {
  const said = [];
  for (const seat of seats || await reachSeats({ fetcher })) {
    if (said.length >= want) break;
    try {
      const r = await fetcher(`${String(seat).replace(/\/+$/, '')}/capacity`, { signal: AbortSignal.timeout(10000) });
      if (r.status !== 200) continue;
      const j = await r.json();
      const n = Number(j && j.network && j.network.installMinimumBondSats);
      if (Number.isSafeInteger(n) && n > 0) said.push({ seat, sats: n, band: j.network.band || null });
    } catch { /* that seat said nothing */ }
  }
  if (!said.length) return { sats: floor, from: [], said, why: `no seat answered GET /capacity: the floor, ${floor} sat` };
  // ONLY UNDER PRESSURE (measured in the installer walk of fd47329c, 2026-10-25: the testnet4 seats said 36,570,000 sat at band CALM - their
  // reserves grew with the market bots' deposits - and a new node was asked for that, which no faucet gives): the owner's "new installs should
  // increase their minimum" is the answer to capacity stalling (§23A.3a's bands); while every open federation is CALM the floor stands
  const pressed = said.filter((x) => x.band && x.band !== 'CALM');
  if (!pressed.length) return { sats: floor, from: said.map((x) => x.seat), said, why: `the floor, ${floor} sat: the network is CALM (its bond target, ${Math.max(...said.map((x) => x.sats))} sat, applies under capacity pressure)` };
  const sats = Math.max(floor, ...pressed.map((x) => x.sats));
  return { sats, from: said.map((x) => x.seat), said, why: sats > floor ? `the network's bond target (band ${said[0].band || '?'}): ${sats} sat` : `the floor, ${floor} sat` };
}
