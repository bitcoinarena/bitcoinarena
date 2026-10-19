// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CHART'S OBJECTIVE WORDS, AS THE CORE WRITES THEM: chartView's GROUND view on the core this tree builds, for
// the EditMode check ChartHudObjectivesTests - the C# draws its markers from exactly these words, never from numbers typed
// into a test. Three windows: HIGH, LOW and OPEN on three candles; a window wholly above the open (OPEN absent); and one
// candle that is both the window's HIGH and its LOW (§4.11: "one marker, HIGH/LOW").
//
//     node packages/nextblock/tools/chart-objectives-fixture.mjs      -> packages/nextblock/test/fixtures/chart-objectives.json
import { writeFileSync } from 'node:fs';
import { init, submitSample, submitTape } from '../src/sim.js';
import * as L from '../src/state.js';
import * as T from '../src/rules/tactics.js';
import * as C from '../src/chart.js';
import { SAMPLES } from '../src/rules/frontline.js';
import { coreHashHex } from './hash-core.js';

const view = (st) => { const out = new Int32Array(C.CH_WORDS); C.chartView(st, C.CHART_GROUND, out); return Array.from(out); };
const words = (st) => [0, 1, 2].map((o) => ({ lane: T.objectiveLane(st.i32, L.O_TACTICS, o), candle: T.objectiveCandle(st.i32, L.O_TACTICS, o) }));
const need = (ok, why) => { if (!ok) throw new Error('fixture: ' + why); };

// 1. three candles: seed 1, twelve samples of a walk around the open
const a = init(1), openA = a.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN], bpA = Math.max(1, Math.floor(openA / 10000));
for (let k = 1, p = openA; k <= 12; k++) { p += ((k * 7) % 17 - 8) * bpA; submitSample(a, p); }
const wa = words(a);
need(wa.every((w) => w.lane !== T.OBJ_ABSENT) && new Set(wa.map((w) => w.candle)).size === 3, 'case 1 is not three objectives on three candles');

// 2. OPEN absent: seventy samples, the whole window above the open
const b = init(1), openB = b.i32[L.O_TACTICS + T.TAC_MARKET + T.MK_OPEN], bpB = Math.max(1, Math.floor(openB / 10000));
for (let k = 1; k <= 70; k++) submitSample(b, openB + (200 + k) * bpB);
need(T.objectiveLane(b.i32, L.O_TACTICS, T.OBJ_OPEN) === T.OBJ_ABSENT, 'case 2 has an OPEN');

// 3. one candle both HIGH and LOW: a live tape before any sample, level but for one candle that spikes up and down
const c = init(1), lvl = c.tape[SAMPLES - 1], bpC = Math.max(1, Math.floor(lvl / 10000));
const tape = Array.from({ length: SAMPLES }, (_, i) => lvl + ((i % 3) - 1) * bpC);
tape[32] = lvl + 400 * bpC; tape[33] = lvl - 400 * bpC;          // samples 2k and 2k + 1 of one candle
need(submitTape(c, tape), 'case 3: the tape was refused');
const wc = words(c);
need(wc[T.OBJ_HIGH].candle === wc[T.OBJ_LOW].candle && wc[T.OBJ_HIGH].lane !== T.OBJ_ABSENT, 'case 3: HIGH and LOW are not one candle');

const out = { core: coreHashHex(), CH_WORDS: C.CH_WORDS,
  cases: { threeCandles: { view: view(a), objectives: wa }, openAbsent: { view: view(b), objectives: words(b) },
    highLowOneCandle: { view: view(c), objectives: wc } } };
writeFileSync(new URL('../test/fixtures/chart-objectives.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(`core ${out.core.slice(0, 8)}: threeCandles ${JSON.stringify(wa)}; openAbsent ${JSON.stringify(words(b))}; highLowOneCandle ${JSON.stringify(wc)}`);
