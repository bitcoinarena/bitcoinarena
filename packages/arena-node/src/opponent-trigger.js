// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHEN THE TEST BOT STAKES (kanban #2842, ruling 2026-11-16 (a)): only on the seats' own fact - a table on which a seat holds a VERIFIED
// stake lock (§23.1 step 5, GET /order-locks: stakeVerifiedMs) for the entry of a player key that is not the bot's. A tap is a hint: it may
// wake the bot to watch that round, never the reason it stakes (a tap is self-signed, a fresh key's signature over a public round id is valid).
// The opponent lead: the bot joins only when the round gives it at least BOT_LEAD_MS after that first verified lock; a round that cannot is
// not a bot round, and the lone player's locks go back at once when the round voids for want of an opponent (#2872).

export const BOT_LEAD_MS = 12000;

/**
 * Whether the bot enters now. `entries`: the round's paid entries a seat holds, [{ entry, player }] (GET /api/round-result players);
 * `locks`: entry id hex -> stakeVerifiedMs (a number) for the entries a seat answered GET /order-locks with a verified stake lock;
 * `botKeys`: player keys hex the bot entered with. Returns { go, why }.
 */
export function botMayEnter({ entries = [], locks = new Map(), botKeys = new Set(), closeMs, nowMs, leadMs = BOT_LEAD_MS, minLeftMs = 4050 }) {
  const others = entries.filter((e) => e && e.entry && !botKeys.has(String(e.player || '')));
  if (others.length === 0) return { go: false, why: 'no entry but the bot\'s' };
  if (others.length > 1) return { go: false, why: 'two players already: no seat for the bot' };
  const at = locks.get(others[0].entry);
  if (!Number.isFinite(at)) return { go: false, why: 'no seat holds a verified stake lock of that entry' };
  if (Number(closeMs) - at < leadMs) return { go: false, why: `the round gives ${Number(closeMs) - at} ms after the first lock, under the ${leadMs} ms lead: not a bot round` };
  if (Number(closeMs) - nowMs < minLeftMs) return { go: false, why: 'too little left to enter' };
  return { go: true, why: 'a player\'s stake lock is verified' };
}
