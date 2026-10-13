// A ROUND THAT NAMES ITS CREATOR OPENS ONLY WITH THE CREATOR'S SIGNATURE (§6, kanban #313; 2026.0.3). POST /round?creator=<hex>: no
// signature or another key's is refused (403) before anything of the round exists; the creator's opens it, is kept beside it and
// served at GET /round-creator; a round the seat already holds with its signature is not asked again. Harness: federation-named's.
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { creatorMessage } from '../../arena-protocol/src/creator.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('a round naming its creator: refused without the creator\'s signature or with another\'s, opened with it, the signature served', async () => {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = async (body, q = '') => { const r = await fetch(`${base}/round${q}`, { method: 'POST', body }); return { status: r.status, text: (await r.text()).trim() }; };
    const SECRET = b32(0x11);
    const nodes = [d.round.pubkey, b32(0x33)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID,
      protocolVersion: 3, creatorPubkey: schnorr.getPublicKey(SECRET) };
    const c = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`], protocolVersions: [1, 2, 3] }).censusRoot };
    const rid = roundId(c);
    const sig = toHex(schnorr.sign(creatorMessage(rid), SECRET));
    const other = toHex(schnorr.sign(creatorMessage(rid), b32(0x22)));
    const none = await post(encodeRoundContract(c));
    const wrong = await post(encodeRoundContract(c), `?creator=${other}`);
    const held = async () => (await fetch(`${base}/round?id=${toHex(rid)}`)).status;
    const before = await held();
    const good = await post(encodeRoundContract(c), `?creator=${sig}`);
    const served = await fetch(`${base}/round-creator?id=${toHex(rid)}`);
    const again = await post(encodeRoundContract(c));
    console.log(`  none ${none.status} "${none.text.slice(0, 80)}"; another key ${wrong.status}; held before ${before}; signed ${good.status}; served ${served.status}; again without ${again.status}`);
    assert.equal(none.status, 403); assert.match(none.text, /without the creator's 64-byte signature/);
    assert.equal(wrong.status, 403); assert.match(wrong.text, /not the named creator's/);
    assert.equal(before, 404, 'a refused round exists on the seat');
    assert.equal(good.status, 201, good.text);
    assert.equal(served.status, 200); assert.equal((await served.text()).trim(), sig);
    assert.ok([200, 201].includes(again.status), again.text);
    assert.equal((await fetch(`${base}/round-creator?id=${toHex(b32(0x44))}`)).status, 404);
  } finally { await d.close(); }
});
