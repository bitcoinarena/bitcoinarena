// A SEATED GUARDIAN'S OWN COPY OF A HALTED FEDERATION'S SPENT SET (§23A.5 step 1, kanban #323): its guardian asked through fedimint-cli
// (stubbed here), the copy signed with the node key as of the last finished session, standing against the record; then posted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { produceSpentSet, publishSpentSet } from '../src/spent-set-producer.js';
import { decodeSpentSet, spentSetStands } from '../../arena-protocol/src/spent-set.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const FED = 'ab'.repeat(32);
const secret = new Uint8Array(32).fill(7), me = schnorr.getPublicKey(secret);
const nonce = (n) => '02' + n.repeat(32);

test('the copy: the guardian\'s spent nonces, sorted, as of its last finished session, signed by the node key; it stands; then posted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guardian-'));
  writeFileSync(join(dir, 'local.json'), JSON.stringify({ identity: 2, p2p_endpoints: {} }));
  writeFileSync(join(dir, 'admin-password'), 'pw\n');
  const asked = [];
  const run = async (bin, args) => { asked.push(args.slice(4).join(' '));
    if (args.includes('blwp_spent_nonces')) return { ok: true, out: JSON.stringify([nonce('cc'), nonce('aa'), nonce('aa')]) };
    if (args.includes('session_count')) return { ok: true, out: '42' };
    return { ok: false, err: 'unknown' }; };
  const got = await produceSpentSet({ guardianDir: dir, clientDir: '/client', federationId: FED, nodeSecret: secret, run });
  assert.equal(got.ok, true, got.why);
  assert.deepEqual(asked, ['blwp_spent_nonces null --module mintv2 --peer-id 2 --password pw', 'session_count null --peer-id 2']);
  const copy = { ...decodeSpentSet(fromHex(got.copy.spentSet)), signature: fromHex(got.copy.signature) };
  assert.deepEqual([copy.session, copy.nonces.length, Buffer.from(copy.nonces[0]).toString('hex')], [41, 2, nonce('aa')], 'session 42 is running: 41 is the last finished; distinct and sorted');
  const record = { federationId: fromHex(FED), guardians: [{ nodePubkey: me }] };
  assert.equal(spentSetStands(copy, { record, verify: (sg, m, k) => schnorr.verify(sg, m, k) }).ok, true);
  const posted = [];
  const out = await publishSpentSet(got.copy, ['https://s1', 'https://s2/'], { fetcher: async (u, o) => { posted.push(u); return { ok: u.startsWith('https://s1'), text: async () => 'not HALTED here' }; } });
  assert.deepEqual(posted, ['https://s1/liquidations/spent-set', 'https://s2/liquidations/spent-set']);
  assert.deepEqual(out.map((x) => x.ok), [true, false]);
  // a guardian that does not answer is said, by name
  const down = await produceSpentSet({ guardianDir: dir, clientDir: '/client', federationId: FED, nodeSecret: secret, run: async () => ({ ok: false, err: 'Error: Unauthorized' }) });
  assert.match(down.why, /did not answer its spent nonces: Error: Unauthorized/);
});
