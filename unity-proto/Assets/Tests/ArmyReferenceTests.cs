using System.Collections;
using System.Text;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// Records how the C# army behaves, so the port into the deterministic core
/// can be held to it rather than to a description of it.
///
/// The same approach the driving took, and for the same reason: the feel of
/// this army is not written down anywhere. It is 700 lines of tuned
/// behaviour - squads that drift, armour that pushes to the line and falls
/// back when overrun, infantry that closes and stops - and the only reliable
/// statement of what it does is what it does.
///
/// Prints a table; asserts nothing.
/// </summary>
public class ArmyReferenceTests
{
    [Test]
    [Explicit("Measurement, not an assertion. Read the ARMYREF lines out of " +
              "the log and paste them into packages/core/test/vectors/.")]
    public void MeasureTheArmy()
    {
        var sb = new StringBuilder();
        sb.AppendLine("ARMYREF BEGIN");

        // Three passes, one Unity launch, because the first one on its own
        // cannot answer the question the core is stuck on.
        //
        // The core loses two thirds of its armour in twenty seconds and then
        // stands still, while this recording holds 79-88% for ninety. That
        // looked like a firing or death fault - until Reinforce turned up:
        // this army REPLACES its dead, one tank per side per six seconds and
        // faster the further behind it is. `n` in the rows below is therefore
        // an establishment, not a survivor count, and no change to firing or
        // death can make an army without replacement match it.
        //
        //   reinforce  what the game actually fields, and what the current
        //              vector holds. Kept so the existing rows still line up.
        //   attrition  the same army with replacement switched off. THIS is
        //              the firing-and-death reference: with nothing refilling
        //              the line, `n` is survivorship and can be laid directly
        //              beside the core's.
        //   core-size  attrition again at the establishment the core actually
        //              fields - 12 armour and 36 infantry a side, because
        //              UNITS is 96 - so the comparison is not also a
        //              comparison of two differently sized armies.
        //   core-size-reinforce
        //              the one the core's own reinforcement is accepted
        //              against: its establishment AND its replacement. The
        //              24/72 figures cannot be a target for a 24-tank army,
        //              and reading them as one is the mistake that cost 2b
        //              four rounds.
        Pass(sb, "reinforce", 24, 72, reinforce: true);
        Pass(sb, "attrition", 24, 72, reinforce: false);
        Pass(sb, "core-size", 12, 36, reinforce: false);
        Pass(sb, "core-size-reinforce", 12, 36, reinforce: true);

        sb.AppendLine("ARMYREF END");
        Debug.Log(sb.ToString());
    }

    /// <summary>
    /// One recorded run. Same world every time - flat, still, no truck - so
    /// the only difference between the passes is the one named in the tag.
    /// </summary>
    static void Pass(StringBuilder sb, string tag, int armourPerSide, int infantryPerSide, bool reinforce)
    {
        // A flat, still world: the seam down the middle, no trade flow, no
        // truck. Everything that moves here is the army's own doing.
        var army = new Army(20260901);
        army.FrontlineAt = _ => 0f;
        army.GroundAt = (x, z) => 0f;
        army.Flow = 0f;

        // Off by pushing the cadence past the run rather than by editing
        // Army: a measurement that needs the thing it measures modified is
        // one more thing that can be wrong.
        if (!reinforce)
        {
            army.ReinforceSeconds = 1e9f;
            army.InfantryReinforceSeconds = 1e9f;
        }

        // Every tank that dies, counted as it dies. With replacement on, the
        // headcount hides this completely: the recording sits at 19-21 of 24
        // while the army is losing one every few seconds and refilling.
        int armourLost = 0;
        army.Destroyed += _ => armourLost++;

        army.Populate(armourPerSide, infantryPerSide);

        sb.AppendLine($"ARMYREF RUN tag={tag} armourPerSide={armourPerSide} " +
                      $"infantryPerSide={infantryPerSide} reinforce={(reinforce ? "on" : "off")} " +
                      $"seed=20260901");
        sb.AppendLine($"ARMYREF spawn armour={army.Armour.Count} infantry={army.Infantry.Count}");
        Row(sb, army, 0f, tag, armourLost);

        const float dt = 1f / 60f;
        for (int step = 1; step <= 60 * 90; step++)
        {
            army.Update(dt);
            if (step % (60 * 5) == 0) Row(sb, army, step * dt, tag, armourLost);
        }
    }

    /// <summary>
    /// One line of the table: where each side's units are relative to the
    /// seam, how fast they are closing, and how many are still alive.
    /// </summary>
    static void Row(StringBuilder sb, Army army, float t, string tag, int armourLost)
    {
        Stats(army.Armour, Army.Side.Bull, out float av, out float ad, out int an);
        Stats(army.Armour, Army.Side.Bear, out float bv, out float bd, out int bn);
        Stats(army.Infantry, Army.Side.Bull, out float iv, out float idd, out int inn);
        Stats(army.Infantry, Army.Side.Bear, out float jv, out float jd, out int jn);

        // What the core cannot reproduce yet: the DEPTH of the front. Reported
        // as the spread of |z - seam| per side, plus how many enemies each
        // tank has inside gun range, because those two numbers together are
        // what decides whether a fight is a grind or one collision.
        Density(army, out float dens, out float xspread);
        Concentration(army, out float per, out int worst, out int shooters);

        // Three numbers the old recording did not carry, and the core's whole
        // disagreement lives in them:
        //   tanksAlive minus shooters is how many tanks have NOTHING in range.
        //     When that reaches the headcount the fight is over whatever the
        //     survivor count says - which is where the core sits from t=34.
        //   lost is real deaths, not headcount.
        //   arrived is how many replacements walked on to keep the line up.
        int alive = an + bn;
        int arrived = alive + armourLost - army.ArmourPerSide * 2;
        sb.AppendLine($"ARMYREF density tag={tag} t={t:0.0} inRange={dens:0.00} xspread={xspread:0.0} " +
                      $"shooters={shooters} perTarget={per:0.00} worst={worst} " +
                      $"tanksAlive={alive} lost={armourLost} arrived={arrived}");

        sb.AppendLine($"ARMYREF t={t:0.0} tag={tag} " +
                      $"bullArmour n={an} z={ad:0.00} spread={av:0.00} " +
                      $"bearArmour n={bn} z={bd:0.00} spread={bv:0.00} " +
                      $"bullInf n={inn} z={idd:0.00} spread={iv:0.00} " +
                      $"bearInf n={jn} z={jd:0.00} spread={jv:0.00}");
    }

    /// <summary>Mean enemies inside 46 m, and how far the armour is spread along x.</summary>
    static void Density(Army army, out float inRange, out float xSpread)
    {
        float total = 0f; int n = 0;
        var xs = new System.Collections.Generic.List<float>();
        foreach (var a in army.Armour)
        {
            if (a.hp <= 0f) continue;
            xs.Add(a.x);
            int c = 0;
            foreach (var b in army.Armour)
            {
                if (b == a || b.hp <= 0f || b.side == a.side) continue;
                float dx = b.x - a.x, dz = b.z - a.z;
                if (dx * dx + dz * dz < 46f * 46f) c++;
            }
            total += c; n++;
        }
        inRange = n > 0 ? total / n : 0f;

        float m = 0f;
        foreach (var x in xs) m += x;
        m = xs.Count > 0 ? m / xs.Count : 0f;
        float v = 0f;
        foreach (var x in xs) v += (x - m) * (x - m);
        xSpread = xs.Count > 1 ? Mathf.Sqrt(v / xs.Count) : 0f;
    }

    /// <summary>
    /// How concentrated the fire is: shooters per target, and the worst case.
    ///
    /// Every tank shoots at its nearest enemy, so several can pick the same
    /// one. That is the difference between an army that grinds and one that
    /// evaporates, and it is the quantity the core is being compared on.
    /// </summary>
    static void Concentration(Army army, out float perTarget, out int worst, out int shooters)
    {
        var hits = new System.Collections.Generic.Dictionary<Army.Unit, int>();
        shooters = 0;
        foreach (var a in army.Armour)
        {
            if (a.hp <= 0f) continue;
            Army.Unit best = null; float bd = 46f * 46f;
            foreach (var b in army.Armour)
            {
                if (b == a || b.hp <= 0f || b.side == a.side) continue;
                float d = (b.x - a.x) * (b.x - a.x) + (b.z - a.z) * (b.z - a.z);
                if (d < bd) { bd = d; best = b; }
            }
            if (best == null) continue;
            shooters++;
            hits.TryGetValue(best, out int c);
            hits[best] = c + 1;
        }
        worst = 0;
        foreach (var c in hits.Values) worst = Mathf.Max(worst, c);
        perTarget = hits.Count > 0 ? (float)shooters / hits.Count : 0f;
    }

    static void Stats(System.Collections.Generic.List<Army.Unit> units, Army.Side side,
                      out float spread, out float meanZ, out int alive)
    {
        float sum = 0f; alive = 0;
        foreach (var u in units)
        {
            if (u.side != side || u.hp <= 0f) continue;
            sum += u.z; alive++;
        }
        meanZ = alive > 0 ? sum / alive : 0f;

        float var2 = 0f;
        foreach (var u in units)
        {
            if (u.side != side || u.hp <= 0f) continue;
            float d = u.z - meanZ; var2 += d * d;
        }
        spread = alive > 1 ? Mathf.Sqrt(var2 / alive) : 0f;
    }
}
