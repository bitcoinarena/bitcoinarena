// kanban #3893b: every gateway joins every federation the seats serve (a successor too), from the record's own invite; a gateway that
// stops running (its LND restarted under it) is restarted after FAIL_PASSES passes in a row
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFederationRecord, joinSignedRecord, FEDERATION_STATUS, thresholdOf } from '../../arena-protocol/src/federation-record.js';
import { federationsToJoin, missingJoins, healthStep, parseGateways } from '../tools/gateway-keeper.mjs';

const id = (b) => new Uint8Array(32).fill(b);
const hex = (b) => Buffer.from(b).toString('hex');
const row = ({ fed, status = FEDERATION_STATUS.OPEN, sigs = 5, invite = `fed11${'q'.repeat(20)}${fed}`, rowFed = fed }) => {
  const body = encodeFederationRecord({ federationId: id(fed), networkId: id(9), invite, nominal: 7, threshold: thresholdOf(7), guardians: [],
    status, successorId: null, gone: [], exposureCapSats: 0n, reserveSats: 0n, height: 100 });
  const signatures = Array.from({ length: sigs }, (_, i) => ({ nodePubkey: id(0x10 + i), signature: new Uint8Array(64).fill(i) }));
  return { federation: hex(id(rowFed)), status: 'OPEN', record: Buffer.from(joinSignedRecord(body, signatures)).toString('hex') };
};

test('#3893b: the served federations to join - OPEN/DRAINING/CRITICAL, threshold-signed, the record\'s own invite; others left out', () => {
  const m = federationsToJoin([
    { federations: [row({ fed: 1 }), row({ fed: 2, status: FEDERATION_STATUS.DRAINING }), row({ fed: 3, status: FEDERATION_STATUS.CLOSED }),
      row({ fed: 4, sigs: 4 }), row({ fed: 5, rowFed: 6 }), { federation: hex(id(7)), record: 'zz' }] },
    { federations: [row({ fed: 8, status: FEDERATION_STATUS.CRITICAL })] }, null, { nope: 1 }]);
  assert.deepEqual([...m.keys()], [hex(id(1)), hex(id(2)), hex(id(8))]);
  assert.match(m.get(hex(id(1))), /^fed11q+1$/);
});

test('#3893b: a gateway joined to A and B but not to the successor C must join C only', () => {
  const wanted = new Map([['aa', 'fed1a'], ['bb', 'fed1b'], ['cc', 'fed1c']]);
  assert.deepEqual(missingJoins(['AA', 'bb'], wanted), [{ id: 'cc', invite: 'fed1c' }]);
  assert.deepEqual(missingJoins(['aa', 'bb', 'cc'], wanted), []);
});

test('#3893b: a gateway not Running (or silent) on two passes in a row is restarted; one good pass resets the count', () => {
  let s = healthStep(0, { gateway_state: 'Disconnected' });
  assert.deepEqual([s.fails, s.restart], [1, false]); assert.match(s.why, /Disconnected/);
  s = healthStep(s.fails, null); assert.deepEqual([s.fails, s.restart], [2, true]); assert.equal(s.why, 'no answer');
  s = healthStep(5, { gateway_state: 'Running' }); assert.deepEqual([s.fails, s.restart, s.why], [0, false, null]);
});

test('#3893b: GATEWAYS names port, data dir and unit', () => {
  assert.deepEqual(parseGateways('a:31270:/g/gw-a, c:31290:/g/gw-c:my-unit,bad'), [
    { name: 'a', port: 31270, dir: '/g/gw-a', unit: 'blwp-tn4-gw-a' }, { name: 'c', port: 31290, dir: '/g/gw-c', unit: 'my-unit' }]);
});
