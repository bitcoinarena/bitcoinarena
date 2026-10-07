// THE MAP'S OWN COLLISION BOXES, AND THEY BELONG HERE.
//
// The world solids used to be Unity's: `WorldSolids.Gather` collected every
// BoxCollider the player had BUILT AT RUNTIME and `CoreDrivenTruck.UploadSolids`
// sent them to the core - re-sending whenever the count changed, so the world
// the core resolved against moved mid-run as models streamed in. No replay set
// any at all, so a committee resolved every drive against nothing. Measured:
// one box on the path moves a 600-tick drive 40.233 m, more than the 33.500 m
// the ground was worth.
//
// So the boxes are made here, from the map's own geometry, the same way the
// relief is. THE NUMBERS ARE THE MAP'S and they were taken from a running
// player rather than from a reading of the code: 37 boxes, four map edges, the
// post office shell of twenty-five pillars on the bays' own 6.8 m pitch with
// its two ends and its lintel, and the miner's facade, lintel and tunnel
// sides. `SolidsInventoryTests` prints the set a real Bootstrap builds and
// pins it against these.
//
// EVERY HEIGHT IS SAMPLED FROM THE GROUND THIS CORE GENERATED. A shell sits at
// one terrain sample and the relief falls away to either side, which is why
// each one is buried: twenty metres of footing, so a truck cannot drive under
// a wall where the ground drops. That was Unity's reasoning and it is right;
// what changes is that the sample is now the core's own.
import { ONE, add, sub } from '../fixed.js';
import { heightAtWorld } from './ground.js';
import { BOX_WORDS } from './solids.js';

/** Q16.16 metres, written as the integer it is, with the metres beside it. */
export const POST_X = -7497318;          // -114.4 m, the post office's own origin
export const WALL_DEPTH = 524288;        //    8 m, the barrier runs back into the hall
export const PORT_PITCH = 445645;        //  6.8 m, one bay to the next
export const FIRST_PORT_Z = -5124915;    // -78.2 m, the middle of bay 0
export const MOUTH_HALF = 163840;        //  2.5 m, the clear half-width of a bay
export const MOUTH_HIGH = 602931;        //  9.2 m, the top of a bay mouth
export const SHELL_HALF = 5514854;       // 84.15 m, half the post office
export const SHELL_HIGH = 3407872;       //   52 m
export const FOOTING = 1310720;          //   20 m of foundations under every shell

export const MINER_X = 11075584;         // 169 m, the miner's own origin (was 114.4; the world grew east)
// 114 m was written here first, off `DeliveryGate.gateX`'s field initialiser,
// and Bootstrap overwrites it: `gate.gateX = _terrain.width * 0.44f` on a 260 m
// map is 114.4. The 0.4 m put every miner box - facade, lintel and both tunnel
// sides - a wall's thickness off where Unity draws them.
/**
 * WHERE THE MINER ACTUALLY BEGINS - the west edge of the DRAWN building, not its origin and not its tunnel.
 *
 * The first cut of this (2026-09-19 13:09) put the door at the tunnel's mouth, 90.4 m, because that is where the
 * entry corridor clears. the owner's 15:58 shot showed why that was the wrong edge: the building's legs, feet, cables
 * and lower mass stand on the ground from 60.6 m west of its origin, so road, chart and tanks were still under it.
 * The door is that edge. With the origin at 169 m it is 108.4 m, and nothing the world lays down goes past it: the
 * candle field ends at 90.0 m, the road ribbon ends here, and the army's own east clamp is held short of it.
 */
export const MINER_DOOR_X = 7098470;     // 108.3 m: MINER_X less the 60.60486 m the model reaches west of its
                                         // origin (108.39514), and 9.5 cm of daylight inside that
export const MINER_MOUTH_HALF = 2621440; //   40 m, the clear half-width of the tunnel
export const MINER_MOUTH_HIGH = 1703936; //   26 m
export const MINER_SHELL_HALF = 5531238; // 84.4 m
export const MINER_SHELL_HIGH = 8729395; // 133.2 m

export const EDGE_THICK = 196608;        //    3 m
export const EDGE_HIGH = 1703936;        //   26 m of blocker above the kerb
export const EDGE_SUNK = 393216;         //    6 m of it below the ground

/** How many boxes the map has, so a caller can size a buffer. */
// 33 map + 4 coin stacks + 24 post office mouths. It was 37 map and 106 total until
// ruling 4 (2026-09-22) made the edge a clamp: the four edge walls are gone, and the core owes no wall
// solids; then 102 until the finish straight was cleared (2026-09-25 21:19): the corridor lost the fifteen
// boxes that stood in the passage; then 87 until the corridor lining - 26 boxes mirrored off the drawn tunnel -
// came out (2026-09-26 07:18). Unity draws what this builds, so its own count moves with it.
export const MAP_BOXES = 61;

/**
 * The map's solids for a world, as the six words a box carries:
 * centre x, centre z, half x, half z, lowest y, highest y.
 *
 * Ordered the way the map is laid out - west edge, the post office, the two
 * long edges, the miner, east edge - and NOT the order Unity's
 * `FindObjectsByType` happens to return, which is not an order at all.
 */
export function mapSolids(ground, halfX, halfZ, reliefHalfX = halfX) {
  const box = new Int32Array(Math.imul(MAP_BOXES, BOX_WORDS));
  let n = 0;
  const put = (cx, cz, hx, hz, yLow, yHigh) => {
    const b = Math.imul(n, BOX_WORDS);
    box[b] = cx; box[b + 1] = cz; box[b + 2] = hx; box[b + 3] = hz;
    box[b + 4] = yLow; box[b + 5] = yHigh;
    n++;
  };
  const groundAt = (x, z) => heightAtWorld(ground, x, z, reliefHalfX, halfZ);
  const half = (v) => v >> 1;

  // ---- THE FOUR EDGES OF THE WORLD ARE NOT SOLIDS ------------------------
  //
  // RULED (the owner 2026-09-22, ruling 4 of `ef7af68c`, re-stated knowing these existed): the map edge is
  // a CLAMP, not a wall. The core owes no wall solids, and the client stops drawing walls the core does
  // not build.
  //
  // This used to put four boxes here - 3 m thick, 26 m tall, sunk 6 m - at +-halfX and +-halfZ, so that
  // "a truck arriving airborne off a fee cliff still cannot clear the edge". A clamp holds that same
  // truck at the edge without a solid to collide with, and it holds it whatever the arrival speed,
  // which a 26 m box does not: a box is a thing to tunnel through at high enough speed, and a clamp is
  // not. The clamp is in `sim.js`, applied after the pushes as well as the steps - see the note there.
  //
  // EDGE_THICK / EDGE_HIGH / EDGE_SUNK stay exported and unused by this file: the Unity side still
  // reads them while it is being taught to stop drawing them, and deleting them would break that build
  // before the draw is gone rather than after.

  // ---- THE POST OFFICE ----------------------------------------------------
  //
  // The building spans the map, so the only way onto the road is out of a bay.
  // The slabs run BACKWARDS into the hall - forwards would put a wall in front
  // of the doors the truck is parked at.
  const shellX = add(POST_X, sub(0, half(WALL_DEPTH)));   // FacadeX is the shell's own zero
  const postG = groundAt(POST_X, 0);
  const postLow = sub(postG, FOOTING);
  const postHigh = add(postG, SHELL_HIGH);
  const pillarHalf = half(sub(PORT_PITCH, Math.imul(MOUTH_HALF, 2)));
  for (let i = 0; i <= 24; i++) {
    const z = add(sub(FIRST_PORT_Z, half(PORT_PITCH)), Math.imul(PORT_PITCH, i));
    put(shellX, z, half(WALL_DEPTH), pillarHalf, postLow, postHigh);
  }
  // The two ends, from the outermost pillar out to the edge of the shell.
  const lastEdge = add(FIRST_PORT_Z, add(Math.imul(PORT_PITCH, 23), half(PORT_PITCH)));
  const endHalf = half(sub(SHELL_HALF, lastEdge));
  put(shellX, sub(0, add(lastEdge, endHalf)), half(WALL_DEPTH), endHalf, postLow, postHigh);
  put(shellX, add(lastEdge, endHalf), half(WALL_DEPTH), endHalf, postLow, postHigh);
  // Over every mouth.
  put(shellX, 0, half(WALL_DEPTH), SHELL_HALF, add(postG, MOUTH_HIGH), postHigh);

  // AND ACROSS EVERY MOUTH, WHICH WAS A HOLE RIGHT THROUGH THE BUILDING (the owner 2026-09-20 18:59,
  // photographed: "the truck must not drive through that building ... Mempool collision must be exactly the
  // yellow marked line on the facade").
  //
  // The wall above was pillars BETWEEN the mouths and a lintel OVER them, so each bay mouth stood open from the
  // ground to MOUTH_HIGH - 2.5 m of clear half-width and 9.2 m of clear height, twenty-four times. MEASURED:
  // the truck spawns at START_X -100.40, z 10.20, which is bay 13's own centre, so driving WEST it went
  // straight out through the back of the post office and across the whole map to x -180.22, the west map edge.
  // It never touched the building at all.
  //
  // These close the mouths on the SAME PLANE as the rest of the shell - shellX, half(WALL_DEPTH) - so the face
  // a truck meets is the wall's own east face at POST_X, which is where the yellow marks stand: every part
  // drawn in `bumper_guard_yellow` on this facade, the `port_guard_post_*` at each mouth, spans x -114.95 to
  // -113.94. The line is not moved and the box is neither in front of it nor behind it.
  //
  // THE BAY IS STILL DRIVEABLE AND THE SPAWN DOES NOT MOVE: a run leaves the bay EASTWARD, and the spawn at
  // x -100.40 stands 14 m east of this plane, outside the wall by more than the truck's own 6.35 m length.
  for (let i = 0; i < 24; i++)
    put(shellX, add(FIRST_PORT_Z, Math.imul(PORT_PITCH, i)), half(WALL_DEPTH), MOUTH_HALF,
        postLow, add(postG, MOUTH_HIGH));

  // ---- THE MINER ----------------------------------------------------------
  //
  // Its shell faces the player, so its own x and z run the other way; what is
  // written here is where the boxes STAND, which is the only thing a collision
  // cares about.
  const minerG = groundAt(MINER_X, 0);
  const minerLow = sub(minerG, FOOTING);
  const minerHigh = add(minerG, MINER_SHELL_HIGH);
  const facadeX = sub(MINER_X, Math.imul(2, ONE));         // local x 2, faced about
  const sideHalf = half(sub(MINER_SHELL_HALF, MINER_MOUTH_HALF));
  const sideZ = add(MINER_MOUTH_HALF, sideHalf);
  put(facadeX, sub(0, sideZ), Math.imul(4, ONE), sideHalf, minerLow, minerHigh);
  put(facadeX, sideZ, Math.imul(4, ONE), sideHalf, minerLow, minerHigh);
  put(facadeX, 0, Math.imul(4, ONE), MINER_MOUTH_HALF,
      add(minerG, MINER_MOUTH_HIGH), minerHigh);
  // The tunnel's own two sides, so the run-in is a corridor and not a doorway
  // that can be clipped past at an angle.
  const tunnelX = add(MINER_X, Math.imul(11, ONE));
  const tunnelZ = add(MINER_MOUTH_HALF, Math.imul(2, ONE));
  const tunnelLow = sub(minerG, FOOTING);
  const tunnelHigh = add(minerG, MINER_MOUTH_HIGH);
  put(tunnelX, sub(0, tunnelZ), Math.imul(14, ONE), Math.imul(2, ONE), tunnelLow, tunnelHigh);
  put(tunnelX, tunnelZ, Math.imul(14, ONE), Math.imul(2, ONE), tunnelLow, tunnelHigh);

  // ---- THE MINER'S CORRIDOR ------------------------------------------------
  //
  // MEASURED 2026-09-20: 452 of the miner's 904 drawn parts carried no box at all, 46 of them standing in the
  // entry corridor below a truck's height, and a truck driven down the lane passed 1.27 m - its FULL body
  // radius, through the middle and not a graze - through five of them on every one of five approaches. The five
  // boxes above are the facade and the tunnel's outer walls; they leave the corridor itself unlined, which is
  // why a tank can stand in a drawn cable.
  //
  // These are those parts, read from the model through Unity's own 180-degree turn and (1, 0.45, 1) scale and
  // written here in the units the core keeps. They are NOT a mesh collider and nothing was copied from the C#:
  // DeliveryGate's five Slab() calls still build the five above, and that agreement is left exactly as it was.
  //
  // WHAT IS DELIBERATELY ABSENT, and it is a ruling rather than an oversight (the owner 2026-09-20):
  //   mass_behind_tunnel         hangs from y 2.7 m across the whole approach while the truck's body is 3.26 m,
  //                              so its roof passes 0.56 m through it. The delivery gate is at x 169, PAST that
  //                              mass at x 119..145, so a solid there closes the only route to the miner. The
  //                              ceiling is passable BY RULING, and the 0.56 m is Unity's (1, 0.45, 1) height
  //                              scale rather than a missing slab. Raising the miner is a later item.
  //   tunnel_end_backglow, tunnel_grid_h_0 and _h_1, tunnel_grid_v_5/6/7, btc_medallion_tunnel_end
  //                              the same thing at the tunnel mouth: measured, these seven span the driving lane
  //                              at truck height, and the gate is beyond them. A box on any of them closes the
  //                              route as surely as the mass does. Nothing solid stands within 6 m of the centre
  //                              line at truck height, so the run-in is always open.
  // THE FINISH STRAIGHT IS FREE (the owner 2026-09-25 21:19: "The finish-straight passage must be completely free. A
  // truck at speed crosses it with no hit and no slowdown from a collider ... Whatever is now in that passage, in the
  // core or in Unity, comes out. Do not add a box to keep the mesh honest if it stands in the passage").
  //   MEASURED before (straight.mjs, 20 seeds, full throttle from x 60): on the spawn bay's own lane, z 10.2, 17 of
  //   20 runs never delivered, stopped on tunnel_grid_v_4; on the centre line 3 of 20, on tunnel_grid_v_9 and _v_4;
  //   at z -6, 9 of 20 on tunnel_grid_v_8. The mouth's ten grid columns (x 145.4, |z| 10.2 .. 31.4, 4 m apart) were a
  //   fence across the finish, and its three bars (z +-33, from 3.55 m) were a ceiling 0.29 m over the truck that any
  //   rise in the run-in brought down onto it.
  //   OUT, and not to come back: tunnel_grid_v_0 .. _4 and _8 .. _12, tunnel_grid_h_1 .. _3, and power_cable_0 / _1
  //   (x 108.4 .. 120.8, |z| 22.4 .. 34.2), which stood inside the mouth where a truck from an outer bay funnels in.
  //   The passage is the tunnel between its ribs, |z| < 32.8, from the miner's door to the gate: nothing in it is
  //   solid at any height. The walls, ribs, jambs and seams line it and stay; the coin stacks are past the gate and
  //   outside the mouth, and stay.
  // THE CORRIDOR LINING IS OUT, AND THE COIN STACKS STAND WHERE THEY ARE DRAWN (the owner 2026-09-26 07:18, phone, block
  // 968644: "The collisions left and right of the finish straight are wrong. They come out. The passage stays free ...
  // The circled stack needs a collision. You can drive through it now. The box is where that drawn stack stands, not
  // where an old measurement put coin_stack").
  //
  // MEASURED 2026-09-26 in a real Bootstrap world (PlayMode, the .glb handed to DeliveryGate.ShowMiner as the streamer
  // does, Renderer.bounds in world metres): the model is no longer turned about or squashed to 0.45 in height, so the
  // 2026-09-20 reading of it is MIRRORED about the miner's origin x 169 and 0.45 too low. The tunnel's walls, ribs and
  // jambs are drawn at x 169..193 - inside the building, past the gate - where this list had them at x 145..169,
  // lining the finish straight with 26 boxes nothing draws. They come out and are not put back: a run is over at the
  // gate, so nothing past it is ever driven. The stacks are drawn at x 145.6..164.4, not 173.6..192.4:
  //
  //   coin_stack_plinth_l/r   x 145.60 .. 164.40   |z| 40.60 .. 59.40   y 0.42 .. 1.82 (world)
  //   coin_stack_*_0 .. _3    x 148.00 .. 162.00   |z| 43.00 .. 57.00   y 0.52 .. 7.22 (world)
  //
  // The miner is drawn 0.40 m above the core's ground there (tunnel_wall at world 0.42, core 0.02), so the heights
  // below are the drawn ones less 0.40. The stacks stand OUTSIDE the passage (|z| 40.6 against its 32.8) and against
  // the facade (x 163), 30 m off the lane at z 10.2: nothing on the centre line or in the passage is touched.
  const corridor = [
    [155.00, 50.00, 9.40, 9.40, 0.02, 1.42],   // coin_stack_plinth_l
    [155.00, -50.00, 9.40, 9.40, 0.02, 1.42],   // coin_stack_plinth_r
    [155.00, 50.00, 7.00, 7.00, 0.12, 6.82],   // coin_stack_l_0 .. _3
    [155.00, -50.00, 7.00, 7.00, 0.12, 6.82],   // coin_stack_r_0 .. _3
  ];
  const minerBase = groundAt(MINER_X, 0);
  for (const [cx, cz, hx, hz, y0, y1] of corridor)
    put(Math.round(cx * ONE), Math.round(cz * ONE), Math.round(hx * ONE), Math.round(hz * ONE),
        add(minerBase, Math.round(y0 * ONE)), add(minerBase, Math.round(y1 * ONE)));

  return { n, box };
}

