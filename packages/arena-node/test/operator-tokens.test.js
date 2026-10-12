// THE OPERATOR UI'S PAIRING AND SCOPED TOKENS (spec §27A.7.7, kanban #332): a blwp-operator: URI with a 32-byte token, printed on
// first start; read / vote / config scopes, none of which moves money; minted and revoked by the owner's signature only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createOperatorTokens, operatorUri, readOperatorUri, OPERATOR_SCOPES } from '../src/operator-tokens.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { joinedWithLock } from './lock-fixture.js';

const memory = () => { let l = []; return { read: () => l, write: (x) => { l = JSON.parse(JSON.stringify(x)); }, peek: () => l }; };

test('first start mints one pairing token with every scope; the store keeps its hash, never the token', () => {
  const store = memory(); const said = [];
  const t = createOperatorTokens({ store, log: (l) => said.push(l) });
  const first = t.first('https://seat.example/');
  assert.deepEqual(first.scopes, [...OPERATOR_SCOPES]);
  assert.match(first.uri, /^blwp-operator:https:\/\/seat\.example#[0-9a-f]{64}$/);
  assert.deepEqual(readOperatorUri(first.uri), { endpoint: 'https://seat.example', token: first.token });
  assert.equal(JSON.stringify(store.peek()).includes(first.token), false, 'the token itself is not stored');
  assert.match(said[0], /none can move money/);
  assert.equal(t.first('https://seat.example'), null, 'a second start mints nothing');
  assert.equal(createOperatorTokens({ store }).list().length, 1, 'the kept token survives a restart');
});

test('a token opens only its scopes; a wrong, malformed or revoked one opens nothing', () => {
  const t = createOperatorTokens({ store: memory() });
  const r = t.mint(['read']);
  assert.deepEqual(t.check(`Bearer ${r.token}`, 'read'), { ok: true, id: r.id });
  assert.equal(t.check(`Bearer ${r.token}`, 'vote').status, 403);
  assert.equal(t.check(`Bearer ${'0'.repeat(64)}`, 'read').status, 401);
  assert.equal(t.check('Bearer nope', 'read').status, 401);
  assert.equal(t.check(undefined, 'read').status, 401);
  assert.throws(() => t.mint(['spend']), /scopes are some of read, vote, config/);
  assert.throws(() => t.mint([]), /scopes/);
  assert.equal(t.revoke(r.id).ok, true);
  assert.equal(t.check(`Bearer ${r.token}`, 'read').status, 401, 'revoked');
  assert.equal(operatorUri({ endpoint: 'http://x:1/', token: 'ab'.repeat(32) }), `blwp-operator:http://x:1#${'ab'.repeat(32)}`);
});

test('on a running seat: the pairing token reads status; vote and config answer by name what is not built; the owner mints and revokes', async () => {
  const seed = new Uint8Array(32).fill(7);
  const secret = ownerSecretFromSeed(seed);
  const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
  const ostore = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
  let pairing = null;
  const s = await joinedWithLock({ owner: { store: ostore }, operator: { store: memory(), writePairing: (u) => { pairing = u; }, endpoint: 'https://seat.example' } });
  try {
    const base = `http://127.0.0.1:${s.d.port}`;
    const { token } = readOperatorUri(pairing);
    const get = (path, tok) => fetch(base + path, { method: path === '/operator/status' ? 'GET' : 'POST', headers: tok ? { authorization: `Bearer ${tok}` } : {} });
    assert.equal((await get('/operator/status')).status, 401, 'no token');
    const st = await (await get('/operator/status', token)).json();
    assert.equal(st.ok, true);
    assert.equal(typeof st.node, 'string');
    assert.equal(typeof st.roundsHeld, 'number');
    const vote = await get('/operator/vote', token);
    assert.equal(vote.status, 501);
    assert.match((await vote.json()).why, /no ballot to vote in yet/);
    assert.equal((await get('/operator/config', token)).status, 501);
    // the owner mints a read-only token and revokes it again
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const signed = (action, args) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    const post = (path, body) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const minted = await (await post('/owner/operator/mint', signed('operator-mint', { scopes: ['read'] }))).json();
    assert.equal(minted.ok, true, minted.why);
    const ro = readOperatorUri(minted.uri).token;
    assert.equal((await get('/operator/status', ro)).status, 200);
    assert.equal((await get('/operator/vote', ro)).status, 403, 'a read token cannot vote');
    const stranger = signOwnerRequest({ node, action: 'operator-mint', args: { scopes: ['vote'] }, secret: ownerSecretFromSeed(new Uint8Array(32).fill(9)), sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
    assert.equal((await post('/owner/operator/mint', stranger)).status, 403, 'only the owner mints');
    assert.equal((await post('/owner/operator/revoke', signed('operator-revoke', { id: minted.id }))).status, 200);
    assert.equal((await get('/operator/status', ro)).status, 401, 'revoked');
    const listed = await (await post('/owner/operator/list', signed('operator-list', {}))).json();
    assert.equal(listed.tokens.length, 1, 'the pairing token stays');
  } finally { await s.d.close(); }
});
