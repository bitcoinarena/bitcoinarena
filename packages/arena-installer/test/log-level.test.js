// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// --VERBOSE AND --DEBUG (kanban #693, 2026-10-26: "add a --debug and --verbose flag that shows more info on what its doing, what is going
// wrong etc"): the flags read off any place of a command line, the level from a flag over ARENA_LOG_LEVEL over arena.conf log_level, the
// default output of bitcoinarena unchanged line for line, every step said at --verbose, and a --debug run with secrets in every input - the
// node's files, a failed answer's body, a child process's command line and stderr - printing none of them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { levelFlags, levelOf, createLog, redact, redactArgs, redactObject, secretName, traceRuntime, serviceLog, QUIET } from '../../arena-node/src/log-level.js';
import { main } from '../src/bitcoinarena.js';
import { checkOnce } from '../src/auto-update.js';
import { formatConf } from '../../arena-node/src/arena-conf.js';
import http from 'node:http';
import { createWizard } from '../src/wizard.js';
import { nodeState } from '../src/state.js';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'bitcoinarena.mjs');
// THE SECRETS planted in the inputs: none of them may appear in any line
const SECRETS = { macaroonHex: '0201036c6e6402f801030a10'.repeat(8), gatewayPw: 'SEKRITgatewaypw693', cookie: '__cookie__:aa11bb22cc33dd44ee55ff66aa11bb22',
  ownerKey: 'f00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeedf00dfeed', rpcPw: 'rpcSEKRIT693', bodyPw: 'bodySEKRIT693', token: 'tokSEKRIT693',
  seed: 'abandon ability able about above absent absorb abstract absurd abuse access accident account accuse achieve acid' };
const leaks = (text) => Object.entries(SECRETS).filter(([, v]) => text.includes(v) || (v.includes('__cookie__') && text.includes(v.split(':')[1]))).map(([k]) => k);

/** A node as the installer leaves it on Linux, its secrets in its files and settings. */
function node({ port = 1 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loglevel-'));
  const home = join(root, 'home'); mkdirSync(join(home, 'lnd'), { recursive: true });
  const release = join(root, 'release'); mkdirSync(release); writeFileSync(join(release, 'VERSION'), '2026.1.9.7\n');
  const env = { XDG_CONFIG_HOME: join(root, 'config'), HOME: join(root, 'user') };
  const units = join(env.XDG_CONFIG_HOME, 'systemd', 'user'); mkdirSync(units, { recursive: true });
  writeFileSync(join(home, 'arena.conf'), formatConf({ network: 'testnet4', port: String(port), database: join(home, 'node.db'), roles: 'verify,settlement,custody',
    public_url: 'https://some-name.trycloudflare.com', bitcoind_url: 'http://127.0.0.1:1/', bitcoind_cookie: join(home, '.cookie'), gateway_password: SECRETS.gatewayPw }));
  writeFileSync(join(home, '.cookie'), SECRETS.cookie);
  writeFileSync(join(home, 'lnd', 'admin.macaroon'), Buffer.from(SECRETS.macaroonHex, 'hex'));
  writeFileSync(join(home, 'gw.pw'), SECRETS.gatewayPw);
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', release: { path: release }, reach: { mode: 'quick', port, url: 'https://some-name.trycloudflare.com' },
    lightning: { restUrl: 'https://127.0.0.1:1', tlsCert: join(home, 'lnd', 'tls.cert'), macaroon: join(home, 'lnd', 'admin.macaroon') },
    gateway: { apiUrl: `http://bob:${SECRETS.gatewayPw}@127.0.0.1:1/`, passwordFile: join(home, 'gw.pw') }, tor: { ports: { socks: 1 } }, ownerKey: SECRETS.ownerKey }));
  for (const id of ['tor', 'lnd', 'gateway', 'node', 'tunnel', 'chain-bridge']) writeFileSync(join(units, `arena-${id}.service`), `[Service]\nExecStart=/r/${id}\n`);
  return { root, home, env };
}
/** systemctl played: every unit active. */
const activeSh = async (cmd, args) => (cmd === 'systemctl' && args[1] === 'show' ? { ok: true, out: 'ActiveState=active\nSubState=running\nMainPID=4242\nNRestarts=0\n', err: '' }
  : cmd === 'ps' ? { ok: true, out: '', err: '' } : { ok: true, out: '', err: '' });
/** Every request answered 401, its body echoing secrets as a broken server might. */
const leakyFetch = async () => new Response(JSON.stringify({ error: `bad macaroon ${SECRETS.macaroonHex}`, password: SECRETS.bodyPw, seed: SECRETS.seed }), { status: 401 });

test('the level flags come off any place of the command line; --debug wins over --verbose; a word that is no level is refused', () => {
  assert.deepEqual(levelFlags(['status']), { level: null, rest: ['status'], bad: null });
  assert.deepEqual(levelFlags(['--verbose', 'status']), { level: 'verbose', rest: ['status'], bad: null });
  assert.deepEqual(levelFlags(['logs', 'lnd', '-v']), { level: 'verbose', rest: ['logs', 'lnd'], bad: null });
  assert.deepEqual(levelFlags(['-v', 'update', '--debug']), { level: 'debug', rest: ['update'], bad: null });
  assert.deepEqual(levelFlags(['status', '--log-level', 'debug']), { level: 'debug', rest: ['status'], bad: null });
  assert.deepEqual(levelFlags(['status', '--log-level=verbose']), { level: 'verbose', rest: ['status'], bad: null });
  assert.match(levelFlags(['--log-level', 'loud']).bad, /"loud" is no log level/);
});

test('the level: a flag over ARENA_LOG_LEVEL over arena.conf log_level over info; a word that is no level is said and read as info', () => {
  assert.deepEqual(levelOf({ flag: 'debug', env: { ARENA_LOG_LEVEL: 'verbose' }, conf: { log_level: 'info' } }), { level: 'debug', from: '--debug', bad: null });
  assert.deepEqual(levelOf({ env: { ARENA_LOG_LEVEL: 'Verbose' }, conf: { log_level: 'debug' } }), { level: 'verbose', from: 'ARENA_LOG_LEVEL', bad: null });
  assert.deepEqual(levelOf({ env: {}, conf: { log_level: 'debug' } }), { level: 'debug', from: 'arena.conf log_level', bad: null });
  assert.deepEqual(levelOf({ env: {}, conf: null }), { level: 'info', from: 'default', bad: null });
  assert.deepEqual(levelOf({ env: {} }), { level: 'info', from: 'default', bad: null });
  const bad = levelOf({ env: { ARENA_LOG_LEVEL: 'loud' } });
  assert.equal(bad.level, 'info'); assert.match(bad.bad, /ARENA_LOG_LEVEL "loud" is no log level/);
  // what each level says
  const lines = []; const at = (level) => { lines.length = 0; const l = createLog({ level, tag: 'x', write: (s) => lines.push(s) }); l.verbose('v'); l.debug('d'); l.fail('it', new Error('boom')); return [...lines]; };
  assert.deepEqual(at('info'), []);
  assert.deepEqual(at('verbose'), ['[x] v', '[x] it: boom']);
  const d = at('debug');
  assert.deepEqual(d.slice(0, 3), ['[x] v', '[x] d', '[x] it: boom']);
  assert.match(d[3], /^\[x\] it, stack:\n\s+at /);
});

test('redaction: by key name and by pattern; a file path, a public key and plain words stay', () => {
  for (const k of ['password', 'gateway_password', 'rpcpassword', 'macaroonHex', 'bitcoind_cookie', 'seedHex', 'ownerKey', 'owner_key', 'api_key', 'token', 'nsec', 'Authorization'])
    assert.equal(secretName(k), true, k);
  for (const k of ['inside', 'authority', 'port', 'identity', 'public_url', 'pubkey', 'node'])
    assert.equal(secretName(k), false, k);
  assert.equal(redact('password=hunter2 port=8470'), 'password=*** port=8470');
  assert.equal(redact('{"macaroon":"0201abcd","inside":"node","cookiePath":"/h/.cookie"}'), '{"macaroon":"***","inside":"node","cookiePath":"/h/.cookie"}');
  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz'), 'Authorization: *** ***');
  assert.equal(redact('GET http://bob:hunter2@127.0.0.1:1/v1/info'), 'GET http://bob:***@127.0.0.1:1/v1/info');
  assert.equal(redact('open http://127.0.0.1:7800/?t=abcDEF123'), 'open http://127.0.0.1:7800/?t=***');
  assert.equal(redact('cookie file says __cookie__:9f8e7d'), 'cookie file says __cookie__:***');
  assert.equal(redact(`macaroon ${SECRETS.macaroonHex}`), 'macaroon ***(192 hex)');
  assert.equal(redact(`the words: ${SECRETS.seed}.`), 'the words: ***(seed words).');
  assert.equal(redact('1. abandon 2. ability 3. able 4. about 5. above 6. absent 7. absorb 8. abstract 9. absurd 10. abuse 11. access 12. accident'), '1. ***(seed words)');
  assert.equal(redact('nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'), '***');
  // what must stay readable
  for (const keep of ['the macaroon file is at /x/admin.macaroon', 'node: asking http://127.0.0.1:8470/identity', `answers as ${'ab'.repeat(32)}`, 'tunnel answers as https://a-b.trycloudflare.com', 'seed words are written down'])
    assert.equal(redact(keep), keep);
  assert.equal(redactArgs(['lncli', '--macaroonpath', '/x/admin.macaroon', '--rpcpassword', 'pw1', '--password=pw2', 'unlock']), 'lncli --macaroonpath /x/admin.macaroon --rpcpassword *** --password=*** unlock');
  assert.deepEqual(redactObject({ a: { password: 'x', seedHex: 'ab', cookie: '/p/.cookie', port: 1 } }), { a: { password: '***', seedHex: '***', cookie: '/p/.cookie', port: 1 } });
});

test('the default output is as it was: bitcoinarena status and config print the same lines with no log, a quiet log and a verbose one, and nothing else', async () => {
  const n = node();
  try {
    const run = async (args, log) => { const out = [], err = []; const code = await main(args, { home: n.home, io: { out: (l) => out.push(l), err: (l) => err.push(l) }, deps: { sh: activeSh, fetcher: leakyFetch, platform: 'linux', env: n.env, dnsPauseMs: 1 }, ...(log ? { log } : {}) }); return { code, out, err }; };
    for (const args of [['status'], ['config'], ['config', 'get', 'roles'], ['logs', 'node', '5']]) {
      const plain = await run(args);
      const said = [];
      assert.deepEqual(await run(args, createLog({ level: 'info', write: (l) => said.push(l) })), plain, args.join(' '));
      assert.deepEqual(said, [], `${args.join(' ')}: nothing said at info`);
      assert.deepEqual(await run(args, createLog({ level: 'verbose', write: (l) => said.push(l) })), plain, `${args.join(' ')}: its output the same at --verbose`);
    }
    // the status table's lines today
    const s = await run(['status']);
    assert.ok(s.out.includes('    SERVICE                    STATE    PID     DETAIL'), s.out.join('\n'));
    assert.ok(s.out.some((l) => /^  ✗ Bitcoin Arena node \(seat\)  running  4242    /.test(l)), s.out.join('\n'));
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('the command itself: no flag prints what it always did and nothing on stderr; --verbose adds its lines on stderr only', async () => {
  const n = node();
  const env = { ...process.env, ...n.env }; delete env.ARENA_LOG_LEVEL;
  const run = (args) => new Promise((ok) => execFile(process.execPath, [BIN, '--home', n.home, ...args], { env, timeout: 60000 }, (e, out, err) => ok({ code: e ? e.code : 0, out, err })));
  try {
    for (const cmd of [['version'], ['config', 'get', 'network']]) {
      const plain = await run(cmd);
      assert.equal(plain.err, '', `${cmd.join(' ')}: nothing on stderr`);
      const v = await run([...cmd, '--verbose']);
      assert.equal(v.out, plain.out, `${cmd.join(' ')}: stdout the same at --verbose`);
      assert.match(v.err, /^\[bitcoinarena\] log level verbose \(--verbose\)$/m);
      const d = await run(['-v', ...cmd, '--debug']);
      assert.equal(d.out, plain.out);
      assert.match(d.err, /^\[bitcoinarena\] log level debug \(--debug\)$/m);
      assert.match(d.err, /ARENA_LATEST_URL \(not set\)/);
    }
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('--verbose says each step of bitcoinarena status: the files read, each service and what it was asked, with times', async () => {
  const n = node();
  try {
    const said = [];
    await main(['status'], { home: n.home, io: { out: () => {}, err: () => {} }, deps: { sh: activeSh, fetcher: leakyFetch, platform: 'linux', env: n.env, dnsPauseMs: 1 },
      log: createLog({ level: 'verbose', write: (l) => said.push(l) }) });
    const t = said.join('\n');
    assert.match(t, /^\[status\] home .*: arena\.conf \d+ setting\(s\), state\.json read/m);
    assert.match(t, /^\[status\] 6 service\(s\) installed: chain-bridge, tor, lnd, gateway, node, tunnel$/m);
    assert.match(t, /^\[status\] node: systemd unit arena-node\.service is running, pid 4242: active \(running\) \(\d+ ms\)$/m);
    assert.match(t, /^\[status\] node: asking http:\/\/127\.0\.0\.1:1\/identity$/m);
    assert.match(t, /^\[status\] node: NOT ok - \/identity answered 401 \(\d+ ms\)$/m);
    assert.match(t, /^\[status\] tor: is anything listening on its SOCKS port 127\.0\.0\.1:1\?$/m);
    assert.match(t, /^\[status\] gateway: asking http:\/\/bob:\*\*\*@127\.0\.0\.1:1\/ \(its password read from .*gw\.pw\)$/m);
    assert.doesNotMatch(t, /\[exec\]|stack:/, 'the insides only at --debug');
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('a --debug run with secrets in every input prints none of them: the node\'s files, failed answers\' bodies, child processes, an update', async () => {
  const n = node();
  const said = [];
  const log = createLog({ level: 'debug', write: (l) => said.push(l) });
  const realFetch = globalThis.fetch;
  globalThis.fetch = leakyFetch;
  const undo = traceRuntime(log);   // every request and child process of this test, traced as the command traces them
  try {
    // status and doctor, every request through the traced global fetch
    const deps = { sh: activeSh, fetcher: (...a) => globalThis.fetch(...a), platform: 'linux', env: n.env, dnsPauseMs: 1, esplora: 'http://127.0.0.1:1/api' };
    await main(['status'], { home: n.home, io: { out: () => {}, err: () => {} }, deps, log });
    await main(['doctor'], { home: n.home, io: { out: () => {}, err: () => {} }, deps: { ...deps, latest: async () => { throw new Error(`token=${SECRETS.token} refused`); } }, log });
    // a child process with a password on its command line and secrets on its stderr, failing
    await new Promise((ok) => execFile(process.execPath, ['-e', `process.stderr.write("password=${SECRETS.rpcPw}; the words ${SECRETS.seed}"); process.exit(3)`, '--', '--rpcpassword', SECRETS.rpcPw], () => ok()));
    try { execFileSync(process.execPath, ['-e', 'process.exit(4)', '--', `--password=${SECRETS.rpcPw}`], { stdio: 'pipe' }); } catch { /* exit 4 */ }
    // an update whose release list fails with a secret in its why
    await checkOnce({ home: n.home, latest: async () => ({ latest: null, why: `http://u:${SECRETS.gatewayPw}@x/latest.json answered 401` }), force: true, trace: log });
    const t = said.join('\n');
    assert.deepEqual(leaks(t), [], `secrets printed:\n${t}`);
    // and it did say the insides
    assert.match(t, /^\[fetch\] GET http:\/\/127\.0\.0\.1:1\/identity -> 401 in \d+ ms$/m);
    assert.match(t, /^\[fetch\] GET http:\/\/127\.0\.0\.1:1\/identity answered 401: \{"error":"bad macaroon \*\*\*\(192 hex\)","password":"\*\*\*","seed":"\*\*\*\(seed words\)"\}$/m);
    assert.match(t, /^\[exec\] .*node.* -e .* -- --rpcpassword \*\*\* -> exit 3 in \d+ ms; stderr: password=\*\*\*; the words \*\*\*\(seed words\)$/m);
    assert.match(t, /^\[exec\] .*node.* -e process\.exit\(4\) -- --password=\*\*\* -> exit 4 in \d+ ms$/m);
    assert.match(t, /^\[doctor\] the newest release: token=\*\*\* refused$/m);
    assert.match(t, /^\[doctor\] the newest release, stack:/m);
    assert.match(t, /^\[status\] the service files are looked for in .*, decided by: XDG_CONFIG_HOME \(set\), HOME \(set\), ARENA_INSTANCE \(not set\)$/m);
  } finally { undo(); globalThis.fetch = realFetch; rmSync(n.root, { recursive: true, force: true }); }
});

test('the node\'s services: arena.conf log_level set by `bitcoinarena config set`, checked, read at their start, and named above `bitcoinarena logs`', async () => {
  const n = node();
  try {
    const io = () => { const out = [], err = []; return { out, err, io: { out: (l) => out.push(l), err: (l) => err.push(l) } }; };
    const bad = io();
    assert.equal(await main(['config', 'set', 'log_level', 'loud'], { home: n.home, io: bad.io }), 2);
    assert.match(bad.err[0], /loud is no log level: info, verbose, debug/);
    const ok = io();
    assert.equal(await main(['config', 'set', 'log_level', 'debug'], { home: n.home, io: ok.io }), 0);
    assert.deepEqual(ok.out, ['log_level=debug', 'Takes effect at the next start: bitcoinarena restart node']);   // a setting this release lists
    assert.match(readFileSync(join(n.home, 'arena.conf'), 'utf8'), /^# how much the node's services log: .*\nlog_level=debug$/m);
    const logs = io();
    writeFileSync(join(n.home, 'node.log'), 'one\ntwo\n');
    await main(['logs', 'node'], { home: n.home, io: logs.io, deps: { platform: 'darwin', env: n.env } });
    assert.deepEqual(logs.out.slice(0, 2), [`--- ${join(n.home, 'node.log')}`, '--- log level debug (arena.conf log_level; it applies from the service\'s next start)']);
    // a service reads it at its start: its first line says the level, and ARENA_LOG_LEVEL is over the file
    const lines = [];
    const l = serviceLog({ home: n.home, env: {}, write: (x) => lines.push(x), trace: false });
    assert.equal(l.level, 'debug'); assert.deepEqual(lines, ['[log] log level debug (arena.conf log_level)']);
    lines.length = 0;
    assert.equal(serviceLog({ home: n.home, env: { ARENA_LOG_LEVEL: 'info' }, write: (x) => lines.push(x), trace: false }).level, 'info');
    assert.deepEqual(lines, [], 'at info a service says nothing more than today');
    // unset: back to today's output
    await main(['config', 'unset', 'log_level'], { home: n.home, io: io().io });
    const again = io();
    await main(['logs', 'node'], { home: n.home, io: again.io, deps: { platform: 'darwin', env: n.env } });
    assert.deepEqual(again.out, [`--- ${join(n.home, 'node.log')}`, 'one\ntwo\n'.split('\n').slice(-61).join('\n')]);
  } finally { rmSync(n.root, { recursive: true, force: true }); }
});

test('the installer\'s wizard at --verbose says each step and its time; at --debug the fields it was handed, by name only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'loglevel-wizard-'));
  const said = [];
  const wizard = createWizard({ state: nodeState(join(root, 'home')), release: root, trace: createLog({ level: 'debug', write: (l) => said.push(l) }) });
  const server = http.createServer((req, res) => wizard.handle(req, res));
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const first = await fetch(`${base}/?t=${wizard.token}`, { redirect: 'manual' });
    const cookie = String(first.headers.get('set-cookie')).split(';')[0];
    const r = await fetch(`${base}/api/seed/confirm`, { method: 'POST', headers: { cookie, 'x-arena-wizard': '1', 'content-type': 'application/json' },
      body: JSON.stringify({ words: SECRETS.seed.split(' '), nsec: 'nsec1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', password: SECRETS.rpcPw }) });
    assert.equal(r.status, 200);
    const t = said.join('\n');
    assert.match(t, /^\[wizard\] POST \/api\/seed\/confirm with field\(s\) words, nsec, password$/m);
    assert.match(t, /^\[wizard\] POST \/api\/seed\/confirm took \d+ ms$/m);
    assert.deepEqual(leaks(t), []);
    assert.doesNotMatch(t, /abandon|nsec1q/);
  } finally { server.close(); wizard.close(); rmSync(root, { recursive: true, force: true }); }
});

test('the quiet log says nothing and the help names both flags in plain words', async () => {
  QUIET.verbose('x'); QUIET.debug('y'); QUIET.fail('z', new Error('e'));
  const out = [];
  await main(['help'], { home: '/nowhere', io: { out: (l) => out.push(l), err: () => {} } });
  assert.match(out.join('\n'), /Add --verbose \(or -v\) to any of them/);
  assert.match(out.join('\n'), /Add --debug to see that and more/);
  assert.match(out.join('\n'), /config set log_level verbose \(or debug\), then bitcoinarena restart/);
});
