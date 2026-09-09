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

export const MINER_X = 7497318;          // 114.4 m, the miner's own origin
// 114 m was written here first, off `DeliveryGate.gateX`'s field initialiser,
// and Bootstrap overwrites it: `gate.gateX = _terrain.width * 0.44f` on a 260 m
// map is 114.4. The 0.4 m put every miner box - facade, lintel and both tunnel
// sides - a wall's thickness off where Unity draws them.
export const MINER_MOUTH_HALF = 2621440; //   40 m, the clear half-width of the tunnel
export const MINER_MOUTH_HIGH = 1703936; //   26 m
export const MINER_SHELL_HALF = 5531238; // 84.4 m
export const MINER_SHELL_HIGH = 8729395; // 133.2 m

export const EDGE_THICK = 196608;        //    3 m
export const EDGE_HIGH = 1703936;        //   26 m of blocker above the kerb
export const EDGE_SUNK = 393216;         //    6 m of it below the ground

/** How many boxes the map has, so a caller can size a buffer. */
export const MAP_BOXES = 37;

/**
 * The map's solids for a world, as the six words a box carries:
 * centre x, centre z, half x, half z, lowest y, highest y.
 *
 * Ordered the way the map is laid out - west edge, the post office, the two
 * long edges, the miner, east edge - and NOT the order Unity's
 * `FindObjectsByType` happens to return, which is not an order at all.
 */
export function mapSolids(ground, halfX, halfZ) {
  const box = new Int32Array(Math.imul(MAP_BOXES, BOX_WORDS));
  let n = 0;
  const put = (cx, cz, hx, hz, yLow, yHigh) => {
    const b = Math.imul(n, BOX_WORDS);
    box[b] = cx; box[b + 1] = cz; box[b + 2] = hx; box[b + 3] = hz;
    box[b + 4] = yLow; box[b + 5] = yHigh;
    n++;
  };
  const groundAt = (x, z) => heightAtWorld(ground, x, z, halfX, halfZ);
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

  return { n, box };
}

