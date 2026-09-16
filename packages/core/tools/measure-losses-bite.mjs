// WAR_TACTICS.md §0.1 "Losses bite" breakdown: supply, living tanks, tank deaths and spawns for the side holding more
// objectives vs less, and how long the objectives have been uneven.   node tools/measure-losses-bite.mjs
const C = new URL('../src/', import.meta.url).pathname;
const { init, step } = await import(C + 'sim.js');
const L = await import(C + 'state.js');
const T = await import(C + 'rules/tactics.js');
const ONE = 65536; const base = (i) => L.O_UNITS + i * L.U_WORDS; const sideOf = (i) => (((i >> 2) & 1) === 0 ? -1 : 1);
const r = { more: { ticks: 0, tanks: 0, deaths: 0, spawns: 0, supply: 0 }, less: { ticks: 0, tanks: 0, deaths: 0, spawns: 0, supply: 0 } };
let lagSum = 0, lagN = 0; const hist = {};
for (const seed of [1, 2, 3, 4, 5]) {
  const st = init(seed), s = st.i32; let unevenSince = null, unevenSide = null;
  for (let t = 0; t < 3600; t++) {
    const aliveB = Array.from({ length: 96 }, (_, i) => s[base(i) + L.U_STATE] !== 0);
    step(st, 0, 0, 0, ONE, 0);
    const held = { '-1': 0, '1': 0 };
    for (let o = 0; o < 3; o++) { const h = T.objectiveHolder(s, L.O_TACTICS, o); if (h === T.HOLDER_BULL) held['-1']++; else if (h === T.HOLDER_BEAR) held['1']++; }
    if (held['-1'] === held['1']) { unevenSince = null; continue; }
    const more = held['-1'] > held['1'] ? -1 : 1;
    if (unevenSide !== more || unevenSince === null) { unevenSince = t; unevenSide = more; }
    const age = t - unevenSince; const k = age < 600 ? '<10s' : age < 1800 ? '10-30s' : '>30s';
    for (const [who, sd] of [['more', more], ['less', -more]]) {
      const x = r[who]; x.ticks++; x.supply += T.supplyOf(s, L.O_TACTICS, sd);
      for (let i = 0; i < 96; i += 4) if (sideOf(i) === sd) { if (s[base(i) + L.U_STATE]) x.tanks++; if (aliveB[i] && !s[base(i) + L.U_STATE]) x.deaths++; if (!aliveB[i] && s[base(i) + L.U_STATE]) x.spawns++; }
    }
    const tm = [-1, 1].map((sd) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].filter((kk) => s[base((kk << 3) | (sd < 0 ? 0 : 4)) + L.U_STATE]).length);
    const moreT = more < 0 ? tm[0] : tm[1], lessT = more < 0 ? tm[1] : tm[0];
    hist[k] ||= [0, 0]; hist[k][0]++; if (moreT > lessT) hist[k][1]++;
  }
}
const m = (x, f) => (x[f] / x.ticks).toFixed(2), per60 = (x, f) => (x[f] / x.ticks * 3600).toFixed(1);
for (const who of ['more', 'less']) console.log(`holding ${who}: mean supply ${m(r[who], 'supply')}, mean living tanks ${m(r[who], 'tanks')}, tank deaths per 60 s ${per60(r[who], 'deaths')}, tank spawns per 60 s ${per60(r[who], 'spawns')}`);
for (const [k, v] of Object.entries(hist)) console.log(`  uneven for ${k}: holder has more tanks on ${(100 * v[1] / v[0]).toFixed(1)}% of ${v[0]} ticks`);
