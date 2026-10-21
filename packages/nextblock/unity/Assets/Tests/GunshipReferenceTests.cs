// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using System.Text;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// Records what the air arm actually does, so 2d's second half can be held to
/// a measurement rather than to the code read out loud.
///
/// Same method as ArmyReferenceTests, and for the same reason: nothing about
/// gunships and bombs is written down. What IS written down - "one every
/// twenty-odd seconds per side is an event you look up for" - is a design
/// intent, not a count, and the last four rounds of item 2 went at the wrong
/// quantity because a description stood in for a number.
///
/// Three things this measures that reading the code cannot answer:
///
///   how much of a sortie is wasted. A gunship enters at |x| = 104, may only
///   drop inside |x| &lt; 92, and its bomb is thrown 30 m/s along its own track
///   before it falls. How many bombs land where there is nobody is a number,
///   and the loop that produces it has three gates in it.
///
///   what a bomb is worth against armour. hp is Rand(6,10) and the blast is
///   12 * (1 - d/16), so a tank dies inside about 8 m of centre and survives
///   outside it. Whether that ever happens depends on where tanks actually
///   stand when a bomb lands, which is not derivable.
///
///   whether air changes the ground fight at all. The paired no-air control
///   is the only way to read that: bombs also consume Army's own _rng, so an
///   air pass and a no-air pass on one seed do not share a ground battle.
///
/// Prints a table; asserts nothing.
/// </summary>
public class GunshipReferenceTests
{
    /// <summary>The recording's seed, and three more, because ~40 bombs on one seed is a sample.</summary>
    static readonly int[] Seeds = { 20260901, 20260902, 20260903, 20260904 };

    /// <summary>Battlefield.cs:51. Read out of the C#, not assumed.</summary>
    const float SortieSeconds = 17f;

    [Test]
    [Explicit("Measurement, not an assertion. Read the GUNREF/ARMYREF lines out " +
              "of the log and paste them into packages/nextblock/test/vectors/.")]
    public void MeasureTheGunships()
    {
        var sb = new StringBuilder();
        sb.AppendLine("GUNREF BEGIN");
        sb.AppendLine("GUNREF setup seam=0 flat=yes courier=none dt=1/60 duration=90 " +
                      "armourPerSide=12 infantryPerSide=36 reinforce=on " +
                      $"sortieSeconds={SortieSeconds} jitter=0.7-1.4 " +
                      "order=Update-then-LaunchSorties bombRadius=16 armourHp=6-10");

        // Paired, and the no-air pass first on each seed so the control cannot
        // be quietly tuned to the air pass. noair-20260901 is config-identical
        // to passes.core-size-reinforce in csharp-army.json: if its rows do not
        // reproduce that vector exactly, this harness is wrong and nothing
        // below it counts.
        foreach (int seed in Seeds) Pass(sb, $"noair-{seed}", seed, sorties: false);
        foreach (int seed in Seeds) Pass(sb, $"gunships-{seed}", seed, sorties: true);

        sb.AppendLine("GUNREF END");
        Debug.Log(sb.ToString());
    }

    /// <summary>One bomb, from release to what it was worth.</summary>
    class Blast
    {
        public float t, x, z;
        public Army.Side side;
        public int infIn, armourIn;          // inside the radius when it went off
        public int infKilled, infBull, infBear, armourKilled;
        public int infDouble, armourDouble;  // events for units already dead
    }

    static void Pass(StringBuilder sb, string tag, int seed, bool sorties)
    {
        // The same world ArmyReferenceTests records in: flat, still, seam at
        // zero, no truck. Everything that moves is the army's own doing.
        var army = new Army(seed);
        army.FrontlineAt = _ => 0f;
        army.GroundAt = (x, z) => 0f;
        army.Flow = 0f;
        army.Courier = null;

        // The sortie clock and the gunship's direction are on UnityEngine.Random,
        // NOT on Army's seeded _rng (Army.cs:393, Battlefield.cs:171). Without
        // this line the air arm is unreproducible from a seed - which is also a
        // finding for the port, not just a detail of the measurement.
        Random.InitState(seed);

        // --- what the run is counted with -----------------------------------
        //
        // Public surface only: four events and the public lists. Nothing here
        // reaches into Army, and Army is not modified.
        int armourLost = 0, riflemenKilled = 0, shellKills = 0;
        int armourDoubleTotal = 0, infDoubleTotal = 0, ambiguousBombs = 0;
        var blasts = new List<Blast>();
        var sortieLines = new List<string>();

        // Detonate fires Bombed FIRST, then Killed/Destroyed for everyone in
        // the circle (Army.cs:513-539). Update's order is StepArmour,
        // StepInfantry, StepHelicopters, StepBombs - so every death event after
        // a Bombed, within the same Update, belongs to that bomb. The bucket is
        // closed before each Update, which is what keeps the next frame's rifle
        // fire out of the last frame's blast.
        Blast bucket = null;

        // Detonate does NOT skip units already at hp <= 0, and RemoveAll only
        // runs at the end of Update - so a tank killed by a shell earlier in
        // the same frame, or by an earlier bomb in the same frame, fires
        // Destroyed a second time. Counted deduped, with the double-fires
        // reported, because an undeduped bomb tally would be inflated by
        // exactly the bombs that land on a fight already going badly.
        var deadArmour = new HashSet<Army.Unit>();
        var deadInfantry = new HashSet<Army.Unit>();

        army.Bombed += p =>
        {
            // The detonating bomb is still in the list while Bombed runs, so
            // its side is readable without touching Army.
            Army.Side side = Army.Side.Bull; int matches = 0;
            foreach (var b in army.Bombs)
                if (b.x == p.x && b.z == p.y) { if (matches == 0) side = b.side; matches++; }
            if (matches != 1) ambiguousBombs++;

            var blast = new Blast { t = army.Time, x = p.x, z = p.y, side = side };
            float r2 = Army.BombRadius * Army.BombRadius;
            foreach (var u in army.Infantry)
            {
                if (u.hp <= 0f) continue;
                float dx = u.x - p.x, dz = u.z - p.y;
                if (dx * dx + dz * dz <= r2) blast.infIn++;
            }
            foreach (var v in army.Armour)
            {
                if (v.hp <= 0f) continue;
                float dx = v.x - p.x, dz = v.z - p.y;
                if (dx * dx + dz * dz <= r2) blast.armourIn++;
            }
            blasts.Add(blast);
            bucket = blast;
        };

        army.Killed += (u, knock) =>
        {
            bool first = deadInfantry.Add(u);
            if (bucket != null)
            {
                if (!first) { bucket.infDouble++; infDoubleTotal++; return; }
                bucket.infKilled++;
                if (u.side == Army.Side.Bull) bucket.infBull++; else bucket.infBear++;
            }
            else if (first) riflemenKilled++;
        };

        army.Destroyed += v =>
        {
            bool first = deadArmour.Add(v);
            if (!first) { if (bucket != null) { bucket.armourDouble++; } armourDoubleTotal++; return; }
            armourLost++;
            if (bucket != null) bucket.armourKilled++; else shellKills++;
        };

        army.Populate(12, 36);

        sb.AppendLine($"GUNREF RUN tag={tag} seed={seed} air={(sorties ? "on" : "off")}");
        sb.AppendLine($"ARMYREF spawn armour={army.Armour.Count} infantry={army.Infantry.Count}");
        ArmyReferenceTests.Row(sb, army, 0f, tag, armourLost);

        const float dt = 1f / 60f;
        float sortieBull = 0f, sortieBear = 0f;
        int sortiesBull = 0, sortiesBear = 0;
        float airborneSeconds = 0f, bombsInAirSeconds = 0f;
        int peakAirborne = 0;

        for (int step = 1; step <= 60 * 90; step++)
        {
            bucket = null;
            army.Update(dt);

            // Battlefield.cs:120 - sorties are launched AFTER the step, so a
            // gunship first moves on the frame after it is sent.
            if (sorties)
            {
                float t = step * dt;
                sortieBull -= dt;
                sortieBear -= dt;
                if (sortieBull <= 0f)
                {
                    sortieBull = SortieSeconds * Random.Range(0.7f, 1.4f);
                    army.SendHelicopter(Army.Side.Bull);
                    sortiesBull++;
                    sortieLines.Add(Sortie(army, t, tag, "bull", sortieBull));
                }
                if (sortieBear <= 0f)
                {
                    sortieBear = SortieSeconds * Random.Range(0.7f, 1.4f);
                    army.SendHelicopter(Army.Side.Bear);
                    sortiesBear++;
                    sortieLines.Add(Sortie(army, t, tag, "bear", sortieBear));
                }
            }

            if (army.Helicopters.Count > 0) airborneSeconds += dt;
            if (army.Bombs.Count > 0) bombsInAirSeconds += dt;
            peakAirborne = Mathf.Max(peakAirborne, army.Helicopters.Count);

            if (step % (60 * 5) == 0)
            {
                float t = step * dt;
                ArmyReferenceTests.Row(sb, army, t, tag, armourLost);
                sb.AppendLine($"GUNREF air tag={tag} t={t:0.0} helis={army.Helicopters.Count} " +
                              $"bombsInAir={army.Bombs.Count} sorties={sortiesBull + sortiesBear} " +
                              $"bombs={blasts.Count} bombKills={Sum(blasts, b => b.infKilled)} " +
                              $"bombArmour={Sum(blasts, b => b.armourKilled)} lost={armourLost}");
            }
        }

        foreach (var line in sortieLines) sb.AppendLine(line);
        foreach (var b in blasts)
            sb.AppendLine($"GUNREF bomb tag={tag} t={b.t:0.0} side={(b.side == Army.Side.Bull ? "bull" : "bear")} " +
                          $"x={b.x:0.0} z={b.z:0.0} where={Where(b)} " +
                          $"infIn={b.infIn} armourIn={b.armourIn} " +
                          $"inf={b.infKilled} infBull={b.infBull} infBear={b.infBear} " +
                          $"armour={b.armourKilled} dbl={b.infDouble}/{b.armourDouble}");

        Summary(sb, army, tag, seed, sorties, blasts, sortiesBull, sortiesBear,
                armourLost, riflemenKilled, shellKills, armourDoubleTotal, infDoubleTotal,
                ambiguousBombs, airborneSeconds, bombsInAirSeconds, peakAirborne);
    }

    static string Sortie(Army army, float t, string tag, string side, float nextIn)
    {
        var h = army.Helicopters[army.Helicopters.Count - 1];
        return $"GUNREF sortie tag={tag} t={t:0.0} side={side} entryX={h.x:0} z={h.z:0.0} " +
               $"dir={(h.dir > 0 ? "+x" : "-x")} dropIn={h.dropIn:0.00} " +
               $"airborne={army.Helicopters.Count} nextIn={nextIn:0.0}";
    }

    /// <summary>
    /// Where a bomb landed, in the only three categories that matter to the
    /// port: outside the box the armies are held in at all, on the dropper's
    /// own side of the seam, or across it where it was aimed.
    /// </summary>
    static string Where(Blast b)
    {
        if (Mathf.Abs(b.x) >= Army.FrontX || Mathf.Abs(b.z) > Army.HalfDepth) return "offfield";
        // Bull's Dir is +1 and it enters at z = -26, so its enemy is at z > 0.
        bool enemyGround = b.side == Army.Side.Bull ? b.z > 0f : b.z < 0f;
        return enemyGround ? "enemy" : "own";
    }

    static int Sum(List<Blast> xs, System.Func<Blast, int> f)
    {
        int n = 0;
        foreach (var x in xs) n += f(x);
        return n;
    }

    static void Summary(StringBuilder sb, Army army, string tag, int seed, bool sorties,
                        List<Blast> blasts, int sortiesBull, int sortiesBear,
                        int armourLost, int riflemenKilled, int shellKills,
                        int armourDouble, int infDouble, int ambiguous,
                        float airborneSeconds, float bombsInAirSeconds, int peakAirborne)
    {
        int detonated = blasts.Count;
        int effective = 0, duds = 0, offField = 0, ownGround = 0, enemyGround = 0;
        int infKills = 0, infBull = 0, infBear = 0, armourKills = 0;
        int armourIn = 0, infIn = 0, friendlyFire = 0, tankKillers = 0;
        foreach (var b in blasts)
        {
            bool hit = b.infKilled > 0 || b.armourKilled > 0 || b.armourIn > 0;
            if (hit) effective++; else duds++;
            string w = Where(b);
            if (w == "offfield") offField++; else if (w == "own") ownGround++; else enemyGround++;
            infKills += b.infKilled; infBull += b.infBull; infBear += b.infBear;
            armourKills += b.armourKilled;
            armourIn += b.armourIn; infIn += b.infIn;
            if (b.armourKilled > 0) tankKillers++;
            // a bomb killing its own side's infantry
            friendlyFire += b.side == Army.Side.Bull ? b.infBull : b.infBear;
        }

        // The exit row, in the shape the reinforcement work reads.
        int bullArmour = 0, bearArmour = 0, bullInf = 0, bearInf = 0;
        foreach (var u in army.Armour) { if (u.side == Army.Side.Bull) bullArmour++; else bearArmour++; }
        foreach (var u in army.Infantry) { if (u.side == Army.Side.Bull) bullInf++; else bearInf++; }
        int arrived = bullArmour + bearArmour + armourLost - army.ArmourPerSide * 2;

        sb.AppendLine($"ARMYREF exit tag={tag} seed={seed} air={(sorties ? "on" : "off")} " +
                      $"armour={bullArmour}/{bearArmour} infantry={bullInf}/{bearInf} " +
                      $"lost={armourLost} arrived={arrived} riflemenKilled={riflemenKilled}");

        sb.AppendLine($"GUNREF sum tag={tag} seed={seed} air={(sorties ? "on" : "off")} " +
                      $"sorties={sortiesBull + sortiesBear} bull={sortiesBull} bear={sortiesBear} " +
                      $"onStation={airborneSeconds:0.0}s share={(airborneSeconds / 90f):0.00} " +
                      $"peakAirborne={peakAirborne} bombsInAir={bombsInAirSeconds:0.0}s");

        float perSortie = (sortiesBull + sortiesBear) > 0
            ? (float)detonated / (sortiesBull + sortiesBear) : 0f;
        sb.AppendLine($"GUNREF sum tag={tag} bombs detonated={detonated} stillFlying={army.Bombs.Count} " +
                      $"perSortie={perSortie:0.00} effective={effective} dud={duds} " +
                      $"offfield={offField} ownGround={ownGround} enemyGround={enemyGround}");

        sb.AppendLine($"GUNREF sum tag={tag} infantry killed={infKills} bull={infBull} bear={infBear} " +
                      $"friendlyFire={friendlyFire} inRadius={infIn} " +
                      $"perBomb={(detonated > 0 ? (float)infKills / detonated : 0f):0.00} " +
                      $"perEffective={(effective > 0 ? (float)infKills / effective : 0f):0.00} " +
                      $"byRifle={riflemenKilled}");

        sb.AppendLine($"GUNREF sum tag={tag} armour hitInRadius={armourIn} destroyedByBombs={armourKills} " +
                      $"bombsThatKilledArmour={tankKillers} byShell={shellKills} totalLost={armourLost} " +
                      $"bombShare={(armourLost > 0 ? (float)armourKills / armourLost : 0f):0.00}");

        // Not a footnote: an undeduped count would be wrong by exactly these,
        // and Detonate's missing hp check is a defect the port must not copy.
        sb.AppendLine($"GUNREF sum tag={tag} doubleFire armour={armourDouble} infantry={infDouble} " +
                      $"ambiguousBombMatch={ambiguous}");
    }
}
