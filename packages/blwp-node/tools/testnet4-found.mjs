// THE TESTNET FEDERATION FOUNDED, 5 OF 7, ON SEVEN NODES THAT ARE EACH ONE GUARDIAN (spec §23A.2; the owner 2026-09-27
// 10:04: "Testnet is 7 nodes and 7 guardians, one each ... Stock threshold is 5 of 7" - the seven Funnel paths
// /guardian-1..7 on 127.0.0.1:31221..31281; labelled testnet4).
//
// A node starts its guardian only once it holds a guardian key (node-start.js), and the key is what this ceremony
// writes. So the nodes are stopped, each node's guardian is started here in setup through the node's own startGuardian
// - the same port, store, chain and derived endpoint the node itself would use - the stock Fedimint ceremony runs among
// the four over their local admin APIs (set-local-params, add-peer, start-dkg; unpatched ceremony, base fees off), and
// once every one holds private.json and consensus.json they are stopped. The nodes then start as usual and find their
// keys. It does not draw the four: §23A.2's sortition is not built; these are the four this operator runs.
//
// A guardian directory already there - an earlier founding - is moved aside, never deleted:
// <store>.guardian -> <store>.guardian.<label>-<time>.
//
// THE CHAIN IS THE ONE NAMED (kanban #148 step 6): bitcoind must report BLWP_TN4_NETWORK (default testnet4) - a founding
// pointed at another chain is refused before any guardian starts. The regtest harness (tn4-tools-regtest.sh) names regtest.
//
//   PATH=<dir with the patched fedimintd and fedimint-cli>:$PATH BLWP_BITCOIND_URL=... BLWP_BITCOIND_COOKIE=...
//     node tools/testnet4-found.mjs [port:store ...]
import { existsSync, renameSync, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { startGuardian, guardianPorts } from '../src/guardian.js';
import { holdsGuardianKey } from '../src/node-start.js';
import { bitcoindRpc } from '../src/chain-rpc.js';

const env = process.env;
const say = (s) => console.log(`[found] ${s}`);
const nodes = (process.argv.slice(2).length ? process.argv.slice(2)
  : [1, 2, 3, 4, 5, 6, 7].map((n) => `${31211 + n * 10}:${env.BLWP_TESTNET4_DIR || `${env.HOME}/blwp-testnet4`}/node-${n}.db`))
  .map((s) => ({ port: Number(s.split(':')[0]), store: s.slice(s.indexOf(':') + 1) }));
if (nodes.length !== 7) throw new Error(`the testnet federation is seven guardians (5 of 7); got ${nodes.length}`);
const url = env.BLWP_BITCOIND_URL, cookiePath = env.BLWP_BITCOIND_COOKIE;
if (!url || !cookiePath) throw new Error('BLWP_BITCOIND_URL and BLWP_BITCOIND_COOKIE: the chain the guardians run on');
const call = bitcoindRpc({ url, cookiePath });
const network = env.BLWP_TN4_NETWORK || 'testnet4';
const { chain } = await call('getblockchaininfo');
if (chain !== network) throw new Error(`bitcoind at ${url} runs ${chain}, not ${network} (BLWP_TN4_NETWORK): nothing is founded`);

// THE NODES ARE DOWN: a guardian started here would share the node's ports and data
for (const n of nodes) {
  const up = await fetch(`http://127.0.0.1:${n.port}/guardian`).then(() => true, () => false);
  if (up) throw new Error(`the node on ${n.port} is running; stop it before founding`);
}
const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
for (const n of nodes) {
  const dir = `${n.store}.guardian`;
  if (existsSync(dir)) {
    let label = 'old';
    try { label = JSON.parse(readFileSync(`${dir}/consensus.json`, 'utf8')).modules ? 'founded' : 'setup'; } catch { /* setup only */ }
    renameSync(dir, `${dir}.${label}-${stamp}`);
    say(`${n.port}: the earlier guardian directory kept as ${dir}.${label}-${stamp}`);
  }
}

const cli = (args, password) => new Promise((resolve, reject) => execFile('fedimint-cli', ['--password', password, ...args],
  { timeout: 300000, env }, (e, out, err) => (e ? reject(new Error(`${args.slice(0, 4).join(' ')}: ${String(err || e.message).trim()}`)) : resolve(String(out).trim()))));

const guardians = [];
try {
  for (const n of nodes) {
    const g = await startGuardian({ nodePort: n.port, host: '127.0.0.1', storePath: n.store, bitcoindUrl: url, cookiePath, call,
      log: (s) => say(`${n.port}: ${s}`) });
    if (!g.running) throw new Error(`${n.port}: ${g.why}`);
    guardians.push({ ...n, g, api: `ws://127.0.0.1:${guardianPorts(n.port).api}`,
      password: readFileSync(`${n.store}.guardian/admin-password`, 'utf8').trim() });
  }
  // setup answers once fedimintd is up
  for (const x of guardians)
    for (let i = 0; ; i++) {
      try { await cli(['admin', 'setup', x.api, 'status'], x.password); break; }
      catch (e) { if (i > 60) throw e; await new Promise((r) => setTimeout(r, 1000)); }
    }
  const codes = [];
  for (const [i, x] of guardians.entries())
    codes.push((await cli(['admin', 'setup', x.api, 'set-local-params', `node-${i + 1}`,
      ...(i === 0 ? ['--federation-name', 'blwp-testnet4', '--federation-size', '7'] : [])], x.password)).replace(/["\s]/g, ''));
  say('every guardian set its local params');
  for (const [i, x] of guardians.entries())
    for (const [j, code] of codes.entries()) if (i !== j) await cli(['admin', 'setup', x.api, 'add-peer', code], x.password);
  say('every guardian holds the other six; the ceremony starts');
  await Promise.all(guardians.map((x) => cli(['admin', 'setup', x.api, 'start-dkg'], x.password).catch(() => '')));
  for (let i = 0; !guardians.every((x) => holdsGuardianKey(x.store)); i++) {
    if (i > 300) throw new Error('the ceremony wrote no keys in 300 s');
    await new Promise((r) => setTimeout(r, 1000));
  }
  for (let i = 0; !existsSync(`${guardians[0].store}.guardian/invite-code`); i++) {
    if (i > 120) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  say('founded: every node holds its guardian key');
  const invite = existsSync(`${guardians[0].store}.guardian/invite-code`)
    ? readFileSync(`${guardians[0].store}.guardian/invite-code`, 'utf8').replace(/["\s]/g, '') : '(none written)';
  console.log(JSON.stringify({ founded: true, invite }));
} finally {
  for (const x of guardians) await x.g.stop();
  say('the setup guardians are stopped; start the nodes');
}
