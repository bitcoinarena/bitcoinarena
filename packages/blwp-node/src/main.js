// One process, one round.
//
//     node src/main.js [port] [database]
//
// The database defaults to a file so a round survives the process; pass
// `:memory:` for a node that forgets, which is what the tests use.
import { openStore } from './store.js';
import { serve } from './server.js';

const port = Number(process.argv[2] || 8080);
const path = process.argv[3] || 'round.db';
const node = await serve(openStore(path), { port });
console.log(`blwp-node on http://127.0.0.1:${node.port}  (${path})`);
