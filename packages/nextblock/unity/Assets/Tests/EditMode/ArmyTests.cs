// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// The armour behaviours that took the most correcting in the three.js build:
/// hulls that interpenetrated instead of pushing apart, tanks that stood in
/// ground the line had already passed, and armour that strafed sideways rather
/// than turning into its line of advance.
/// </summary>
public class ArmyTests
{
    static Army Field(float front = 0f)
        => new Army(1234) { FrontlineAt = _ => front };

    [Test]
    public void HullsPushApartInsteadOfOverlapping()
    {
        var army = Field();
        army.Populate(8, 0);
        // pile them all on one spot
        foreach (var v in army.Armour) { v.x = 0f; v.z = 0f; }
        for (int i = 0; i < 200; i++) army.Update(1f / 60f);

        for (int i = 0; i < army.Armour.Count; i++)
            for (int j = i + 1; j < army.Armour.Count; j++)
            {
                var a = army.Armour[i]; var b = army.Armour[j];
                float d = Mathf.Sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));
                float min = a.side == b.side ? Army.FriendlySpacing : Army.HostileSpacing;
                Assert.Greater(d, min * 0.72f, $"zwei Panzer stecken ineinander (Abstand {d:0.0}, Minimum {min})");
            }
    }

    [Test]
    public void SeparationIsSymmetric()
    {
        var a = new Army.Unit { side = Army.Side.Bull, x = 0f, z = 0f };
        var b = new Army.Unit { side = Army.Side.Bull, x = 1f, z = 0f };
        Army.Separate(a, b);
        Assert.Less(a.x, 0f, "der erste Panzer wurde nicht weggedrueckt");
        Assert.Greater(b.x, 1f, "der zweite Panzer wurde nicht weggedrueckt");
        Assert.AreEqual(-a.x, b.x - 1f, 0.0001f, "der Stoss war einseitig");
    }

    [Test]
    public void UnitsBehindTheirOwnLineAreNotOverrun()
    {
        var bull = new Army.Unit { side = Army.Side.Bull, z = -30f };
        Assert.IsFalse(Army.IsOverrun(bull, 0f), "ein Panzer hinter der eigenen Linie gilt als ueberrannt");
        var bear = new Army.Unit { side = Army.Side.Bear, z = 30f };
        Assert.IsFalse(Army.IsOverrun(bear, 0f));
    }

    [Test]
    public void UnitsTheLineHasPassedAreOverrun()
    {
        var bull = new Army.Unit { side = Army.Side.Bull, z = 30f };   // deep in bear ground
        Assert.IsTrue(Army.IsOverrun(bull, 0f), "der Bulle steht im Baerengebiet und faellt nicht zurueck");
        var bear = new Army.Unit { side = Army.Side.Bear, z = -30f };
        Assert.IsTrue(Army.IsOverrun(bear, 0f));
    }

    [Test]
    public void OverrunArmourFallsBackTowardItsOwnSide()
    {
        var army = Field();
        army.Populate(2, 0);
        var v = army.Armour.Find(u => u.side == Army.Side.Bull);
        v.x = 0f; v.z = 40f;                       // stranded deep in bear ground
        float before = v.z;
        for (int i = 0; i < 120; i++) army.Update(1f / 60f);

        Assert.Less(v.z, before, "der ueberrannte Panzer haelt Boden, den er nicht mehr haelt");
        Assert.IsTrue(v.retreating, "Rueckzug wurde nicht als solcher erkannt");
    }

    [Test]
    public void ArmourAdvancesToTheLine()
    {
        var army = Field();
        army.Populate(1, 0);
        var v = army.Armour[0];
        v.x = 0f; v.z = v.Dir * 70f;               // sitting far back in the rear
        float before = Mathf.Abs(v.z);
        for (int i = 0; i < 300; i++) army.Update(1f / 60f);
        Assert.Less(Mathf.Abs(v.z), before, "der Panzer rueckt nicht zur Linie vor");
    }

    [Test]
    public void HullsTurnIntoTheirLineOfAdvanceRatherThanStrafing()
    {
        var army = Field();
        army.Populate(1, 0);
        var v = army.Armour[0];
        v.x = -60f; v.z = v.Dir * 60f; v.heading = 0f;
        for (int i = 0; i < 200; i++) army.Update(1f / 60f);

        // the hull must face roughly where it is actually going
        float moving = Mathf.Atan2(0f, -v.Dir);
        Assert.Less(Mathf.Abs(Mathf.DeltaAngle(v.heading * Mathf.Rad2Deg, moving * Mathf.Rad2Deg)), 100f,
            "der Panzer schiebt sich seitwaerts statt zu drehen");
    }

    [Test]
    public void UnitsStayInsideTheBattlefield()
    {
        var army = Field(60f);
        army.Populate(10, 30);
        for (int i = 0; i < 600; i++) army.Update(1f / 60f);
        foreach (var u in army.Armour)
        {
            Assert.LessOrEqual(Mathf.Abs(u.x), Army.FrontX, $"Panzer bei x={u.x:0} ausserhalb");
            Assert.LessOrEqual(Mathf.Abs(u.z), Army.HalfDepth + 0.1f, $"Panzer bei z={u.z:0} ausserhalb");
        }
        foreach (var u in army.Infantry)
            Assert.LessOrEqual(Mathf.Abs(u.z), Army.HalfDepth + 0.1f, $"Soldat bei z={u.z:0} ausserhalb");
    }

    [Test]
    public void DestroyedArmourLeavesTheField()
    {
        var army = Field();
        army.Populate(3, 0);
        // by identity, not by count: losses are made good in the same step, so
        // counting would only measure the reinforcement
        var doomed = army.Armour[0];
        doomed.hp = 0f;
        army.Update(1f / 60f);
        Assert.IsFalse(army.Armour.Contains(doomed), "ein zerstoerter Panzer bleibt stehen");
    }

    [Test]
    public void BothSidesArePresentAndFaceEachOther()
    {
        var army = Field();
        army.Populate(6, 12);
        int bull = 0, bear = 0;
        foreach (var v in army.Armour) { if (v.side == Army.Side.Bull) bull++; else bear++; }
        Assert.AreEqual(6, bull); Assert.AreEqual(6, bear);

        // they must start on opposite sides of the seam
        foreach (var v in army.Armour)
            Assert.AreEqual(v.side == Army.Side.Bull ? -1f : 1f, Mathf.Sign(v.z), 0.001f,
                $"{v.side} startet auf der falschen Seite der Front");
    }
}

/// <summary>
/// Reported from play: drive past a battle, turn round, and one side has no
/// tanks left. Armour dies in the duel and nothing was replacing it.
/// </summary>
public class ReinforcementTests
{
    static Army Field() => new Army(99) { FrontlineAt = _ => 0f, ReinforceSeconds = 2f };

    [Test]
    public void NeitherSideEverRunsOutOfArmour()
    {
        var army = Field();
        army.Populate(8, 10);

        // five simulated minutes of shooting at each other
        for (int i = 0; i < 60 * 300; i++) army.Update(1f / 60f);

        Assert.Greater(army.ArmourOf(Army.Side.Bull), 0, "die Bullen haben keine Panzer mehr");
        Assert.Greater(army.ArmourOf(Army.Side.Bear), 0, "die Baeren haben keine Panzer mehr");
    }

    [Test]
    public void LossesAreMadeGoodTowardEstablishment()
    {
        var army = Field();
        army.Populate(8, 4);
        // wipe out one side
        for (int i = army.Armour.Count - 1; i >= 0; i--)
            if (army.Armour[i].side == Army.Side.Bull) army.Armour.RemoveAt(i);
        Assert.AreEqual(0, army.ArmourOf(Army.Side.Bull));

        for (int i = 0; i < 60 * 60; i++) army.Update(1f / 60f);
        Assert.GreaterOrEqual(army.ArmourOf(Army.Side.Bull), 6,
            "der Verband wurde nach einem Totalverlust nicht wieder aufgefuellt");
    }

    [Test]
    public void ReinforcementsArriveOnACadenceRatherThanAllAtOnce()
    {
        var army = Field();
        army.Populate(8, 0);
        army.Armour.Clear();

        army.Update(1f / 60f);
        Assert.LessOrEqual(army.Armour.Count, 2, "der ganze Verband ist in einem Frame erschienen");
    }

    [Test]
    public void EstablishmentIsNotExceeded()
    {
        var army = Field();
        army.Populate(6, 8);
        for (int i = 0; i < 60 * 120; i++) army.Update(1f / 60f);
        Assert.LessOrEqual(army.ArmourOf(Army.Side.Bull), 6, "mehr Bullen-Panzer als vorgesehen");
        Assert.LessOrEqual(army.ArmourOf(Army.Side.Bear), 6, "mehr Baeren-Panzer als vorgesehen");
    }

    [Test]
    public void ReinforcementsArriveFromTheirOwnRear()
    {
        var army = Field();
        army.Populate(4, 0);
        army.Armour.Clear();
        for (int i = 0; i < 60 * 30; i++) army.Update(1f / 60f);

        foreach (var v in army.Armour)
            Assert.LessOrEqual(Mathf.Abs(v.z), Army.HalfDepth + 0.1f,
                $"Verstaerkung bei z={v.z:0} ausserhalb des Feldes");
    }
}

/// <summary>
/// A battle has to stay a battle. Reported from play as green sitting at two
/// tanks and never recovering; measured, it sat at 0-1 for five minutes while
/// red held eleven, because a side that starts losing gets focused down and a
/// fixed reinforcement cadence is always behind.
/// </summary>
public class AttritionTests
{
    static Army UnderPressure(float flow)
    {
        var army = new Army(7) { FrontlineAt = _ => 0f };
        army.Populate(11, 20);
        army.Flow = flow;
        return army;
    }

    static void Run(Army army, float seconds)
    {
        float flow = army.Flow;
        for (int i = 0; i < 60 * seconds; i++) { army.Flow = flow; army.Update(1f / 60f); }
    }

    [Test]
    public void NeitherSideIsAnnihilatedByASustainedOneSidedTape()
    {
        foreach (float flow in new[] { -1f, -0.5f, 0.5f, 1f })
        {
            var army = UnderPressure(flow);
            Run(army, 300f);
            int bull = army.ArmourOf(Army.Side.Bull), bear = army.ArmourOf(Army.Side.Bear);
            Assert.Greater(bull, 3, $"Bullen bei Fluss {flow} auf {bull} zusammengebrochen");
            Assert.Greater(bear, 3, $"Baeren bei Fluss {flow} auf {bear} zusammengebrochen");
        }
    }

    [Test]
    public void PressureStillFavoursTheSideItShould()
    {
        // damped, but not neutered: the tape has to mean something
        var bearish = UnderPressure(-1f);
        Run(bearish, 300f);
        Assert.GreaterOrEqual(bearish.ArmourOf(Army.Side.Bear), bearish.ArmourOf(Army.Side.Bull),
            "anhaltender Baeren-Druck verschafft den Baeren keinen Vorteil mehr");
    }

    [Test]
    public void ACollapsedSideRecoversQuickly()
    {
        var army = UnderPressure(0f);
        for (int i = army.Armour.Count - 1; i >= 0; i--)
            if (army.Armour[i].side == Army.Side.Bull) army.Armour.RemoveAt(i);

        Run(army, 30f);
        Assert.GreaterOrEqual(army.ArmourOf(Army.Side.Bull), 6,
            "ein zusammengebrochener Verband braucht laenger als 30 s zurueck auf die Beine");
    }
}

/// <summary>
/// Riflemen shoot each other. The counts alone do not show it - reinforcement
/// matches the losses, which is what a front holding looks like - so these
/// count the casualties themselves.
/// </summary>
public class InfantryCombatTests
{
    static Army Field(float flow = 0f)
    {
        var a = new Army(21) { FrontlineAt = _ => 0f };
        a.Populate(0, 60);
        a.Flow = flow;
        return a;
    }

    static int KillsOver(Army army, float seconds)
    {
        int kills = 0;
        army.Killed += (_, __) => kills++;
        for (int i = 0; i < 60 * seconds; i++) army.Update(1f / 60f);
        return kills;
    }

    [Test]
    public void RiflemenActuallyKillEachOther()
    {
        var army = Field();
        int kills = KillsOver(army, 60f);
        Assert.Greater(kills, 10, $"in einer Minute nur {kills} Gefallene - es wird nicht geschossen");
    }

    [Test]
    public void TheFrontHoldsRatherThanEmptying()
    {
        var army = Field();
        KillsOver(army, 240f);
        Assert.Greater(army.InfantryOf(Army.Side.Bull), 40, "die Bullen-Infanterie ist ausgeblutet");
        Assert.Greater(army.InfantryOf(Army.Side.Bear), 40, "die Baeren-Infanterie ist ausgeblutet");
    }

    [Test]
    public void CasualtiesAreNotSoFastThatTheLineEvaporates()
    {
        // ninety riflemen a side at a realistic hit rate wipe both armies out
        // in seconds; this pins the rate to something you can watch
        var army = Field();
        int kills = KillsOver(army, 60f);
        Assert.Less(kills, 400, $"{kills} Gefallene pro Minute - die Linie loest sich auf");
    }

    [Test]
    public void NobodyDiesWithNoEnemyInRange()
    {
        var army = new Army(5) { FrontlineAt = _ => 0f };
        army.Populate(0, 4);
        // park the two sides at opposite ends, far beyond rifle range
        foreach (var u in army.Infantry)
        {
            u.x = u.side == Army.Side.Bull ? -80f : 80f;
            u.z = u.side == Army.Side.Bull ? -60f : 60f;
        }
        int kills = 0;
        army.Killed += (_, __) => kills++;
        // one step only: any more and they close on the front and engage
        army.Update(1f / 60f);
        Assert.AreEqual(0, kills, "Soldaten sterben ausser Schussweite");
    }

    [Test]
    public void PressureFavoursTheSideItShould()
    {
        var bearish = Field(-1f);
        for (int i = 0; i < 60 * 180; i++) { bearish.Flow = -1f; bearish.Update(1f / 60f); }
        Assert.GreaterOrEqual(bearish.InfantryOf(Army.Side.Bear), bearish.InfantryOf(Army.Side.Bull) - 8,
            "anhaltender Baeren-Druck hilft der Baeren-Infanterie nicht");
    }
}

/// <summary>
/// Infantry is meant to be driven through, not driven around. Armour is the
/// opposite, and getting the two the wrong way round is easy to do silently.
/// </summary>
public class RunOverTests
{
    static Army Field()
    {
        var a = new Army(31) { FrontlineAt = _ => 0f };
        a.Populate(4, 30);
        return a;
    }

    [Test]
    public void DrivingThroughRiflemenKillsThem()
    {
        var army = Field();
        foreach (var u in army.Infantry) { u.x = 0f; u.z = 0f; }
        int before = army.Infantry.Count;
        int down = army.RunOver(0f, 0f, 3.6f, 12f, Vector2.right);
        Assert.Greater(down, 0, "niemand wurde ueberfahren");
        Assert.AreEqual(before - down, army.Infantry.Count);
    }

    [Test]
    public void CrawlingDoesNotMowDownALine()
    {
        var army = Field();
        foreach (var u in army.Infantry) { u.x = 0f; u.z = 0f; }
        Assert.AreEqual(0, army.RunOver(0f, 0f, 3.6f, 0.4f, Vector2.right),
            "ein stehender Truck raeumt sich einen Platz frei");
    }

    [Test]
    public void OnlyThoseUnderTheWheelsGoDown()
    {
        var army = Field();
        foreach (var u in army.Infantry) { u.x = 60f; u.z = 60f; }
        Assert.AreEqual(0, army.RunOver(0f, 0f, 3.6f, 12f, Vector2.right), "Soldaten am anderen Ende sterben mit");
    }

    [Test]
    public void ArmourIsNotRunOver()
    {
        var army = Field();
        foreach (var v in army.Armour) { v.x = 0f; v.z = 0f; }
        int before = army.Armour.Count;
        army.RunOver(0f, 0f, 3.6f, 20f, Vector2.right);
        Assert.AreEqual(before, army.Armour.Count, "ein Panzer wurde ueberfahren");
    }

    [Test]
    public void NobodyStepsAsideAnyMore()
    {
        var army = Field();
        var man = army.Infantry[0];
        // well clear of the truck, but up the road it is pointed down
        man.x = 14f; man.z = 0.5f;
        float wasX = man.x, wasZ = man.z;
        army.ClearPath(0f, 0f, 0f, 1f / 60f);
        Assert.AreEqual(wasX, man.x, 0.001f, "der Soldat weicht immer noch aus");
        Assert.AreEqual(wasZ, man.z, 0.001f, "der Soldat weicht immer noch aus");
    }

    [Test]
    public void DeepOverlapIsStillUndoneSoNothingWedges()
    {
        var army = Field();
        var man = army.Infantry[0];
        man.x = 0.1f; man.z = 0f;          // standing inside the truck
        army.ClearPath(0f, 0f, 0f, 1f / 60f);
        Assert.Greater(Mathf.Abs(man.x) + Mathf.Abs(man.z), 1f,
            "jemand steht im Truck - genau das klemmt ihn fest");
    }
}

/// <summary>
/// A man walking backwards while playing a forward run is the giveaway that
/// heading and movement have come apart.
/// </summary>
public class InfantryFacingTests
{
    static Army At(float front)
    {
        var a = new Army(77) { FrontlineAt = _ => front };
        a.Populate(0, 6);
        return a;
    }

    static Army.Unit Bull(Army a) => a.Infantry.Find(u => u.side == Army.Side.Bull);

    [Test]
    public void AdvancingMenFaceForward()
    {
        var army = At(0f);
        var man = Bull(army);
        man.z = -60f;                      // well behind his own line
        army.Update(1f / 60f);
        Assert.IsTrue(man.walking, "er steht, obwohl er weit hinter der Linie ist");
        Assert.AreEqual(0f, man.heading, 0.01f, "er rueckt vor, schaut aber zurueck");
    }

    [Test]
    public void FallingBackMenTurnRoundRatherThanReversing()
    {
        var army = At(-60f);               // the line has moved away behind him
        var man = Bull(army);
        man.z = 40f;                       // stranded far up the field
        army.Update(1f / 60f);
        Assert.IsTrue(man.walking);
        Assert.AreEqual(Mathf.PI, man.heading, 0.01f,
            "er geht zurueck, dreht sich aber nicht um - genau das laesst ihn rueckwaerts laufen");
    }

    [Test]
    public void HeadingAlwaysAgreesWithTheDirectionOfTravel()
    {
        foreach (float front in new[] { -70f, -20f, 0f, 20f, 70f })
        {
            var army = At(front);
            foreach (var u in army.Infantry)
            {
                float before = u.z;
                army.Update(1f / 60f);
                float moved = u.z - before;
                if (Mathf.Abs(moved) < 0.001f || !u.walking) continue;
                float faces = Mathf.Cos(u.heading);      // +1 looks at +z, -1 at -z
                Assert.Greater(moved * faces, 0f,
                    $"laeuft nach {(moved > 0 ? "+z" : "-z")}, schaut aber nach {(faces > 0 ? "+z" : "-z")}");
            }
        }
    }

    [Test]
    public void DugInMenFaceTheEnemyRatherThanTheirOwnRear()
    {
        var army = At(0f);
        var man = Bull(army);
        // Exactly at HIS position. Every man digs in at his own distance behind
        // the line AND at his own place in his squad, so "at the line" is not
        // one shared number - it is his number.
        man.z = -(man.standoff + man.squadOffsetZ);
        army.Update(1f / 60f);
        Assert.IsFalse(man.walking, "er sollte an der Linie stehen");
        Assert.Less(Mathf.Abs(Mathf.DeltaAngle(man.heading * Mathf.Rad2Deg, 0f)), 91f,
            "er steht an der Front und schaut nach hinten");
    }
}

/// <summary>
/// A wreck is an obstacle. Physics stops the truck, but the units are moved by
/// this logic rather than by the engine, so they would walk straight through
/// unless the army is told the ground is taken.
/// </summary>
public class WreckObstacleTests
{
    static Army Field()
    {
        var a = new Army(51) { FrontlineAt = _ => 0f };
        a.Populate(4, 10);
        return a;
    }

    [Test]
    public void ArmourIsPushedOutOfAWreck()
    {
        var army = Field();
        army.Wrecks.Add(new Vector3(0f, 0f, 4.2f));
        var tank = army.Armour[0];
        tank.x = 0.5f; tank.z = 0.5f;              // sitting inside it
        army.Update(1f / 60f);
        float d = Mathf.Sqrt(tank.x * tank.x + tank.z * tank.z);
        Assert.Greater(d, 4f, $"der Panzer steht im Wrack (Abstand {d:0.0})");
    }

    [Test]
    public void InfantryIsPushedOutToo()
    {
        var army = Field();
        army.Wrecks.Add(new Vector3(20f, -10f, 4.2f));
        var man = army.Infantry[0];
        man.x = 20f; man.z = -10f;
        army.Update(1f / 60f);
        float d = Mathf.Sqrt((man.x - 20f) * (man.x - 20f) + (man.z + 10f) * (man.z + 10f));
        Assert.Greater(d, 3f, $"der Soldat steht im Wrack (Abstand {d:0.0})");
    }

    [Test]
    public void UnitsWellClearOfAWreckAreLeftAlone()
    {
        var army = Field();
        army.Wrecks.Add(new Vector3(60f, 60f, 4.2f));
        var tank = army.Armour[0];
        tank.x = -60f; tank.z = -60f;
        float wasX = tank.x, wasZ = tank.z;
        army.Update(1f / 60f);
        // it still runs its normal step, but the wreck must not have moved it
        Assert.Less(Mathf.Abs(tank.x - wasX), 2f, "ein Wrack am anderen Ende hat ihn verschoben");
        Assert.Less(Mathf.Abs(tank.z - wasZ), 2f, "ein Wrack am anderen Ende hat ihn verschoben");
    }

    [Test]
    public void AClearedWreckSlotStopsPushing()
    {
        var army = Field();
        army.Wrecks.Add(new Vector3(0f, 0f, 0f));   // burnt out: zero radius
        var tank = army.Armour[0];
        tank.x = 0.5f; tank.z = 0.5f;
        army.Update(1f / 60f);
        Assert.Less(Mathf.Sqrt(tank.x * tank.x + tank.z * tank.z), 4f,
            "ein abgeraeumtes Wrack schiebt immer noch");
    }
}

/// <summary>
/// Reported from play: the infantry reads as one homogeneous block. An army
/// evenly spaced along a line at one height and one speed looks like a
/// spreadsheet, whatever the models are.
/// </summary>
public class InfantryVarietyTests
{
    static Army Field()
    {
        var a = new Army(88) { FrontlineAt = _ => 0f };
        a.Populate(0, 60);
        return a;
    }

    [Test]
    public void MenAreNotAllTheSameSizeOrSpeed()
    {
        var army = Field();
        var heights = new System.Collections.Generic.HashSet<float>();
        var paces = new System.Collections.Generic.HashSet<float>();
        foreach (var u in army.Infantry) { heights.Add(u.height); paces.Add(u.pace); }
        Assert.Greater(heights.Count, 20, "alle Soldaten sind gleich gross");
        Assert.Greater(paces.Count, 20, "alle Soldaten laufen gleich schnell");
    }

    [Test]
    public void HeightsStayWithinAHumanRange()
    {
        var army = Field();
        foreach (var u in army.Infantry)
            Assert.That(u.height, Is.InRange(0.85f, 1.15f), "die Streuung ist grotesk statt menschlich");
    }

    [Test]
    public void MenClumpIntoSquadsRatherThanFormingAnEvenLine()
    {
        var army = Field();
        for (int i = 0; i < 60 * 30; i++) army.Update(1f / 60f);

        var xs = new System.Collections.Generic.List<float>();
        foreach (var u in army.Infantry)
            if (u.side == Army.Side.Bull) xs.Add(u.x);
        xs.Sort();
        Assert.Greater(xs.Count, 10);

        // An even line has near-identical gaps between neighbours. Clumps do
        // not: most gaps are small, a few are large. Compare the biggest gap
        // with the median one - on an even line they are the same.
        var gaps = new System.Collections.Generic.List<float>();
        for (int i = 1; i < xs.Count; i++) gaps.Add(xs[i] - xs[i - 1]);
        gaps.Sort();
        float median = gaps[gaps.Count / 2];
        float widest = gaps[gaps.Count - 1];
        Assert.Greater(widest, median * 3f,
            $"die Abstaende sind fast gleich (Median {median:0.0}, groesster {widest:0.0}) - das ist eine Reihe, kein Haufen");
    }

    [Test]
    public void SquadsDriftSoTheLineIsNotFrozen()
    {
        var army = Field();
        for (int i = 0; i < 60 * 5; i++) army.Update(1f / 60f);
        var before = army.Infantry.ConvertAll(u => u.x);
        for (int i = 0; i < 60 * 60; i++) army.Update(1f / 60f);

        float moved = 0f;
        for (int i = 0; i < before.Count && i < army.Infantry.Count; i++)
            moved += Mathf.Abs(army.Infantry[i].x - before[i]);
        Assert.Greater(moved / Mathf.Max(1, before.Count), 1f,
            "die Front steht nach einer Minute noch exakt gleich da");
    }
}

/// <summary>
/// Gunships and the bombs they drop - the heaviest thing either side puts in
/// the air, and the only weapon that clears a circle rather than hitting a
/// point.
/// </summary>
public class HelicopterTests
{
    static Army Field()
    {
        var a = new Army(64) { FrontlineAt = _ => 0f, GroundAt = (_, __) => 0f };
        a.Populate(6, 40);
        return a;
    }

    [Test]
    public void AGunshipEntersFromOffTheMapAndCrossesIt()
    {
        var army = Field();
        army.SendHelicopter(Army.Side.Bull);
        var h = army.Helicopters[0];
        Assert.Greater(Mathf.Abs(h.x), Army.FrontX, "er erscheint mitten auf dem Feld statt anzufliegen");

        float startX = h.x;
        for (int i = 0; i < 60 * 3; i++) army.Update(1f / 60f);
        if (army.Helicopters.Count > 0)
            Assert.Greater(Mathf.Abs(army.Helicopters[0].x - startX), 1f, "er fliegt nicht");
    }

    [Test]
    public void HeStandsOffOnHisOwnSideOfTheLine()
    {
        var army = Field();
        army.SendHelicopter(Army.Side.Bull);
        for (int i = 0; i < 60 * 4; i++) army.Update(1f / 60f);
        if (army.Helicopters.Count == 0) Assert.Pass("bereits durchgeflogen");
        var h = army.Helicopters[0];
        Assert.Less(h.z, 0f, "der Bullen-Helikopter steht auf der Baeren-Seite der Front");
    }

    [Test]
    public void HeFliesAboveTheGroundRatherThanThroughIt()
    {
        var army = new Army(64) { FrontlineAt = _ => 0f, GroundAt = (_, __) => 12f };
        army.Populate(2, 4);
        army.SendHelicopter(Army.Side.Bear);
        for (int i = 0; i < 60 * 3; i++) army.Update(1f / 60f);
        if (army.Helicopters.Count == 0) Assert.Pass("bereits durchgeflogen");
        Assert.Greater(army.Helicopters[0].y, 12f + 10f, "er fliegt im Boden");
    }

    [Test]
    public void HeDropsAndTheBombFalls()
    {
        var army = Field();
        army.SendHelicopter(Army.Side.Bull);
        int released = 0;
        army.BombReleased += _ => released++;

        for (int i = 0; i < 60 * 12; i++) army.Update(1f / 60f);
        Assert.Greater(released, 0, "er wirft nichts ab");
    }

    [Test]
    public void ABombClearsACircleRatherThanHittingAPoint()
    {
        var army = Field();
        // a tight knot of men directly under the bomb
        foreach (var u in army.Infantry) { u.x = 0f; u.z = 0f; }
        int killed = 0;
        army.Killed += (_, __) => killed++;

        army.Bombs.Add(new Army.Bomb { x = 0f, y = 0.5f, z = 0f, vy = -20f, side = Army.Side.Bull });
        // a bomb needs a frame or two to reach the ground, whatever its speed
        for (int i = 0; i < 30 && army.Bombs.Count > 0; i++) army.Update(1f / 60f);
        Assert.AreEqual(0, army.Bombs.Count, "die Bombe ist nicht eingeschlagen");

        Assert.Greater(killed, 5, $"nur {killed} gefallen - eine Bombe raeumt einen Kreis, nicht einen Mann");
    }

    [Test]
    public void ABombDamagesArmourByDistance()
    {
        var army = Field();
        var near = army.Armour[0];
        var far = army.Armour[1];
        near.x = 0f; near.z = 0f; near.hp = 20f;
        far.x = 0f; far.z = Army.BombRadius * 0.9f; far.hp = 20f;

        army.Bombs.Add(new Army.Bomb { x = 0f, y = 0.5f, z = 0f, vy = -20f, side = Army.Side.Bull });
        for (int i = 0; i < 30 && army.Bombs.Count > 0; i++) army.Update(1f / 60f);

        Assert.Less(near.hp, 20f, "der Panzer im Zentrum nimmt keinen Schaden");
        Assert.Greater(near.hp < far.hp ? 1 : 0, 0,
            $"der ferne Panzer nimmt gleich viel oder mehr ({far.hp:0.0}) als der nahe ({near.hp:0.0})");
    }

    [Test]
    public void GunshipsLeaveOnceTheyHaveCrossed()
    {
        var army = Field();
        army.SendHelicopter(Army.Side.Bull);
        for (int i = 0; i < 60 * 40; i++) army.Update(1f / 60f);
        Assert.AreEqual(0, army.Helicopters.Count, "der Helikopter kreist ewig weiter");
    }
}

/// <summary>
/// An advance at an unbroken rate is the clearest tell that nobody in the
/// column is deciding anything.
/// </summary>
public class InfantryGaitTests
{
    static Army Field()
    {
        var a = new Army(404) { FrontlineAt = _ => 0f };
        a.Populate(0, 40);
        // put them well back, so they are all walking to begin with
        foreach (var u in a.Infantry) u.z = -u.Dir * 60f;
        return a;
    }

    [Test]
    public void MenStopNowAndThenRatherThanMarchingContinuously()
    {
        var army = Field();
        bool sawAHalt = false;
        for (int i = 0; i < 60 * 40 && !sawAHalt; i++)
        {
            army.Update(1f / 60f);
            foreach (var u in army.Infantry)
                if (!u.walking && Mathf.Abs(u.z) > 20f) { sawAHalt = true; break; }
        }
        Assert.IsTrue(sawAHalt, "in vierzig Sekunden bleibt niemand stehen - das ist eine Prozession");
    }

    [Test]
    public void NotEveryoneIsInStep()
    {
        var army = Field();
        for (int i = 0; i < 60 * 6; i++) army.Update(1f / 60f);

        // the distance covered in one second must differ from man to man
        var before = army.Infantry.ConvertAll(u => u.z);
        for (int i = 0; i < 60; i++) army.Update(1f / 60f);

        var moved = new System.Collections.Generic.HashSet<float>();
        for (int i = 0; i < before.Count && i < army.Infantry.Count; i++)
            moved.Add(Mathf.Round(Mathf.Abs(army.Infantry[i].z - before[i]) * 20f));
        Assert.Greater(moved.Count, 5, "alle legen exakt dieselbe Strecke zurueck");
    }

    [Test]
    public void AHaltedManDoesNotPlayTheWalkingAnimation()
    {
        var army = Field();
        for (int i = 0; i < 60 * 40; i++)
        {
            army.Update(1f / 60f);
            foreach (var u in army.Infantry)
                if (u.restFor > 0f)
                    Assert.IsFalse(u.walking, "er steht, laeuft aber weiter in der Animation");
        }
    }
}
