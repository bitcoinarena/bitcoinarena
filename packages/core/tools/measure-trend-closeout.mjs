// WAR_TACTICS.md §4.14 close-out: trend cadence (10 s, 60 s window, ramps), an assault running out when the trend turns,
// supply under a trend. Prints what the core holds.   node tools/measure-trend-closeout.mjs
const C = new URL('../src/', import.meta.url).pathname;
const { init, step, submitSample } = await import(C + 'sim.js');
const L = await import(C + 'state.js');
const T = await import(C + 'rules/tactics.js');
const ONE = 65536; const M = (s, k) => s[L.O_TACTICS + T.TAC_MARKET + k];
// 1. CADENCE: a sample every 300 ticks; 12 green-candle samples, then red ones. Print the trend word after each sample.
{
  const st = init(1), s = st.i32, open = st.tape[63], bp = Math.floor(open / 10000); let p = open; const row = [];
  let changesOnOdd = 0, lastWord = null, stepsBig = 0;
  for (let k = 1; k <= 30; k++) {
    for (let t = 0; t < 300; t++) step(st, 0, 0, 0, ONE, 0);
    // candles are (odd sample, even sample): green = the even sample 5 bp above the odd one; from sample 13 red
    if (k % 2 === 0) p += (k <= 12 ? 5 : -5) * bp;
    submitSample(st, p);
    const w = M(s, T.MK_TREND) * M(s, T.MK_STRENGTH);
    if (lastWord !== null && w !== lastWord) { if (k % 2 === 1) changesOnOdd++; if (Math.abs(w - lastWord) > 1) stepsBig++; }
    lastWord = w; row.push(`${k}:${w > 0 ? '+' : ''}${w}`);
  }
  console.log(`CADENCE  trend (signed strength) after sample k, one sample per 300 ticks:\n  ${row.join(' ')}`);
  console.log(`  changes on a sample that closes no candle (odd k): ${changesOnOdd}; changes of more than one strength step at once: ${stepsBig}`);
}
// 2. A RUNNING ASSAULT RUNS OUT WHEN THE TREND TURNS: seeds 1-10, run until a bull assault is pushing, then turn the trend
//    DOWN 3 in one go (12 red samples 5 ticks apart). The assault must keep running (PUSH) until its 1800 ticks or a flip;
//    no bull assault may start while DOWN holds.
{
  let ranOut = 0, cancelled = 0, newStarts = 0, tried = 0;
  for (let seed = 1; seed <= 10; seed++) {
    const st = init(seed), s = st.i32, bp = Math.floor(st.tape[63] / 10000); let p = st.tape[63];
    let t = 0; while (t < 10800 && T.assaultPhase(s, L.O_TACTICS, -1) !== T.ASSAULT_PUSH) { step(st, 0, 0, 0, ONE, 0); t++; }
    if (t >= 10800) continue;
    tried++;
    const start = s[L.O_TACTICS + T.TAC_ASSAULT + 1];
    for (let k = 0; k < 12; k++) { p -= 5 * bp; submitSample(st, p); }
    const down = M(s, T.MK_TREND) === -1 && M(s, T.MK_STRENGTH) === 3;
    let endedAt = -1, endPhase = -1, starts = 0, was = T.ASSAULT_PUSH;
    for (let u = 0; u < 3600; u++) {
      step(st, 0, 0, 0, ONE, 0);
      const ph = T.assaultPhase(s, L.O_TACTICS, -1), tick = s[L.O_TICK];
      if (endedAt < 0 && ph !== T.ASSAULT_PUSH) { endedAt = tick; endPhase = ph; }
      if (ph === T.ASSAULT_PUSH && was !== T.ASSAULT_PUSH) starts++;
      was = ph;
    }
    const ranFor = endedAt - start;
    if (down && (endPhase === T.ASSAULT_CONSOLIDATE || ranFor >= 1800)) ranOut++; else cancelled++;
    newStarts += starts;
  }
  console.log(`RUNDOWN  bull assaults turned against (DOWN 3) mid-push: ${tried}; ran out (30 s or took the objective): ${ranOut}; cut short: ${cancelled}; new bull assaults started in the next 60 s under DOWN 3: ${newStarts}`);
}
// 3. SUPPLY under a trend: mean supply per side from tick 1200 in the up and down probes (seeds 1-5).
for (const kind of ['up', 'down']) {
  const sum = { '-1': 0, '1': 0 }; let n = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const st = init(seed), s = st.i32, open = st.tape[63]; let price = open;
    for (let t = 0; t < 3600; t++) {
      if (t >= 600 && t < 1200 && (t - 600) % 50 === 0) { price += (kind === 'up' ? 1 : -1) * Math.round(open * 0.005 / 12); submitSample(st, price); }
      step(st, 0, 0, 0, ONE, 0);
      if (t >= 1200) { sum['-1'] += T.supplyOf(s, L.O_TACTICS, -1); sum['1'] += T.supplyOf(s, L.O_TACTICS, 1); n++; }
    }
  }
  const wait = (x) => (4 / (4 + x)).toFixed(2);
  console.log(`SUPPLY   ${kind.toUpperCase()}: mean supply bull ${(sum['-1'] / n).toFixed(2)} (wait x${wait(sum['-1'] / n)}), bear ${(sum['1'] / n).toFixed(2)} (wait x${wait(sum['1'] / n)})`);
}
