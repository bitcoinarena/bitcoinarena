// M3 W7: THE SIGNER NODE DOOR OPENS NO PAYING FEDERATION ROUND THAT DOES NOT NAME ITS FEDERATION.
//
// A round becomes real on a signer node at POST /round and nowhere else. Measured before: the door
// decoded any contract and opened it - a paying FEDERATION round with a zero federation_id
// included - and checked the custody fields only on a signer node that holds Lightning. Now the decode
// refuses the zero id (400), and a paying FEDERATION round is held to the custody fields in full
// (409): its federation, the 144-block expiry, its relays. A THRESHOLD_LN round and a free round
// open as before.
import { TRUCK_CORE_HASH, TRUCK_CONFIG_HASH } from '../src/cores.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../protocol/src/test-federation.js';
import { toHex } from '../../protocol/src/hash.js';

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

test('the signer node door refuses a paying FEDERATION round naming no federation (400) or failing the custody fields (409), and opens a named one, a THRESHOLD_LN one and a free one', async () => {
  const d = await serve(openStore(':memory:'), { port: 0, ...opts });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = async (body) => { const r = await fetch(`${base}/round`, { method: 'POST', body }); return { status: r.status, text: (await r.text()).trim() }; };
    const held = async (c) => (await fetch(`${base}/round?id=${toHex(roundId(c))}`)).status;
    const nodes = [d.round.pubkey, b32(0x33)];
    const named = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID };

    const zero = await post(zeroedFederation(named));
    const noRelay = { ...named, publicationRelays: [] };
    const shortExpiry = { ...named, stakeExpiryBlocks: 12 };
    const refusedRelay = await post(encodeRoundContract(noRelay));
    const refusedExpiry = await post(encodeRoundContract(shortExpiry));
    const lightning = { ...named, custody: 'THRESHOLD_LN', federationId: new Uint8Array(32), configHash: TRUCK_CONFIG_HASH, slashMinimumServed: 21 };
    const free = { ...named, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_CONFIG_HASH, slashMinimumServed: 22 };
    const opened = { named: await post(encodeRoundContract(named)), lightning: await post(encodeRoundContract(lightning)), free: await post(encodeRoundContract(free)) };
    console.log(`  zero id ${zero.status} "${zero.text.slice(0, 90)}"; no relay ${refusedRelay.status}; expiry 12 ${refusedExpiry.status}; `
      + `named ${opened.named.status}, THRESHOLD_LN ${opened.lightning.status}, free ${opened.free.status}`);

    assert.equal(zero.status, 400);
    assert.match(zero.text, /takes a stake into a FEDERATION and names no federation_id/);
    assert.equal(refusedRelay.status, 409);
    assert.match(refusedRelay.text, /takes a stake and names no publication relay/);
    assert.equal(refusedExpiry.status, 409);
    assert.match(refusedExpiry.text, /stake_expiry_blocks 12 where §23\.1 rules 144/);
    assert.equal(await held(noRelay), 404, 'a round the door refused exists on the signer node');
    assert.equal(await held(shortExpiry), 404, 'a round the door refused exists on the signer node');
    assert.equal(opened.named.status, 201, opened.named.text);
    assert.equal(opened.lightning.status, 201, opened.lightning.text);
    assert.equal(opened.free.status, 201, opened.free.text);
    assert.equal(await held(named), 200);
  } finally { await d.close(); }
});
