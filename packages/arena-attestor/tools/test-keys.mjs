#!/usr/bin/env node
// THE TEST UP/DOWN MARKET'S ATTESTOR KEYS AS FILES (kanban #236): A.pkcs8, B.pkcs8, C.pkcs8 (mode 600) and attestors.txt (the
// market's attestor keys, hex, comma-separated) in <dir>, for the three daemon units. Test keys: regtest only.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { UPDOWN, UPDOWN_ATTESTOR_KEYS } from '../../arena-node/test/plugins/updown/index.js';
const dir = process.argv[2];
if (!dir) { console.error('node test-keys.mjs <dir>'); process.exit(2); }
mkdirSync(dir, { recursive: true });
for (const [letter, k] of Object.entries(UPDOWN_ATTESTOR_KEYS)) writeFileSync(join(dir, `${letter}.pkcs8`), k.key.export({ type: 'pkcs8', format: 'der' }), { mode: 0o600 });
writeFileSync(join(dir, 'attestors.txt'), UPDOWN.attestors.map((a) => Buffer.from(a.pubkey).toString('hex')).join(','));
console.log(JSON.stringify({ dir, game: Buffer.from(UPDOWN.registration.gameId).toString('hex'), attestors: Object.fromEntries(Object.entries(UPDOWN_ATTESTOR_KEYS).map(([l, k]) => [l, Buffer.from(k.pubkey).toString('hex').slice(0, 16)])) }));
