// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PLAYER'S NAME, AS THE WHOLE NETWORK SHOWS IT (PIP, 2026-10-17: "Users can sign in with their ingame key and
// their custom name or their generated name" - "Have custom names in the protocol").
//
// The lobby's name record (lobby-name.js) is one round's: signed by the round key, kept by that round's signer nodes. This one is
// the player's own, for anywhere a player is named outside a round - the proposals forum first: the network it is for, the player's
// IDENTITY key (the key its generated name is made from, display-name.js), when (ms), and the name the player chose - empty for
// none, and then the generated one is shown. The identity key signs it (BIP-340), so a node can leave a name out but cannot write
// one; nodes keep the newest per player and refuse one dated more than PLAYER_NAME_SKEW_MS ahead of their clock. The name is held
// to the lobby's rule (lobbyNameIsValid): one rule names a player everywhere. Like every name, it decides nothing (§0.12).
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { PROTOCOL_VERSION, speaksVersion, TYPE_PLAYER_NAME, TAG } from './constants.js';
import { lobbyNameIsValid } from './lobby-name.js';

/** How far ahead of a node's clock a name may be dated and still be kept. */
export const PLAYER_NAME_SKEW_MS = 10 * 60 * 1000;

const n32 = (b) => b instanceof Uint8Array && b.length === 32;

export function encodePlayerName({ networkId, player, atMs, name = '' } = {}) {
  if (!n32(networkId) || !n32(player)) throw new Error('a player name names its network and the player\'s identity key by 32 bytes each');
  const at = BigInt(atMs);
  if (at < 0n) throw new Error('a player name\'s time is not negative');
  if (typeof name !== 'string') throw new Error('a name is text');
  if (name !== '') {
    const kept = lobbyNameIsValid(name);
    if (!kept.ok) throw new Error(kept.why);
    if (kept.name !== name) throw new Error('a name is signed as it is kept: trimmed, one space between words');
  }
  const w = new Writer();
  w.u8(TYPE_PLAYER_NAME); w.u16(PROTOCOL_VERSION);
  w.bytes32(networkId); w.bytes32(player); w.u64(at); w.str(name);
  return w.finish();
}

export function decodePlayerName(bytes) {
  const r = new Reader(bytes);
  if (r.u8() !== TYPE_PLAYER_NAME) throw new Error('not a player name');
  if (!speaksVersion(r.u16())) throw new Error('unknown protocol version');
  const n = { networkId: r.bytes32(), player: r.bytes32(), atMs: r.u64(), name: r.str() };
  if (r.at !== bytes.length) throw new Error('trailing bytes after the player name');
  encodePlayerName(n);                       // the same rules on the way in
  return n;
}

/** What the player's identity key signs (BIP-340). */
export const playerNameId = (n) => taggedHash(TAG.playerName, encodePlayerName(n));

/** Of two records of one player, the one that stands: the later; at the same ms, the lower id. */
export function newerPlayerName(a, b) {
  if (!a) return b; if (!b) return a;
  if (a.obj.atMs !== b.obj.atMs) return a.obj.atMs > b.obj.atMs ? a : b;
  return a.idHex < b.idHex ? a : b;
}
