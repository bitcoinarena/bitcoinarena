// A NODE THAT IS FALLING BEHIND SAYS SO (§5A.10B, kanban #310): own weight, brackets served, headroom against the bracket now common; a
// warning while headroom is still above 1 at the 1.5x margin, with the capital that restores it; a falling share told apart, not urgent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nodeStanding, commonBracket } from '../src/node-standing.js';

const ME = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const census = (bondMinSats, entries, excluded = []) => ({ atMs: 0, bondMinSats, entries, excluded });

test('standing: weight, brackets served, headroom; warned near the floor and under it, with what restores it; a falling share apart', () => {
  // healthy: 1,000,000 sat against a 500,000 bracket - 2x headroom, no urgent warning
  const ok = nodeStanding({ me: ME, rounds: [census(500000n, [{ pubkey: ME, bondSats: 1000000n }, { pubkey: B, bondSats: 1000000n }])] });
  assert.equal(ok.headroom, 2); assert.equal(ok.ownWeight, 0.5); assert.deepEqual(ok.bracketsServed, { eligible: 1, of: 1 }); assert.equal(ok.warnings.length, 0);
  // near the floor: 600,000 against 500,000 - 1.2x, warned, 150,000 sat more restores 1.5x
  const near = nodeStanding({ me: ME, rounds: [census(500000n, [{ pubkey: ME, bondSats: 600000n }, { pubkey: B, bondSats: 1000000n }])] });
  assert.equal(near.warnings[0].kind, 'near the floor'); assert.match(near.warnings[0].says, /150000 sat more in a second bond restores 1.5x/);
  // the common bracket rose past the bond: not eligible for those rounds, losing brackets
  const rounds = [census(800000n, [{ pubkey: B, bondSats: 1000000n }], [{ pubkey: ME, bondSats: 600000n }]),
    census(800000n, [{ pubkey: B, bondSats: 1000000n }], [{ pubkey: ME, bondSats: 600000n }]), census(500000n, [{ pubkey: ME, bondSats: 600000n }, { pubkey: B, bondSats: 1000000n }])];
  const lost = nodeStanding({ me: ME, rounds });
  assert.equal(commonBracket(rounds), 800000n);
  assert.deepEqual(lost.bracketsServed, { eligible: 1, of: 3 });
  assert.equal(lost.warnings[0].kind, 'losing brackets'); assert.match(lost.warnings[0].says, /no longer eligible/); assert.match(lost.warnings[0].says, /600000 sat more/);
  // the network grew: the share fell by half - told, not urgent
  const grew = nodeStanding({ me: ME, rounds: [census(500000n, [{ pubkey: ME, bondSats: 1000000n }, { pubkey: B, bondSats: 1000000n }, { pubkey: C, bondSats: 2000000n }]),
    census(500000n, [{ pubkey: ME, bondSats: 1000000n }, { pubkey: B, bondSats: 1000000n }])] });
  const fall = grew.warnings.find((w) => w.kind === 'falling share');
  assert.equal(fall.urgent, false); assert.match(fall.says, /fell from 50.0 % to 25.0 %/);
  console.log('  ' + near.warnings[0].says + '\n  ' + fall.says);
});
