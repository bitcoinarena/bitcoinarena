// AN EXISTING NODE UPDATED IN PLACE (kanban #471 part E, F.1): a node installed from one release is updated to another - settings,
// database, key and owner kept, the same node answering after - and to a broken one, which is rolled back by itself to the old
// release and its backup. systemd is played by a fake `systemctl` that starts the seat from the unit file's own command line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateNode, releaseOfUnit, inSeatingWindow, backupNode } from '../src/update.js';
import { seatUnit, unitDir, UNIT, waitHealthy } from '../src/service.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../../../..');
const freePort = () => new Promise((ok) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

/** A release tree from the repo at HEAD (what build-linux.sh archives), its npm dependencies linked. */
function releaseFrom(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('sh', ['-c', `git -C "${REPO}" archive HEAD packages/arena-node/src packages/arena-node/pages packages/arena-node/package.json packages/arena-protocol packages/arena-client/src packages/nextblock | tar -x -C "${dir}"`]);
  symlinkSync(join(REPO, 'packages/arena-node/node_modules'), join(dir, 'packages/arena-node/node_modules'));
  return dir;
}

/** systemctl --user, played: start runs the unit's ExecStart in its WorkingDirectory with its EnvironmentFile; stop kills it. */
function fakeSystemd(env) {
  const running = new Map();
  const unitFile = (u) => readFileSync(join(unitDir(env), u), 'utf8');
  const sh = async (cmd, args) => {
    if (cmd !== 'systemctl') return { ok: true, out: '', err: '' };
    const [, verb, ...units] = args;
    for (const u of units) {
      if (verb === 'stop' && running.has(u)) {
        const c = running.get(u); running.delete(u);
        if (c.exitCode === null && c.signalCode === null) { const gone = new Promise((ok) => c.once('exit', ok)); c.kill('SIGTERM'); await gone; }
      }
      if (verb === 'start') {
        const text = unitFile(u);
        const exec = /ExecStart=(.*)/.exec(text)[1].split(' ');
        const cwd = /WorkingDirectory=(.*)/.exec(text)[1];
        const envFile = /EnvironmentFile=(.*)/.exec(text)[1];
        const e = { PATH: process.env.PATH };
        for (const l of readFileSync(envFile, 'utf8').split('\n')) { const m = /^([A-Z0-9_]+)=(.*)$/.exec(l); if (m) e[m[1]] = m[2]; }
        const c = spawn(exec[0], exec.slice(1), { cwd, env: e, stdio: 'ignore' });
        running.set(u, c);
      }
    }
    return { ok: true, out: '', err: '' };
  };
  return { sh, stopAll: () => { for (const c of running.values()) c.kill('SIGKILL'); } };
}

test('an update keeps the node, its settings and data; a broken release is rolled back by itself', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'arena-update-'));
  const env = { XDG_CONFIG_HOME: join(root, 'config'), USER: 'test' };
  const home = join(root, 'home'); mkdirSync(home, { recursive: true });
  const port = await freePort();
  const sys = fakeSystemd(env);
  t.after(() => { sys.stopAll(); rmSync(root, { recursive: true, force: true }); });
  const v1 = releaseFrom(join(root, 'releases/0.1.0'));
  const v2 = releaseFrom(join(root, 'releases/0.1.1'));
  const broken = releaseFrom(join(root, 'releases/0.1.2-broken'));
  writeFileSync(join(broken, 'packages/arena-node/src/main.js'), "throw new Error('this release does not start');\n");

  // the node as the installer leaves it: settings, state, an owner, its unit on release 0.1.0, running
  const settings = `ARENA_BIND=127.0.0.1\nARENA_DONATION_NETWORK=testnet4\nARENA_GAMES=${join(v1, 'packages/nextblock/plugin/nextblock.js')}\nARENA_ROLES=verify\n`;
  writeFileSync(join(home, 'node.env'), settings);
  writeFileSync(join(home, 'state.json'), JSON.stringify({ network: 'testnet4', roles: ['verify'], done: { service: 1 } }));
  writeFileSync(join(home, 'node.db.owner.json'), JSON.stringify({ pubkey: 'ab'.repeat(32), claimedAtMs: 1 }) + '\n');
  mkdirSync(unitDir(env), { recursive: true });
  writeFileSync(join(unitDir(env), UNIT), seatUnit({ node: process.execPath, release: v1, home, port }));
  await sys.sh('systemctl', ['--user', 'start', UNIT]);
  const first = await waitHealthy({ port, waitMs: 60000, everyMs: 300 });
  assert.equal(first.ok, true, first.why);
  assert.equal(releaseOfUnit(readFileSync(join(unitDir(env), UNIT), 'utf8')), v1);

  // to 0.1.1: the same node, the same settings file, its database and owner kept, a backup taken
  const up = await updateNode({ home, newRelease: v2, port, env, sh: sys.sh, nowMs: () => 0 });
  assert.equal(up.ok, true, up.why);
  assert.deepEqual([up.from, up.to, up.identity], [v1, v2, first.identity], 'the same node answers from the new release');
  assert.equal(readFileSync(join(home, 'node.env'), 'utf8'), settings, 'the settings untouched');
  assert.equal(JSON.parse(readFileSync(join(home, 'node.db.owner.json'), 'utf8')).pubkey, 'ab'.repeat(32), 'the owner kept');
  assert.ok(existsSync(join(up.backup, 'node.db')) && existsSync(join(up.backup, 'node.env')), 'the backup holds the database and settings');
  assert.equal(releaseOfUnit(readFileSync(join(unitDir(env), UNIT), 'utf8')), v2);
  assert.equal(JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')).release.path, v2);

  // to a release that does not start: rolled back to 0.1.1 by itself, and said why
  const bad = await updateNode({ home, newRelease: broken, port, env, sh: sys.sh, nowMs: () => 0, waitMs: 8000 });
  assert.deepEqual([bad.ok, bad.rolledBack, bad.restored], [false, true, true]);
  assert.match(bad.why, /did not come up/);
  assert.equal(releaseOfUnit(readFileSync(join(unitDir(env), UNIT), 'utf8')), v2, 'the unit names the old release again');
  const after = await waitHealthy({ port, waitMs: 30000, everyMs: 300 });
  assert.deepEqual([after.ok, after.identity], [true, first.identity], 'and the same node answers from it');

  assert.equal((await updateNode({ home, newRelease: v2, port, env, sh: sys.sh })).why, 'that release is the one running');
  assert.match((await updateNode({ home: join(root, 'nothing'), newRelease: v1, port, env, sh: sys.sh })).why, /no node is installed/);
});

test('updates wait out a market seating window; a backup copies only the node\'s files', () => {
  assert.equal(inSeatingWindow(Date.parse('2026-10-18T07:11:30Z')), true, 'minute 11 of the quarter');
  assert.equal(inSeatingWindow(Date.parse('2026-10-18T07:14:00Z')), false, 'minute 14 (840 s) is out');
  assert.equal(inSeatingWindow(Date.parse('2026-10-18T07:05:00Z')), false);
  const home = mkdtempSync(join(tmpdir(), 'arena-backup-'));
  try {
    writeFileSync(join(home, 'node.env'), 'A=1\n'); writeFileSync(join(home, 'other.txt'), 'x');
    const b = backupNode(home, 'stamp');
    assert.deepEqual(b.files, ['node.env']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
