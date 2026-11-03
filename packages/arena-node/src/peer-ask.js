// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ASKING THE OTHER SEATS, WITHIN A BOUND (kanban #1061). A seat that is stopped still takes the connection: the kernel accepts it, nothing answers, and a fetch waits
// up to undici's 300 s for the headers (measured: connection refused 46 ms, that one 300 s; on seven real seats the settlement waited for two seats under SIGSTOP).
// Only a hung seat costs the bound: a dead one refuses at once.

/** A seat's POST that needs work there (a plan checked, a settlement rebuilt): spent whole only when the threshold has not answered. */
export const PEER_ASK_MS = 60000;
/** A read of what a seat already holds. Shorter than PEER_ASK_MS, since a seat answering a POST may be making this read of a third seat first. */
export const PEER_READ_MS = 10000;
/** Once the threshold has answered, how long the others still have: a healthy seat is in the list as it always was, a hung one costs this much. */
export const PEER_GRACE_MS = 3000;

/**
 * EVERY PEER ASKED AT THE SAME TIME, one answer per peer in the peers' order. `ask(peer, signal)` is the whole exchange, the body read too: `signal` ends it at `boundMs`.
 * Answers are { peer, value }, or { peer, error } for a throw or no answer. With `enough` answers that `counts`, the rest have `graceMs` and then are left unanswered here.
 * A request left is not cancelled before the bound, so a slow seat still gets what it was sent. Never rejects.
 */
export function askPeers(peers, ask, { boundMs = PEER_ASK_MS, graceMs = PEER_GRACE_MS, enough = Infinity, counts = () => true } = {}) {
  return new Promise((resolve) => {
    const unanswered = new Map(peers.map((peer) => [peer, new Error(`no answer in ${boundMs} ms`)]));
    const answers = peers.map((peer) => ({ peer, error: unanswered.get(peer) }));
    if (!peers.length) { resolve(answers); return; }
    const signal = AbortSignal.timeout(boundMs);
    let left = peers.length;
    let good = 0;
    let grace = null;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(grace);
      signal.removeEventListener('abort', close);
      resolve(answers.slice());
    };
    const startGrace = () => {
      if (good >= enough && grace === null) grace = setTimeout(() => { for (const x of answers) if (x.error === unanswered.get(x.peer)) x.error = new Error('no answer once enough had'); close(); }, graceMs);
    };
    const land = (i, answer, counted) => {
      if (closed) return;
      answers[i] = answer;
      if (counted) good += 1;
      left -= 1;
      if (left === 0) close(); else startGrace();
    };
    signal.addEventListener('abort', close, { once: true });
    startGrace();
    peers.forEach((peer, i) => {
      Promise.resolve().then(() => ask(peer, signal)).then((value) => land(i, { peer, value }, counts(value)), (error) => land(i, { peer, error }, false));
    });
  });
}

/**
 * ONE ASK WITHIN A BOUND (kanban #1074): `ask(signal)` is the whole exchange, the body read too. Answers its value, or throws `no answer in <boundMs> ms`
 * (or the ask's own error). For a server that is not a seat, such as an address's LNURL endpoint.
 */
export async function askWithin(ask, boundMs) {
  const [x] = await askPeers(['one'], (_, signal) => ask(signal), { boundMs });
  if (!('value' in x)) throw x.error;
  return x.value;
}
