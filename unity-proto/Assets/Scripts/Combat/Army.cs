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

    public enum Side { Bull = -1, Bear = 1 }

    public class Unit
    {
        public Side side;
        public float x, z;
        public float heading, turretYaw;
        public float hp, reload, phase;
        public bool retreating;
        /// <summary>+1 for bear (holds the +z side), -1 for bull.</summary>
        public float Dir => side == Side.Bull ? -1f : 1f;
    }

    public readonly List<Unit> Armour = new List<Unit>();
    public readonly List<Unit> Infantry = new List<Unit>();

    /// <summary>Where the seam runs. Set by the battlefield.</summary>
    public System.Func<float, float> FrontlineAt = _ => 0f;
    /// <summary>Signed trade flow: &gt;0 means the bulls are pushing.</summary>
    public float Flow;

    readonly System.Random _rng;

    public Army(int seed = 0) { _rng = new System.Random(seed); }

    float Rand(float a, float b) => a + (float)_rng.NextDouble() * (b - a);

    public void Populate(int armourPerSide, int infantryPerSide)
    {
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
        float dir = side == Side.Bull ? -1f : 1f;
        // arrives from the rear, well behind its own line
        float z = FrontlineAt(x) + dir * Rand(vehicle ? 46f : 30f, vehicle ? 76f : 78f);
        return new Unit
        {
            side = side, x = x, z = Mathf.Clamp(z, -HalfDepth, HalfDepth),
            hp = vehicle ? Rand(6f, 10f) : 1f,
            reload = Rand(0f, 3f),
            phase = Rand(0f, 6.283f),
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
        for (int i = 0; i < Armour.Count; i++)
            for (int j = i + 1; j < Armour.Count; j++)
                Separate(Armour[i], Armour[j]);

        foreach (var v in Armour) StepArmour(v, dt);
        foreach (var s in Infantry) StepInfantry(s, dt);

        Armour.RemoveAll(u => u.hp <= 0f);
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
            v.reload = Rand(1.4f, 3.2f) / (1f + Mathf.Max(0f, pressure));
            LastShot = (v, foe);
            if (Random01() < 0.55f)                    // near misses are part of the show
            {
                foe.hp -= Rand(1.1f, 2.4f) * (1f + Mathf.Max(0f, pressure) * 0.6f);
                if (foe.hp <= 0f) Destroyed?.Invoke(foe);
            }
        }
    }

    void StepInfantry(Unit s, float dt)
    {
        float front = FrontlineAt(s.x);
        float goalZ = front - s.Dir * Rand(4f, 12f);
        float dz = goalZ - s.z;
        float step = Mathf.Min(3.4f * dt, Mathf.Abs(dz));
        s.z += Mathf.Sign(dz) * step;
        s.x += Mathf.Sin(s.phase + Time.time * 0.2f) * 1.6f * dt;
        s.x = Mathf.Clamp(s.x, -FrontX + 4f, FrontX - 4f);
        s.z = Mathf.Clamp(s.z, -HalfDepth, HalfDepth);
        s.heading = Mathf.Atan2(0f, -s.Dir);
        s.phase += dt * 6f;
    }

    float Random01() => (float)_rng.NextDouble();

    /// <summary>Last shell fired, for the renderer to draw a tracer.</summary>
    public (Unit from, Unit at)? LastShot;
    public System.Action<Unit> Destroyed;
}
