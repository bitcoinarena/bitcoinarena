// kanban #1684 refute (a44-43, variant 2, the same loop): a verified row is filed under the row's LABEL. One seat lists federation A's
// genuine, newer OPEN record under federation B's id; B's own guardians' newest record says HALTED. federationStatus(B) takes A's record as B's:
// B shows OPEN and allows deposit/join/withdraw/move, though B's guardians froze it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { federationStatus } from '../src/federations.js';
import { FEDERATION_STATUS } from '../../arena-protocol/src/federation-record.js';
import { setup } from './wf1489-a44-refute-43-helpers.mjs';

test('wf1489-a44-refute-43-2: another federation\'s record listed under B\'s id does not become B\'s status', async () => {
  const halted = FEDERATION_STATUS.HALTED ?? FEDERATION_STATUS.halted;
  const { census, good, feds } = setup([{ byte: 0x37, height: 160000 }, { byte: 0x50, height: 156000, status: halted }]);
  const A = feds[0x37], B = feds[0x50];
  const verify = (sig) => good.has(Buffer.from(sig).toString('hex'));
  const fetcher = async (u) => new Response(JSON.stringify(String(u).startsWith('https://liar')
    ? { federations: [{ federation: B.fid, record: A.honest }] }
    : { federations: [{ federation: A.fid, record: A.honest }, { federation: B.fid, record: B.honest }] }), { status: 200 });
  const honestOnly = await federationStatus({ federationIdHex: B.fid, nodes: ['https://honest.example'], census, verify, fetcher });
  const st = await federationStatus({ federationIdHex: B.fid, nodes: ['https://honest.example', 'https://liar.example'], census, verify, fetcher });
  console.log(`FACTS: B from honest seat = ${honestOnly.status}; B with one liar seat = ${st.status}, deposit allowed = ${st.allows.deposit}, height ${st.height}`);
  assert.equal(honestOnly.status, 'HALTED');
  assert.equal(st.status, 'HALTED', `one seat made B ${st.status} with federation A's record`);
});
