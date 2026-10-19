// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

/// <summary>
/// The armies either side of the seam: armour that duels, and infantry that
/// holds ground. Plain logic with no MonoBehaviour and no meshes, so the parts
/// that were hardest to get right in the three.js build - hulls that refuse to
/// interpenetrate, and units that fall back rather than standing in ground they
/// no longer hold - can be tested without a scene.
///
/// Ported from _updateArmour / _updateInfantry in src/world/battlefield.js.
/// </summary>
public class Army
{
    /// <summary>Troops are held between these, well inside the compound walls.</summary>
    public const float FrontX = 92f;
    public const float HalfDepth = 79f;

    /// <summary>
    /// How far out along the map a gunship may fly.
    ///
    /// The two depots are not scenery a helicopter can pass through. The post
    /// office wall stands from x -122.4 to -114.4 and reaches 58 m up; the
    /// miner from 108.4 to 116.4 and reaches 133. A gunship holds 19 m over
    /// the ground, so it flew straight into both - and worse, it SPAWNED at
    /// -FrontX - 30 = -122, which is inside the post office wall. It appeared
    /// in the building, flew out of it, crossed the field, and vanished into
    /// the miner.
    ///
    /// Climbing over is not the answer: the miner is 133 m tall and a gunship
    /// at that height is a speck. They patrol the front, so the front is where
    /// they belong - 104 is past the fighting at 92 and short of the miner's
    /// leading face at 108.
    /// </summary>
    public const float AirCorridorX = 104f;

    /// <summary>Hulls push apart below this centre distance. Enemies close a little tighter.</summary>
    public const float FriendlySpacing = 8.5f;
    public const float HostileSpacing = 7.5f;

    /// <summary>Beyond this the line has moved past a unit and it is falling back.</summary>
    public const float OverrunDepth = 14f;

    /// <summary>How far a rifle reaches.</summary>
    public const float RifleRange = 26f;

    /// <summary>
    /// Chance a shot connects. Deliberately tiny: ninety riflemen a side firing
    /// every three seconds is thirty shots a second, so anything like a
    /// realistic hit rate wipes both armies out inside ten seconds. At this
    /// value a soldier lives about a minute under fire, which is long enough to
    /// watch a line hold and break.
    /// </summary>
    public const float RifleHitChance = 0.045f;

    public enum Side { Bull = -1, Bear = 1 }

    public class Unit
    {
        public Side side;
        public float x, z;
        public float heading, turretYaw;
        public float hp, reload, phase;
        public bool retreating;
        /// <summary>Moving under his own legs, as opposed to holding a position.</summary>
        public bool walking;
        /// <summary>
        /// How far behind the line this man digs in. Fixed at spawn: rolling it
        /// every frame moved his goal under his feet, so "walking" flickered
        /// and a standing man kept twitching into a run.
        /// </summary>
        public float standoff;

        /// <summary>
        /// Which squad he belongs to, and where he stands in it. Men are not
        /// evenly spaced along a front - they clump, with gaps between groups -
        /// and an even line is the single thing that most makes an army read as
        /// a spreadsheet rather than as people.
        /// </summary>
        public int squad = -1;
        public float squadOffsetX, squadOffsetZ;

        /// <summary>Per-man variation, so a rank is not one model repeated.</summary>
        public float height = 1f;
        public float pace = 1f;

        /// <summary>
        /// Men do not advance at a constant rate in a straight line. They
        /// stop, look, and set off again, and they arrive at their position by
        /// a slightly different route each time. These carry that.
        /// </summary>
        public float restFor;        // seconds still to spend halted
        public float nextRest;       // seconds until he next stops
        public float drift;          // his own lateral bias, not a shared wave
        /// <summary>
        /// +1 for bull, -1 for bear. Sign convention matters: every formula
        /// ported from battlefield.js is written as "front - dir * distance",
        /// so getting this backwards silently inverts advance, retreat and the
        /// overrun test all at once.
        /// </summary>
        public float Dir => side == Side.Bull ? 1f : -1f;
    }

    /// <summary>
    /// Burnt-out hulls standing on the field. Units are moved by this logic
    /// rather than by physics, so a collider on a wreck stops the truck but not
    /// a tank - the army has to be told the ground is occupied.
    /// </summary>
    public readonly List<Vector3> Wrecks = new List<Vector3>();   // x, z, radius

    /// <summary>
    /// Gunships. They run the length of the front on their own side of it and
    /// drop on what they pass - the heaviest thing either army puts in the air.
    /// </summary>
    public class Helicopter
    {
        public Side side;
        public float x, y, z;
        public float yaw, bank, dir;
        public float t, dropIn;
        public float Dir => side == Side.Bull ? 1f : -1f;
    }

    /// <summary>A bomb in the air. Ballistic, so it lands ahead of where it was released.</summary>
    public class Bomb
    {
        public float x, y, z;
        public float vx, vy, vz;
        public Side side;
    }

    public readonly List<Helicopter> Helicopters = new List<Helicopter>();
    public readonly List<Bomb> Bombs = new List<Bomb>();

    /// <summary>How far a bomb kills. Deliberately far larger than a tank shell.</summary>
    public const float BombRadius = 16f;

    /// <summary>A bomb went off at x, z.</summary>
    /// <summary>
    /// Where the player's truck is, or null when it is off the field. Both
    /// sides treat it as a target once it comes close: running the gauntlet is
    /// the point, and a neutral supply van in the middle of a firefight has no
    /// friends. Ported from nearestHostile in src/world/battlefield.js.
    /// </summary>
    public Vector2? Courier;

    /// <summary>How close the truck has to come before it is shot at.</summary>
    public const float CourierRange = 34f;

    /// <summary>
    /// How badly both sides want the truck, 0..1.
    ///
    /// Set from what it is carrying. An empty van is in the way; a van with a
    /// whale on the back is worth diverting a tank for. Without this the
    /// freight choice had no consequence at all - the player simply took the
    /// most valuable thing on the ramp every time.
    /// </summary>
    public float Heat;

    /// <summary>The truck was hit. Carries damage before its armour.</summary>
    public System.Action<float> CourierHit;

    public System.Action<Vector2> Bombed;
    /// <summary>A bomb was released, so the renderer can follow it down.</summary>
    public System.Action<Bomb> BombReleased;

    public readonly List<Unit> Armour = new List<Unit>();
    public readonly List<Unit> Infantry = new List<Unit>();

    /// <summary>Where the seam runs. Set by the battlefield.</summary>
    public System.Func<float, float> FrontlineAt = _ => 0f;
    /// <summary>Signed trade flow: &gt;0 means the bulls are pushing.</summary>
    public float Flow;

    readonly System.Random _rng;
    /// <summary>Own clock, so the logic runs identically in a test and in a scene.</summary>
    public float Time { get; private set; }

    public Army(int seed = 0) { _rng = new System.Random(seed); }

    float Rand(float a, float b) => a + (float)_rng.NextDouble() * (b - a);

    /// <summary>Establishment per side. Losses are made good against this.</summary>
    public int ArmourPerSide { get; private set; }
    public int InfantryPerSide { get; private set; }

    /// <summary>
    /// Seconds between replacements when a side is one tank short. A bigger
    /// deficit brings them faster - see Reinforce.
    /// </summary>
    public float ReinforceSeconds = 6f;
    readonly Dictionary<Side, float> _reinforceAt = new Dictionary<Side, float>
    {
        { Side.Bull, 0f }, { Side.Bear, 0f },
    };

    /// <summary>Riflemen are cheaper than tanks, and there are far more of them.</summary>
    public float InfantryReinforceSeconds = 2.5f;
    readonly Dictionary<Side, float> _infantryAt = new Dictionary<Side, float>
    {
        { Side.Bull, 0f }, { Side.Bear, 0f },
    };

    public int ArmourOf(Side side)
    {
        int n = 0;
        foreach (var v in Armour) if (v.side == side) n++;
        return n;
    }

    public void Populate(int armourPerSide, int infantryPerSide)
    {
        ArmourPerSide = armourPerSide;
        InfantryPerSide = infantryPerSide;
        Armour.Clear(); Infantry.Clear();
        foreach (Side side in new[] { Side.Bull, Side.Bear })
        {
            for (int i = 0; i < armourPerSide; i++) Armour.Add(Spawn(side, true));
            for (int i = 0; i < infantryPerSide; i++) Infantry.Add(Spawn(side, false));
        }
    }

    /// <summary>Squad anchors along the front, per side. Index is the squad id.</summary>
    readonly Dictionary<Side, List<float>> _squads = new Dictionary<Side, List<float>>
    {
        { Side.Bull, new List<float>() }, { Side.Bear, new List<float>() },
    };

    /// <summary>
    /// Roughly one squad per twelve men, spread along the front with uneven
    /// spacing - evenly spaced squads look as mechanical as evenly spaced men.
    /// </summary>
    void EnsureSquads(Side side, int strength)
    {
        var list = _squads[side];
        int want = Mathf.Max(3, strength / 12);
        while (list.Count < want)
            list.Add(Rand(-FrontX + 12f, FrontX - 12f));
    }

    Unit Spawn(Side side, bool vehicle)
    {
        float x = Rand(-FrontX + 8f, FrontX - 8f);
        float dir = side == Side.Bull ? 1f : -1f;

        // From the edge of the field, always.
        //
        // This used to be a random depth behind the line - 30 to 78 m for a
        // man, 46 to 76 for a tank - and reinforcements arrive DURING the
        // round, so at the near end of that range a squad simply appeared
        // thirty metres from the fighting, in plain view. Coming in off the
        // edge and walking up costs nothing: StepArmour and StepInfantry
        // already drive every unit towards the line on their own, so the
        // approach is the movement they would have made anyway.
        //
        // A metre or two of jitter so they do not arrive on one ruled line.
        float z = -dir * (HalfDepth - Rand(0f, 3f));
        var unit = new Unit
        {
            side = side, x = x, z = Mathf.Clamp(z, -HalfDepth, HalfDepth),
            hp = vehicle ? Rand(6f, 10f) : 1f,
            reload = Rand(0f, 3f),
            phase = Rand(0f, 6.283f),
            standoff = Rand(4f, 12f),
            heading = dir > 0 ? 0f : Mathf.PI,
        };

        if (!vehicle)
        {
            EnsureSquads(side, InfantryPerSide);
            var squads = _squads[side];
            unit.squad = _rng.Next(squads.Count);
            // a loose knot rather than a rank: wider across than deep, and
            // never the same shape twice
            unit.squadOffsetX = Rand(-9f, 9f);
            unit.squadOffsetZ = Rand(-5f, 5f);
            unit.height = Rand(0.92f, 1.08f);
            unit.pace = Rand(0.82f, 1.18f);
            unit.nextRest = Rand(2f, 9f);
            unit.drift = Rand(-1f, 1f);
            unit.x = Mathf.Clamp(squads[unit.squad] + unit.squadOffsetX, -FrontX + 4f, FrontX - 4f);
        }
        return unit;
    }

    /// <summary>
    /// Push two hulls apart. Returned as a pure helper because "tanks must not
    /// overlap" was the single most reported fault in the three.js build.
    /// </summary>
    public static void Separate(Unit a, Unit b)
    {
        float dx = b.x - a.x, dz = b.z - a.z;
        float d2 = dx * dx + dz * dz;
        float min = a.side == b.side ? FriendlySpacing : HostileSpacing;
        if (d2 <= 1e-4f || d2 >= min * min) return;
        float dist = Mathf.Sqrt(d2);
        float push = (min - dist) * 0.5f;
        float nx = dx / dist, nz = dz / dist;
        a.x -= nx * push; a.z -= nz * push;
        b.x += nx * push; b.z += nz * push;
    }

    /// <summary>Has the line moved past this unit? Then it is in ground it no longer holds.</summary>
    public static bool IsOverrun(Unit u, float frontZ)
        => (frontZ - u.z) * u.Dir < -OverrunDepth;

    /// <summary>Nearest live enemy, or null.</summary>
    public Unit NearestEnemy(Unit self, out float distSq)
    {
        Unit best = null; distSq = float.MaxValue;
        foreach (var o in Armour)
        {
            if (o.side == self.side || o.hp <= 0f) continue;
            float d = (o.x - self.x) * (o.x - self.x) + (o.z - self.z) * (o.z - self.z);
            if (d < distSq) { distSq = d; best = o; }
        }
        return best;
    }

    public void Update(float dt)
    {
        Time += dt;
        for (int i = 0; i < Armour.Count; i++)
            for (int j = i + 1; j < Armour.Count; j++)
                Separate(Armour[i], Armour[j]);

        foreach (var v in Armour) StepArmour(v, dt);
        foreach (var s in Infantry) StepInfantry(s, dt);
        DriftSquads(dt);
        StepHelicopters(dt);
        StepBombs(dt);
        AvoidWrecks();

        Armour.RemoveAll(u => u.hp <= 0f);
        Infantry.RemoveAll(u => u.hp <= 0f);
        Reinforce(dt);
    }

    /// <summary>
    /// Make good the losses.
    ///
    /// Without this a side simply runs out: armour dies in the duel and nothing
    /// replaces it, so drive past a battle, turn round, and one colour has no
    /// tanks left. They arrive from the rear on a cadence rather than popping
    /// in, so the line is fed rather than restored.
    /// </summary>
    void Reinforce(float dt)
    {
        foreach (Side side in new[] { Side.Bull, Side.Bear })
        {
            int deficit = ArmourPerSide - ArmourOf(side);
            if (deficit <= 0) continue;

            // A fixed cadence cannot recover from a collapse. Once a side is
            // losing it gets focused down, so a flat one-tank-per-six-seconds
            // is always behind: measured, green sat at 0-1 for five minutes
            // while red held eleven. Replacements come faster the worse it is,
            // which is also what a command actually does with a failing front.
            _reinforceAt[side] -= dt * deficit;
            if (_reinforceAt[side] > 0f) continue;
            _reinforceAt[side] = ReinforceSeconds;
            Armour.Add(Spawn(side, true));
        }

        // Infantry the same way, but on its own clock. Adding one per frame
        // whenever a side is short refills ninety men in under two seconds,
        // which reads as a line that cannot be hurt.
        foreach (Side side in new[] { Side.Bull, Side.Bear })
        {
            int deficit = InfantryPerSide - InfantryOf(side);
            if (deficit <= 0) continue;
            _infantryAt[side] -= dt * deficit;
            if (_infantryAt[side] > 0f) continue;
            _infantryAt[side] = InfantryReinforceSeconds;
            Infantry.Add(Spawn(side, false));
        }
    }

    /// <summary>Ground height under a point, so gunships hold a height over terrain.</summary>
    public System.Func<float, float, float> GroundAt = (_, __) => 0f;

    public void SendHelicopter(Side side)
    {
        float dir = Random.value < 0.5f ? 1f : -1f;
        var h = new Helicopter
        {
            side = side,
            dir = dir,
            // Enters from beyond the fighting, so it arrives rather than
            // appearing - but short of the depots, which it cannot fly through.
            x = dir > 0 ? -AirCorridorX : AirCorridorX,
            dropIn = Rand(1.5f, 4f),
        };
        h.z = FrontlineAt(h.x) - h.Dir * 26f;
        h.y = GroundAt(h.x, h.z) + 19f;
        h.yaw = dir > 0 ? Mathf.PI * 0.5f : -Mathf.PI * 0.5f;
        Helicopters.Add(h);
    }

    /// <summary>
    /// Squads drift along the front, so the shape of the line changes over a
    /// few minutes instead of being fixed at spawn.
    /// </summary>
    void DriftSquads(float dt)
    {
        foreach (var side in new[] { Side.Bull, Side.Bear })
        {
            var list = _squads[side];
            for (int i = 0; i < list.Count; i++)
            {
                float drift = Mathf.Sin(Time * 0.12f + i * 2.4f) * 3.6f * dt;
                list[i] = Mathf.Clamp(list[i] + drift, -FrontX + 12f, FrontX - 12f);
            }
        }
    }

    void StepHelicopters(float dt)
    {
        for (int i = Helicopters.Count - 1; i >= 0; i--)
        {
            var h = Helicopters[i];
            h.t += dt;

            // Run the length of the front, standing off on our own side.
            //
            // 20, not 30: at thirty a gunship crossed a 244 unit map in eight
            // seconds, and with a sortie every twenty-six there was something
            // in the air barely a third of the time - measured, and easy to
            // miss entirely. Slower means longer on station and more drops per
            // pass, without making air cover constant.
            const float Speed = 20f;
            float px = h.x, pz = h.z;
            h.x += h.dir * Speed * dt;

            float wantZ = FrontlineAt(h.x) - h.Dir * (26f + Mathf.Sin(h.t * 0.6f) * 9f);
            h.z += Mathf.Clamp(wantZ - h.z, -Speed * dt * 1.6f, Speed * dt * 1.6f);
            // low enough to read against the ground rather than vanish into sky
            float wantY = GroundAt(h.x, h.z) + 19f + Mathf.Sin(h.t * 0.9f) * 3f;
            h.y += (wantY - h.y) * (1f - Mathf.Exp(-2f * dt));

            // nose follows travel, and it banks in proportion to how hard it turns
            float vx = h.x - px, vz = h.z - pz;
            if (vx * vx + vz * vz > 1e-8f)
            {
                float want = Mathf.Atan2(vx, vz);
                float turn = Mathf.DeltaAngle(h.yaw * Mathf.Rad2Deg, want * Mathf.Rad2Deg) * Mathf.Deg2Rad;
                h.yaw = Mathf.LerpAngle(h.yaw * Mathf.Rad2Deg, want * Mathf.Rad2Deg,
                                        1f - Mathf.Exp(-3f * dt)) * Mathf.Deg2Rad;
                h.bank += (Mathf.Clamp(turn * 4.5f, -0.8f, 0.8f) - h.bank) * (1f - Mathf.Exp(-3.5f * dt));
            }

            // drop on what it passes, but only over enemy ground
            h.dropIn -= dt;
            if (h.dropIn <= 0f && Mathf.Abs(h.x) < FrontX)
            {
                h.dropIn = Rand(1.6f, 3.2f);
                Release(h);
            }

            // gone off the far side
            if (Mathf.Abs(h.x) > AirCorridorX) Helicopters.RemoveAt(i);
        }
    }

    void Release(Helicopter h)
    {
        float front = FrontlineAt(h.x);
        var bomb = new Bomb
        {
            side = h.side,
            x = h.x, y = h.y, z = h.z,
            // inherits the aircraft's speed, and is aimed across the seam
            vx = h.dir * 30f,
            vy = 0f,
            vz = Mathf.Sign(front - h.z) * Rand(10f, 22f),
        };
        Bombs.Add(bomb);
        BombReleased?.Invoke(bomb);
    }

    void StepBombs(float dt)
    {
        for (int i = Bombs.Count - 1; i >= 0; i--)
        {
            var b = Bombs[i];
            b.vy -= 9.81f * dt;
            b.x += b.vx * dt;
            b.y += b.vy * dt;
            b.z += b.vz * dt;

            float ground = GroundAt(b.x, b.z);
            if (b.y > ground) continue;

            b.y = ground;
            Detonate(b);
            Bombs.RemoveAt(i);
        }
    }

    /// <summary>
    /// A bomb is not a shell. It clears a circle: everyone inside dies, armour
    /// takes damage falling off with distance rather than a flat hit.
    /// </summary>
    void Detonate(Bomb b)
    {
        Bombed?.Invoke(new Vector2(b.x, b.z));

        float r2 = BombRadius * BombRadius;
        for (int i = Infantry.Count - 1; i >= 0; i--)
        {
            var u = Infantry[i];
            float dx = u.x - b.x, dz = u.z - b.z;
            if (dx * dx + dz * dz > r2) continue;
            u.hp = 0f;
            // thrown outward from the blast, not along a vehicle's line
            var away = new Vector2(dx, dz).normalized;
            Killed?.Invoke(u, away);
            Infantry.RemoveAt(i);
        }

        foreach (var v in Armour)
        {
            float dx = v.x - b.x, dz = v.z - b.z;
            float d2 = dx * dx + dz * dz;
            if (d2 > r2) continue;
            float falloff = 1f - Mathf.Sqrt(d2) / BombRadius;
            v.hp -= 12f * falloff;
            if (v.hp <= 0f) Destroyed?.Invoke(v);
        }
    }

    /// <summary>Push anyone standing inside a wreck back out of it.</summary>
    void AvoidWrecks()
    {
        if (Wrecks.Count == 0) return;
        foreach (var w in Wrecks)
        {
            float r = w.z;                     // x, y = position; z carries the radius
            void Clear(Unit u, float size)
            {
                float dx = u.x - w.x, dz = u.z - w.y;
                float d2 = dx * dx + dz * dz;
                float reach = r + size;
                if (d2 > reach * reach || d2 < 1e-4f) return;
                float d = Mathf.Sqrt(d2);
                float push = reach - d;
                u.x += dx / d * push;
                u.z += dz / d * push;
            }
            foreach (var v in Armour) Clear(v, 3.2f);
            foreach (var u in Infantry) Clear(u, 0.6f);
        }
    }

    void StepArmour(Unit v, float dt)
    {
        float front = FrontlineAt(v.x);
        float pressure = v.side == Side.Bull ? Flow : -Flow;
        var foe = NearestEnemy(v, out float foeD2);
        bool engaged = foe != null && foeD2 < 46f * 46f;

        float goalX, goalZ, speed = 7f + pressure * 2f;
        if (IsOverrun(v, front))
        {
            v.retreating = true;
            goalX = v.x + Mathf.Sin(v.phase) * 20f;
            goalZ = front - v.Dir * 34f;              // fall back behind our own line
            speed *= 1.35f;
        }
        else
        {
            v.retreating = false;
            goalX = engaged ? foe.x : v.x + Mathf.Sin(v.phase * 3f) * 26f;
            if (engaged && foeD2 < 24f * 24f) { goalZ = v.z - v.Dir * 6f; speed *= 0.35f; }
            else goalZ = front - v.Dir * 9f;          // push up to the line
        }

        goalX = Mathf.Clamp(goalX, -FrontX + 4f, FrontX - 4f);
        float gx = goalX - v.x, gz = goalZ - v.z;
        float gl = Mathf.Sqrt(gx * gx + gz * gz);
        if (gl > 0.6f)
        {
            float step = Mathf.Min(speed * dt, gl);
            float px = v.x, pz = v.z;
            v.x += gx / gl * step;
            v.z += gz / gl * step;
            // the hull turns into its line of advance instead of strafing
            float mvx = v.x - px, mvz = v.z - pz;
            if (mvx * mvx + mvz * mvz > dt * dt * 0.16f)
                v.heading = Mathf.LerpAngle(v.heading * Mathf.Rad2Deg,
                                Mathf.Atan2(mvx, mvz) * Mathf.Rad2Deg, 1f - Mathf.Exp(-2.2f * dt)) * Mathf.Deg2Rad;
        }

        v.x = Mathf.Clamp(v.x, -FrontX + 4f, FrontX - 4f);
        v.z = Mathf.Clamp(v.z, -HalfDepth, HalfDepth);
        v.phase += dt * 0.4f;

        // turret traverses in world space, independent of the hull
        float aim = engaged ? Mathf.Atan2(foe.x - v.x, foe.z - v.z)
                            : Mathf.Atan2(Mathf.Sin(v.phase) * 14f, (front + v.Dir * 20f) - v.z);
        v.turretYaw = Mathf.LerpAngle(v.turretYaw * Mathf.Rad2Deg, aim * Mathf.Rad2Deg,
                                      1f - Mathf.Exp(-2.6f * dt)) * Mathf.Deg2Rad;

        v.reload -= dt;
        if (engaged && v.reload <= 0f)
        {
            // Pressure is an edge, not an execution. Doubling both rate of
            // fire and damage compounds into annihilation the moment the tape
            // leans one way for any length of time.
            v.reload = Rand(1.4f, 3.2f) / (1f + Mathf.Max(0f, pressure) * 0.45f);
            bool connects = Random01() < 0.55f;        // near misses are part of the show

            // The truck outranks the other side's tanks as a target when it is
            // nearer than they are - it is in everybody's way and nobody's army.
            var at = new Vector2(foe.x, foe.z);
            bool onCourier = false;
            if (Courier.HasValue)
            {
                var c = Courier.Value;
                float cd = (c.x - v.x) * (c.x - v.x) + (c.y - v.z) * (c.y - v.z);
                float fd = (foe.x - v.x) * (foe.x - v.x) + (foe.z - v.z) * (foe.z - v.z);
                // Heat both widens the range the truck is noticed at and lets
                // it outrank a closer enemy: at full heat a tank will leave the
                // tank in front of it to shoot at the van.
                float reach = CourierRange * (1f + Heat * 1.4f);
                if (cd < reach * reach && cd < fd * (1f + Heat * 2.5f))
                { at = c; onCourier = true; }
            }

            // a miss still has to go somewhere, or the tracer would lie
            var impact = connects
                ? at
                : new Vector2(at.x + Rand(-5f, 5f), at.y + Rand(-5f, 5f));
            Fired?.Invoke(v, impact);

            if (onCourier)
            {
                if (connects) CourierHit?.Invoke(Rand(5f, 11f) * (1f + Heat * 0.6f));
                return;
            }
            if (connects)
            {
                foe.hp -= Rand(1.1f, 2.4f) * (1f + Mathf.Max(0f, pressure) * 0.25f);
                if (foe.hp <= 0f) Destroyed?.Invoke(foe);
            }
        }
    }

    void StepInfantry(Unit s, float dt)
    {
        float front = FrontlineAt(s.x);
        float goalZ = front - s.Dir * (s.standoff + s.squadOffsetZ);
        float dz = goalZ - s.z;

        // He stops now and then - to look, to take cover, for no reason at all.
        // A column that advances at an unbroken rate is the clearest tell that
        // nobody in it is deciding anything.
        if (s.restFor > 0f) s.restFor -= dt;
        else
        {
            s.nextRest -= dt;
            if (s.nextRest <= 0f && Mathf.Abs(dz) > 2f)
            {
                s.restFor = Rand(0.4f, 1.8f);
                s.nextRest = Rand(3f, 11f);
            }
        }
        bool halted = s.restFor > 0f;

        // and he does not hold one speed while moving: a small wave on his own
        // phase, so no two men are ever in step
        float gait = halted ? 0f : s.pace * (0.82f + 0.18f * Mathf.Sin(s.phase * 0.7f));
        float step = Mathf.Min(3.4f * gait * dt, Mathf.Abs(dz));
        s.z += Mathf.Sign(dz) * step;

        // hold station on his squad rather than wandering the whole front
        var squads = _squads[s.side];
        if (s.squad >= 0 && s.squad < squads.Count && !halted)
        {
            float goalX = squads[s.squad] + s.squadOffsetX;
            float toward = Mathf.Clamp(goalX - s.x, -2.4f * dt * s.pace, 2.4f * dt * s.pace);
            // curves in rather than marching straight at his mark
            s.x += toward + s.drift * 0.7f * dt;
        }
        s.x = Mathf.Clamp(s.x, -FrontX + 4f, FrontX - 4f);
        s.z = Mathf.Clamp(s.z, -HalfDepth, HalfDepth);
        s.phase += dt * 6f;

        // Face the way he is actually WALKING, not the way his side faces.
        // When the line moves over a man he has to fall back, and a fixed
        // heading left him reversing up the field playing a forward run.
        s.walking = !halted && Mathf.Abs(dz) > 0.6f;
        s.heading = s.walking
            ? (dz > 0f ? 0f : Mathf.PI)
            : (s.Dir > 0f ? 0f : Mathf.PI);      // dug in: face the enemy

        // --- rifle fire -----------------------------------------------------
        // Targets are acquired only when the shot goes off, not every frame:
        // a hundred and eighty men each scanning every other man every frame is
        // thirty thousand comparisons a frame for a decision that changes once
        // every couple of seconds.
        s.reload -= dt;
        if (s.reload > 0f) return;

        var foe = NearestEnemyInfantry(s, out float d2);
        if (foe == null || d2 > RifleRange * RifleRange)
        {
            s.reload = Rand(0.4f, 1.1f);        // nothing in range; look again shortly
            return;
        }

        float pressure = s.side == Side.Bull ? Flow : -Flow;
        s.reload = Rand(2.5f, 4.5f) / (1f + Mathf.Max(0f, pressure) * 0.45f);
        // only turn to the target while standing; a running man keeps his line
        if (!s.walking) s.heading = Mathf.Atan2(foe.x - s.x, foe.z - s.z);

        bool hit = Random01() < RifleHitChance * (1f + Mathf.Max(0f, pressure) * 0.25f);

        // riflemen switch to the truck on the same rule as the tanks
        var mark = new Vector2(foe.x, foe.z);
        bool atCourier = false;
        if (Courier.HasValue)
        {
            var c = Courier.Value;
            float cd = (c.x - s.x) * (c.x - s.x) + (c.y - s.z) * (c.y - s.z);
            float reach = RifleRange * (1f + Heat * 0.8f);
            if (cd < reach * reach && cd < d2 * (1f + Heat * 2.5f))
            { mark = c; atCourier = true; }
        }

        Shot?.Invoke(s, hit
            ? mark
            : new Vector2(mark.x + Rand(-3f, 3f), mark.y + Rand(-3f, 3f)));

        if (atCourier)
        {
            if (hit) CourierHit?.Invoke(Rand(1.5f, 3.5f));
            return;
        }
        if (hit)
        {
            foe.hp -= 1f;
            if (foe.hp <= 0f) Killed?.Invoke(foe, Vector2.zero);
        }
    }

    /// <summary>Nearest live enemy rifleman, or null.</summary>
    public Unit NearestEnemyInfantry(Unit self, out float distSq)
    {
        Unit best = null; distSq = float.MaxValue;
        foreach (var o in Infantry)
        {
            if (o.side == self.side || o.hp <= 0f) continue;
            float d = (o.x - self.x) * (o.x - self.x) + (o.z - self.z) * (o.z - self.z);
            if (d < distSq) { distSq = d; best = o; }
        }
        return best;
    }

    public int InfantryOf(Side side)
    {
        int n = 0;
        foreach (var u in Infantry) if (u.side == side) n++;
        return n;
    }

    float Random01() => (float)_rng.NextDouble();

    /// <summary>
    /// Get out of the courier's way.
    ///
    /// Without this the armies walk straight into the truck: the Army logic
    /// does not know it exists, and a kinematic body teleported into a dynamic
    /// one every frame jams the truck solid.
    ///
    /// Infantry steps aside. Armour does not - a tank is meant to be an
    /// obstacle - and is only pushed out of a DEEP overlap, which resolves the
    /// wedge without letting the truck shoulder tanks out of the way.
    ///
    /// Ported from clearPath in src/world/battlefield.js.
    /// </summary>
    public void ClearPath(float x, float z, float headingRadians, float dt,
                          float halfWidth = 7.5f, float ahead = 26f)
    {
        float dirX = Mathf.Cos(headingRadians), dirZ = Mathf.Sin(headingRadians);

        void YieldTo(Unit o, float rate, float size, bool stepsAside, float hard)
        {
            float ox = o.x - x, oz = o.z - z;
            float along = ox * dirX + oz * dirZ;      // down the truck's nose
            float across = -ox * dirZ + oz * dirX;    // out of its flank
            float lane = halfWidth + size;

            // anticipatory: still up the road, ease out of the corridor
            if (stepsAside && along > -4f && along < ahead && Mathf.Abs(across) < lane)
            {
                float need = lane - Mathf.Abs(across) + 0.6f;
                float urgency = 1f - Mathf.Max(0f, along) / ahead;
                float step = (across >= 0f ? 1f : -1f) * need * rate * (0.35f + urgency) * dt;
                o.x += -dirZ * step;
                o.z += dirX * step;
            }

            // last resort: undo genuine interpenetration, so nothing is left
            // standing INSIDE the truck at the end of a frame
            float d2 = ox * ox + oz * oz;
            if (d2 > 1e-4f && d2 < hard * hard)
            {
                float d = Mathf.Sqrt(d2);
                float push = hard - d;
                o.x += ox / d * push;
                o.z += oz / d * push;
            }
        }

        // ARMOUR IS DELIBERATELY ABSENT.
        //
        // Tanks carry colliders, so the physics engine already resolves them
        // against the truck. Resolving it here too is two systems arguing over
        // the same overlap every frame, and there is no radius that satisfies
        // both: large enough to clear the collider and the tank is shoved out
        // of the way, so the truck drives through it; small enough to block and
        // the box reaches into the truck while this thinks they are clear, so
        // the truck is pushed around by something it is not touching. Both
        // failures were measured. The engine owns this one.
        //
        // Infantry has no collider - it is meant to be driven through - so it
        // only gets nudged out of a deep overlap, purely so nobody is left
        // standing inside the cab.
        foreach (var u in Infantry) YieldTo(u, 0f, 0.9f, false, 1.6f);
    }

    /// <summary>
    /// Ride down anyone under the wheels.
    ///
    /// Only above a walking pace: a truck edging forward should not mow down a
    /// line it is merely touching, and a stationary one should not clear a
    /// space around itself. Returns how many went down.
    /// </summary>
    public int RunOver(float x, float z, float radius, float speed, Vector2 knock,
                       float minSpeed = 2.5f)
    {
        if (speed < minSpeed) return 0;
        int down = 0;
        float r2 = radius * radius;
        for (int i = Infantry.Count - 1; i >= 0; i--)
        {
            var u = Infantry[i];
            float dx = u.x - x, dz = u.z - z;
            if (dx * dx + dz * dz > r2) continue;
            u.hp = 0f;
            Killed?.Invoke(u, knock);
            Infantry.RemoveAt(i);
            down++;
        }
        return down;
    }

    /// <summary>A tank fired its main gun at another. Carries the impact point.</summary>
    public System.Action<Unit, Vector2> Fired;
    /// <summary>A rifleman fired. Carries the point aimed at.</summary>
    public System.Action<Unit, Vector2> Shot;
    /// <summary>A tank was destroyed.</summary>
    public System.Action<Unit> Destroyed;
    /// <summary>
    /// A rifleman went down. The vector is the knock he took: zero for a bullet,
    /// the vehicle's heading for someone ridden down, so the body can be thrown
    /// the way it was hit rather than folding on the spot.
    /// </summary>
    public System.Action<Unit, Vector2> Killed;
}
