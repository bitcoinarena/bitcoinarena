// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A WEBSOCKET THIS SEAT OPENS TO ANOTHER MACHINE READS ITS ANSWER UP TO A CAP (kanban #3724, gap in #3690, #1469/#2637): Node's own
// WebSocket (undici, globalThis.WebSocket) has no message cap at all, and the 'ws' client's default is 100 MiB - one guardian or peer
// answering with one huge frame had it buffered, turned into a string and parsed whole, outside wsMessages and the body budget. Every
// outgoing dial of the guardian API goes through dialWs with a cap that fits the real answer; a frame past it fails the socket (ws
// 1009, an 'error' event), and the caller counts that as no answer and cut()s the socket.
//
// THE DIAL GUARD STILL APPLIES (kanban #3133, #3539): the 'ws' client does not go through undici's global dispatcher, so the guard's
// connect-time lookup (dial-guard.js guardedLookup: a name resolving to a loopback or private address is not connected) is handed to
// it directly - on every Node, wherever that Node's undici keeps its dispatcher.
import { WebSocket } from 'ws';
import { guardedLookup } from './dial-guard.js';

// WHAT A GUARDIAN'S API ANSWERS (fedimint JSON-RPC, measured from the calls this seat makes):
// - module_N_wallet_summary: { spendable_utxos, unsigned_peg_out_txos, unsigned_change_utxos, unconfirmed_peg_out_txos,
//   unconfirmed_change_utxos }, each entry { outpoint "<64 hex>:<vout>", amount } - about 90 bytes, so 1 MiB is ~11 000 UTXOs;
//   module_N_federation_wallet one { value, outpoint, tweak } (under 300 bytes); session_count one number;
// - client_config: the federation's api endpoints, broadcast keys and module configs - the largest part is the mint's per-peer
//   per-denomination keys (~200 bytes each: 7 guardians x ~47 denominations is ~70 KB, 31 guardians ~300 KB).
/** The most of one answer of a guardian's API a seat reads (kanban #3724). */
export const GUARDIAN_ANSWER_MOST = 1024 * 1024;
/** The seat's own guardian, asked for a batch (gateway-volume.js: 1024 incoming contracts of ~1 KB each, 500 wallet v2 outputs). */
export const GUARDIAN_BATCH_MOST = 16 * 1024 * 1024;

/**
 * A 'ws' client socket to `url` that reads at most `maxPayload` bytes of one message, with the dial guard's lookup. `handshakeTimeout`
 * (ms) bounds the opening handshake when given. The socket speaks both the 'ws' API (on/once) and the EventTarget one (addEventListener,
 * onmessage: a text frame's data is a string, as with Node's own WebSocket).
 */
export function dialWs(url, { maxPayload = GUARDIAN_ANSWER_MOST, handshakeTimeout } = {}) {
  const opts = { maxPayload, lookup: guardedLookup };
  if (handshakeTimeout > 0) opts.handshakeTimeout = handshakeTimeout;
  return new WebSocket(url, opts);
}

// A SEAT'S /play ANSWER TO A FRAME THIS SEAT HANDS IT (kanban #3749, the door #3690 capped for offerReceiptTo at 64 KiB): a mark is answered
// with its signed receipt (a few hundred bytes) or one 'error ...' line, a receipt with 'held' or a refusal line.
/** The most of one /play answer a seat reads when it dials a peer's /play (kanban #3749; #3690's OFFER_ANSWER_MOST). */
export const PLAY_ANSWER_MOST = 64 * 1024;
/** How long a /play dial's opening handshake may take (the relay's own answer timer bounds the rest). */
export const PLAY_OPEN_MS = 5000;
/** `new PlaySocket(url)`: dialWs with the /play cap, for the callers that take a WebSocket class. */
export function PlaySocket(url) { return dialWs(url, { maxPayload: PLAY_ANSWER_MOST, handshakeTimeout: PLAY_OPEN_MS }); }

/** `new GuardianSocket(url)`: dialWs with the guardian cap, for the callers that take a WebSocket class (`new WS(url)`). */
export function GuardianSocket(url) { return dialWs(url, { maxPayload: GUARDIAN_ANSWER_MOST }); }

/** Ends a socket at once (terminate: a polite close() leaves it reading until the peer's close frame comes); never throws. */
export function cut(ws) {
  try { if (!ws) return; if (typeof ws.terminate === 'function') ws.terminate(); else ws.close(); } catch { /* gone */ }
}
