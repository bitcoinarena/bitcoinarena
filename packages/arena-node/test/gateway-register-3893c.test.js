// kanban #3893c: the guardians that list our gateways are learnt from the seats' federation records (a successor too, §23A.6) and matched to
// the guardian dirs we run by federation and endpoint - no federation, url or password path written by hand
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFederationRecord, joinSignedRecord, FEDERATION_STATUS, thresholdOf, GONE } from '../../arena-protocol/src/federation-record.js';
import { inviteForGuardians } from '../src/invite.js';
import { guardiansOfRecords, guardianDirOwn, matchGuardians, isLiveGuardianDir, guardianUrl, parseRoots } from '../tools/gateway-register.mjs';

const id = (b) => new Uint8Array(32).fill(b);
const hex = (b) => Buffer.from(b).toString('hex');
const peer = (i) => { const k = new Uint8Array(33).fill(i); k[0] = 2; return k; };
const T = 'wss://beelink.example.ts.net';
const row = ({ fed, paths, status = FEDERATION_STATUS.OPEN, sigs = 5, gone = [] }) => {
  const guardians = paths.map((p, i) => ({ peerKey: peer(i + 1), nodePubkey: id(0x40 + i), operatorId: '', bondTxid: id(0x60 + i), bondVout: 0, endpoint: `${T}${p}` }));
  const body = encodeFederationRecord({ federationId: id(fed), networkId: id(9), invite: inviteForGuardians(id(fed), [{ url: `${T}${paths[0]}`, peer: 0 }]),
    nominal: paths.length, threshold: thresholdOf(paths.length), guardians, status, successorId: null,
    gone: gone.map((i) => ({ peerKey: peer(i + 1), sinceHeight: 90, kind: GONE.DEPARTED, proofRef: id(0) })), exposureCapSats: 0n, reserveSats: 0n, height: 100 });
  const signatures = Array.from({ length: sigs }, (_, i) => ({ nodePubkey: id(0x10 + i), signature: new Uint8Array(64).fill(i) }));
  return { federation: hex(id(fed)), status: 'OPEN', record: Buffer.from(joinSignedRecord(body, signatures)).toString('hex') };
};
const seven = (f) => Array.from({ length: 7 }, (_, i) => f(i + 1));

test('#3893c: a successor federation\'s guardians are learnt from its record, without a hand entry', () => {
  const g = guardiansOfRecords([{ federations: [
    row({ fed: 0xb1, paths: seven((n) => `/fed2-${n}/guardian`) }),
    row({ fed: 0x4d, paths: [...seven((n) => `/fed2-${n}/guardian-next`).slice(0, 6), '/fed2-8/guardian'], gone: [2] }),   // the successor; one guardian gone
    row({ fed: 0xcc, paths: seven((n) => `/old-${n}/guardian`), status: FEDERATION_STATUS.CLOSED }),
    row({ fed: 0xdd, paths: seven((n) => `/few-${n}/guardian`), sigs: 4 })] }]);
  assert.deepEqual([...new Set(g.map((x) => x.fed))], [hex(id(0xb1)), hex(id(0x4d))]);
  const succ = g.filter((x) => x.fed === hex(id(0x4d))).map((x) => new URL(x.endpoint).pathname);
  assert.equal(succ.length, 6);
  assert.ok(succ.includes('/fed2-8/guardian') && succ.includes('/fed2-1/guardian-next') && !succ.includes('/fed2-3/guardian-next'));
});

test('#3893c: a guardian dir is matched by its federation and its own endpoint; an archived copy or another federation is not', () => {
  const recordGuardians = [{ fed: hex(id(0x4d)), endpoint: `${T}/fed2-1/guardian-next` }, { fed: hex(id(0x4d)), endpoint: `${T}/fed2-8/guardian` },
    { fed: hex(id(0xb1)), endpoint: `${T}/fed2-1/guardian` }, { fed: hex(id(0xb1)), endpoint: `${T}/fed2-9/guardian` }];
  const dirs = [
    { dir: '/r/node-1.db.guardian-next', identity: 1, invite: inviteForGuardians(id(0x4d), [{ url: `wss://tn4.example/fed2-1/guardian-next/`, peer: 1 }]) },
    { dir: '/r/node-15.db.guardian', identity: 6, invite: inviteForGuardians(id(0x4d), [{ url: `${T}/fed2-2/guardian-next`, peer: 2 }, { url: `${T}/fed2-8/guardian`, peer: 6 }]) },
    { dir: '/r/node-1.db.guardian', identity: 0, invite: inviteForGuardians(id(0xb1), [{ url: `${T}/fed2-1/guardian`, peer: 0 }]) },
    { dir: '/r/node-9.db.guardian', identity: 0, invite: inviteForGuardians(id(0xee), [{ url: `${T}/fed2-9/guardian`, peer: 0 }]) },   // another federation's
    { dir: '/r/bad', identity: 0, invite: 'fed1nonsense' }];
  assert.deepEqual(matchGuardians(recordGuardians, dirs).map((x) => x.dir), ['/r/node-1.db.guardian-next', '/r/node-15.db.guardian', '/r/node-1.db.guardian', null]);
  assert.equal(guardianDirOwn({ invite: 'x', identity: 0 }), null);
  assert.ok(isLiveGuardianDir('node-15.db.guardian') && isLiveGuardianDir('node-3.db.guardian-next'));
  assert.ok(!isLiveGuardianDir('node-1.db.guardian.founded-2026-09-27T0612') && !isLiveGuardianDir('node-1.db.guardian.regtest-337ae01a-pegins') && !isLiveGuardianDir('node-1.db'));
});

test('#3893c: the guardian is asked on GUARDIAN_HOST when set; roots are local paths or host:path', () => {
  assert.equal(guardianUrl(`${T}/fed2-1/guardian-next`, 'tn4.bitcoin-arena.io'), 'wss://tn4.bitcoin-arena.io/fed2-1/guardian-next');
  assert.equal(guardianUrl(`${T}/fed2-1/guardian-next`, ''), `${T}/fed2-1/guardian-next`);
  assert.deepEqual(parseRoots('/home/x/blwp-testnet4, daniel@192.168.1.18:m808/blwp-offload/fed2'), [
    { host: null, path: '/home/x/blwp-testnet4' }, { host: 'daniel@192.168.1.18', path: 'm808/blwp-offload/fed2' }]);
});
