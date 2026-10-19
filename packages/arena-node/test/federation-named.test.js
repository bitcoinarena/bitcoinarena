// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// M3 W7: THE SIGNER NODE DOOR OPENS NO PAYING FEDERATION ROUND THAT DOES NOT NAME ITS FEDERATION.
//
// A round becomes real on a signer node at POST /round and nowhere else. Measured before: the door
// decoded any contract and opened it - a paying FEDERATION round with a zero federation_id
// included - and checked the custody fields only on a signer node that holds Lightning. Now the decode
// refuses the zero id (400), and a paying FEDERATION round is held to the custody fields in full
// (409): its federation, the 144-block expiry, its relays. A free round opens as before. A record
// carrying custody byte 0 - the withdrawn THRESHOLD_LN (RULED 2026-09-22 22:59) - does not parse,
// so the door answers it as it answers any bytes that do not decode (400), and no encoder makes it.
// A PAYING ROUND OPENS ONLY ON A SIGNER NODE THAT REACHES A FEDERATION (RULED 2026-09-25): this file's paying-round
// daemons get the lock fixture's port - the test federation, two gateways, zero base fee. Contracts unchanged.
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

/** The named round's bytes with custody byte 0 - the byte just before federation_id on the wire. */
function withdrawnCustody(c) {
  const bytes = encodeRoundContract(c);
  const at = Buffer.from(bytes).toString('hex').indexOf(Buffer.from(c.federationId).toString('hex'));
  assert.ok(at > 0 && at % 2 === 0, 'the federation_id is not in the encoding');
  const forged = Uint8Array.from(bytes);
  assert.equal(forged[at / 2 - 1], 1, 'the custody byte of a FEDERATION round is not 1');
  forged[at / 2 - 1] = 0;
  return forged;
}

/** The named round's bytes with its federation_id zeroed - bytes no encoder here will make. */
function zeroedFederation(c) {
  const bytes = encodeRoundContract(c);
  const hex = Buffer.from(bytes).toString('hex');
  const at = hex.indexOf(Buffer.from(c.federationId).toString('hex'));
  assert.ok(at >= 0 && at % 2 === 0, 'the federation_id is not in the encoding');
  const forged = Uint8Array.from(bytes);
  forged.fill(0, at / 2, at / 2 + 32);
  return forged;
}

test('the signer node door refuses a paying FEDERATION round naming no federation (400) or failing the custody fields (409), refuses a record carrying the withdrawn custody byte 0 (400), and opens a named one and a free one', async () => {
  // AND ON A CHAIN THAT BONDS THE ROUND'S TWO NODES (RULED 2026-09-25): the one daemon and a keyless placeholder, so the
  // claim key is claimKeyFor's. Only the named round's censusRoot changes.
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = async (body) => { const r = await fetch(`${base}/round`, { method: 'POST', body }); return { status: r.status, text: (await r.text()).trim() }; };
    const held = async (c) => (await fetch(`${base}/round?id=${toHex(roundId(c))}`)).status;
    const nodes = [d.round.pubkey, b32(0x33)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };
    const named = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot,
      { endpoints: [`ws://127.0.0.1:${d.port}`] }).censusRoot };

    const zero = await post(zeroedFederation(named));
    const noRelay = { ...named, publicationRelays: [] };
    const shortExpiry = { ...named, stakeExpiryBlocks: 12 };
    const refusedRelay = await post(encodeRoundContract(noRelay));
    const refusedExpiry = await post(encodeRoundContract(shortExpiry));
    assert.throws(() => encodeRoundContract({ ...named, custody: 'THRESHOLD_LN' }), /THRESHOLD_LN is not a custody this network has/);
    const withdrawn = await post(withdrawnCustody({ ...named, configHash: TRUCK_V3_CONFIG_HASH, slashMinimumServed: 21 }));
    const free = { ...named, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH, slashMinimumServed: 22 };
    const opened = { named: await post(encodeRoundContract(named)), free: await post(encodeRoundContract(free)) };
    console.log(`  zero id ${zero.status} "${zero.text.slice(0, 90)}"; no relay ${refusedRelay.status}; expiry 12 ${refusedExpiry.status}; `
      + `withdrawn byte 0 ${withdrawn.status} "${withdrawn.text.slice(0, 60)}"; named ${opened.named.status}, free ${opened.free.status}`);

    assert.equal(zero.status, 400);
    assert.match(zero.text, /takes a stake into a FEDERATION and names no federation_id/);
    assert.equal(refusedRelay.status, 409);
    assert.match(refusedRelay.text, /takes a stake and names no publication relay/);
    assert.equal(refusedExpiry.status, 409);
    assert.match(refusedExpiry.text, /stake_expiry_blocks 12 where §23\.1 rules 144/);
    assert.equal(await held(noRelay), 404, 'a round the door refused exists on the signer node');
    assert.equal(await held(shortExpiry), 404, 'a round the door refused exists on the signer node');
    assert.equal(opened.named.status, 201, opened.named.text);
    assert.equal(withdrawn.status, 400, withdrawn.text);
    assert.match(withdrawn.text, /custody byte 0 is not a custody of this network: the one value is FEDERATION/);
    assert.equal(opened.free.status, 201, opened.free.text);
    assert.equal(await held(named), 200);
  } finally { await d.close(); }
});
