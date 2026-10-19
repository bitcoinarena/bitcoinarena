// kanban #499: every setting of an installed node in arena.conf - read, mapped to the seat's ARENA_* settings, moved from an older
// node.env, changed one key at a time; src/run.js refuses a file that does not read.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseConf, confToRun, envToConfValues, formatConf, setInConf, unsetInConf, unknownKeys } from '../src/arena-conf.js';

test('arena.conf: key=value lines and comments; a later key wins; a line that is no setting is named', () => {
  const { values, errors } = parseConf('# c\nport=8470\n\nbind = 0.0.0.0\r\nPORT=8471\nnot a line\n9x=1\n');
  assert.deepEqual(values, { port: '8471', bind: '0.0.0.0' });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /line 6/);
  assert.match(errors[1], /9x/);
});

test('arena.conf to the seat: ARENA_<KEY>, the port-named three, port and database as its arguments', () => {
  const r = confToRun({ port: '8570', database: '/h/node.db', bind: '127.0.0.1', public_url: 'https://a.example', guardian_endpoint: 'wss://a.example/guardian',
    roles: 'verify,custody', instance: 'b', some_new_thing: 'x' });
  assert.equal(r.port, 8570); assert.equal(r.database, '/h/node.db');
  assert.deepEqual(r.env, { ARENA_BIND: '127.0.0.1', ARENA_WSS_8570: 'https://a.example', ARENA_GUARDIAN_ENDPOINT_8570: 'wss://a.example/guardian',
    ARENA_ROLES: 'verify,custody', ARENA_INSTANCE: 'b', ARENA_SOME_NEW_THING: 'x' });
  assert.deepEqual(unknownKeys({ port: '1', some_new_thing: 'x', public_url: 'u' }), ['some_new_thing']);
  assert.throws(() => confToRun({ port: 'x' }), /no port/);
});

test('an older node.env moves into arena.conf with the same settings (macOS node B\'s keys), and reads back the same', () => {
  const env = ['# The Arena node\'s settings', 'ARENA_BIND=127.0.0.1', 'ARENA_DONATION_NETWORK=testnet4', 'ARENA_CLOSE_AT_END=1', 'ARENA_GAMES=/r/packages/nextblock/plugin/nextblock.js',
    'ARENA_BITCOIND_URL=http://127.0.0.1:48342', 'ARENA_BITCOIND_COOKIE=/c/.cookie', 'ARENA_WSS_8570=https://x.trycloudflare.com', 'ARENA_GATEWAY_PORT=8576',
    'ARENA_FOUNDING=1', 'ARENA_FEDIMINTD=/r/runtime/custody/fedimintd', 'ARENA_GUARDIAN_ENDPOINT_8570=wss://x.trycloudflare.com/guardian', 'ARENA_ROLES=verify,settlement,custody'].join('\n');
  const values = envToConfValues(env, { port: 8570, database: '/h/node.db' });
  assert.equal(values.public_url, 'https://x.trycloudflare.com');
  assert.equal(values.guardian_endpoint, 'wss://x.trycloudflare.com/guardian');
  const text = formatConf(values);
  assert.match(text, /^# the node's public https address, as it names itself\npublic_url=https:\/\/x\.trycloudflare\.com$/m);
  const back = confToRun(parseConf(text).values, { home: '/h' });
  const before = Object.fromEntries(env.split('\n').filter((l) => l.startsWith('ARENA_')).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  assert.deepEqual(back.env, before, 'the seat starts with exactly the settings node.env gave it');
  assert.equal(back.port, 8570);
  assert.ok(formatConf(values, { eol: '\r\n' }).split('\r\n').length > 10, 'Windows line ends');
});

test('config set / unset keep every other line; a new known key comes with its meaning; one line only', () => {
  const t = formatConf({ port: '8470', bind: '127.0.0.1' });
  const t2 = setInConf(t, 'bind', '0.0.0.0');
  assert.equal(parseConf(t2).values.bind, '0.0.0.0');
  assert.equal(t2.split('\n').length, t.split('\n').length, 'replaced in place');
  const t3 = setInConf(t2, 'roles', 'verify');
  assert.match(t3, /# what the node does[^\n]*\nroles=verify\n$/);
  assert.throws(() => setInConf(t3, 'Bad Key', 'x'), /no setting name/);
  assert.throws(() => setInConf(t3, 'roles', 'a\nport=1'), /one line/);
  const t4 = unsetInConf(t3, 'roles');
  assert.equal(parseConf(t4).values.roles, undefined);
  assert.ok(!t4.includes('# what the node does'), 'its meaning goes with it');
  assert.equal(setInConf('a=1\r\n', 'b', '2'), 'a=1\r\nb=2\r\n', 'a Windows file keeps CRLF');
});

test('run.js: a file that does not read stops the start and names the line', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conf-'));
  writeFileSync(join(dir, 'arena.conf'), 'port=8470\nthis is wrong\n');
  const r = spawnSync(process.execPath, [fileURLToPath(new URL('../src/run.js', import.meta.url)), join(dir, 'arena.conf')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /line 2/);
  const m = spawnSync(process.execPath, [fileURLToPath(new URL('../src/run.js', import.meta.url)), join(dir, 'missing.conf')], { encoding: 'utf8', timeout: 30000 });
  assert.equal(m.status, 2);
  assert.match(m.stderr, /cannot read/);
});
