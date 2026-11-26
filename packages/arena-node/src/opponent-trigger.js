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

/** The verified tap keys of a GET /opponent row: `tapKeys` (kanban #3729), or the one `tapKey` an older faucet names. */
export const tapKeysOf = (w) => (Array.isArray(w && w.tapKeys) ? w.tapKeys : (w && w.tapKey ? [w.tapKey] : [])).map(String).filter((k) => /^[0-9a-f]{64}$/.test(k));

/**
 * THE TAP KEY THE BOT MAY LEARN AS A KNOWN PLAYER (kanban #2901; #3309, #3729, audit faucet a5-2-1 + a8-1-1): a tap key is the tab's identity
 * key, not the entry's player key, so nothing at the seats ties it to the entry whose lock verified. It was learnt whenever any non-bot entry's
 * lock verified, and a stranger who signed a tap of a real player's round with his own fresh key got that never-staked key into KNOWN. Now a
 * tap key is learnt only when it is the one key that tapped the round and the round holds exactly one non-bot entry, whose stake lock a seat
 * verified. `tapKeys`: the row's verified tap keys (tapKeysOf); `entries`, `locks`, `botKeys` as for botMayEnter. Returns a key hex or null.
 */
export function tapKeyToLearn({ tapKeys = [], entries = [], locks = new Map(), botKeys = new Set() }) {
  const keys = [...new Set(tapKeys.map(String))];
  if (keys.length !== 1 || botKeys.has(keys[0])) return null;
  const others = entries.filter((e) => e && e.entry && !botKeys.has(String(e.player || '')));
  return others.length === 1 && locks.has(others[0].entry) ? keys[0] : null;
}
