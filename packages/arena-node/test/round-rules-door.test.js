// A ROUND SETTLED UNDER RULES THIS SEAT DOES NOT RUN IS NOT OPENED (§6, kanban #314; 2026.0.3): POST /round with a contract naming another
// rule hash is refused 409 by name, nothing stored; one naming this build's rules opens. Harness: federation-named's.
import { lockPort, bondedChainSlot, bondedChainFor } from './lock-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { contractFor, opts, b32 } from './window-fixture.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { buildRules, ruleHash } from '../../arena-protocol/src/rules.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

test('a round naming rules this build does not run is refused by name; one naming its rules opens', async () => {
  const slot = bondedChainSlot(lockPort());
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, stakeLocks: slot.port, ...opts, chainFor: slot.chainFor,
    randomnessFor: slot.randomnessFor, claimKeyFor: () => new Uint8Array(33).fill(2) });
  try {
    const base = `http://127.0.0.1:${d.port}`;
    const post = async (body) => { const r = await fetch(`${base}/round`, { method: 'POST', body }); return { status: r.status, text: (await r.text()).trim() }; };
    const nodes = [d.round.pubkey, b32(0x33)];
    const draft = (rules) => ({ ...contractFor(nodes, 3000n, ['wss://r.example']), custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, protocolVersion: 3, rules });
    const mine = draft(buildRules({ claimWindowDays: 1, bondMinGameVerifySats: 50000n, bondMinSettlementSats: 50000n }));
    const theirs = draft({ ...mine.rules, slashing: ruleHash('another slashing rule') });
    const withRoot = (c) => ({ ...c, censusRoot: bondedChainFor(c.nodes, c, slot, { endpoints: [`ws://127.0.0.1:${d.port}`], protocolVersions: [1, 2, 3] }).censusRoot });
    const refused = await post(encodeRoundContract(withRoot({ ...theirs, bondMinSats: mine.bondMinSats })));
    const opened = await post(encodeRoundContract(withRoot(mine)));
    console.log(`  other rules ${refused.status} "${refused.text.slice(0, 80)}"; this build's ${opened.status}`);
    assert.equal(refused.status, 409); assert.match(refused.text, /names a slashing rule this build does not run/);
    assert.equal(opened.status, 201, opened.text);
    assert.equal((await fetch(`${base}/round?id=${toHex(roundId(withRoot(mine)))}`)).status, 200);
    // ITS CENSUS HEALTH (§5A.10, kanban #306): two nodes support play money only - shown on regtest, not enforced
    const h = await fetch(`${base}/census-health?round=${toHex(roundId(withRoot(mine)))}`);
    const hj = h.status === 200 ? await h.json() : { status: h.status, why: await h.text() };
    console.log('  CENSUS HEALTH:', JSON.stringify(hj));
    assert.equal(h.status, 200, JSON.stringify(hj)); assert.equal(hj.enforced, false); assert.equal(hj.ceilingSats, '0'); assert.match(hj.why, /under 10: play money only/);
  } finally { await d.close(); }
});
