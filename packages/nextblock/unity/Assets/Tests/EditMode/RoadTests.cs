// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// The road model is where the three.js build needed the most correcting:
/// routes that overlapped, roads that were modified because the frontline
/// drifted over them, and stretches that were cut the instant the shooting
/// started. These pin all of it down.
/// </summary>
public class RoadModelTests
{
    RoadModel Model(float front = 0f)
        => new RoadModel { FrontlineAt = _ => front };

    [Test]
    public void RoutesNeverOverlapAnywhere()
    {
        // sweep the frontline across the whole map, since the front route follows it
        for (float front = -80f; front <= 80f; front += 5f)
        {
            var m = Model(front);
            for (float x = m.PlazaX; x <= m.DepotX; x += 2f)
            {
                for (int i = 0; i < RoadModel.Order.Length; i++)
                    for (int j = i + 1; j < RoadModel.Order.Length; j++)
                    {
                        float gap = Mathf.Abs(m.CenterZ(RoadModel.Order[i], x) - m.CenterZ(RoadModel.Order[j], x));
                        Assert.GreaterOrEqual(gap, 10.4f,
                            $"{RoadModel.Order[i]} und {RoadModel.Order[j]} ueberlappen bei x={x:0}, Front={front:0}");
                    }
            }
        }
    }

    [Test]
    public void FlankRoadsDoNotMoveWhenTheFrontlineDoes()
    {
        var a = Model(-70f);
        var b = Model(70f);
        for (float x = -110f; x <= 110f; x += 7f)
            foreach (var lane in RoadModel.Order)
                Assert.AreEqual(a.CenterZ(lane, x), b.CenterZ(lane, x), 0.001f,
                    $"{lane} wurde bei x={x:0} von der Frontlinie verschoben");
    }

    [Test]
    public void NoRouteFollowsTheSeam()
    {
        // With the frontline road gone, no centreline may depend on the market
        // at all - the four flanks are fixed infrastructure.
        for (float front = -80f; front <= 80f; front += 20f)
        {
            var m = Model(front);
            var flat = Model(0f);
            for (float x = -110f; x <= 110f; x += 11f)
                foreach (var lane in RoadModel.Order)
                    Assert.AreEqual(flat.CenterZ(lane, x), m.CenterZ(lane, x), 0.001f,
                        $"{lane} folgt der Frontlinie bei x={x:0}");
        }
    }

    [Test]
    public void EveryRouteReachesItsOwnGateSlot()
    {
        var m = Model();
        var seen = new System.Collections.Generic.List<float>();
        foreach (var lane in RoadModel.Order)
        {
            float z = m.CenterZ(lane, m.PlazaX + 2f);
            foreach (var other in seen)
                Assert.Greater(Mathf.Abs(z - other), 6f, $"{lane} teilt sich einen Torschlitz");
            seen.Add(z);
        }
    }

    [Test]
    public void RoadsDoNotFailOnTheFirstShell()
    {
        var m = Model();
        float z = m.CenterZ(Lane.Bull, 0f);
        m.WearAt(0f, z, 5f, 0.045f);          // one tank shell, as in the three.js build
        Assert.IsFalse(m.IsCut(Lane.Bull), "eine einzige Granate hat die Strasse zerschnitten");
        Assert.Greater(m.WearLevel(Lane.Bull), 0f, "der Treffer hat gar nichts bewirkt");
    }

    [Test]
    public void SustainedShellingEventuallyCutsTheRoad()
    {
        var m = Model();
        float z = m.CenterZ(Lane.Bull, 0f);
        for (int i = 0; i < 25 && !m.IsCut(Lane.Bull); i++) m.WearAt(0f, z, 5f, 0.045f);
        Assert.IsTrue(m.IsCut(Lane.Bull), "Dauerbeschuss hat die Strasse nie zerschnitten");
        Assert.IsTrue(m.PathBlocked(Lane.Bull, -40f, 40f), "der Schnitt blockiert den Weg nicht");
    }

    [Test]
    public void TheLastOpenRouteAlwaysHolds()
    {
        // The frontline road used to be the guaranteed way through. Now the
        // guarantee is a rule, and it has to survive the whole map being shelled.
        var m = Model();
        for (float x = -110f; x <= 110f; x += 4f)
            foreach (var lane in RoadModel.Order)
                m.CutAt(x, m.CenterZ(lane, x), 14f);

        Assert.GreaterOrEqual(m.OpenLanes().Count, 1,
            "alle vier Strassen gesperrt - der Truck kaeme nirgendwo mehr durch");
    }

    [Test]
    public void EngineersReopenACutAfterSixtySeconds()
    {
        var m = Model();
        m.CutAt(0f, m.CenterZ(Lane.Bear, 0f), 10f);
        Assert.IsTrue(m.IsCut(Lane.Bear));
        Assert.AreEqual(RoadModel.DamageSeconds, m.RepairEta(Lane.Bear), 0.5f);

        for (int i = 0; i < 59; i++) m.Tick(1f);
        Assert.IsTrue(m.IsCut(Lane.Bear), "zu frueh repariert");
        m.Tick(2f);
        Assert.IsFalse(m.IsCut(Lane.Bear), "nach 60 s immer noch gesperrt");
    }

    [Test]
    public void UnshelledSurfacesRecover()
    {
        var m = Model();
        float z = m.CenterZ(Lane.BearRear, 20f);
        m.WearAt(20f, z, 5f, 0.5f);
        float before = m.WearLevel(Lane.BearRear);
        for (int i = 0; i < 10; i++) m.Tick(1f);
        Assert.Less(m.WearLevel(Lane.BearRear), before, "Verschleiss heilt nicht aus");
    }

    [Test]
    public void ACutOnlyBlocksItsOwnLane()
    {
        var m = Model();
        m.CutAt(0f, m.CenterZ(Lane.Bull, 0f), 10f);
        Assert.IsTrue(m.PathBlocked(Lane.Bull, -50f, 50f));
        Assert.IsFalse(m.PathBlocked(Lane.BearRear, -50f, 50f), "ein Treffer hat eine fremde Strasse gesperrt");
        Assert.Contains(Lane.BearRear, m.OpenLanes());
    }

    [Test]
    public void ACutFarAwayDoesNotBlockAShortHop()
    {
        var m = Model();
        m.CutAt(90f, m.CenterZ(Lane.Bull, 90f), 8f);
        Assert.IsFalse(m.PathBlocked(Lane.Bull, -110f, -40f), "ein Schnitt bei x=90 sperrt eine Fahrt bei x=-110");
        Assert.IsTrue(m.PathBlocked(Lane.Bull, 40f, 110f));
    }
}

/// <summary>
/// The ground has to say who holds it at a glance, and the five routes have to
/// be told apart without reading a label.
/// </summary>
public class TerritoryTests
{
    [Test] public void BullGroundIsGreenerThanItIsRed()
    {
        var c = TerritoryMap.Shade(-40f, 0.5f);
        Assert.Greater(c.g, c.r, "Bullen-Gebiet ist nicht gruen");
    }

    [Test] public void BearGroundIsRedderThanItIsGreen()
    {
        var c = TerritoryMap.Shade(40f, 0.5f);
        Assert.Greater(c.r, c.g, "Baeren-Gebiet ist nicht rot");
    }

    [Test] public void TheSeamItselfIsNeitherSide()
    {
        var c = TerritoryMap.Shade(0f, 0.5f);
        Assert.Less(Mathf.Abs(c.r - c.g), 0.12f, "die Frontlinie selbst ist einer Seite zugeschlagen");
    }

    [Test] public void ColourStrengthensWithDistanceFromTheFront()
    {
        float near = TerritoryMap.Shade(-6f, 0.5f).g - TerritoryMap.Shade(-6f, 0.5f).r;
        float far = TerritoryMap.Shade(-60f, 0.5f).g - TerritoryMap.Shade(-60f, 0.5f).r;
        Assert.Greater(far, near, "tiefes Hinterland ist nicht deutlicher gefaerbt als die Front");
    }

    [Test] public void NoiseNeverDrivesAChannelOutOfRange()
    {
        foreach (float d in new[] { -80f, -20f, 0f, 20f, 80f })
            foreach (float n in new[] { 0f, 0.5f, 1f })
            {
                var c = TerritoryMap.Shade(d, n);
                Assert.IsTrue(c.r is >= 0f and <= 1f && c.g is >= 0f and <= 1f && c.b is >= 0f and <= 1f,
                    $"Farbkanal ausserhalb 0..1 bei d={d} n={n}: {c}");
            }
    }

    [Test] public void EveryRouteHasItsOwnColour()
    {
        var seen = new System.Collections.Generic.List<Color>();
        foreach (var lane in RoadModel.Order)
        {
            var c = RoadNetwork.TintFor(lane);
            foreach (var other in seen)
            {
                float diff = Mathf.Abs(c.r - other.r) + Mathf.Abs(c.g - other.g) + Mathf.Abs(c.b - other.b);
                Assert.Greater(diff, 0.12f, $"{lane} ist von einer anderen Strecke kaum zu unterscheiden");
            }
            seen.Add(c);
        }
    }

    [Test] public void RouteColoursDoNotImpersonateTerritory()
    {
        // The ground says who holds it. A road tinted green or red would read
        // as territory rather than as a road.
        foreach (var lane in RoadModel.Order)
        {
            var c = RoadNetwork.TintFor(lane);
            Assert.Less(Mathf.Abs(c.r - c.g), 0.12f, $"{lane} sieht nach Parteifarbe aus");
            Assert.Less(Mathf.Abs(c.g - c.b), 0.12f, $"{lane} sieht nach Parteifarbe aus");
        }
    }

    [Test]
    public void WhatStandsOnARoadOverACandleStandsOnThePlateau()
    {
        // §4.15: the ribbon lies on the ground under the candles; the core's surface there is the plateau. Before, the deck
        // was laid on SurfaceAt and climbed the candles (8.0 - 26.5 m of each 236 m lane).
        Assert.AreEqual(2f, RoadNetwork.Rest(2f, 0.45f, 1f), 1e-5f, "on a 2 m plateau under the road");
        Assert.AreEqual(0.45f, RoadNetwork.Rest(0f, 0.45f, 1f), 1e-5f, "on the deck off the candles");
        Assert.AreEqual(0.225f, RoadNetwork.Rest(0f, 0.45f, 0.5f), 1e-5f, "faded across the shoulder");
        Assert.AreEqual(0.45f, RoadNetwork.Rest(-1f, 0.45f, 1f), 1e-5f, "the deck over a crater, as before");
    }
}
