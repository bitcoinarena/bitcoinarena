// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT ACCUSES SOMEBODY GOES SOMEWHERE PUBLIC TOO (spec §25.2): "equivocation proofs, objections - direct, AND any
// public broadcast channel ... The Round Contract names where: publication_relays[]". Transcripts and slash proofs already went
// there; an objection and a checkpoint equivocation stayed at the seat that took them. These send them on, best effort - a
// relay keeps no promise (§25.2: "Relays have none") - and each relay is a seat door that checks what it is handed itself.
import { PlaySocket, cut } from './ws-dial.js';   // kanban #3749: a peer's /play answer is read up to a cap

const base = (relay) => String(relay).replace(/\/+$/, '');

/**
 * WHERE A ROUND'S RELAYS ARE NOW (kanban #808, 2026-10-31: "immer die richtige IP, auch wenn sich der Tunnel geändert hat"). The contract's
 * publication_relays[] is signed for the day, so an address in it outlives the machine or tunnel it named (5e7fe7e0 VOID at 07:19Z: all seven on the
 * macOS whose forwards had stopped, 0 of 5 postings). `announced` is the committee at the addresses it announces now (Verifier.peersOf, the
 * address book of kanban #757): every seat is a relay door, so these are relays too. The listed ones first, each address once.
 */
export const relayTargets = (listed, announced) => [...new Map([...(listed || []), ...(announced || [])].map((r) => [base(r), r])).values()];

/**
 * PUT a transcript at each listed relay and read it back; only when none kept it, at the committee's announced addresses. A posting needs one
 * relay that holds the bytes. Answers { held: [relay], refused: [why] }.
 */
// A RELAY'S ANSWER IS BOUNDED (kanban #3001, audit gossip r3-1, measured 2026-11-19): the read-back was read whole with no deadline - one relay
// answering it with an endless body grew the seat's heap, one that sent headers and then nothing held publish, and settleTheStakes behind it,
// for good; the relays were asked one after another, so a relay listed first held back the honest ones too. Each PUT and GET now has
// `timeoutMs`, the read-back is read up to the transcript's size (+ RELAY_BACK_SLACK), and the relays of one pass are asked side by side.
// ONE SLOW RELAY HOLDS NOBODY BACK (kanban #3160, refute of #3001): a pass waited for its slowest relay (Promise.all), and a relay
// answering the PUT just inside the deadline and then nothing on the read-back cost ~2 x RELAY_TIMEOUT_MS per entry, which
// settleTheStakes paid once per entry, one after another. A relay now has one deadline for its PUT and read-back together, and a
// pass ends RELAY_GRACE_MS after the first relay held the bytes; a relay still busy then goes on alone within its own deadline.
// THE LISTED RELAYS GET A HEAD START, NOT THE WHOLE DEADLINE (kanban #3185, refute of #3160): the announced addresses were asked only
// after the listed pass ended with nothing held. dayTemplate lists one relay, the poster seat itself, so that one seat (a PUT answered
// just inside the deadline, then a silent read-back) or a dead or black-holed listed address still cost every honest seat the whole
// RELAY_TIMEOUT_MS per entry. Now the announced addresses are asked RELAY_HEADSTART_MS after the listed ones when no listed relay has
// held the bytes by then (at once when every listed relay has already failed); a listed holder before that keeps them unasked, as before.
// Listed relays come first in `held`; one grace window, started by the first holder of either set, ends the publish.
export const RELAY_TIMEOUT_MS = 15000, RELAY_BACK_SLACK = 1024, RELAY_GRACE_MS = 1000, RELAY_HEADSTART_MS = 2000;
async function bytesWithin(r, maxBytes) {
  if (!r.body || typeof r.body.getReader !== 'function') return new Uint8Array(await r.arrayBuffer());   // an injected stand-in
  const reader = r.body.getReader(), parts = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > maxBytes) { reader.cancel().catch(() => {}); throw new Error(`its read-back passed ${maxBytes} bytes`); }
    parts.push(value);
  }
  const out = new Uint8Array(n); let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out;
}
export async function postTranscript({ listed, announced, path, bytes, fetcher = fetch, sameBytes, timeoutMs = RELAY_TIMEOUT_MS, graceMs = RELAY_GRACE_MS, headStartMs = RELAY_HEADSTART_MS }) {
  const refused = [];
  const post = async (relay) => {
    const at = `${base(relay)}${path}`;
    const signal = AbortSignal.timeout(timeoutMs);   // one deadline for the PUT and its read-back (kanban #3160)
    try {
      const put = await fetcher(at, { method: 'PUT', body: bytes, signal });
      if (!put.ok) { refused.push(`${relay}: kept nothing (${put.status})`); return false; }
      const back = await bytesWithin(await fetcher(at, { signal }), bytes.length + RELAY_BACK_SLACK);
      if (!sameBytes(back, bytes)) { refused.push(`${relay}: gave back other bytes`); return false; }
      return true;
    } catch (e) { refused.push(`${relay}: ${e.message}`); return false; }
  };
  // Side by side; done when every relay asked has answered, or graceMs after the first one held the bytes (kanban #3160). The announced
  // addresses join headStartMs after the listed ones, or at once when every listed relay failed, unless a listed one held first (kanban #3185).
  const first = [...new Map((listed || []).map((r) => [base(r), r])).values()];
  const firstBases = new Set(first.map(base));
  const fallback = relayTargets([], announced).filter((r) => !firstBases.has(base(r)));
  const held = await new Promise((resolve) => {
    const asked = [], ok = []; let left = 0, grace = null, head = null, done = false, joined = false;
    const finish = () => { if (done) return; done = true; clearTimeout(grace); clearTimeout(head); resolve(asked.filter((_, i) => ok[i])); };
    const ask = (relays) => relays.forEach((r) => {
      const i = asked.push(r) - 1; ok[i] = false; left += 1;
      post(r).then((kept) => {
        if (done) return;
        ok[i] = kept; left -= 1;
        if (kept && i < first.length) clearTimeout(head);   // a listed relay held: the announced ones stay unasked
        if (kept && !grace) grace = setTimeout(finish, graceMs);
        if (!left) { if (!joined && !ok.some(Boolean)) join(); else finish(); }
      });
    });
    const join = () => { if (joined || done) return; joined = true; clearTimeout(head); ask(fallback); if (!left) finish(); };
    ask(first);
    if (!first.length) join(); else head = setTimeout(join, headStartMs);
  });
  return { held, refused: [...refused] };
}

/** POST `body` to `path` at every relay. Answers { sent, failed: [why] } once every relay answered or timed out. */
export async function relayPost(relays, path, body, { fetcher = fetch, timeoutMs = 8000 } = {}) {
  const failed = []; let sent = 0;
  await Promise.all((relays || []).map(async (r) => {
    try {
      const got = await fetcher(`${base(r)}${path}`, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) });
      if (got.ok) sent += 1; else failed.push(`${r}: ${got.status}`);
    } catch (e) { failed.push(`${r}: ${e.message}`); }
  }));
  return { sent, failed };
}

/**
 * Hand signed marks to every relay over its /play socket, in order - the door a mark comes through; a relay holding one of
 * them and handed the other records the pair itself (round.js). Answers { sent, failed } once every relay answered each mark.
 */
// kanban #3749 (gap in #3690): dialed with the /play cap (PLAY_ANSWER_MOST, 64 KiB) and the dial guard's lookup, not the 'ws' default of
// 100 MiB - one round peer answering each relayed mark with a near-100 MiB frame had both read whole by every seat relaying to it. A frame
// past the cap fails the socket (1009): that relay counts as failed. The socket is cut (terminate) on the timer, an error and the answer.
export async function relayMarks(relays, marks, { Socket = PlaySocket, timeoutMs = 10000 } = {}) {
  const failed = []; let sent = 0;
  await Promise.all((relays || []).map((r) => new Promise((done) => {
    let ws; let answered = 0;
    let ended = false;
    const end = (ok, why) => { if (ended) return; ended = true; clearTimeout(timer); cut(ws); if (ok) sent += 1; else failed.push(`${r}: ${why}`); done(); };
    const timer = setTimeout(() => end(false, 'no answer'), timeoutMs);
    try { ws = new Socket(`${base(r).replace(/^http/, 'ws')}/play`); } catch (e) { end(false, e.message); return; }
    ws.on('open', () => { for (const m of marks) ws.send(m); });
    ws.on('message', () => { answered += 1; if (answered >= marks.length) end(true); });
    ws.on('error', (e) => end(false, e.message));
  })));
  return { sent, failed };
}
