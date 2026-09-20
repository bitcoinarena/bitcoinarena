// WHAT THE TWO TESTNET4 GATEWAYS HOLD RIGHT NOW (M3 inbound liquidity, the owner 2026-09-20).
//
// WHY A LIVE READ AND NOT ONLY THE SUITE. `gateways.test.js` pins the numbers the pair reported on 2026-09-20
// after a real invoice was paid each way. That is a regression floor and it is worth having, but it is a
// CONSTANT: it would have gone on saying "two gateways with inbound" for the four days node B lay dark and
// node A's 196530 sat could not be reached. A green suite cannot see a stopped process. This asks the nodes.
//
// It runs `getinfo` and `listchannels` against each node's own rpc and feeds exactly those words to
// `gatewaysAreIndependent` - the same predicate a paying round will use - then prints what it found. It
// decides nothing about the game: this is LND custody, not the simulation.
//
//   node packages/protocol/tools/measure-gateways.mjs [--json]
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gatewaysAreIndependent } from '../src/gateways.js';

const run = promisify(execFile);
const LNCLI = process.env.BLWP_LNCLI || '/mnt/bitcoin/lnd-linux-amd64-v0.21.3-beta/lncli';

/** The pair as the test host runs them. Same host is allowed by the ruling; the identities are what differ. */
const NODES = [
  { name: 'lnd-testnet4', lnddir: '/mnt/bitcoin/lnd-testnet4', rpc: '127.0.0.1:11009', unit: 'lnd-testnet.service' },
  { name: 'lnd-testnet4-b', lnddir: '/mnt/bitcoin/lnd-testnet4-b', rpc: '127.0.0.1:11010', unit: 'lnd-testnet4-b.service' },
];

async function lncli(node, ...args) {
  const { stdout } = await run(LNCLI, [`--lnddir=${node.lnddir}`, `--rpcserver=${node.rpc}`,
                                       '--network=testnet4', ...args], { timeout: 30000, maxBuffer: 8 << 20 });
  return JSON.parse(stdout);
}
async function unitState(unit) {
  const one = async (verb) => {
    try { const { stdout } = await run('systemctl', ['--user', verb, unit], { timeout: 10000 }); return stdout.trim(); }
    catch (e) { return (e.stdout || '').trim() || 'unknown'; }
  };
  return { enabled: await one('is-enabled'), active: await one('is-active') };
}

const seen = [];
for (const node of NODES) {
  const row = { name: node.name, rpc: node.rpc, unit: await unitState(node.unit) };
  try {
    const info = await lncli(node, 'getinfo');
    const chans = await lncli(node, 'listchannels');
    row.identityPubkey = info.identity_pubkey;
    row.syncedToChain = info.synced_to_chain === true;
    row.blockHeight = info.block_height;
    row.peers = info.num_peers;
    row.channels = (chans.channels || []).map((c) => ({
      chanId: c.chan_id, active: c.active === true,
      capacitySat: BigInt(c.capacity || 0),
      localBalanceSat: BigInt(c.local_balance || 0),
      remoteBalanceSat: BigInt(c.remote_balance || 0),
    }));
  } catch (e) {
    // A NODE THAT WILL NOT ANSWER IS THE WHOLE POINT OF THIS TOOL. Print the RPC's own words rather than a
    // guess about why: "connection refused" is a stopped unit, "wallet locked" is a wallet nobody unlocked.
    row.error = String(e.stderr || e.message || e).split('\n')[0].slice(0, 200);
    row.channels = [];
    row.syncedToChain = false;
  }
  seen.push(row);
}

const verdict = gatewaysAreIndependent({
  gateways: seen.map((r) => ({ identityPubkey: r.identityPubkey || '', rpc: r.rpc,
                               syncedToChain: r.syncedToChain, channels: r.channels })),
});

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ seen, verdict }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
} else {
  for (const r of seen) {
    const inbound = r.channels.filter((c) => c.active).reduce((s, c) => s + c.remoteBalanceSat, 0n);
    const outbound = r.channels.filter((c) => c.active).reduce((s, c) => s + c.localBalanceSat, 0n);
    console.log(`  ${r.name.padEnd(20)} unit ${r.unit.enabled}/${r.unit.active}`
      + `  ${r.error ? 'ERROR ' + r.error : `${r.identityPubkey.slice(0, 8)}...  synced ${r.syncedToChain}`
        + `  peers ${r.peers}  channels ${r.channels.length} (${r.channels.filter((c) => c.active).length} active)`
        + `  inbound ${inbound}  outbound ${outbound}`}`);
  }
  console.log(`\n  gatewaysAreIndependent: ${verdict.ok ? 'YES' : 'NO'} - ${verdict.usable} usable${verdict.why ? ' - ' + verdict.why : ''}`);
}
process.exit(verdict.ok ? 0 : 2);
