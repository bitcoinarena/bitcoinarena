// THE BOND_MIN A 2026.0.3 ROUND MAY NAME (§27A.2-3, kanban #305): at least the census's bond-weighted median of the declared bond_min, a rise
// counted after notice_period - refused below it by name, taken at or above it; a protocol-2 round is not asked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { TRUCK_V3_CONFIG_HASH } from '../../nextblock/plugin/nextblock.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { HOSTED } from './plugins/hosted.js';

test('a v3 round under the declared median is refused by name; at or above it, taken; a v2 round is not asked', async () => {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const nodes = [d.round.pubkey, b32(0x33)];
    const drafted = { ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, protocolVersion: 3 };
    const named = { ...drafted, censusRoot: bondedChainFor(drafted.nodes, drafted, slot, { endpoints: [`ws://127.0.0.1:${d.port}`], protocolVersions: [1, 2, 3],
      declares: { bondMinSats: 80000n, proposalDepositSats: 100000n } }).censusRoot };
    const post = async (c) => { const r = await fetch(`${base}/round`, { method: 'POST', body: encodeRoundContract(c) }); return { status: r.status, text: (await r.text()).trim() }; };
    const free = (bondMinSats, more = {}) => ({ ...named, federationId: new Uint8Array(32), stakeMsat: 0n, configHash: TRUCK_V3_CONFIG_HASH, bondMinSats, ...more });
    const under = await post(free(50000n, { slashMinimumServed: 31 }));
    assert.equal(under.status, 409, under.text);
    assert.match(under.text, /names bond_min 50000 sat, under the 80000 sat in force at its census height/);
    const at = await post(free(80000n, { slashMinimumServed: 32 }));
    assert.equal(at.status, 201, at.text);
    const above = await post(free(100000n, { slashMinimumServed: 33 }));
    assert.equal(above.status, 201, above.text);
    // a protocol-2 round's floor is its own: not asked
    const v2 = await post(free(50000n, { slashMinimumServed: 34, protocolVersion: 2 }));
    assert.equal(v2.status, 201, v2.text);
  } finally { await d.close(); }
});
