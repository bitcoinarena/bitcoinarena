// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT ACCUSES SOMEBODY GOES SOMEWHERE PUBLIC TOO (spec §25.2, kanban #327): "equivocation proofs, objections - direct, AND any
// public broadcast channel ... The Round Contract names where: publication_relays[]". Transcripts and slash proofs already went
// there; an objection and a checkpoint equivocation stayed at the seat that took them. These send them on, best effort - a
// relay keeps no promise (§25.2: "Relays have none") - and each relay is a seat door that checks what it is handed itself.
import { WebSocket } from 'ws';

const base = (relay) => String(relay).replace(/\/+$/, '');

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
