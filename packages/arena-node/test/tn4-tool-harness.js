// RUN A TESTNET4 TOOL OFF THE CHAIN (kanban #148): the tool as a child process, its bitcoin-cli the fake one
// (fake-bitcoin-cli.mjs, every call logged and scripted), its signer node a local server answering `routes`, its out dir a
// temp dir. Answers the exit code, both streams, every cli call and the files the tool wrote.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FAKE_CLI = new URL('./fake-bitcoin-cli.mjs', import.meta.url).pathname;

export async function runTool(tool, { spec, routes = {}, args = (url, dir) => [url, dir], env = {} }) {
  const dir = mkdtempSync(join(tmpdir(), 'tn4-tool-'));
  writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
  const srv = createServer(async (req, res) => {
    const r = routes[req.url];
    if (!r) { res.writeHead(404); return res.end('no such door'); }
    const body = typeof r === 'function' ? await r(req) : r;
    res.writeHead(200); res.end(typeof body === 'string' || body instanceof Uint8Array ? Buffer.from(body) : JSON.stringify(body));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const full = { ...process.env, ARENA_BITCOIN_CLI: FAKE_CLI, BITCOIN_CLI: FAKE_CLI, ARENA_TN4_DATADIR: '/nonexistent', ARENA_TN4_WALLET: 'test',
    FAKE_CLI_SPEC: join(dir, 'spec.json'), FAKE_CLI_LOG: join(dir, 'calls.jsonl'), ...env };
  const got = await new Promise((done) => execFile(process.execPath, [tool, ...args(url, dir)], { env: full, timeout: 90000 },
    (err, stdout, stderr) => done({ code: err ? err.code || 1 : 0, stdout, stderr })));
  await new Promise((r) => srv.close(r));
  const calls = existsSync(join(dir, 'calls.jsonl')) ? readFileSync(join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const files = Object.fromEntries(readdirSync(dir).filter((f) => !['spec.json', 'calls.jsonl'].includes(f)).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  return { ...got, calls, methods: calls.map((c) => c.method), files, dir, url };
}
