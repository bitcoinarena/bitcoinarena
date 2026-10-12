// THE SANDBOX UNDER STRACE (kanban #328, spec §0A.6): a core loaded and a run replayed, with each phase marked in the
// system-call trace by a stat of a path that does not exist (/__arena_mark_<phase>), so the trace can be cut by phase.
//
//   strace -f -tt -e trace=network,openat,open,newfstatat,statx -o trace.txt node tools/sandbox-strace.mjs [--ticks N]
//   node tools/sandbox-strace.mjs --read trace.txt
//
// The reading answers, per phase and per thread (the core's thread is the one that opened core-host.js): the sockets,
// connects and other network calls, and the files opened. The node reads the core's files in `files`; the core's thread
// must open none of them, and nothing at all may open a file or a socket from `loaded` to the end of the replay.
import { statSync, readFileSync } from 'node:fs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const mark = (phase) => { try { statSync(`/__arena_mark_${phase}`); } catch { /* the mark is the call */ } };

if (arg('--read')) {
  const lines = readFileSync(arg('--read'), 'utf8').split('\n').filter(Boolean);
  const main = Number(lines[0].split(/\s+/)[0]);
  let phase = 'start';
  let coreTid = null;
  const out = {};
  for (const l of lines) {
    const tid = Number(l.split(/\s+/)[0]);
    const m = l.match(/__arena_mark_(\w+)/);
    if (m) { phase = m[1]; continue; }
    const call = (l.match(/^\d+\s+[\d:.]+\s+(\w+)\(/) || [])[1];
    if (!call || /resumed|unfinished/.test(l) && !call) continue;
    if (/core-host\.js/.test(l) && call.startsWith('open')) coreTid = tid;
    const who = tid === main ? 'node' : tid === coreTid ? 'core' : 'other';
    const kind = /^(socket|connect|bind|listen|accept|accept4|sendto|recvfrom|sendmsg|recvmsg|getsockopt|setsockopt|socketpair|getsockname|getpeername|shutdown)$/.test(call) ? 'network'
      : /^open/.test(call) ? 'open' : null;
    if (!kind) continue;
    const k = `${phase}|${who}|${kind}`;
    (out[k] = out[k] || []).push(l.replace(/^\d+\s+[\d:.]+\s+/, '').slice(0, 140));
  }
  console.log(JSON.stringify({ mainTid: main, coreTid }));
  for (const [k, v] of Object.entries(out)) {
    console.log(`${k}: ${v.length}`);
    const files = v.filter((x) => /^open/.test(x)).map((x) => (x.match(/"([^"]+)"/) || [])[1]).filter(Boolean);
    const core = files.filter((f) => /nextblock\/(src|frozen)\//.test(f));
    if (core.length) console.log(`   core files: ${core.length} (${core.slice(0, 3).join(', ')}${core.length > 3 ? ', ...' : ''})`);
    if (/network|loaded|replay/.test(k)) for (const x of v.slice(0, 6)) console.log('   ' + x);
  }
  process.exit(0);
}

const ticks = Number(arg('--ticks', '10800'));
mark('import');
const { coreFiles, loadCore } = await import('../src/core-sandbox.js');
const { TRUCK } = await import('../../nextblock/plugin/truck-cores.js');
mark('files');
const files = coreFiles(TRUCK);
mark('load');
const s = loadCore(files, { name: 'truck' });
mark('loaded');
const words = Array.from({ length: ticks }, (_, t) => [45875, ((t * 977) % 30000) - 15000, (t % 700) < 40 ? 65536 : 0, 0, 0]);
mark('replay');
const r = s.call('replay', { seedWord: 4242, config: {}, runTicks: ticks, start: 0, words, events: { loads: [[0, 17314, 42]] }, marks: [], pictures: [ticks - 1] });
mark('replayed');
console.error(JSON.stringify({ ticks, outcome: r.outcome, score: r.score, stateHash: r.stateHash }));
mark('end');
s.end();
