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
export const MAP_BOXES = 78;   // 37 map boxes + 41 for the miner's corridor

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

  // ---- THE FOUR EDGES OF THE WORLD ---------------------------------------
  //
  // Tall and invisible, so a truck arriving airborne off a fee cliff still
  // cannot clear the edge. Sunk six metres so a dip does not open a gap.
  const edge = (cx, cz, hx, hz) => {
    const g = groundAt(cx, cz);
    put(cx, cz, hx, hz, sub(g, EDGE_SUNK), add(sub(g, EDGE_SUNK), EDGE_HIGH));
  };
  edge(-halfX, 0, half(EDGE_THICK), add(halfZ, EDGE_THICK));
  edge(halfX, 0, half(EDGE_THICK), add(halfZ, EDGE_THICK));
  edge(0, -halfZ, add(halfX, EDGE_THICK), half(EDGE_THICK));
  edge(0, halfZ, add(halfX, EDGE_THICK), half(EDGE_THICK));

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
  const corridor = [
    [114.57, 28.28, 6.18, 5.91, 0.08, 9.32],   // power_cable_0
    [114.62, -28.35, 6.18, 5.25, 0.09, 9.36],   // power_cable_1
    [145.40, 31.00, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_0
    [145.40, 25.80, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_1
    [145.40, 20.60, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_2
    [145.40, 15.40, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_3
    [145.40, 10.20, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_4
    [145.40, -10.60, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_8
    [145.40, -15.80, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_9
    [145.40, -21.00, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_10
    [145.40, -26.20, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_11
    [145.40, -31.40, 0.60, 0.55, 0.25, 9.70],   // tunnel_grid_v_12
    [145.40, 0.00, 0.60, 33.00, 3.55, 4.05],   // tunnel_grid_h_1
    [145.40, 0.00, 0.60, 33.00, 5.98, 6.48],   // tunnel_grid_h_2
    [145.40, 0.00, 0.60, 33.00, 8.41, 8.91],   // tunnel_grid_h_3
    [157.00, 35.20, 12.00, 1.20, 0.02, 9.92],   // tunnel_wall_l
    [157.00, -35.20, 12.00, 1.20, 0.02, 9.92],   // tunnel_wall_r
    [146.65, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_9
    [146.65, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_9
    [149.00, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_8
    [149.00, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_8
    [151.35, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_7
    [151.35, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_7
    [153.70, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_6
    [153.70, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_6
    [156.05, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_5
    [156.05, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_5
    [158.40, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_4
    [158.40, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_4
    [160.75, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_3
    [160.75, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_3
    [163.10, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_2
    [163.10, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_2
    [165.45, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_1
    [165.45, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_1
    [167.80, 33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_l_0
    [167.80, -33.40, 0.70, 0.60, 0.25, 9.70],   // tunnel_rib_r_0
    [170.10, 37.00, 1.30, 3.00, -0.43, 11.72],   // tunnel_jamb_l
    [170.10, -37.00, 1.30, 3.00, -0.43, 11.72],   // tunnel_jamb_r
    [169.35, 37.50, 0.35, 0.55, 2.72, 40.52],   // seam_v_3
    [169.35, -37.50, 0.35, 0.55, 2.72, 40.52],   // seam_v_9
  ];
  const minerBase = groundAt(MINER_X, 0);
  for (const [cx, cz, hx, hz, y0, y1] of corridor)
    put(Math.round(cx * ONE), Math.round(cz * ONE), Math.round(hx * ONE), Math.round(hz * ONE),
        add(minerBase, Math.round(y0 * ONE)), add(minerBase, Math.round(y1 * ONE)));

  return { n, box };
}

