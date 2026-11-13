// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1204 RES-3: the exchange was keyed by the e-cash STRING, the federation reads the NOTES (case-blind, the bits after the last
// whole byte dropped). A re-cased copy of notes already exchanged made a new row; its reissue answered AlreadyReceived with the notes'
// earlier Success and amount, and the seat paid them a second time - and again for every other spelling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import * as ex from '../src/ecash-exchange.js';

const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
// Fedimint's base32 encode (fedimint-core base32.rs encode), for test strings the federation would read
const B32 = '0123456789abcdefghijklmnopqrstuv';
function encode(bytes) {
  let out = '', buf = 0, bits = 0;
  for (const b of bytes) { buf |= b << bits; bits += 8; while (bits >= 5) { out += B32[buf & 31]; buf >>>= 5; bits -= 5; } }
  if (bits > 0) out += B32[buf & 31];
  return `fedimint${out}`;
}
const NOTE_BYTES = Uint8Array.from({ length: 41 }, (_, i) => (i * 37 + 11) & 0xff);
const NOTES = encode(NOTE_BYTES);

// the federation as the tool answers it: received notes are known by their BYTES, whatever the spelling
function seat({ lostReceive = 0 } = {}) {
  const received = new Map(); let holdsB = 10_000_000n, n = 0, sends = 0;
  const key = (e) => { const b = ex.decodeEcashBytes(e); if (!b) throw new Error('Invalid character encountered'); return Buffer.from(b).toString('hex'); };
  const ports = {
    [A]: { ecashBalance: async () => 0n,
      ecashReceive: async (e) => { const k = key(e);
        if (received.has(k)) return { state: 'AlreadyReceived', msat: 0n, earlier: 'Success', carriedMsat: received.get(k) };
        received.set(k, 100_000n);
        if (lostReceive > 0) { lostReceive--; throw new Error('arena-stake-lock ecash-receive timed out'); }
        return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n }; } },
    [B]: { ecashBalance: async () => holdsB,
      ecashSend: async (m) => { sends++; holdsB -= m; return { ecash: `fedimintb-${++n}`, msat: m }; },
      ecashSent: async () => ({ found: false }) },
  };
  const db = new DatabaseSync(':memory:');
  const x = ex.createEcashExchange({ db, portOf: async (f) => ports[f] || null, perHourMsat: 1_000_000_000n });
  return { x, db, sends: () => sends };
}
const ask = (x, ecash) => x.exchange({ from: A, to: B, ecash, amountMsat: '100000' });

test('RES-3 decodeEcashBytes reads a string as Fedimint does: case-blind, trailing bits dropped', () => {
  assert.deepEqual(ex.decodeEcashBytes(NOTES), NOTE_BYTES);
  assert.deepEqual(ex.decodeEcashBytes(NOTES.toUpperCase()), NOTE_BYTES);
  assert.equal(ex.decodeEcashBytes('fedimintxyz'), null, 'w-z are not in the alphabet');
  assert.equal(ex.decodeEcashBytes('cashuabc'), null);
  assert.equal(ex.noteKey(NOTES), ex.noteKey(NOTES.toUpperCase()));
  assert.equal(ex.noteKey(NOTES), ex.noteKey(` ${NOTES}\n`));
});

test('RES-3 a re-cased copy of exchanged notes is the same exchange: answered again, never paid twice', async () => {
  const s = seat();
  const a = await ask(s.x, NOTES);
  assert.equal(a.ok, true, a.why);
  for (const spelling of [NOTES.toUpperCase(), NOTES.slice(0, 12).toUpperCase() + NOTES.slice(12), `  ${NOTES}  `]) {
    const b = await ask(s.x, spelling);
    assert.equal(b.ok, true, b.why);
    assert.equal(b.again, true, 'the same exchange, answered again');
    assert.equal(b.ecash, a.ecash);
  }
  assert.equal(s.sends(), 1, 'one payout for one set of notes');
});

test('RES-3 notes received under another key (a row from before the fix, or outside the exchange): refused on the first ask', async () => {
  const s = seat();
  // the notes were taken under an old string-keyed row: a different row, and the federation knows the notes
  const a = await ask(s.x, NOTES);
  assert.equal(a.ok, true);
  s.db.prepare('UPDATE ecash_exchanges SET id = ? WHERE id = ?').run('f'.repeat(64), ex.noteKey(NOTES));
  const b = await ask(s.x, NOTES.toUpperCase());
  assert.equal(b.ok, false);
  assert.equal(b.status, 409);
  assert.match(b.why, /another exchange/);
  assert.equal(s.sends(), 1, 'nothing paid for the second ask');
  const c = await ask(s.x, NOTES.toUpperCase());
  assert.equal(c.ok, false, 'refused for good');
  assert.equal(s.sends(), 1);
});

test('RES-3 a stop between the ask and its answer still finishes (#1160 kept): the retry\'s AlreadyReceived is this row\'s own', async () => {
  const s = seat({ lostReceive: 1 });
  const a = await ask(s.x, NOTES);
  assert.equal(a.ok, false);
  const b = await ask(s.x, NOTES.toUpperCase());
  assert.equal(b.ok, true, b.why);
  assert.equal(s.sends(), 1);
});

test('RES-3 a row from before the fix (keyed by the raw string, receive_asked NULL) is still found and finished by its retry', async () => {
  const s = seat({ lostReceive: 1 });
  const a = await ask(s.x, NOTES);
  assert.equal(a.ok, false);
  const legacy = (await import('node:crypto')).createHash('sha256').update(NOTES).digest('hex');
  s.db.prepare('UPDATE ecash_exchanges SET id = ?, receive_asked = NULL WHERE id = ?').run(legacy, ex.noteKey(NOTES));
  const b = await ask(s.x, NOTES);
  assert.equal(b.ok, true, b.why);
  assert.equal(s.sends(), 1);
});

// KANBAN #1244 (audit 3 #1210 MONEY-3): notes claimed at the arbitration set of a liquidating federation were also exchangeable here - paid twice
test('#1244 an exchange out of or into a federation this seat lists as liquidating is refused before anything is asked or written', async () => {
  const asked = [];
  const ports = {
    [A]: { ecashBalance: async () => 0n, ecashReceive: async () => { asked.push('receive'); return { state: 'Success', msat: 100_000n, carriedMsat: 100_000n }; } },
    [B]: { ecashBalance: async () => 10_000_000n, ecashSend: async (m) => { asked.push('send'); return { ecash: 'fedimintb-1', msat: m }; }, ecashSent: async () => ({ found: false }) },
  };
  const db = new DatabaseSync(':memory:');
  const liquidating = new Set([A]);
  const x = ex.createEcashExchange({ db, portOf: async (f) => ports[f] || null, perHourMsat: 1_000_000_000n, halted: (f) => (liquidating.has(f) ? { height: 1000 } : null) });
  const out = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  const into = await x.exchange({ from: B, to: A, ecash: NOTES, amountMsat: '100000' });
  const rows = db.prepare('SELECT COUNT(*) AS n FROM ecash_exchanges').get().n;
  const askedWhileListed = asked.slice();
  liquidating.clear();
  const after = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
  console.log('  MEASURED #1244:', JSON.stringify({ out: [out.status, out.why.slice(0, 60)], into: into.status, askedWhileListed, rows, notLiquidating: after.ok, askedAfter: asked.slice(askedWhileListed.length) }));
  assert.equal(out.ok, false); assert.equal(out.status, 409); assert.match(out.why, /being liquidated/);
  assert.equal(into.ok, false); assert.equal(into.status, 409);
  assert.deepEqual(askedWhileListed, [], 'the federation was asked for a refused exchange');
  assert.equal(rows, 0, 'a row was written for a refused exchange');
  assert.equal(after.ok, true, 'a federation no longer listed is exchanged as before');
});

// KANBAN #1272 (audit 4 #1257 fixesB-1, a #1244 regression): the liquidation refusal ran before the row was looked up, so an exchange whose notes this
// seat had taken before the federation was listed - PAID with its answer lost, or SENDING - was refused for good: the player's notes stayed with the seat.
test('#1272 an exchange taken before its federation was listed is finished after it: PAID answered again, SENDING paid; a new one is refused', async () => {
  const run = async ({ sendFailsOnce }) => {
    let failed = !sendFailsOnce, sends = 0;
    const ports = {
      [A]: { ecashBalance: async () => 0n, ecashReceive: async () => ({ state: 'Success', msat: 100_000n, carriedMsat: 100_000n }) },
      [B]: { ecashBalance: async () => 10_000_000n, ecashSend: async (m) => { if (!failed) { failed = true; throw new Error('the tool timed out'); } sends++; return { ecash: `fedimintb-${sends}`, msat: m }; },
        ecashSent: async () => ({ found: false }) },
    };
    const listed = new Set();
    const x = ex.createEcashExchange({ db: new DatabaseSync(':memory:'), portOf: async (f) => ports[f] || null, perHourMsat: 1_000_000_000n, halted: (f) => (listed.has(f) ? { height: 1000 } : null) });
    const first = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
    listed.add(A);
    const again = await x.exchange({ from: A, to: B, ecash: NOTES, amountMsat: '100000' });
    const fresh = await x.exchange({ from: A, to: B, ecash: encode(Uint8Array.from({ length: 41 }, (_, i) => (i * 13 + 5) & 0xff)), amountMsat: '100000' });
    return { first: first.ok, again: { ok: again.ok, again: !!again.again, ecash: again.ecash || null, why: again.why || null }, newAfterListing: fresh.status, sends };
  };
  const paid = await run({ sendFailsOnce: false });
  const sending = await run({ sendFailsOnce: true });
  console.log('  FACTS #1272:', JSON.stringify({ paidThenListed: paid, sendingThenListed: sending }));
  assert.equal(paid.first, true);
  assert.equal(paid.again.ok, true, `a PAID exchange was refused once its federation was listed: ${paid.again.why}`);
  assert.equal(paid.again.again, true); assert.equal(paid.again.ecash, 'fedimintb-1'); assert.equal(paid.sends, 1);
  assert.equal(sending.first, false, 'the fixture: the first send fails, the row stays in its send');
  assert.equal(sending.again.ok, true, `an exchange whose notes were taken was refused once listed: ${sending.again.why}`);
  assert.equal(sending.sends, 1);
  assert.equal(paid.newAfterListing, 409, 'a new exchange out of a listed federation is still refused');
});
