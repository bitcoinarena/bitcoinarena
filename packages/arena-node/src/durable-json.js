// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SMALL JSON FILE BESIDE THE DATABASE THAT A CRASH CANNOT TEAR (kanban #1630, the state audit 2026-11-12): the owner binding
// (<db>.owner.json), the operator UI's tokens (<db>.operator-tokens.json) and the retire consents (<db>.retire.json) were written
// with a plain writeFileSync - truncate, then write - so a node killed (SIGKILL, an update's stop timing out) or a machine losing
// power between the two left the file empty, and the next start read "unreadable" exactly as "absent": a claimed, leaving node came
// back unclaimed with a new claim code. Now, as the installer's state.json (#1178):
//   - every write is a temp file of its own + fsync + rename (+ the folder fsync'd), the same bytes first to <file>.bak the same way;
//   - a read tells "no file" (ENOENT: absent, as before - a rename never leaves it missing, so only a hand removes it) from "a file
//     that does not parse": the latter is read from <file>.bak, and with no good .bak it THROWS (DurableJsonUnreadable) - nothing
//     starts fresh over a file that exists. A file written by an older build or the installer (no .bak) reads as it did.
import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

/** Write `text` to `path` so that no reader ever sees half of it. */
export function atomicWriteText(path, text, { mode = 0o600 } = {}) {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const fd = openSync(tmp, 'w', mode);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
  if (process.platform !== 'win32') { try { const d = openSync(dirname(path), 'r'); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* the rename stands */ } }
}

/** Write `value` as JSON to `path`, its copy `<path>.bak` first (a crash between the two leaves `path` at the value before). */
export function writeDurableJson(path, value, { mode = 0o600 } = {}) {
  const text = JSON.stringify(value) + '\n';
  atomicWriteText(`${path}.bak`, text, { mode });
  atomicWriteText(path, text, { mode });
}

export class DurableJsonUnreadable extends Error {
  constructor(path, why) {
    super(`${path} does not read (${why}) and ${path}.bak is no good copy: the node does not start fresh over it. Put back a good ${path}`);
    this.code = 'DURABLE_JSON_UNREADABLE';
  }
}

/** The value at `path`; `absent` when it does not exist; its .bak's when it does not parse; else throws. */
export function readDurableJson(path, absent = null) {
  let why;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return absent; why = e.message; }
  try { return JSON.parse(readFileSync(`${path}.bak`, 'utf8')); } catch { /* no good copy */ }
  throw new DurableJsonUnreadable(path, why);
}
