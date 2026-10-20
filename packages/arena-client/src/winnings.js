// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHERE A WINNER'S WINNINGS ARE SENT (RULED 2026-09-23: winnings are always sent; a qualifier who names no
// address is not paid, its share pooled over those who did).
//
// ONCE, AT THE RUN'S END, AND ONLY TO A QUALIFIER. On the existing ARENA_RUN_OVER hook the page asks the player one
// question, and only when its own core says DELIVERED with a score at or above the round's min_score. The key
// `arena.winnings.asked.<round>.<entry>` is written BEFORE the prompt, so a reload - or the hook firing twice, which
// it does - never asks again. A wreck, a forfeit or a score below min_score is asked nothing and posts nothing.
//
// WHAT IS SIGNED IS THE ADDRESS AND NOTHING ELSE: its UTF-8 bytes, by the entry's session key, through the bridge's
// one narrow call (`run.signAddress`) - no score, no payout, no round id. That is what the signer nodes' door checks.
//
// EVERY SIGNER NODE OF THE ROUND IS TOLD, not the gateways: each builds the settlement from the addresses it holds
// itself, and a node missing one rebuilds other amounts and refuses the plan. So an accepted address is kept as
// `arena.winnings.addr.<round>.<entry>` - the address, its signature, the round's nodes and which of them answered
// 201 - and on every load the page posts the SAME signed bytes again to the nodes that did not, and to no other,
// until every one has. Empty, cancelled or not an address: nothing is kept and nothing is posted; the share is
// pooled by the settlement.
import { lightningAddressEndpoint } from '../../arena-protocol/src/lnurl-pay.js';
import { toHex } from '../../arena-protocol/src/hash.js';

export const WINNINGS_PROMPT = 'Where should your winnings be sent? Lightning address (name@host)';
export const WINNINGS_ASKED_PREFIX = 'arena.winnings.asked.';
export const WINNINGS_ADDR_PREFIX = 'arena.winnings.addr.';
const WINNINGS_DELIVERED_WORD = 1;

export const winningsAskedKey = (roundHex, entryHex) => `${WINNINGS_ASKED_PREFIX}${roundHex}.${entryHex}`;
export const winningsAddrKey = (roundHex, entryHex) => `${WINNINGS_ADDR_PREFIX}${roundHex}.${entryHex}`;

/** Whether this run is a qualifier's: the page core's word DELIVERED, its score at or above the round's min_score. */
export function winningsQualify({ word, score, minScore } = {}) {
  return (word | 0) === WINNINGS_DELIVERED_WORD && Number.isFinite(Number(score)) && Number(score) >= Number(minScore || 0);
}

/** The address a player typed, as the bytes that are signed and posted - or null when it is not a Lightning address. */
export function winningsAddressOf(typed) {
  const address = String(typed == null ? '' : typed).trim();
  if (!address) return null;
  return lightningAddressEndpoint(address).ok ? address : null;
}

const winningsRead = (storage, key) => { try { return storage.getItem(key); } catch { return null; } };
const winningsWrite = (storage, key, value) => { try { storage.setItem(key, value); return true; } catch { return false; } };
const winningsKeys = (storage) => {
  const out = [];
  try { for (let i = 0; i < storage.length; i++) out.push(storage.key(i)); } catch { /* none readable */ }
  return out.filter((k) => typeof k === 'string');
};

/** POST one signed address to one signer node; true only on its 201. */
async function winningsPost(node, entryHex, body, fetcher) {
  try {
    const r = await fetcher(`${String(node).replace(/\/$/, '')}/payout-address?entry=${entryHex}`, { method: 'POST', body });
    return r.status === 201;
  } catch { return false; }
}

/**
 * POST EVERY KEPT ADDRESS TO THE SIGNER NODES THAT HAVE NOT TAKEN IT - and only to them. What the page runs at load
 * and right after the one prompt. Returns one line per kept address: whom it was posted to now, and who holds it.
 */
export async function resendWinnings({ storage, fetcher = fetch } = {}) {
  const out = [];
  for (const key of winningsKeys(storage).filter((k) => k.startsWith(WINNINGS_ADDR_PREFIX))) {
    let kept;
    try { kept = JSON.parse(winningsRead(storage, key)); } catch { continue; }
    if (!kept || !Array.isArray(kept.nodes) || typeof kept.address !== 'string' || typeof kept.signature !== 'string') continue;
    const acked = new Set(Array.isArray(kept.acked) ? kept.acked : []);
    const owed = kept.nodes.filter((n) => !acked.has(n));
    const body = new Uint8Array([...new TextEncoder().encode(kept.address), ...winningsHexBytes(kept.signature)]);
    const posted = [];
    for (const node of owed) {
      posted.push(node);
      if (await winningsPost(node, kept.entry, body, fetcher)) acked.add(node);
    }
    if (posted.length) winningsWrite(storage, key, JSON.stringify({ ...kept, acked: [...acked] }));
    out.push({ round: kept.round, entry: kept.entry, posted, acked: [...acked], complete: kept.nodes.every((n) => acked.has(n)) });
  }
  return out;
}

const winningsHexBytes = (h) => Uint8Array.from(String(h).match(/../g) || [], (x) => parseInt(x, 16));

/**
 * THE ONE QUESTION, on the run-over hook. `run` is the bridge's: { roundHex, entryHex, word, score, minScore, nodes,
 * signAddress }. `prompt` is the page's `window.prompt`. Returns what happened, for the page's console and a test.
 */
export async function askForWinnings({ run, prompt, storage, fetcher = fetch } = {}) {
  if (!run || typeof run.roundHex !== 'string' || typeof run.entryHex !== 'string') return { asked: false, why: 'no run to ask for' };
  if (!winningsQualify(run))
    return { asked: false, why: `not a qualifier: word ${run.word | 0}, score ${run.score} against min_score ${run.minScore}` };
  const askedKey = winningsAskedKey(run.roundHex, run.entryHex);
  if (winningsRead(storage, askedKey) !== null) return { asked: false, why: 'already asked for this entry' };
  // WRITTEN BEFORE THE PROMPT: whatever the player does next, this entry is never asked again.
  if (!winningsWrite(storage, askedKey, String(Date.now()))) return { asked: false, why: 'this page cannot remember that it asked, so it does not ask' };
  let typed = null;
  try { typed = prompt(WINNINGS_PROMPT); } catch { typed = null; }
  const address = winningsAddressOf(typed);
  if (!address) return { asked: true, named: false, why: 'no Lightning address named: the share is pooled over those who named one' };
  let signature;
  try { signature = await run.signAddress(address); } catch (e) { return { asked: true, named: false, why: `the address was not signed: ${e.message}` }; }
  const nodes = [...new Set((run.nodes || []).map(String))];
  winningsWrite(storage, winningsAddrKey(run.roundHex, run.entryHex), JSON.stringify({ round: run.roundHex, entry: run.entryHex, address,
    signature: toHex(signature), nodes, acked: [] }));
  const sent = await resendWinnings({ storage, fetcher });
  const mine = sent.find((s) => s.entry === run.entryHex && s.round === run.roundHex) || null;
  return { asked: true, named: true, address, posted: mine ? mine.posted : [], acked: mine ? mine.acked : [], complete: !!(mine && mine.complete) };
}
