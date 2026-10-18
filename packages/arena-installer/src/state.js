// THE WIZARD'S STATE, ON DISK (kanban #471 step B.4: "the wizard can be left and resumed; every step's state is kept on disk").
//
// One directory holds everything the node is: the wizard state (state.json), the seat's settings (node.env, what the service hands
// main.js), the seed (seed.hex) and the seat's database (node.db and the files main.js keeps beside it). Every file is the user's only
// (0600, the directory 0700). An update keeps this directory as it is; the release is elsewhere.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const STEPS = Object.freeze(['chain', 'roles', 'seed', 'owner', 'reach', 'service', 'lightning', 'federation', 'promise', 'bond', 'done']);

/** Where a node lives unless told otherwise: $ARENA_HOME, else ~/.arena-node. */
export const defaultHome = (env = process.env) => env.ARENA_HOME || join(homedir(), '.arena-node');

// THE ROLES (spec §27A roles; ruling 2: custody on Linux and macOS, and in slice 5): what each needs, said before it is chosen
export const ROLES = Object.freeze({
  verify: { title: 'Game / verify', needs: 'Replays and signs the rounds it is seated on. A bond, a reachable https endpoint, about 2 GB of disk and one core.', slice: 1 },
  settlement: { title: 'Settlement', needs: 'Co-signs the settlement of rounds it is seated on. The verify role\'s needs, and to be up through each settlement window.', slice: 1 },
  custody: { title: 'Custody', needs: 'A Lightning node (LND): set up here in the Lightning step, or your own connected. Needs your own Bitcoin Core (not Electrum), about 1 GB more disk, port 9735 open for Lightning peers. Your node becomes one of a federation\'s 10 guardians and may run one of its 2 gateways (the next steps explain both).', slice: 1 },
});

const atomicWrite = (path, text) => {
  writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
};

/** The state of the node at `home`: { read(), save(patch), path(name) }. A new home starts at the first step. */
export function nodeState(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const file = join(home, 'state.json');
  const read = () => {
    try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return { network: 'testnet4', step: 'chain', createdMs: Date.now() }; }
  };
  return {
    home,
    path: (name) => join(home, name),
    read,
    save(patch) { const s = { ...read(), ...patch, updatedMs: Date.now() }; atomicWrite(file, JSON.stringify(s, null, 2) + '\n'); return s; },
    writeSecret(name, text) { atomicWrite(join(home, name), text); },
    readSecret(name) { try { return readFileSync(join(home, name), 'utf8').trim(); } catch { return null; } },
    exists: (name) => existsSync(join(home, name)),
  };
}

/** The node's guardian endpoint: its public address as a websocket, /guardian (the seat carries it to its fedimintd). */
export const guardianUrlOf = (url) => (url ? `${url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/+$/, '')}/guardian` : null);

/** A custody node's guardian: its binaries from the release and its endpoint, or null (no custody, no Core, no public address, no binaries). */
export function guardianSetupOf(s, { release, platform = process.platform }) {
  if (!(s.roles || []).includes('custody') || !s.chain || s.chain.kind !== 'core' || !s.reach || !s.reach.url) return null;
  const x = platform === 'win32' ? '.exe' : '';
  const fedimintd = join(release, 'runtime', 'custody', `fedimintd${x}`), cli = join(release, 'runtime', 'custody', `fedimint-cli${x}`);
  if (!existsSync(fedimintd) || !existsSync(cli)) return null;
  return { fedimintd, cli, endpoint: guardianUrlOf(s.reach.url) };
}

/** The first step not done yet. */
export const nextStep = (s) => STEPS.find((k) => !(s.done || {})[k]) || 'done';

/**
 * THE SEAT'S SETTINGS (main.js reads them): a systemd EnvironmentFile, KEY=VALUE per line. Bitcoin Core by its cookie file (user and
 * password go into a cookie-format file of our own, main.js reads only a cookie). Answers the text.
 */
export function seatEnv(s, { home, release }) {
  const lines = [
    '# The Arena node\'s settings, written by the installer (kanban #471). An update keeps this file.',
    // a direct node listens on every interface; behind a tunnel only cloudflared on this machine reaches it
    `ARENA_BIND=${s.reach && s.reach.mode === 'direct' ? '0.0.0.0' : '127.0.0.1'}`,
    'ARENA_DONATION_NETWORK=testnet4',
    'ARENA_CLOSE_AT_END=1',
    `ARENA_GAMES=${join(release, 'packages/nextblock/plugin/nextblock.js')}`,
    `ARENA_PLUGINS_DIR=${join(home, 'node.db.plugins')}`,
  ];
  if (s.chain && s.chain.kind === 'core') {
    lines.push(`ARENA_BITCOIND_URL=${s.chain.url}`, `ARENA_BITCOIND_COOKIE=${s.chain.cookiePath || join(home, 'bitcoind.auth')}`);
  }
  if (s.chain && s.chain.kind === 'electrum') {
    // the chain bridge (chain-bridge.js) answers the seat's bitcoind calls from the Electrum server and Esplora, on this port
    lines.push(`ARENA_BITCOIND_URL=http://127.0.0.1:${s.bridgePort}/`, `ARENA_BITCOIND_COOKIE=${join(home, 'bridge.cookie')}`);
  }
  if (s.reach && s.reach.url) lines.push(`ARENA_WSS_${s.port}=${s.reach.url}`);   // the node's public address, as it names itself
  // CUSTODY (kanban #471 slice 5, ruling 3): the node's guardian in setup mode (ARENA_FOUNDING=1, node-start.js) from the release's own
  // fedimintd, reached at the node's public address /guardian - so it can be drawn when new nodes found a federation
  const custody = guardianSetupOf(s, { release });
  if ((s.roles || []).includes('custody')) lines.push('ARENA_GATEWAY_PORT=8476', `ARENA_GATEWAY_CLAIM_FILE=${join(home, 'gateway-claim.json')}`);   // the gateway seat's claim (custody-agent.js)   // the seat carries <public>/gateway/ to the node's gateway (gateway.js GATEWAY_PORT)
  if (custody) lines.push('ARENA_FOUNDING=1', `ARENA_FEDIMINTD=${custody.fedimintd}`, `ARENA_FEDIMINT_CLI=${custody.cli}`, `ARENA_GUARDIAN_ENDPOINT_${s.port}=${custody.endpoint}`);
  lines.push(`ARENA_ROLES=${(s.roles || []).join(',')}`);
  return lines.join('\n') + '\n';
}
