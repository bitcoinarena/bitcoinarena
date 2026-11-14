// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A HEADLESS PLAYER'S REVEAL, AS THE PAGE MAKES IT (kanban #2658, audit #1489 r1-h2h-2, high). From protocol 28 (kanban #2561) no seat takes a
// reveal before the round's certified lock set: POST /reveal answers 409 "not certified yet - ask again shortly". The house opponent
// (tools/rps-opponent.mjs) and tn4-rps-paid.mjs revealed ONCE with revealMove at the entry close + 150 ms, every seat refused it, the bot's
// entry FORFEITED and whoever sat at its table won every paid round whatever the moves. Here the reveal goes the page's way: a round below 28
// at once, a round of 28 and later once the certificate stands against the round's own committee (its contract's seats) under BIP-340.
import { schnorr } from '@noble/curves/secp256k1.js';
import { revealMove, revealWhenCertified } from '../../arena-client/src/head-to-head.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';

/** Reveal `move`/`salt` of entry `entryIdHex` in round contract `c` (id `roundIdHex`) to `nodes`. Answers revealWhenCertified's shape: { seats, ... }. */
export async function revealAsPage({ c, roundIdHex, entryIdHex, move, salt, nodes, identity = null, now = () => Date.now(), fetcher = fetch, onWait = null }) {
  if (Number(c.protocolVersion || 1) < LOCK_SET_VERSION) return { seats: await revealMove({ entryIdHex, move, salt, nodes, identity, fetcher }), certified: null };
  return revealWhenCertified({ roundIdHex, entryIdHex, move, salt, nodes, identity, committee: (c.nodes || []).map((k) => toHex(k)),
    verify: (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } }, entryCloseMs: c.entryCloseMs, now, fetcher, onWait });
}
