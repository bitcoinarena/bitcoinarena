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
