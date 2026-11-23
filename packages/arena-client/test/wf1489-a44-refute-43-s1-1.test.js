// kanban #1684 refute (a44-43, variant 1): the per-seat bound is keyed on the row's `federation` LABEL, which the seat picks, not on the
// federation the record names. One liar seat lists the one real federation's public body under 16 made-up labels, 2 rows each, each row 32
// forged signatures under the bonded guardians' keys: every row reaches verify (the census does bond those keys for the record's real
// federation), 16x the 2-rows-of-one-federation bound the fix meant. federationStatuses with no `only` (the Move offer's loads) pays it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationStatuses } from '../src/federations.js';
import { setup } from './wf1489-a44-refute-43-s1-helpers.mjs';

test('wf1489-a44-refute-43-s1-1: rows of one real federation under made-up labels cost no more than 2 rows of it', async () => {
  const { census, good, feds } = setup([{ byte: 0x37, height: 156036 }]);
  const A = feds[0x37];
  const rows = [];
  for (let l = 0; l < 16; l++) for (let k = 0; k < 2; k++) rows.push({ federation: (l + 1).toString(16).padStart(64, '0'), record: A.forged() });
  let verifies = 0;
  const verify = (sig) => { verifies++; return good.has(Buffer.from(sig).toString('hex')); };
  const fetcher = async (u) => new Response(JSON.stringify(String(u).startsWith('https://liar') ? { federations: rows } : { federations: [{ federation: A.fid, record: A.honest }] }), { status: 200 });
  const all = await federationStatuses({ nodes: ['https://honest.example', 'https://liar.example'], census, verify, fetcher });
  console.log(`FACTS: signature checks for one read = ${verifies}; labels shown = ${all.size}`);
  assert.equal(all.get(A.fid).status, 'OPEN');
  assert.ok(verifies <= 7 + 2 * 32, `one seat's answer cost ${verifies} checks: the bound counts labels, not the federation the record names`);
});
