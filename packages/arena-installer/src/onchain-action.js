// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WALLET'S ON-CHAIN ACTIONS, WRITTEN BEFORE THEY ARE SENT (kanban #1165, the state machine audit 2026-11-06). Every transaction the
// installer sends from the node's wallet - the first bond, an added output, a larger bond, the move to the key from the words, an
// advertisement update (custody, roles, games, guardian_of), a peg-in, a liquidity / outside / ring deposit, a further node's deposit -
// went "not posted -> broadcast -> recorded" with nothing recorded in between. A crash, a lost HTTP answer, a double click or the custody
// agent's next tick then built a SECOND valid transaction (wallet.js coinsOf counts the mempool's change and drops the coins it spends):
// a second bond, a second peg-in.
//
// Now one action of the wallet at a time, kept in state.json `onchain` (state.js: atomic, locked):
//
//   (none) --begin--> BUILT --every tx accepted or seen--> SENT --its effect done, its record written--> DONE
//                       \--a tx refused as a conflict and seen nowhere-------------------------------> VOID
//
//   - BUILT is written - the signed transactions' bytes and txids, and what the state will record - BEFORE the first broadcast;
//   - every entry (any process: the wizard, the owner page, the custody agent) first finishes the open action: the SAME bytes broadcast
//     again ("already in the mempool / chain" is a success), never a new transaction built while one is open;
//   - DONE writes the record (ops) in the same atomic write that closes the action, so it is written exactly once;
//   - DONE and VOID are terminal. `once` kinds (the first bond, a federation's guardian_of and peg-in, ...) never run twice; an action
//     asked again with the same key answers the one done (the owner page's double click, a lost answer);
//   - VOID only when the chain says it can never confirm: refused as a conflict (its inputs spent elsewhere) and seen neither in the
//     mempool nor in a block since it was built. Anything else (no answer, a fee refused) keeps it open, to be sent again.
// A state.json from before has no `onchain`: it reads as no action open. One written here reads in an older installer, which ignores it.
import { randomBytes } from 'node:crypto';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { bondsOf } from './state.js';

export const ACTION = Object.freeze({ BUILT: 'built', SENT: 'sent', DONE: 'done', VOID: 'void' });
const A = ACTION;
/** The only moves there are (begin makes BUILT from nothing); DONE and VOID never change. */
const MOVES = Object.freeze({ [A.BUILT]: [A.SENT, A.VOID], [A.SENT]: [A.DONE], [A.DONE]: [], [A.VOID]: [] });

/** A broadcast answer that means the transaction is there already: a success. */
export const ALREADY = /already in (the )?(block ?chain|mempool|utxo set)|txn-already-(known|in-mempool)|already have transaction|outputs already in utxo set|transaction already exists/i;
/** A refusal that means the transaction's inputs are spent by another one. */
export const CONFLICT = /missing ?inputs|missingorspent|txn-mempool-conflict|rejecting replacement|spends-conflicting|bad-txns-inputs-spent/i;

export const txidOfHex = (hex) => toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse());
const onchainOf = (s) => (s && s.onchain && typeof s.onchain === 'object' ? s.onchain : {});
/** The action open in a state, or null (a state from before #1165 has none). */
export const openActionOf = (s) => { const a = onchainOf(s).open; return a && (a.phase === A.BUILT || a.phase === A.SENT) ? a : null; };
/** The last finished action of `kind`, or null. */
export const lastActionOf = (s, kind) => (onchainOf(s).last || {})[kind] || null;
const msgOf = (e) => String((e && e.message) || e);

/** What an action writes when it is DONE, applied to the state as it is then (never a copy read before the broadcast). */
export function applyOps(n, ops = [], atMs = Date.now()) {
  const patch = {};
  const cur = (k) => (k in patch ? patch[k] : n[k]);
  for (const o of ops) {
    if (o.op === 'set') patch[o.key] = o.value;
    else if (o.op === 'merge') patch[o.key] = { ...(cur(o.key) || {}), ...o.value };
    else if (o.op === 'push') patch[o.key] = [...(o.key === 'bonds' ? bondsOf({ ...n, ...patch }) : cur(o.key) || []), ...o.values];
    else if (o.op === 'replace-first') { patch.bond = o.value; patch.bonds = [o.value, ...bondsOf({ ...n, ...patch }).slice(1)]; }
    else if (o.op === 'done') patch.done = { ...(cur('done') || {}), [o.step]: atMs };
    else throw new Error(`not an op an on-chain record knows: ${o.op}`);
  }
  return patch;
}

/**
 * THE ONE TRANSITION: the open action `id` from `from` to `to`, compare-and-set in one locked write - false when it is not open in
 * `from`, or the move is not one there is. DONE writes its record (ops) with it; DONE and VOID close it and keep it as the kind's last.
 */
export function transition(state, id, from, to, { why = null, nowMs = Date.now() } = {}) {
  let moved = false;
  const after = state.update((n) => {
    const o = onchainOf(n), a = o.open;
    if (!a || a.id !== id || a.phase !== from || !(MOVES[from] || []).includes(to)) return null;
    moved = true;
    if (to === A.SENT) return { onchain: { ...o, open: { ...a, phase: A.SENT, sentMs: nowMs, why: null } } };
    // closed: the bytes are not kept (they are on the chain, or never will be); what it was and what it answered are
    const kept = { id: a.id, kind: a.kind, key: a.key, phase: to, txids: a.txs.map((t) => t.txid), result: a.result || null, atMs: a.atMs, closedMs: nowMs, ...(why ? { why } : {}) };
    return { ...(to === A.DONE ? applyOps(n, a.ops, nowMs) : {}), onchain: { ...o, seq: (o.seq || 0) + 1, open: null, last: { ...(o.last || {}), [a.kind]: kept } } };
  });
  return moved ? after : null;
}

/** An open action's note (why it is still open, how often it was sent): only while it is the one open. */
function note(state, id, why) {
  state.update((n) => { const o = onchainOf(n); return o.open && o.open.id === id ? { onchain: { ...o, open: { ...o.open, why, tries: (o.open.tries || 0) + 1, triedMs: Date.now() } } } : null; });
}

/** EFFECTS: what an action does off the chain between SENT and DONE, by name - each one idempotent (asked again after a crash). */
export const EFFECTS = {
  // the node's key moves to the one from its 24 words (identity-switch.js): the old key kept in identity_old and the new one set, in ONE
  // SQLite transaction, only from the key the action was built from (compare-and-set)
  async 'key-switch'(state, a) {
    const { DatabaseSync } = await import('node:sqlite');
    const { schnorr } = await import('@noble/curves/secp256k1.js');
    const { nodeKeyOf } = await import('./seed.js');
    const next = nodeKeyOf(fromHex(String(state.readSecret('seed.hex') || '').trim()));
    if (toHex(schnorr.getPublicKey(next)) !== a.meta.to) throw new Error('the key from the words is not the one this action was built for');
    const db = new DatabaseSync(state.path('node.db'));
    try {
      db.exec('BEGIN IMMEDIATE');
      try {
        const row = db.prepare('SELECT secret FROM identity WHERE one = 0').get();
        const now = row ? toHex(schnorr.getPublicKey(new Uint8Array(row.secret))) : null;
        if (now === a.meta.to) { db.exec('ROLLBACK'); return { already: true }; }
        if (now !== a.meta.from) throw new Error(`the node's key is ${String(now).slice(0, 16)}, neither the one moved from nor the one moved to`);
        db.exec('CREATE TABLE IF NOT EXISTS identity_old (secret BLOB NOT NULL, pubkey BLOB NOT NULL, at_ms INTEGER NOT NULL)');
        db.prepare('INSERT INTO identity_old (secret, pubkey, at_ms) VALUES (?, ?, ?)').run(new Uint8Array(row.secret), fromHex(a.meta.from), a.atMs);
        const cols = db.prepare('PRAGMA table_info(identity)').all().map((c) => c.name);
        if (cols.includes('pubkey')) db.prepare('UPDATE identity SET secret = ?, pubkey = ? WHERE one = 0').run(next, fromHex(a.meta.to));
        else db.prepare('UPDATE identity SET secret = ? WHERE one = 0').run(next);
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* not open */ } throw e; }
    } finally { db.close(); }
    return { moved: true };
  },
};

/**
 * FINISH THE OPEN ACTION, if there is one: its bytes sent again from where they stopped, then its effect, then DONE with its record.
 * Answers { none } | { done: action-as-kept } | { open: action, why } | { void: action-as-kept, why }.
 */
export async function settleOpen(state, { chainKit, log = () => {}, nowMs = () => Date.now() } = {}) {
  const s = state.read();
  const a = openActionOf(s);
  if (!a) return { none: true };
  const chain = s.chain;
  if (a.phase === A.BUILT) {
    let from = 0;
    while (from < a.txs.length) {
      let at = -1, why = null, conflict = false;
      for (let i = from; i < a.txs.length; i++) {
        try { await chainKit.broadcast(chain, a.txs[i].hex); }
        catch (e) { if (ALREADY.test(msgOf(e))) continue; at = i; why = msgOf(e); conflict = CONFLICT.test(why); break; }
      }
      if (at < 0) break;
      // refused: one the chain has already (the funding is refused as "missing inputs" once its bond spent it in a block) - the newest seen
      // counts for every one before it, which it spends
      let seen = -1, asked = typeof chainKit.seen === 'function';
      if (asked) {
        for (let j = a.txs.length - 1; j >= at && seen < 0; j--) {
          try { if (await chainKit.seen(chain, a.txs[j].txid, { sinceTip: a.tip })) seen = j; } catch { asked = false; break; }
        }
      }
      if (seen >= at) { from = seen + 1; continue; }
      // (only with the tip it was built at: without it a mined one is not found in its block, and a mined bond must never be void)
      if (conflict && asked && Number.isInteger(a.tip)) {
        log(`${a.kind}: ${a.txs[at].txid} can never confirm (${why}; seen nowhere since block ${a.tip}): void`);
        const closed = transition(state, a.id, A.BUILT, A.VOID, { why, nowMs: nowMs() });
        return closed ? { void: lastActionOf(closed, a.kind), why } : settleOpen(state, { chainKit, log, nowMs });
      }
      note(state, a.id, why);
      return { open: a, why };
    }
    if (!transition(state, a.id, A.BUILT, A.SENT, { nowMs: nowMs() })) return settleOpen(state, { chainKit, log, nowMs });   // another process moved it
    log(`${a.kind}: sent ${a.txs.map((t) => t.txid).join(', ')}`);
  }
  if (a.effect) {
    const fx = EFFECTS[a.effect];
    if (!fx) return { open: a, why: `this release does not know the effect ${a.effect}` };
    try { await fx(state, a); } catch (e) { note(state, a.id, msgOf(e)); return { open: a, why: msgOf(e) }; }
  }
  const closed = transition(state, a.id, A.SENT, A.DONE, { nowMs: nowMs() });
  if (!closed) { const last = lastActionOf(state.read(), a.kind); return last && last.id === a.id ? { done: last } : settleOpen(state, { chainKit, log, nowMs }); }
  return { done: lastActionOf(closed, a.kind) };
}

/** The open action finished if it can be; answers as settleOpen, with `why` said for the owner when it stays open. */
export async function resumeOpen(state, o = {}) {
  const r = await settleOpen(state, o);
  if (r.open) r.why = `a transaction of this node's wallet (${r.open.kind}: ${r.open.txs.map((t) => t.txid).join(', ')}) is signed and kept but not through yet: ${r.why}. It is sent again at the next try - nothing new is built while it is open`;
  return r;
}

/**
 * RUN AN ON-CHAIN ACTION: the open one finished first; `kind`'s last DONE answered again when `once`, or when it had the same `key` (within
 * `sameWithinMs`, 0 = always); else `build(state read now)` - { ok: false, why } or { ok: true, tip, txs: [{ name, hex }], ops, effect,
 * meta, result } - is written BUILT (only if nothing began or finished meanwhile: the action count `seq` compare-and-set), then sent.
 * Answers { ok: true, result, txids, already? } | { ok: false, pending: true, why } | { ok: false, why }.
 */
export async function onchainAction({ state, kind, key = null, once = false, sameWithinMs = 0, build, chainKit, log = () => {}, nowMs = () => Date.now(), _again = false }) {
  const first = await resumeOpen(state, { chainKit, log, nowMs });
  if (first.open) return { ok: false, pending: true, kind: first.open.kind, txids: first.open.txs.map((t) => t.txid), why: first.why };
  const s = state.read();
  const o = onchainOf(s);
  const repeat = (l) => !!l && l.phase === A.DONE && (once || (key !== null && l.key === key && (!sameWithinMs || nowMs() - l.closedMs < sameWithinMs)));
  const last = lastActionOf(s, kind);
  if (repeat(last)) return { ok: true, already: true, result: last.result, txids: last.txids };
  const built = await build(s);
  if (!built || !built.ok) return built || { ok: false, why: `${kind}: nothing built` };
  const action = { id: randomBytes(8).toString('hex'), kind, key, phase: A.BUILT, atMs: nowMs(), tip: built.tip ?? null,
    txs: built.txs.filter(Boolean).map((t) => ({ name: t.name || null, hex: t.hex, txid: t.txid || txidOfHex(t.hex) })),
    ops: built.ops || [], effect: built.effect || null, meta: built.meta || null, result: built.result || null };
  let began = false;
  state.update((n) => {
    const now = onchainOf(n);
    if (openActionOf(n) || (now.seq || 0) !== (o.seq || 0) || repeat(lastActionOf(n, kind))) return null;
    began = true;
    return { onchain: { ...now, open: action } };
  });
  if (!began) {
    // another process began or finished an action of this wallet between the read and here: its answer, or this one built again on it
    if (_again) return { ok: false, why: 'another transaction of this node\'s wallet began at the same moment: try again' };
    return onchainAction({ state, kind, key, once, sameWithinMs, build, chainKit, log, nowMs, _again: true });
  }
  const r = await settleOpen(state, { chainKit, log, nowMs });
  if (r.done && r.done.id === action.id) return { ok: true, result: r.done.result, txids: r.done.txids };
  if (r.void && r.void.id === action.id) return { ok: false, why: `the transaction was refused and can never confirm: ${r.why}` };
  if (r.open && r.open.id === action.id) return { ok: false, pending: true, kind, txids: action.txs.map((t) => t.txid),
    why: `the transaction(s) ${action.txs.map((t) => t.txid).join(', ')} are signed and kept but were not accepted yet: ${r.why}. They are sent again at the next try - nothing new is built while they are open` };
  const l = lastActionOf(state.read(), kind);
  return l && l.id === action.id && l.phase === A.DONE ? { ok: true, result: l.result, txids: l.txids } : { ok: false, why: `${kind}: the action ended as ${l ? l.phase : 'unknown'}` };
}
