import { Game } from './game.js';
import { Q } from './quality.js';

// The failure surface itself lives in a classic script in index.html, so that
// it is already installed if this module graph fails to link at all.
const fatal = (err) => window.__fatal?.(err);

const canvas = document.getElementById('view');
let game;
try {
  game = new Game(canvas);
} catch (err) {
  fatal(err);
  throw err;
}
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

// ---- adaptive resolution ----------------------------------------------------
// Geometry counts are fixed at load from the device tier, but a phone can still
// run hot. Drop render scale first (cheapest big win), then shadows, and give it
// back once the frame rate recovers.
const renderer = game.stage.renderer;
const baseRatio = Math.min(devicePixelRatio, Q.pixelRatio);
let scale = 1, slow = 0, fast = 0;

function adapt(fps) {
  if (fps < 24 && scale > 0.6) {
    if (++slow >= 4) {
      slow = 0;
      scale = Math.max(0.6, scale - 0.15);
      renderer.setPixelRatio(baseRatio * scale);
      if (scale <= 0.7 && renderer.shadowMap.enabled) {
        renderer.shadowMap.enabled = false;
        game.stage.sun.castShadow = false;
      }
    }
  } else if (fps > 52 && scale < 1) {
    if (++fast >= 10) { fast = 0; scale = Math.min(1, scale + 0.1); renderer.setPixelRatio(baseRatio * scale); }
  } else { slow = 0; fast = 0; }
}

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
  if (fpsAcc > 0.5) {
    const fps = fpsFrames / fpsAcc;
    game.setFps(fps);
    adapt(fps);
    fpsAcc = 0; fpsFrames = 0;
  }

  game.update(dt);
});

// Pause the clock when the tab is hidden so we don't return to a huge dt.
document.addEventListener('visibilitychange', () => { last = performance.now(); });
