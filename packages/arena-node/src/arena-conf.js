// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ARENA.CONF: EVERY SETTING OF AN INSTALLED NODE IN ONE FILE (2026-10-19: "Every setting must be in a config file
// arena.conf not in some PARAMETER env vars. the installer writes that config file"). The file is `key=value` lines, `#` comments, as
// bitcoin.conf; the node's services start from it alone (src/run.js <home>/arena.conf) - no environment file, no command line to edit.
//
// Inside, the seat still reads its settings as ARENA_* variables (63 of them, read across its modules): run.js puts each key there
// before the seat loads - `foo_bar` is ARENA_FOO_BAR - so every setting the seat knows can be written here, the known ones below with
// their meaning. Three name the seat's port in the variable: public_url (ARENA_WSS_<port>), guardian_endpoint and
// guardian_next_endpoint (ARENA_GUARDIAN_ENDPOINT_<port>, ARENA_GUARDIAN_NEXT_ENDPOINT_<port>). `port` and `database` are the seat's
// port and store.

/** The settings an installed node uses, in the order the file lists them, each with its meaning. */
export const CONF_KEYS = Object.freeze([
  ['network', 'the chain the node plays on (testnet4)'],
  ['port', 'the seat\'s local port'],
  ['database', 'the seat\'s store (its keys, rounds, census)'],
  ['bind', 'the address the seat listens on: 127.0.0.1 behind a tunnel, 0.0.0.0 for a direct node'],
  ['public_url', 'the node\'s public https address, as it names itself'],
  ['roles', 'what the node does: verify, settlement, custody, liquidity'],
  ['instance', 'a second node on this machine: its name (arenanode-<instance>, its services named apart)'],
  ['port_offset', 'a second node on this machine: added to every port'],
  ['bitcoind_url', 'the chain: Bitcoin Core\'s RPC, or the chain bridge in Electrum mode'],
  ['bitcoind_cookie', 'the chain\'s RPC cookie file'],
  ['apps', 'the app plugins the seat loads'],
  ['plugins_dir', 'where installed plugins are kept'],
  ['donation_network', 'the network whose donation set the node pays'],
  ['close_at_end', '1: rounds are closed when they end'],
  ['gateway_port', 'custody: the Lightning gateway\'s local port (the seat carries <public_url>/gateway/ to it)'],
  ['gateway_claim_file', 'custody: the gateway seat\'s claim'],
  ['founding', 'custody: 1 = the guardian starts in setup mode, ready to found a federation'],
  ['fedimintd', 'custody: the guardian program'],
  ['fedimint_cli', 'custody: the guardian\'s command-line client'],
  ['fedimint_ram', 'custody: 1 = the guardian\'s database in RAM (Linux /dev/shm), a snapshot on disk every minute (more than 5 nodes on a machine)'],
  ['guardian_endpoint', 'custody: the guardian\'s public websocket (<public_url>/guardian)'],
  ['liquidity_claim_file', 'liquidity: the provider\'s claim'],
  ['liquidity_provider_url', 'liquidity: the provider service\'s local address'],
  ['auto_update', '1 (default): the node updates itself to a newer signed release; 0: only by hand (arenanode update)'],
  ['latest_url', 'a test update channel: a signed latest.json on https://testnet.bitcoin-arena.io/ (empty: the production release)'],
  // kanban #693, 2026-10-26: "add a --debug and --verbose flag that shows more info on what its doing, what is going wrong etc"
  ['log_level', 'how much the node\'s services log: info (default), verbose (each step), debug (and the insides); from their next start'],
]);
const KNOWN = new Set(CONF_KEYS.map(([k]) => k));
const PORT_NAMED = Object.freeze({ public_url: 'ARENA_WSS_', guardian_endpoint: 'ARENA_GUARDIAN_ENDPOINT_', guardian_next_endpoint: 'ARENA_GUARDIAN_NEXT_ENDPOINT_' });
const KEY = /^[a-z][a-z0-9_]*$/;

/** The file read: { values: { key: value }, errors: [line: why] }. A later line of a key wins, as in bitcoin.conf. */
export function parseConf(text) {
  const values = {}; const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const eq = line.indexOf('=');
    if (eq < 0) { errors.push(`line ${i + 1}: "${line.slice(0, 40)}" is no key=value`); return; }
    const key = line.slice(0, eq).trim().toLowerCase(); const value = line.slice(eq + 1).trim();
    if (!KEY.test(key)) { errors.push(`line ${i + 1}: "${key}" is no setting name (a-z, 0-9, _)`); return; }
    values[key] = value;
  });
  return { values, errors };
}

/** The keys a file holds that this release does not list (each still reaches the seat as ARENA_<KEY>). */
// KEYS THAT TOOK A NEW NAME (kanban #569, 2026-10-21: "Rename it so apps in the code and envs"): an update rewrites them once in
// an installed node's arena.conf (arena-installer/src/update.js) - the seat reads only the new name
export const RENAMED_KEYS = Object.freeze({ games: 'apps' });
/** arena.conf's text with every renamed key written under its new name (the rest of the file as it was). */
export const renameKeys = (text) => String(text).replace(/^(\s*)([a-z_]+)(\s*=)/gm, (m, lead, k, eq) => (RENAMED_KEYS[k] ? `${lead}${RENAMED_KEYS[k]}${eq}` : m));
/** Settings read from an older release's environment, their renamed keys under the new name. */
export const renameValues = (values) => Object.fromEntries(Object.entries(values).map(([k, v]) => [RENAMED_KEYS[k] || k, v]));
export const unknownKeys = (values) => Object.keys(values).filter((k) => !KNOWN.has(k) && !PORT_NAMED[k]);

/** What the seat starts with: { port, database, env } - env the ARENA_* variables of every other key. */
export function confToRun(values, { home = '.' } = {}) {
  const port = Number(values.port || 8470);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`arena.conf: port=${values.port} is no port`);
  const database = values.database || `${home}/node.db`;
  const env = {};
  for (const [k, v] of Object.entries(values)) {
    if (k === 'port' || k === 'database') continue;
    env[PORT_NAMED[k] ? `${PORT_NAMED[k]}${port}` : `ARENA_${k.toUpperCase()}`] = v;
  }
  return { port, database, env };
}

/** An older node's node.env (ARENA_*=value) as arena.conf values, with the seat's port and store (migration). */
export function envToConfValues(envText, { port, database }) {
  const values = { port: String(port), database };
  for (const raw of String(envText || '').split(/\r?\n/)) {
    const m = /^\s*(ARENA_[A-Z0-9_]+)=(.*)$/.exec(raw);
    if (!m) continue;
    const named = Object.entries(PORT_NAMED).find(([, pre]) => m[1] === `${pre}${port}`);
    values[named ? named[0] : m[1].slice(6).toLowerCase()] = m[2].trim();
  }
  return values;
}

/** The file's text: the known settings in order, each under its meaning, then any other. `eol` '\r\n' on Windows. */
export function formatConf(values, { eol = '\n', header = 'written by the installer' } = {}) {
  const lines = [`# The Arena node's settings (${header}). Change one with: arenanode config set <key> <value>, then: arenanode restart`,
    '# One key=value per line. A key left out takes the node\'s default.', ''];
  for (const [k, what] of CONF_KEYS) if (values[k] !== undefined && values[k] !== null && values[k] !== '') lines.push(`# ${what}`, `${k}=${values[k]}`);
  const rest = Object.keys(values).filter((k) => !KNOWN.has(k) && values[k] !== undefined && values[k] !== null && values[k] !== '');
  if (rest.length) lines.push('', '# other settings (each is ARENA_<KEY> to the seat)', ...rest.map((k) => `${k}=${values[k]}`));
  return lines.join(eol) + eol;
}

/** `key` set to `value` in the file's text, keeping every other line and comment; a new key is added at the end. */
export function setInConf(text, key, value, { eol = /\r\n/.test(String(text)) ? '\r\n' : '\n' } = {}) {
  if (!KEY.test(key)) throw new Error(`"${key}" is no setting name (a-z, 0-9, _)`);
  if (/[\r\n]/.test(String(value))) throw new Error('a setting is one line');
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let found = false;
  const out = lines.map((l) => { const m = /^\s*([a-z][a-z0-9_]*)\s*=/i.exec(l); if (m && m[1].toLowerCase() === key) { found = true; return `${key}=${value}`; } return l; });
  if (!found) { const what = CONF_KEYS.find(([k]) => k === key); if (what) out.push(`# ${what[1]}`); out.push(`${key}=${value}`); }
  return out.join(eol) + eol;
}

/** `key` taken out of the file's text (its line; the comment line above it when it is that key's meaning). */
export function unsetInConf(text, key) {
  const eol = /\r\n/.test(String(text)) ? '\r\n' : '\n';
  const lines = String(text || '').split(/\r?\n/);
  const what = (CONF_KEYS.find(([k]) => k === key) || [])[1];
  const out = [];
  for (const l of lines) {
    const m = /^\s*([a-z][a-z0-9_]*)\s*=/i.exec(l);
    if (m && m[1].toLowerCase() === key) { if (what && out[out.length - 1] === `# ${what}`) out.pop(); continue; }
    out.push(l);
  }
  return out.join(eol);
}
