import * as THREE from 'three';
import { CAMERAS, LANES } from './config.js';
import { clamp } from './util.js';

/**
 * Mouse / keyboard / touch. Handles picking (packages + trucks), box multi-select,
 * free-fly look, manual driving, and every hotkey.
 */
export function bindInput(game) {
  const dom = game.stage.renderer.domElement;
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const keys = game.stage.freeKeys();
  const proj = new THREE.Vector3();

  let dragging = null;      // {x0,y0,x1,y1,moved,button}
  let lookLast = null;

  game.manualSteer = { x: 0, z: 0 };

  const setNdc = (e) => {
    ndc.x = (e.clientX / innerWidth) * 2 - 1;
    ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  };

  const pick = (e) => {
    setNdc(e);
    ray.setFromCamera(ndc, game.stage.camera);
    const hits = ray.intersectObjects(
      [game.logistics.pkgMesh, ...game.logistics.trucks.map((t) => t.obj)],
      true,
    );
    for (const h of hits) {
      if (h.object === game.logistics.pkgMesh) {
        const p = game.logistics.packageByInstance(h.instanceId);
        if (p) return { type: 'package', p };
      }
      let o = h.object;
      while (o && !o.userData.truck) o = o.parent;
      if (o?.userData.truck) return { type: 'truck', t: o.userData.truck };
    }
    return null;
  };

  /**
   * Crates are small and they bob, so an exact ray hit is a harsh requirement.
   * On a miss, fall back to the nearest plaza package within a few pixels.
   */
  const pickForgiving = (e, tol = 26) => {
    const hit = pick(e);
    if (hit) return hit;
    let best = null, bestD = tol * tol;
    for (const p of game.logistics.plazaPackages()) {
      proj.copy(p.pos).project(game.stage.camera);
      if (proj.z > 1) continue;
      const sx = (proj.x * 0.5 + 0.5) * innerWidth;
      const sy = (-proj.y * 0.5 + 0.5) * innerHeight;
      const d = (sx - e.clientX) ** 2 + (sy - e.clientY) ** 2;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { type: 'package', p: best } : null;
  };

  /* ------------------------------------------------------------ pointer */

  dom.addEventListener('pointerdown', (e) => {
    game.audio.resume();
    dragging = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, moved: false, button: e.button };
    if (e.button === 2 || game.stage.mode === 'free') lookLast = { x: e.clientX, y: e.clientY };
    dom.setPointerCapture?.(e.pointerId);
  });

  dom.addEventListener('pointermove', (e) => {
    if (lookLast && (dragging?.button === 2 || game.stage.mode === 'free')) {
      game.stage.lookDelta(e.clientX - lookLast.x, e.clientY - lookLast.y);
      lookLast = { x: e.clientX, y: e.clientY };
    }
    if (dragging) {
      dragging.x1 = e.clientX; dragging.y1 = e.clientY;
      if (Math.abs(dragging.x1 - dragging.x0) + Math.abs(dragging.y1 - dragging.y0) > 6) dragging.moved = true;
    }

    // hover tooltip (skip while dragging the camera)
    if (!lookLast) {
      const hit = pick(e);
      game.logistics.hover = hit?.type === 'package' ? hit.p : null;
      if (hit?.type === 'package') game.ui.packageTooltip(hit.p, e.clientX, e.clientY);
      else if (hit?.type === 'truck') game.ui.truckTooltip(hit.t, e.clientX, e.clientY);
      else game.ui.hideTooltip();
      dom.style.cursor = hit ? 'pointer' : 'default';
    }
  });

  dom.addEventListener('pointerup', (e) => {
    const d = dragging;
    dragging = null; lookLast = null;
    if (!d || e.button === 2) return;

    if (d.moved) {
      // box select every plaza package inside the rectangle
      const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1);
      const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (!e.shiftKey) game.logistics.selected.clear();
      let n = 0;
      for (const p of game.logistics.plazaPackages()) {
        proj.copy(p.pos).project(game.stage.camera);
        if (proj.z > 1) continue;
        const sx = (proj.x * 0.5 + 0.5) * innerWidth;
        const sy = (-proj.y * 0.5 + 0.5) * innerHeight;
        if (sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1) { game.logistics.selected.add(p); n++; }
      }
      if (n) { game.audio.click(); game.events.emit('log', { kind: 'ops', text: `${n} package${n > 1 ? 's' : ''} selected` }); }
      return;
    }

    // fingers are blunter than a mouse pointer
    const hit = pickForgiving(e, e.pointerType === 'touch' ? 44 : 26);
    if (!hit) { if (!e.shiftKey) game.logistics.selected.clear(); return; }
    if (hit.type === 'package') {
      if (!e.shiftKey && !game.logistics.selected.has(hit.p)) game.logistics.selected.clear();
      game.togglePackage(hit.p);
      if (e.pointerType === 'touch') {
        game.ui.packageTooltip(hit.p, e.clientX, e.clientY);
        clearTimeout(game.ui._tipTimer);
        game.ui._tipTimer = setTimeout(() => game.ui.hideTooltip(), 2600);
      }
    } else if (hit.type === 'truck') {
      game.selectTruck(hit.t.id);
    }
  });

  dom.addEventListener('contextmenu', (e) => e.preventDefault());

  dom.addEventListener('wheel', (e) => {
    // dolly the free camera; otherwise nudge cinematic distance
    if (game.stage.mode === 'free') {
      const f = game.stage._free;
      f.speed = clamp(f.speed * (e.deltaY > 0 ? 0.88 : 1.14), 8, 400);
    }
  }, { passive: true });

  // double click a package to load it straight onto the selected truck
  dom.addEventListener('dblclick', (e) => {
    const hit = pick(e);
    if (hit?.type === 'package' && game.selectedTruck) game.logistics.load(game.selectedTruck, hit.p);
  });

  /* ----------------------------------------------------------- keyboard */

  const camKeys = { Digit1: 'cinematic', Digit2: 'god', Digit3: 'follow', Digit4: 'plaza', Digit5: 'driver', Digit6: 'free' };

  addEventListener('keydown', (e) => {
    if (e.repeat) { keys.add(e.code.toLowerCase()); return; }
    keys.add(e.code.toLowerCase());
    game.audio.resume();

    if (camKeys[e.code]) { game.setCamera(camKeys[e.code]); return; }

    switch (e.code) {
      case 'Space':   e.preventDefault(); game.autoLoad(); break;
      case 'Enter':   game.dispatch(); break;
      case 'KeyL':    game.loadSelected(); break;
      case 'KeyB':    game.boost(); break;
      case 'KeyP':    game.repair(); break;
      case 'KeyR':    game.rbf(); break;
      case 'KeyF':    game.setCamera(game.stage.mode === 'follow' ? 'cinematic' : 'follow'); break;
      case 'KeyE':    game.toggleEdu(); break;
      case 'KeyM':    game.toggleMute(); break;
      case 'KeyQ':    game.setLane('bullRear'); break;
      case 'KeyZ':    game.setLane('bull'); break;
      case 'KeyX':    game.setLane('front'); break;
      case 'KeyC':    game.setLane('bear'); break;
      case 'KeyV':    game.setLane('bearRear'); break;
      case 'Tab':     e.preventDefault(); cycleTruck(); break;
      case 'Escape':  game.logistics.selected.clear(); game.ui.el.edu.classList.add('hidden'); break;
    }
  });

  addEventListener('keyup', (e) => keys.delete(e.code.toLowerCase()));
  addEventListener('blur', () => keys.clear());

  function cycleTruck() {
    const list = game.logistics.trucks;
    if (!list.length) return;
    const i = list.indexOf(game.selectedTruck);
    game.selectTruck(list[(i + 1) % list.length].id);
  }

  /* ------------------------------------------------- manual driving tick */

  game.stage.onBeforeUpdate = null;
  const steerTick = () => {
    const t = game.selectedTruck;
    const driving = t && (game.stage.mode === 'driver' || game.stage.mode === 'follow') && t.state === 'enroute';
    if (driving) {
      t.manual = true;
      game.manualSteer.z = (keys.has('keyd') || keys.has('arrowright') ? 1 : 0) - (keys.has('keya') || keys.has('arrowleft') ? 1 : 0);
      game.manualSteer.x = (keys.has('keyw') || keys.has('arrowup') ? 1 : 0) - (keys.has('keys') || keys.has('arrowdown') ? 1 : 0);
    } else if (t) {
      t.manual = false;
      game.manualSteer.z = 0; game.manualSteer.x = 0;
    }
    requestAnimationFrame(steerTick);
  };
  steerTick();

  /* -------------------------------------------------------------- touch */

  // NOTE: there are deliberately no touchstart/touchend tap handlers here.
  // Touch already produces pointer events, so a separate touch path fires the
  // selection twice — the package would be selected and immediately
  // deselected. Taps go through the pointer handlers above, which widen their
  // pick tolerance for touch.

  // Pinch to dolly the free camera in or out.
  let pinch = 0;
  dom.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinch = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY,
      );
    }
  }, { passive: true });

  dom.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !pinch) return;
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY,
    );
    const f = game.stage._free;
    if (game.stage.mode === 'free' && f) {
      const fwd = new THREE.Vector3(
        -Math.sin(f.yaw) * Math.cos(f.pitch), Math.sin(f.pitch), -Math.cos(f.yaw) * Math.cos(f.pitch),
      );
      f.pos.addScaledVector(fwd, (d - pinch) * 0.6);
      f.pos.y = clamp(f.pos.y, 3, 420);
    }
    pinch = d;
  }, { passive: true });

  dom.addEventListener('touchend', () => { pinch = 0; }, { passive: true });

  /* ------------------------------------------------------- HUD buttons */

  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('qa-autoload', () => game.autoLoad());
  on('qa-dispatch', () => game.dispatch());
  on('qa-boost', () => game.boost());
  on('qa-repair', () => game.repair());
  on('qa-rbf', () => game.rbf());
  on('qa-edu', () => game.toggleEdu());
  on('qa-mute', () => game.toggleMute());
}
