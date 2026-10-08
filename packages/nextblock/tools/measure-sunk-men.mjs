// THE THREE HEIGHTS UNDER A MAN STANDING ON A HOLE (2026-09-20).
// core ground  = surfaceAt, what the core says he stands on
// Unity mesh   = MempoolTerrain's vertex = BlwpCore.TerrainAt (MempoolTerrain.cs:302, and the reveal loop at :392
//                assigns the same TerrainAt again, so Unity carves NO bowl of its own); the candle bodies are a
//                second mesh standing up to surfaceAt, so the VISIBLE surface under a lip man is surfaceAt.
// drawn Y      = ArmyRenderer.cs:928-940  Ground(x,z) + lift + bob - (down ? soldierProneDrop : 0),
//                lift = soldierPrefab != null ? 0 : 0.9, and Bootstrap.cs:879 assigns the prefab in a real build.
//                ArmyRenderer.cs:265 wraps it "OnItsSole", so the origin is the man's FEET.
import { init, step, submitLiquidation, surfaceAt, terrainAt } from '../src/sim.js';
import * as T from '../src/rules/tactics.js';
import * as L from '../src/state.js';
const Q=65536, isMan=(i)=>(i&L.ARMOUR_MASK)!==0;
const WRECK_MAX=L.UNITS*2, CRATER_MAX=WRECK_MAX+L.MAX_CRATERS*4;
// The renderer's own arithmetic, mirrored here so the fixture can be run without a browser build. BEFORE, the
// sole-anchored prefab path subtracted the box's drop; AFTER, it subtracts nothing and the 82-degree pitch lays
// the body down about the man's own feet. The box path is unchanged and is printed beside it.
// THIS PROBE MIRRORS THE FORMULA - it does not observe it. What observes it is Assets/Tests/EditMode/
// SoldierLiftTests.cs, which calls ArmyRenderer.SoldierLift directly and needs no core to do it.
const PRONE_DROP=0.75;
const liftBefore=(down,prefab)=>(prefab?0:0.9)-(down?PRONE_DROP:0);
const liftAfter =(down,prefab)=>prefab?0:(down?0.9-PRONE_DROP:0.9);
const rows={wreck:[],crater:[],lip:[]}; let down=0, total=0;
for(const seed of [1,2]){
  const st=init(seed), s=st.i32;
  for(let t=0;t<900;t++) step(st,Q,0,0,0,0);
  for(let t=0;t<2400;t++){
    if(t%1800===300) submitLiquidation(st,4000000);
    step(st,Q,0,0,0,0);
    for(let i=0;i<L.UNITS;i++){
      if(!isMan(i))continue; const b=L.O_UNITS+i*L.U_WORDS;
      if(s[b+L.U_STATE]===0||s[b+L.U_HP]<=0)continue;
      const id=T.coverClaim(s,L.O_TACTICS,i); if(id===T.COVER_NONE)continue;
      const side=s[b+L.U_SIDE]<0?-1:1;
      const p=T.coverPlace(s,id,side,st.candles,st.candleShift|0); if(!p)continue;
      if(Math.hypot((s[b]-p.x)/Q,(s[b+1]-p.z)/Q)>0.5) continue;
      total++;
      const isDown=T.coverPosture(s,L.O_TACTICS,i)!==T.POSTURE_STAND; if(isDown)down++;
      const k=id<WRECK_MAX?'wreck':id<CRATER_MAX?'crater':'lip';
      const su=surfaceAt(st,s[b],s[b+1])/Q, te=terrainAt(st,s[b],s[b+1])/Q;
      rows[k].push({su,te,isDown,
        before:su+liftBefore(isDown,true), after:su+liftAfter(isDown,true), box:su+liftAfter(isDown,false)});
    }
  }
}
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const pc=(a,b)=>`${(100*a/Math.max(b,1)).toFixed(1)}%`;
console.log(`MEN STANDING ON A HOLE: ${total} man-ticks, of which the core has ${down} DOWN (${pc(down,total)})\n`);
console.log('place kind   n        core ground   Unity terrain   visible surface   drawn Y BEFORE   SUNK BEFORE   drawn Y AFTER   SUNK AFTER');
for(const k of ['lip','crater','wreck']){const a=rows[k]; if(!a.length)continue;
  const vis=k==='lip'?mean(a.map(e=>e.su)):mean(a.map(e=>e.te));
  const b=mean(a.map(e=>e.before)), af=mean(a.map(e=>e.after));
  console.log(`${k.padEnd(11)} ${String(a.length).padStart(5)}    ${mean(a.map(e=>e.su)).toFixed(2).padStart(8)}   ${mean(a.map(e=>e.te)).toFixed(2).padStart(10)}   ${vis.toFixed(2).padStart(13)}   ${b.toFixed(2).padStart(12)}   ${(vis-b).toFixed(2).padStart(9)} m   ${af.toFixed(2).padStart(11)}   ${(vis-af).toFixed(2).padStart(8)} m`);}
const all=[...rows.lip,...rows.crater,...rows.wreck];
const sunk=all.filter(e=>e.isDown).length;
console.log(`\nDOWN men on a hole: ${sunk} of ${total} man-ticks (${pc(sunk,total)}) - the population that was drawn under the dirt.`);
console.log(`The box path is untouched: a downed box man sits at surface + ${(0.9-PRONE_DROP).toFixed(2)} m, as it always did.`);
console.log(`The crater bowl is still 0.00 m of it: Unity's mesh vertex IS the core's TerrainAt, so there is no second bowl.`);
