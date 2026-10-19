// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Drives the core with the SAME protocol PhysxReferenceTests uses, so the two
// tables can be laid side by side. Feel is not a formula; it is whatever the
// PhysX truck did, and this is how we find out whether we have it.
import { init, step } from '../src/sim.js';

const O = 5, X = 0, Z = 1, HEAD = 2, VX = 3, VZ = 4, SPEED = 9, STEER = 11;
const HZ = 60, ONE = 65536;
const get = (s, f) => s.i32[O + f] / ONE;
const headDeg = (s) => (s.i32[O + HEAD] & 65535) * 360 / ONE;

const drive = (s, n, th, st) => { for (let i = 0; i < n; i++) step(s, Math.round(th*ONE), Math.round(st*ONE), 0, 0, 0); };

console.log('COREREF BEGIN');

// --- straight line ---
{
  const s = init(1);
  for (let t = 1; t <= 16; t++) { drive(s, HZ, 1, 0); console.log(`COREREF accel ${t}.0 ${get(s,SPEED).toFixed(3)}`); }
}

// --- steady turns ---
for (const steer of [0.25, 0.5, 1.0]) {
  const s = init(1);
  drive(s, HZ*8, 1, 0);
  drive(s, HZ*5, 1, steer);

  let prev = headDeg(s), turned = 0, vsum = 0, slip = 0, steersum = 0, n = 0;
  for (let i = 0; i < HZ*5; i++) {
    drive(s, 1, 1, steer);
    const h = headDeg(s);
    let d = h - prev; if (d > 180) d -= 360; if (d < -180) d += 360;
    turned += d; prev = h;

    const vx = get(s,VX), vz = get(s,VZ), sp = Math.hypot(vx,vz);
    vsum += sp;
    if (sp > 1) {
      const velDeg = Math.atan2(vx, vz) * 180/Math.PI;
      let sl = velDeg - h; if (sl > 180) sl -= 360; if (sl < -180) sl += 360;
      slip += sl;
    }
    steersum += s.i32[O+STEER] * 360 / ONE;
    n++;
  }
  const v = vsum/n, yaw = turned/5;
  const radius = Math.abs(yaw) > 0.01 ? v/(Math.abs(yaw)*Math.PI/180) : 9999;
  console.log(`COREREF turn ${steer.toFixed(2)} v=${v.toFixed(2)} yaw=${yaw.toFixed(2)} radius=${radius.toFixed(1)} slip=${(slip/n).toFixed(2)} steer=${(steersum/n).toFixed(2)}`);
}

// --- transient ---
{
  const s = init(1);
  drive(s, HZ*8, 1, 0);
  console.log(`COREREF transient entry v=${get(s,SPEED).toFixed(2)}`);
  let prev = headDeg(s), acc = 0;
  for (let q = 1; q <= 12; q++) {
    for (let i = 0; i < HZ*0.25; i++) {
      drive(s, 1, 1, 1);
      const h = headDeg(s); let d = h - prev; if (d>180)d-=360; if(d<-180)d+=360;
      acc += d; prev = h;
    }
    console.log(`COREREF transient ${(q*0.25).toFixed(2)} turned=${acc.toFixed(1)} steer=${(s.i32[O+STEER]*360/ONE).toFixed(1)} v=${get(s,SPEED).toFixed(2)}`);
  }
}
console.log('COREREF END');
