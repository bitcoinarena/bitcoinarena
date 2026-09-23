// A ROUND UNDER THE WITHDRAWN CUSTODY IS NO ROUND HERE, PAST ROUNDS INCLUDED (RULED, the owner 2026-09-22 22:59).
//
// §23.6: "a record from before this ruling that carries the old value is not a round of this network and
// is neither decoded, replayed, settled, listed nor counted; a node that holds such a record treats it as
// it treats bytes that do not parse." Two doors to that: a byte-0 contract posted to `/round` is refused
// as bytes that do not parse - not a custody-specific 409 - and nothing of it is stored; and a store that
// already holds byte-0 rows, from before the ruling, answers them as absent after a restart, while the
// bytes stay where they are (absent, not deleted).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openStore, OPEN, CLOSED } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { toHex } from '../../protocol/src/hash.js';

/** The FEDERATION round's bytes with custody byte 0 - the byte just before federation_id on the wire. */
function underByteZero(c) {
  const bytes = encodeRoundContract(c);
  const at = Buffer.from(bytes).toString('hex').indexOf(Buffer.from(c.federationId).toString('hex'));
  assert.ok(at > 0 && at % 2 === 0, 'the federation_id is not in the encoding');
  const old = Uint8Array.from(bytes);
  assert.equal(old[at / 2 - 1], 1, 'the custody byte of a FEDERATION round is not 1');
  old[at / 2 - 1] = 0;
  return old;
}

const count = (db) => db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n;

test('a byte-0 contract posted to /round is refused as bytes that do not parse, and nothing of it is stored', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const c = contractFor([d.round.pubkey, b32(0x33)], 3000n, ['wss://r.example']);
    const r = await fetch(`http://127.0.0.1:${d.port}/round`, { method: 'POST', body: underByteZero(c) });
    const why = (await r.text()).trim();
    console.log(`  FACTS: ${r.status} "${why.slice(0, 110)}"; rounds stored ${count(d.round.db)}`);
    assert.equal(r.status, 400, 'a byte-0 round was answered as something other than bytes that do not parse');
    assert.match(why, /^that is not a round this signer node opens: custody byte 0 is not a custody of this network/);
    assert.equal(count(d.round.db), 0, 'something of a byte-0 round was stored');
  } finally { await d.close(); }
});

test('a store holding byte-0 rows from before the ruling answers them as absent after a restart: not listed, not read, not closed-over - and their bytes stay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'blwp-withdrawn-'));
  const path = join(dir, 'node.db');
  try {
    // BEFORE THE RULING: a node that ran under the old decoder kept a byte-0 round open and one closed,
    // beside a FEDERATION round. Written straight into the table, as that node's store holds them.
    const first = openStore(path);
    const nodes = [b32(0x11), b32(0x33)];
    const fed = contractFor(nodes, 3000n, ['wss://r.example']);
    const oldOpen = underByteZero({ ...fed, slashMinimumServed: 21 });
    const oldClosed = underByteZero({ ...fed, slashMinimumServed: 22 });
    const put = first.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, ?, ?)');
    put.run(roundId(fed), encodeRoundContract(fed), OPEN, 1);
    put.run(b32(0xa0), oldOpen, OPEN, 2);
    put.run(b32(0xa1), oldClosed, CLOSED, 3);
    const before = first.prepare('SELECT round_id, contract FROM rounds ORDER BY opened_ms').all()
      .map((r) => [toHex(r.round_id), toHex(r.contract)]);
    first.close();

    // RESTARTED ON THAT STORE under this decoder. Starting at all is part of the claim: a close-resume or
    // a listing that decoded the old rows would throw here.
    const d = await serve(openStore(path), { port: 0, ...opts });
    try {
      const listed = d.round.openRounds().map((r) => toHex(r.roundId));
      const closed = d.round.closedRounds().map(toHex);
      const asked = {};
      for (const [name, id] of [['federation', roundId(fed)], ['old open', b32(0xa0)], ['old closed', b32(0xa1)]])
        asked[name] = (await fetch(`http://127.0.0.1:${d.port}/round?id=${toHex(id)}`)).status;
      const after = d.round.db.prepare('SELECT round_id, contract FROM rounds ORDER BY opened_ms').all()
        .map((r) => [toHex(r.round_id), toHex(r.contract)]);
      console.log('  FACTS:', JSON.stringify({ listed: listed.map((x) => x.slice(0, 8)), closed, asked, rowsBefore: before.length, rowsAfter: after.length }));

      assert.deepEqual(listed, [toHex(roundId(fed))], 'an old byte-0 round is listed as open');
      assert.deepEqual(closed, [], 'an old byte-0 round is listed as closed');
      assert.deepEqual(asked, { federation: 200, 'old open': 404, 'old closed': 404 });
      assert.equal(d.round.get(b32(0xa0)), null);
      assert.equal(d.round.get(b32(0xa1)), null);
      // ABSENT, NOT DELETED: every row and every byte is where it was.
      assert.deepEqual(after, before, 'the store was written to');
    } finally { await d.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
