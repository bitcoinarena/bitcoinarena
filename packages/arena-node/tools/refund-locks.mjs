// kanban #1044 hole 1 (regtest): refund Arena locks at their expiration with a FRESH lock client, from the secret a player wrote to its KEYS_FILE (#1123).
// Used when a player's own client went quiet while it waited (s47a try 1: no guardian connection, 0 % CPU for minutes after "refund go").
// env: INVITE_FILE WASM_PKG SECRET OUTPOINTS="<txid>:<i>,<txid>:<i>" [MINE_CMD] [LOG=<file to append the "refunded" line to>]
import { readFileSync, copyFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
const env = process.env;
const log = (o) => { const l = JSON.stringify({ at: new Date().toISOString(), by: "refund-locks.mjs (fresh client)", ...o }); console.log(l); if (env.LOG) appendFileSync(env.LOG, l + "\n"); };
const run = (bin, args) => new Promise((done) => execFile(bin, args, { timeout: 240000 }, () => done()));
const invite = readFileSync(env.INVITE_FILE, "utf8").replace(/["\s]/g, "");
const esm = join(tmpdir(), `blwp-lock-client-refund-${process.pid}.mjs`);
copyFileSync(`${env.WASM_PKG}/blwp_lock_client.js`, esm);
const wasmMod = await import(esm);
await wasmMod.default({ module_or_path: readFileSync(`${env.WASM_PKG}/blwp_lock_client_bg.wasm`) });
const { LockClient } = wasmMod;
const held = new Map();
const memStore = { entries: () => JSON.stringify([...held]), put: (k, v) => { held.set(k, v); }, remove: (k) => { held.delete(k); } };
const lc = await LockClient.join(invite, LockClient.federationIdOf(invite), randomBytes(32).toString("hex"), memStore);
log({ step: "joined" });
const refunds = [];
for (const op of env.OUTPOINTS.split(",")) {
  const [txid, i] = op.split(":");
  let st = JSON.parse(await lc.arenaLockStatus(txid, Number(i)));
  log({ step: "status", outpoint: op, status: st });
  for (const stop = Date.now() + 40 * 60000; ;) {
    const said = JSON.parse(await lc.arenaRedeem(txid, Number(i), JSON.stringify({ kind: "refund" }), env.SECRET));
    if (said.accepted === true || Date.now() > stop || !/expir|not yet|before/i.test(JSON.stringify(said))) {
      refunds.push({ outpoint: op, accepted: said.accepted === true, txid: said.txid, error: said.error || undefined, blockCount: said.block_count, expiration: said.expiration });
      break;
    }
    log({ step: "waiting for expiry", outpoint: op, said: JSON.stringify(said).slice(0, 200) });
    if (env.MINE_CMD) { const [bin, ...args] = env.MINE_CMD.split(" "); await run(bin, args); }
    await new Promise((ok) => setTimeout(ok, 10000));
  }
}
log({ step: "refunded", refunds, balanceMsat: await lc.balanceMsat() });
process.exit(refunds.length && refunds.every((x) => x.accepted) ? 0 : 1);
