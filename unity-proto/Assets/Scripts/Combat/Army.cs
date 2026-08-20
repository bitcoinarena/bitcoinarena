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
        /// +1 for bull, -1 for bear. Sign convention matters: every formula
        /// ported from battlefield.js is written as "front - dir * distance",
        /// so getting this backwards silently inverts advance, retreat and the
        /// overrun test all at once.
        /// </summary>
        public float Dir => side == Side.Bull ? 1f : -1f;
    }

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

    Unit Spawn(Side side, bool vehicle)
    {
        float x = Rand(-FrontX + 8f, FrontX - 8f);
        float dir = side == Side.Bull ? 1f : -1f;
        // arrives from the rear, well behind its own line
        float z = FrontlineAt(x) - dir * Rand(vehicle ? 46f : 30f, vehicle ? 76f : 78f);
        return new Unit
        {
            side = side, x = x, z = Mathf.Clamp(z, -HalfDepth, HalfDepth),
            hp = vehicle ? Rand(6f, 10f) : 1f,
            reload = Rand(0f, 3f),
            phase = Rand(0f, 6.283f),
            standoff = Rand(4f, 12f),
            heading = dir > 0 ? 0f : Mathf.PI,
        };
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
            // a miss still has to go somewhere, or the tracer would lie
            var impact = connects
                ? new Vector2(foe.x, foe.z)
                : new Vector2(foe.x + Rand(-5f, 5f), foe.z + Rand(-5f, 5f));
            Fired?.Invoke(v, impact);
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
        float goalZ = front - s.Dir * s.standoff;
        float dz = goalZ - s.z;
        float step = Mathf.Min(3.4f * dt, Mathf.Abs(dz));
        s.z += Mathf.Sign(dz) * step;
        s.x += Mathf.Sin(s.phase) * 1.6f * dt;
        s.x = Mathf.Clamp(s.x, -FrontX + 4f, FrontX - 4f);
        s.z = Mathf.Clamp(s.z, -HalfDepth, HalfDepth);
        s.phase += dt * 6f;

        // Face the way he is actually WALKING, not the way his side faces.
        // When the line moves over a man he has to fall back, and a fixed
        // heading left him reversing up the field playing a forward run.
        s.walking = Mathf.Abs(dz) > 0.6f;
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
        Shot?.Invoke(s, hit
            ? new Vector2(foe.x, foe.z)
            : new Vector2(foe.x + Rand(-3f, 3f), foe.z + Rand(-3f, 3f)));
        if (hit)
        {
            foe.hp -= 1f;
            if (foe.hp <= 0f) Killed?.Invoke(foe);
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
    public int RunOver(float x, float z, float radius, float speed, float minSpeed = 2.5f)
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
            Killed?.Invoke(u);
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
    /// <summary>A rifleman went down.</summary>
    public System.Action<Unit> Killed;
}
