// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A THEFT'S EVIDENCE, EXPORTED AND VERIFIED BY THE STAKE-LOCK TOOL (kanban #1093 part 2, ruling #1109 X, the decoder of kanban #1108).
//
// The proof carries every signed session it stands on, as consensus bytes, and the federation's client config they verify against (theft-slash.js). Two tool modes do the Fedimint side,
// with the stock client crates and no fork:
//   --mode session-export --data-dir D --from N --to M --out F   writes F, one JSON object { mode: 'session-export', federation, config (hex, the client config's consensus bytes),
//                                                                firstSession, sessions: [hex, each SignedSessionOutcome's consensus bytes, verified as session-audit verifies it] }
//   --mode theft-verify  (stdin: theft-slash.js theftVerifyInput)   answers the line THE SESSION VERIFIER names in theft-slash.js; reads no guardian and needs no client directory
// A tool without a mode answers no such line: a theft's proof is then not built (null) and not judged (undefined), never false.
import { spawn as spawnDefault } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fromHex } from '../../arena-protocol/src/hash.js';
import { THEFT_VERIFY_MODE } from '../../arena-protocol/src/theft-slash.js';

/** The last JSON line a tool printed, or null. */
const lastJson = (out) => { for (const l of String(out).trim().split('\n').reverse()) { if (!l.startsWith('{')) continue; try { return JSON.parse(l); } catch { return null; } } return null; };

/**
 * `bin` the stake-lock tool (ARENA_STAKE_LOCK_BIN) or null; `dirOf(fid hex)` the client directory of a federation this seat audits, or null; `spawn` child_process.spawn's shape.
 * Answers { theftEvidenceOf(fid, alarm), verifySessions(input) } for federation-records.js.
 */
export function theftTools({ bin, dirOf = () => null, spawn = spawnDefault, log = () => {}, timeoutMs = 900000 }) {
  const said = new Set();
  const once = (k, line) => { if (!said.has(k)) { said.add(k); log(line); } };
  const runTool = (args, stdin = null) => new Promise((done) => {
    let out = '', err = '';
    let child; try { child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { done({ error: e.message }); return; }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.on('error', (e) => { clearTimeout(timer); done({ error: e.message }); });
    child.on('close', () => { clearTimeout(timer); done(lastJson(out) || { error: String(err).trim().slice(-400) || 'no answer' }); });
    if (stdin !== null) child.stdin.end(stdin); else child.stdin.end();
  });

  /** The tool's word on a proof's sessions: its `theft-verify` line, or undefined where no tool or no such mode runs here. */
  async function verifySessions(input) {
    if (!bin) return undefined;
    const got = await runTool(['--mode', THEFT_VERIFY_MODE], JSON.stringify(input));
    if (!got || got.mode !== THEFT_VERIFY_MODE) { once('verify', `[theft] the stake-lock tool verifies no theft proof here: ${(got && got.error) || 'no theft-verify line'}`); return undefined; }
    return got;
  }

  /**
   * A theft's evidence for its proof: inflation, every signed session from 0 to the alarm's session, exported from this seat's client of that federation. An unbacked spend needs the reserve
   * outpoint's creating session and the spend from the spend watch (reserve-spend-watch.js), which no seat runs yet: null, said once.
   */
  async function theftEvidenceOf(fid, alarm) {
    if (!alarm) return null;
    if (alarm.kind !== 'inflation') { once(`unbacked:${fid}`, `[theft] ${String(fid).slice(0, 16)}: an unbacked spend's proof needs the spend watch's outpoint and spend, not wired on a seat yet`); return null; }
    const dir = dirOf(fid);
    if (!bin || !dir) { once(`dir:${fid}`, `[theft] ${String(fid).slice(0, 16)}: no client of that federation to export its sessions from`); return null; }
    const file = join(dir, `theft-sessions-${alarm.session}.json`);
    const got = await runTool(['--mode', 'session-export', '--data-dir', dir, '--from', '0', '--to', String(alarm.session), '--out', file]);
    let ex = null;
    try { ex = JSON.parse(readFileSync(file, 'utf8')); } catch { ex = null; } finally { try { unlinkSync(file); } catch { /* none written */ } }
    if (!ex || ex.mode !== 'session-export' || !Array.isArray(ex.sessions) || ex.firstSession !== 0 || ex.sessions.length !== alarm.session + 1) {
      once(`export:${fid}`, `[theft] ${String(fid).slice(0, 16)}: the sessions were not exported: ${(got && got.error) || 'no session-export file'}`);
      return null;
    }
    return { mark: { kind: 'inflation', height: alarm.height, session: alarm.session }, config: fromHex(ex.config), firstSession: 0, sessions: ex.sessions.map((s) => fromHex(s)) };
  }
  return { theftEvidenceOf, verifySessions };
}
