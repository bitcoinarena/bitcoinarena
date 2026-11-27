// #1489 r20 gossip: POST /dkg takes a contribution from anybody - nothing in it is signed by the dealer it names (`from`); the proof of
// knowledge is bound to the dealer's signer node NUMBER only, and the dealer picks its own sealing key. A stranger who knows the
// committee (public: the round's contract) deals a polynomial of its own "from" an honest member and posts it to the other members
// before the real one arrives; dkg_contributions is INSERT OR IGNORE, so the honest member's real deal is never kept there, the
// member itself holds its own - the agreement step refuses the split and the committee's claim key is never made (paid rounds stall).
// Safe behaviour: a contribution not made by the key it names is refused, and the honest committee finishes its key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { Dkg, runAgainIn } from '../src/dkg.js';
import { feldmanGroup, tweakPoint } from '../src/curve.js';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { dealContribution, encodeContribution } from '../../arena-protocol/src/dkg.js';

const curve = { ...feldmanGroup, tweakPoint };
const rand = (n) => new Uint8Array(randomBytes(n));

/** `n` signer nodes in one process, reached at http://n<i> through one fetcher that counts each /dkg call; `silent` never deals. */
function committee(n, { silent = -1 } = {}) {
  const st = { silent };
  const calls = [];
  const dkgs = [];
  const fetcher = async (url, opts = {}) => {
    const u = new URL(url); const i = Number(u.hostname.slice(1)); const method = opts.method || 'GET';
    calls.push({ to: i, method, path: u.pathname });
    const epoch = fromHex(u.searchParams.get('epoch'));
    const d = dkgs[i];
    if (u.pathname === '/dkg' && method === 'POST') {
      if (i === st.silent) return new Response('this node knows no such epoch', { status: 409 });
      const r = await d.accept(new Uint8Array(opts.body));
      return r.ok ? new Response('ok') : new Response(r.why, { status: 409 });
    }
    if (u.pathname === '/dkg') {
      const held = i === st.silent ? null : d.round.epoch(epoch);
      return held && held.mine ? new Response(held.mine) : new Response('none', { status: 404 });
    }
    if (u.pathname === '/dkg-agreement') {
      const a = i === st.silent ? { ok: false } : d.agreementBytes(epoch);
      return a.ok ? new Response(a.bytes) : new Response('none', { status: 404 });
    }
    return new Response('no such door', { status: 404 });
  };
  for (let i = 0; i < n; i++) dkgs.push(new Dkg(new Round(openStore(':memory:')), { curve, random: rand, fetcher }));
  const nodes = dkgs.map((d) => d.round.pubkey);
  const peersOf = (i) => dkgs.map((_, j) => `http://n${j}`).filter((_, j) => j !== i);
  return { dkgs, nodes, peersOf, calls, st };
}

test('a stranger\'s contribution in an honest member\'s name is refused and the committee still makes its key', async () => {
  const { dkgs, nodes, peersOf } = committee(3);
  const k2 = { needed: 2 };
  await Promise.all(dkgs.map((d) => d.deal(nodes, k2)));
  // the stranger: no key of any member, only the committee's public keys
  const order = [...nodes].sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  const epoch = dkgs[0].epochFor(nodes).epochId;
  const victim = nodes[2];
  let secret; for (;;) { secret = rand(32); if (secret[0] < 0xf0 && secret.some((b) => b)) break; }
  const eph = rand(32);
  const forged = await dealContribution({ secret, signerNodes: order, epochId: epoch, from: victim, ephemeralSecret: eph,
    ephemeralPubkey: curve.pointX(eph), coefficients: [BigInt('0x' + Buffer.from(rand(31)).toString('hex'))], needed: 2, curve });
  assert.equal(forged.ok, true, forged.why);
  const took0 = await dkgs[0].accept(encodeContribution(forged.contribution));
  const took1 = await dkgs[1].accept(encodeContribution(forged.contribution));
  let said = [];
  for (let pass = 0; pass < 4; pass++) said = await Promise.all(dkgs.map((d, i) => d.run(nodes, peersOf(i), k2)));
  assert.equal(took0.ok || took1.ok, false, `the forged deal "from" member 2 was taken (seat 0: ${took0.ok}, seat 1: ${took1.ok}); after 4 runs: ${said.map((s) => `${s.ok}${s.ok ? '' : ' ' + String(s.why).slice(0, 90)}`).join(' | ')}`);
  assert.ok(said.every((s) => s.ok), said.map((s) => s.why).join(' | '));
});
