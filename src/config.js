// Central tunables. Everything gameplay-ish that a designer would want to poke
// lives here so the rest of the modules stay about behaviour, not numbers.

export const WORLD = {
  // X = time (past -> left, now -> right). Z = territory (bull = -Z, bear = +Z).
  width: 260,          // along X
  depth: 170,          // along Z
  columns: 160,        // terrain segments along X == price history samples
  rows: 96,            // terrain segments along Z
  halfZ: 62,           // frontline can swing this far either way
  plazaX: -118,        // sorting plaza sits off the "past" end
  depotX: 118,         // block depot / blockchain gate at the "now" end
};

export const HISTORY = {
  sampleMs: 220,       // one price sample per terrain column
  windowPad: 0.18,     // padding on the auto price window
};

export const LANES = {
  bull:  { id: 'bull',  name: 'Bull Flank',   z: -46, risk: 0.18, mult: 1.0, speed: 1.0,  desc: 'Long way round through green-held ground. Slow, safe, boring.' },
  front: { id: 'front', name: 'The Frontline', z: null, risk: 1.0,  mult: 2.6, speed: 1.18, desc: 'Straight up the contested trench. Double score, gets you shot at.' },
  bear:  { id: 'bear',  name: 'Bear Flank',   z: 46,  risk: 0.55, mult: 1.5, speed: 1.08, desc: 'Behind red lines. Faster than the bull road, ambush-prone.' },
};

export const TRUCKS = [
  { id: 'vanguard', name: 'Vanguard Van',      capacity: 2600,  speed: 15, armor: 1.0, cost: 0,      desc: 'Standard issue. Smells faintly of diesel and despair.' },
  { id: 'hauler',   name: 'Blockspace Hauler', capacity: 6200,  speed: 13, armor: 1.6, cost: 250000,  desc: 'More vbytes, more armour, corners like a fridge.' },
  { id: 'express',  name: 'Lightning Express', capacity: 3400,  speed: 27, armor: 0.9, cost: 600000,  desc: 'Off-chain speed, on-chain settlement. Do not blink.' },
  { id: 'fortress', name: 'Fortress Convoy',   capacity: 11000, speed: 11, armor: 3.0, cost: 1500000, desc: 'Survives liquidation airstrikes. Mostly.' },
];

export const SIM = {
  blockMeanSec: 600,   // simulated block interval (exponential)
  startPrice: 63000,
};

export const FEE = {
  // Tiers are RELATIVE to what the next block is actually paying, which is how
  // fee markets really work — 5 sat/vB is luxury in a quiet mempool and garbage
  // during an ordinal frenzy. `min` is a multiple of the next-block median.
  tiers: [
    { min: 0,    name: 'Stuck',    color: 0x44607a, glow: 0.03 },
    { min: 0.45, name: 'Economy',  color: 0x6f95b4, glow: 0.12 },
    { min: 0.95, name: 'Standard', color: 0xd8c98f, glow: 0.28 },
    { min: 1.8,  name: 'Priority', color: 0xffb648, glow: 0.62 },
    { min: 3.5,  name: 'Express',  color: 0xffd447, glow: 1.1  },
    { min: 8,    name: 'VIP',      color: 0xfff3b0, glow: 1.7  },
  ],
  whaleBtc: 50,        // >= this many BTC -> whale package
};

export const SCORE = {
  handling: 120,       // flat points per package delivered
  valueWeight: 40,     // × log10(1 + USD value) — whales matter, but don't erase everything else
  feeWeight: 0.35,     // × fee paid in sats
  feeBonus: 0.9,       // weight of the fee-RATE multiplier
  blockWindowSec: 25,  // ×3 scoring window after a block is found
  windowMult: 3,
  fullBlockBonus: 1.25,// truck packed >90% — what a miner would do
  rescueBonus: 2500,   // delivering a long-stuck low-fee package
  rescueAgeSec: 180,
};

export const COSTS = {
  boost: 5000,         // sats
  repair: 25000,
  rbfMin: 2500,
  rbfPerVbyte: 40,
};

export const CAMERAS = ['cinematic', 'god', 'follow', 'plaza', 'driver', 'free'];

export const ENDPOINTS = {
  binanceSpot: 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade/btcusdt@ticker/btcusdt@depth20@100ms',
  binanceFutures: 'wss://fstream.binance.com/stream?streams=!forceOrder@arr',
  mempoolWs: 'wss://mempool.space/api/v1/ws',
  mempoolApi: 'https://mempool.space/api',
};
