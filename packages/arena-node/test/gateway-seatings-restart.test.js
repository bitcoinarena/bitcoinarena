// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SIGNED GATEWAY SEATINGS OUTLIVE A RESTART (spec §23A.9, kanban #559: "every guardian keeps ... the signed seatings across a
// restart"): a seat keeps its own signed seatings and the standing ones in its database (server.js gateway_seatings) and reads them
// back when it starts, so a round whose census is days back is still paid from the seating of its epoch. Measured over HTTP on a
// seat with a file store: a seating this guardian signed before the restart is served by GET /gateway-seating after it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { opts } from './window-fixture.js';
import { HOSTED } from './plugins/hosted.js';
import { signGatewaySeating } from '../../arena-protocol/src/gateway-seating.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('a seating this guardian signed is in its database and served again after the seat restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seatings-'));
  const file = join(dir, 'seat.db');
  const fid = 'f1'.repeat(32), epoch = 1090, other = 'f2'.repeat(32);
  const secret = new Uint8Array(32).fill(9);
  const own = signGatewaySeating({ federationId: fid, epoch, seats: ['aa'.repeat(32), 'bb'.repeat(32)], pegIns: { ['aa'.repeat(32)]: '60000' } },
    toHex(schnorr.getPublicKey(secret)), (h) => schnorr.sign(h, secret));
  const standing = { federationId: other, epoch, seats: ['cc'.repeat(32)] };
  const start = () => serve(openStore(file), { plugins: HOSTED, port: 0, ...opts });
  const get = async (d, f, e) => { const r = await fetch(`http://127.0.0.1:${d.port}/gateway-seating?federation=${f}&epoch=${e}`); return [r.status, await r.json()]; };
  let d = await start();
  try {
    assert.equal((await get(d, fid, epoch))[0], 404, 'a new seat has signed none');
    // what gatherSeatings' keepSeating writes: this guardian's own ('own') and a standing one ('standing'), as JSON per federation and epoch
    const keep = d.round.db.prepare('INSERT INTO gateway_seatings (federation, epoch, kind, body) VALUES (?, ?, ?, ?) ON CONFLICT(federation, epoch, kind) DO UPDATE SET body = excluded.body');
    keep.run(fid, epoch, 'own', JSON.stringify(own));
    keep.run(other, epoch, 'standing', JSON.stringify(standing));
  } finally { await d.close(); }
  d = await start();                                     // the restart
  try {
    const [st, body] = await get(d, fid, epoch);
    assert.equal(st, 200, 'served after the restart, from the database');
    assert.deepEqual(body, own, 'the same signed body, signature and proved peg-in included');
    assert.equal((await get(d, fid, epoch + 1))[0], 404, 'another epoch: none');
    assert.equal((await get(d, other, epoch))[0], 404, 'a standing seating is kept apart from the ones this guardian signed: never served as its own');
    const rows = d.round.db.prepare('SELECT federation, epoch, kind FROM gateway_seatings ORDER BY kind').all().map((r) => [r.federation, Number(r.epoch), r.kind]);
    assert.deepEqual(rows, [[fid, epoch, 'own'], [other, epoch, 'standing']], 'both kinds still in the database after the restart');
  } finally { await d.close(); rmSync(dir, { recursive: true, force: true }); }
});
