// THE CUSTODY AGENT (kanban #471 slice 5 part 4, custody-agent.js; the owner 2026-10-18: "It should happen automatically"): nothing before a
// founding; once fedimintd wrote the invite, guardian_of[] is published in an advertisement update of the node's bond (signed by its key,
// paid from its wallet), then the gateway joins the federation, then the peg-in goes to the gateway's address - each once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { checkGatewayClaim } from '../../arena-protocol/src/gateway-claim.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createCustodyAgent, guardianOfEntry } from '../src/custody-agent.js';
import { nodeState } from '../src/state.js';
import { readAdvertUpdate, checkAgainstBond } from '../../arena-protocol/src/advert-update.js';
import { inviteForGuardians } from '../../arena-node/src/invite.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

test('the custody agent: waits for the founding, then guardian_of, the gateway\'s federation, the peg-in - each once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'custody-'));
  const state = nodeState(home);
  writeFileSync(join(home, 'seed.hex'), '11'.repeat(32));
  const nodeSecret = new Uint8Array(32).fill(6);
  const db = new DatabaseSync(join(home, 'node.db'));
  db.exec('CREATE TABLE identity (one INTEGER PRIMARY KEY, secret BLOB)'); db.prepare('INSERT INTO identity VALUES (0, ?)').run(nodeSecret); db.close();
  const bondTxid = '77'.repeat(32);
  state.save({ roles: ['verify', 'custody'], chain: { kind: 'core' }, owner: { pubkey: 'ab'.repeat(32) }, reach: { mode: 'permanent', url: 'https://node.example.com' },
    bond: { txid: bondTxid, vout: 0, sats: '50000', maturity: 157057 }, custody: { pegInSats: 50000 },
    gateway: { apiUrl: 'http://127.0.0.1:8476', passwordFile: join(home, 'pw'), federations: [] } });
  const sent = [];
  let coins = [{ txid: '5a'.repeat(32), vout: 1, sats: 57000 }];
  const chainKit = { coinsOf: async () => ({ tip: 157000, coins }), broadcast: async (_c, hex) => { sent.push(hex); return toHex(Uint8Array.from(parseTransaction(fromHex(hex)).txid).reverse()); } };
  const fid = 'ee'.repeat(32);
  const calls = [];
  const gw = { joinFederation: async (o) => { calls.push(['join', o.invite]); return { ok: true, federationId: fid }; },
    testGateway: async () => ({ ok: true, federations: [{ federationId: fid, name: 'arena' }] }),
    depositAddress: async (o) => { calls.push(['address', o.federationId]); return { ok: true, address: 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx' }; } };
  let clock = 1_800_000_000_000;
  const agent = createCustodyAgent({ state, release: home, chainKit, gw, nowMs: () => clock,
    channels: async () => ({ ok: true, open: [], pending: [], publicCapacitySats: 250000 }) });

  assert.match((await agent.tick()).idle, /waits to be drawn/);
  const dir = join(home, 'node.db.guardian'); mkdirSync(dir);
  const invite = inviteForGuardians(fromHex(fid), [{ url: 'wss://node.example.com/guardian', peer: 2 }]);
  writeFileSync(join(dir, 'invite-code'), `"${invite}"\n`);
  writeFileSync(join(dir, 'local.json'), JSON.stringify({ identity: 2 }));
  writeFileSync(join(dir, 'consensus.json'), JSON.stringify({ broadcast_public_keys: { 2: '03' + 'cd'.repeat(32) } }));
  assert.deepEqual(guardianOfEntry(dir).federationId, fid);

  const one = await agent.tick();
  assert.equal(one.did, 'guardian_of');
  assert.equal(sent.length, 2, 'the funding and the update');
  const read = readAdvertUpdate(fromHex(sent[1]), { network: 'testnet4' });
  const ok = await checkAgainstBond(read, { txid: fromHex(bondTxid).reverse(), vout: 0, nodePubkey: schnorr.getPublicKey(nodeSecret) }, (s, m, k) => schnorr.verify(s, m, k));
  assert.equal(ok.ok, true, ok.why);
  assert.deepEqual([toHex(read.advert.guardianOf[0].federationId), toHex(read.advert.guardianOf[0].guardianKey)], [fid, '03' + 'cd'.repeat(32)]);
  assert.deepEqual([read.advert.guardianCapable, read.advert.bondMaturityHeight], [false, 157057], 'no custody binaries in this test release: capable only with them; the bond\'s maturity kept');

  coins = [{ txid: '6b'.repeat(32), vout: 2, sats: 55000 }];   // the update's change, confirmed
  assert.equal((await agent.tick()).did, 'join');
  assert.deepEqual(calls[0], ['join', invite]);
  const peg = await agent.tick();
  assert.equal(peg.did, 'peg-in');
  const pegTx = parseTransaction(fromHex(sent[2]));
  assert.equal(pegTx.outputs[0].value, 50000n);
  assert.equal(toHex(pegTx.outputs[0].script), '0014751e76e8199196d454941c45d1b3a323f1433bd6');
  assert.match((await agent.tick()).idle, /custody is set up/, 'no public gateway address and no tested LND: no claim');
  state.save({ gateway: { ...state.read().gateway, publicUrl: 'https://node.example.com/gateway/' }, lightning: { pubkey: '02' + '99'.repeat(32) } });
  assert.equal((await agent.tick()).did, 'gateway-claim');
  const claim = JSON.parse(readFileSync(join(home, 'gateway-claim.json'), 'utf8'));
  assert.equal(checkGatewayClaim(claim, (s, m, k) => schnorr.verify(s, m, k)).ok, true, 'signed by the node key');
  assert.deepEqual([claim.node, claim.federationId, claim.gatewayUrl, claim.capacitySats, claim.pegInSats], [toHex(schnorr.getPublicKey(nodeSecret)), fid, 'https://node.example.com/gateway/', '250000', '50000']);
  assert.match((await agent.tick()).idle, /gateway seat claimed/, 'renewed hourly, not every minute');
  clock += 3_600_000;
  assert.equal((await agent.tick()).did, 'gateway-claim');
  assert.equal(sent.length, 3, 'each payment once');
  state.save({ roles: ['verify'] });
  assert.match((await agent.tick()).idle, /no custody role/);
});
