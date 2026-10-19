// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A PLAYER'S CHOSEN NAME, AS THE OTHER PLAYERS OF ITS ROUND ARE SHOWN IT (M3.3-34).
//
// The name decides nothing (§0.12): it is in no entry, no mark and no result,
// and the board still shows the name made from a player's key. But a lobby two
// players share shows each the other's name, so a tab hands its signer nodes ONE
// RECORD: this round, the round key it is joined under, the tab's identity key
// (its generated name is made from that), the name the player chose - empty
// for none - and when. The joined player's round key signs it (BIP-340), so a
// signer node that serves it can leave a name out but cannot write one, and a record
// for one round is no record for another. The newest record of a player wins.
import { Writer, Reader } from './encode.js';
import { taggedHash } from './hash.js';
import { TAG } from './constants.js';

/** The longest name a player may choose, in characters. */
export const LOBBY_NAME_MAX = 24;

/**
 * WHETHER A CHOSEN NAME STANDS, and the name as it is kept: trimmed, inner
 * spaces collapsed, 1 to 24 characters, letters and digits with space, dot,
 * dash and underscore between them. Anything else is refused by name.
 */
export function lobbyNameIsValid(text) {
  const name = String(text == null ? '' : text).normalize('NFC').trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, why: 'a name is at least one character' };
  if ([...name].length > LOBBY_NAME_MAX) return { ok: false, why: `a name is at most ${LOBBY_NAME_MAX} characters` };
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N} ._-]*[\p{L}\p{N}])?$/u.test(name))
    return { ok: false, why: 'a name is letters and digits, with space, dot, dash or underscore between them' };
  return { ok: true, name };
}

const nameIs32 = (b) => b instanceof Uint8Array && b.length === 32;

export function encodeLobbyName({ roundId, playerPubkey, identityPubkey, name = '', atMs } = {}) {
  if (!nameIs32(roundId)) throw new Error('a name record names a 32-byte round id');
  if (!nameIs32(playerPubkey)) throw new Error('a name record is signed by a 32-byte player key');
  if (!nameIs32(identityPubkey)) throw new Error('a name record carries the 32-byte identity key its generated name is made from');
  const at = BigInt(atMs);
  if (at < 0n) throw new Error('a name record\'s time is not negative');
  const text = name == null ? '' : name;
  if (typeof text !== 'string') throw new Error('a name is text');
  if (text !== '') {
    const kept = lobbyNameIsValid(text);
    if (!kept.ok) throw new Error(kept.why);
    if (kept.name !== text) throw new Error('a name is signed as it is kept: trimmed, one space between words');
  }
  const w = new Writer();
  w.bytes32(roundId);
  w.bytes32(playerPubkey);
  w.bytes32(identityPubkey);
  w.u64(at);
  w.str(text);
  return w.finish();
}

/** A record as a signer node or a page receives it; held to the same rules as one written. */
export function decodeLobbyName(bytes) {
  const r = new Reader(bytes);
  const record = { roundId: r.bytes32(), playerPubkey: r.bytes32(), identityPubkey: r.bytes32(), atMs: r.u64(), name: r.str() };
  r.end();
  encodeLobbyName(record);
  return record;
}

/** What the joined player signs (BIP-340, its round key) for its name in one round. */
export const lobbyNameId = (record) => taggedHash(TAG.lobbyName, encodeLobbyName(record));
