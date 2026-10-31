// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT ACCUSES SOMEBODY GOES SOMEWHERE PUBLIC TOO (spec §25.2): "equivocation proofs, objections - direct, AND any
// public broadcast channel ... The Round Contract names where: publication_relays[]". Transcripts and slash proofs already went
// there; an objection and a checkpoint equivocation stayed at the seat that took them. These send them on, best effort - a
// relay keeps no promise (§25.2: "Relays have none") - and each relay is a seat door that checks what it is handed itself.
import { WebSocket } from 'ws';

const base = (relay) => String(relay).replace(/\/+$/, '');

/**
 * WHERE A ROUND'S RELAYS ARE NOW (kanban #808, the owner 2026-10-31: "immer die richtige IP, auch wenn sich der Tunnel geändert hat"). The contract's
 * publication_relays[] is signed for the day, so an address in it outlives the machine or tunnel it named (5e7fe7e0 VOID at 07:19Z: all seven on the
 * test host whose forwards had stopped, 0 of 5 postings). `announced` is the committee at the addresses it announces now (Verifier.peersOf, the
 * address book of kanban #757): every seat is a relay door, so these are relays too. The listed ones first, each address once.
 */
export const relayTargets = (listed, announced) => [...new Map([...(listed || []), ...(announced || [])].map((r) => [base(r), r])).values()];

/**
 * PUT a transcript at each listed relay and read it back; only when none kept it, at the committee's announced addresses. A posting needs one
 * relay that holds the bytes. Answers { held: [relay], refused: [why] }.
 */
export async function postTranscript({ listed, announced, path, bytes, fetcher = fetch, sameBytes }) {
  const held = [], refused = [];
  const post = async (relay) => {
    const at = `${base(relay)}${path}`;
    try {
      const put = await fetcher(at, { method: 'PUT', body: bytes });
      if (!put.ok) { refused.push(`${relay}: kept nothing (${put.status})`); return; }
      const back = new Uint8Array(await (await fetcher(at)).arrayBuffer());
      if (!sameBytes(back, bytes)) { refused.push(`${relay}: gave back other bytes`); return; }
      held.push(relay);
    } catch (e) { refused.push(`${relay}: ${e.message}`); }
  };
  for (const relay of listed || []) await post(relay);
  if (!held.length) for (const relay of relayTargets([], announced).filter((r) => !relayTargets(listed).includes(base(r)))) await post(relay);
  return { held, refused };
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
export async function relayMarks(relays, marks, { Socket = WebSocket, timeoutMs = 10000 } = {}) {
  const failed = []; let sent = 0;
  await Promise.all((relays || []).map((r) => new Promise((done) => {
    let ws; let answered = 0;
    const end = (ok, why) => { clearTimeout(timer); try { ws.close(); } catch { /* gone */ } if (ok) sent += 1; else failed.push(`${r}: ${why}`); done(); };
    const timer = setTimeout(() => end(false, 'no answer'), timeoutMs);
    try { ws = new Socket(`${base(r).replace(/^http/, 'ws')}/play`); } catch (e) { end(false, e.message); return; }
    ws.on('open', () => { for (const m of marks) ws.send(m); });
    ws.on('message', () => { answered += 1; if (answered >= marks.length) end(true); });
    ws.on('error', (e) => end(false, e.message));
  })));
  return { sent, failed };
}
