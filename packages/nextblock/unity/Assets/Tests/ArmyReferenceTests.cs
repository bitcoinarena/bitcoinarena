// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
              "the log and paste them into packages/nextblock/test/vectors/.")]
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
    internal static void Row(StringBuilder sb, Army army, float t, string tag, int armourLost)
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
                      $"tanksAlive={alive} lost={armourLost} arrived={arrived} " +
                      $"xbands={XBands(army)}");

        sb.AppendLine($"ARMYREF t={t:0.0} tag={tag} " +
                      $"bullArmour n={an} z={ad:0.00} spread={av:0.00} " +
                      $"bearArmour n={bn} z={bd:0.00} spread={bv:0.00} " +
                      $"bullInf n={inn} z={idd:0.00} spread={iv:0.00} " +
                      $"bearInf n={jn} z={jd:0.00} spread={jv:0.00}");
    }

    /// <summary>Mean enemies inside 46 m, and how far the armour is spread along x.</summary>
    /// <summary>
    /// The armour's |x| in the bands the core is measured in.
    ///
    /// `xSpread` is a standard deviation, and a standard deviation cannot tell
    /// a peak with stragglers from a flat spread: seventeen of twenty tanks
    /// inside |x| &lt; 31 with three at +-90 gives sd 35, and so does an even
    /// spread over +-60. The core reproduces this pass's xSpread to within a
    /// metre and still puts less than half as many tanks near a point, so the
    /// disagreement is the SHAPE and nothing published here could see it.
    ///
    /// Reads `Armour` and draws nothing. That matters: `Shot?.Invoke` and
    /// `CourierHit?.Invoke` build their arguments inside the `?.`, so
    /// SUBSCRIBING to them draws random numbers and makes a different battle.
    /// Counting positions touches no event and no RNG, so these rows belong to
    /// the same run as the ones beside them.
    /// </summary>
    static readonly float[] XBandEdges = { 10f, 20f, 31f, 45f, 60f, 80f };

    static string XBands(Army army)
    {
        var n = new int[XBandEdges.Length + 1];
        int total = 0;
        foreach (var a in army.Armour)
        {
            if (a.hp <= 0f) continue;
            total++;
            float ax = Mathf.Abs(a.x);
            int b = XBandEdges.Length;
            for (int i = 0; i < XBandEdges.Length; i++)
                if (ax < XBandEdges[i]) { b = i; break; }
            n[b]++;
        }
        var sb = new StringBuilder();
        for (int i = 0; i < n.Length; i++) sb.Append(i == 0 ? "" : ",").Append(n[i]);
        return sb + $" of={total}";
    }

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

/// <summary>
/// Records what the C# INFANTRY does, which nothing has ever asked it.
///
/// `csharp-army.json` carries `n`, `z` and `spread` for the riflemen and
/// nothing else - no death causes, no nearest-enemy distance, no rifle fire,
/// no courier fire. Every quantity argued over in PRIORITIES so far is an
/// armour quantity, and the core's infantry has therefore never been held to
/// anything: it has no rifleman-on-rifleman fire at all, and it keeps a hard
/// 24 m floor between the two lines that this army does not have.
///
/// Recorded now because item (e) deletes Army.cs, and with it every chance to
/// ask. Same conditions as MeasureTheArmy - flat, still, seam at zero, seed
/// 20260901, ninety seconds, sampled every five - so the two recordings can be
/// read together.
///
/// Prints a table; asserts nothing.
/// </summary>
public class InfantryReferenceTests
{
    [Test]
    [Explicit("Measurement, not an assertion. Read the INFREF lines out of " +
              "the log and paste them into packages/nextblock/test/vectors/.")]
    public void MeasureTheInfantry()
    {
        var sb = new StringBuilder();
        sb.AppendLine("INFREF BEGIN");

        // line       the establishment the core actually fields, with the
        //            replacement it actually runs. The pass its infantry is
        //            to be accepted against.
        // line-24-72 the same at the size the game ships, so this recording
        //            can be read beside the existing 24/72 rows.
        // courier    a truck parked on the seam and left there. The core
        //            fires at the truck from every unit that has it inside 26
        //            m for a flat one hit point; this army fires at it from
        //            riflemen (1.5-3.5) and from TANKS (5-11, at 34 m), and
        //            only when the shooter already has a foe in range and the
        //            truck is closer than that foe. Truck damage is M1's, so
        //            the rule needs a number and not a reading of the source.
        Line(sb, "line", 12, 36, 20260901);
        Line(sb, "line-24-72", 24, 72, 20260901);
        Courier(sb, "courier", 12, 36);

        // THE SAME FOUR SEEDS THE CORE MEASURES ON, because the line turns out
        // to be seed-sensitive and a one-seed reference cannot say whether that
        // is a fault. Three squad anchors a side, drawn at random x
        // independently per side, sometimes land far apart - and then the two
        // lines never meet at all. Whether that is a fault or the army's own
        // behaviour is a question about the C#, and only the C# can answer it.
        Line(sb, "line-20260902", 12, 36, 20260902);
        Line(sb, "line-20260903", 12, 36, 20260903);
        Line(sb, "line-20260904", 12, 36, 20260904);

        sb.AppendLine("INFREF END");
        Debug.Log(sb.ToString());
    }

    /// <summary>The same world every pass: flat, still, seam down the middle.</summary>
    static Army World(int armourPerSide, int infantryPerSide, int seed = 20260901)
    {
        var army = new Army(seed);
        army.FrontlineAt = _ => 0f;
        army.GroundAt = (x, z) => 0f;
        army.Flow = 0f;
        army.Heat = 0f;
        army.Populate(armourPerSide, infantryPerSide);
        return army;
    }

    /// <summary>
    /// The infantry line with nobody to shoot at but each other.
    ///
    /// No truck and no aircraft, so every Killed in this pass is a bullet:
    /// Detonate and RunOver are the only other callers and neither can fire
    /// here. That is what makes `kills` a rifle death count rather than a
    /// headcount difference, which replacement hides completely.
    /// </summary>
    static void Line(StringBuilder sb, string tag, int armourPerSide, int infantryPerSide, int seed)
    {
        var army = World(armourPerSide, infantryPerSide, seed);

        // NOT subscribed to `Shot`, and that is not an omission.
        //
        //     Shot?.Invoke(s, hit ? mark
        //                        : new Vector2(mark.x + Rand(-3f, 3f), ...));
        //
        // The scatter on a miss is drawn INSIDE the argument, so `?.` skips it
        // when nobody is listening and draws it when somebody is. Subscribing
        // moves the whole RNG stream: the first version of this pass carried a
        // shot counter and its rows walked away from the stored recording from
        // about t=25, which is exactly when the first shot is fired. With the
        // counter gone the rows reproduce `passes.core-size-reinforce` to the
        // digit, which is the check that this pass measures the same run the
        // army recording did.
        //
        // `Killed` and `Destroyed` are safe - their arguments draw nothing.
        int killsBull = 0, killsBear = 0;
        army.Killed += (u, knock) =>
        {
            if (u.side == Army.Side.Bull) killsBull++; else killsBear++;
        };

        sb.AppendLine($"INFREF RUN tag={tag} armourPerSide={armourPerSide} " +
                      $"infantryPerSide={infantryPerSide} reinforce=on courier=none seed={seed}");
        Row(sb, army, tag, 0f, killsBull, killsBear);

        const float dt = 1f / 60f;
        for (int step = 1; step <= 60 * 90; step++)
        {
            army.Update(dt);
            if (step % (60 * 5) == 0) Row(sb, army, tag, step * dt, killsBull, killsBear);
        }
    }

    /// <summary>
    /// One line of the infantry table.
    ///
    /// `nearestPair` is the quantity the core is furthest from and the one no
    /// recording had: the closest any two opposing riflemen come. The core
    /// backs a man off whenever an enemy is inside 24 m and applies it to
    /// riflemen, so its answer is 24.0 at every sample of every seed - which
    /// is wider than the 16 m blast, and is why no bomb in the core can ever
    /// catch men from both sides.
    /// </summary>
    static void Row(StringBuilder sb, Army army, string tag, float t,
                    int killsBull, int killsBear)
    {
        Stats(army.Infantry, Army.Side.Bull, out float bullSpread, out float bullZ, out int bullN);
        Stats(army.Infantry, Army.Side.Bear, out float bearSpread, out float bearZ, out int bearN);
        Contact(army, out float nearestPair, out float meanNearest, out int inRifleRange);

        sb.AppendLine($"INFREF t={t:0.0} tag={tag} " +
                      $"bullInf n={bullN} z={bullZ:0.00} spread={bullSpread:0.00} " +
                      $"bearInf n={bearN} z={bearZ:0.00} spread={bearSpread:0.00} " +
                      $"nearestPair={nearestPair:0.00} meanNearest={meanNearest:0.00} " +
                      $"inRifleRange={inRifleRange} " +
                      $"killsBull={killsBull} killsBear={killsBear}");
    }

    /// <summary>
    /// A truck parked on the seam, and what the army does to it.
    ///
    /// Split by size of hit rather than by source, because CourierHit carries
    /// only the amount - and the two ranges are disjoint: a rifle takes 1.5 to
    /// 3.5 and a tank 5 to 11, with Heat at zero.
    /// </summary>
    static void Courier(StringBuilder sb, string tag, int armourPerSide, int infantryPerSide)
    {
        var army = World(armourPerSide, infantryPerSide);
        var at = new Vector2(0f, 0f);
        army.Courier = at;

        // CourierHit draws its amount INSIDE the argument the same way Shot
        // draws its scatter - `Rand(5f, 11f)` for a tank, `Rand(1.5f, 3.5f)`
        // for a rifle - so listening to it moves the stream. Listened to
        // anyway, because that is the game's own condition: Bootstrap wires
        // this event to TruckHealth.Damage. It does mean this pass is its own
        // run and its positions are not the `line` pass's.
        int rifleHits = 0, tankHits = 0;
        float rifleDmg = 0f, tankDmg = 0f;
        army.CourierHit += amount =>
        {
            if (amount < 4.5f) { rifleHits++; rifleDmg += amount; }
            else { tankHits++; tankDmg += amount; }
        };

        sb.AppendLine($"INFREF RUN tag={tag} armourPerSide={armourPerSide} " +
                      $"infantryPerSide={infantryPerSide} reinforce=on courier=0,0 seed=20260901");

        const float dt = 1f / 60f;
        for (int step = 1; step <= 60 * 90; step++)
        {
            army.Update(dt);
            if (step % (60 * 5) != 0) continue;

            // How many could have fired at it, so the core can be compared on
            // the RATE and not only on the total: a truck standing in a
            // thinner crowd takes less fire for the same rule.
            int inRifle = 0, inTank = 0;
            foreach (var u in army.Infantry)
            {
                if (u.hp <= 0f) continue;
                float dx = u.x - at.x, dz = u.z - at.y;
                if (dx * dx + dz * dz < Army.RifleRange * Army.RifleRange) inRifle++;
            }
            foreach (var u in army.Armour)
            {
                if (u.hp <= 0f) continue;
                float dx = u.x - at.x, dz = u.z - at.y;
                if (dx * dx + dz * dz < Army.CourierRange * Army.CourierRange) inTank++;
            }

            // The denominator, published at last. `inTank` on its own says how
            // many tanks are at the truck and not what share of the army that
            // is, so every reader of it so far has had to guess an alive count
            // - `Populate(12, 36)` is the establishment at t=0, not the count
            // ninety seconds later, and reading it as one put a 71% in
            // PRIORITIES that was never measured. Both counters are reads over
            // the lists the loop above already walks; nothing here draws.
            int tanksAlive = 0, menAlive = 0;
            foreach (var u in army.Armour) if (u.hp > 0f) tanksAlive++;
            foreach (var u in army.Infantry) if (u.hp > 0f) menAlive++;

            sb.AppendLine($"INFREF courier t={step * dt:0.0} tag={tag} " +
                          $"tanksAlive={tanksAlive} menAlive={menAlive} " +
                          $"rifleHits={rifleHits} rifleDmg={rifleDmg:0.00} " +
                          $"tankHits={tankHits} tankDmg={tankDmg:0.00} " +
                          $"totalDmg={rifleDmg + tankDmg:0.00} " +
                          $"inRifle={inRifle} inTank={inTank}");
        }
    }

    /// <summary>Closest opposing pair, mean nearest enemy, and how many have one in range.</summary>
    static void Contact(Army army, out float nearestPair, out float meanNearest, out int inRange)
    {
        nearestPair = float.MaxValue;
        float sum = 0f; int n = 0;
        inRange = 0;

        foreach (var a in army.Infantry)
        {
            if (a.hp <= 0f) continue;
            float best = float.MaxValue;
            foreach (var b in army.Infantry)
            {
                if (b.hp <= 0f || b.side == a.side) continue;
                float dx = b.x - a.x, dz = b.z - a.z;
                float d2 = dx * dx + dz * dz;
                if (d2 < best) best = d2;
            }
            if (best == float.MaxValue) continue;
            best = Mathf.Sqrt(best);
            if (best < nearestPair) nearestPair = best;
            if (best < Army.RifleRange) inRange++;
            sum += best; n++;
        }

        if (n == 0) { nearestPair = 0f; meanNearest = 0f; return; }
        meanNearest = sum / n;
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
