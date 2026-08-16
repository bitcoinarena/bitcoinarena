import { Game } from './game.js';

const canvas = document.getElementById('view');
const game = new Game(canvas);
window.game = game;   // handy for poking at it in the console

// ---- boot screen ------------------------------------------------------------
const bootStatus = () => {
  const m = game.market.status(), p = game.mempool.status();
  game.ui.bootStatus(
    `market: ${m.mode}${m.live ? '' : ' (simulated — Binance unreachable)'}  ·  ` +
    `mempool: ${p.mode}${p.live ? '' : ' (simulated)'}  ·  ` +
    `${game.logistics.packages.length} packages staged`,
  );
};
setInterval(bootStatus, 700);
bootStatus();

document.getElementById('btn-play').onclick = () => game.start(false);
document.getElementById('btn-spectate').onclick = () => game.start(true);

// ---- main loop --------------------------------------------------------------
let last = performance.now();
let fpsAcc = 0, fpsFrames = 0;

game.stage.renderer.setAnimationLoop((now) => {
  const real = (now - last) / 1000;
  last = now;
  const dt = Math.min(real, 0.05);   // never simulate more than 50ms at once

  // Measure fps from the REAL frame time, not the clamped one — otherwise a
  // machine running at 5fps still cheerfully reports 20.
  fpsAcc += real; fpsFrames++;
  if (fpsAcc > 0.5) { game.setFps(fpsFrames / fpsAcc); fpsAcc = 0; fpsFrames = 0; }

  game.update(dt);
});

// Pause the clock when the tab is hidden so we don't return to a huge dt.
document.addEventListener('visibilitychange', () => { last = performance.now(); });
