// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The far end of the run. The loading bay is only worth anything if the
/// freight can be delivered, so this checks the loop actually closes: load,
/// arrive, bank, and start again at the ramp.
/// </summary>
public class DeliveryTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    GameObject _boot;
    TruckController _truck;
    CargoBay _bay;
    LoadoutPanel _ui;
    DeliveryGate _gate;
    MempoolFeed _feed;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        // past the title screen: it holds the truck and the ramp until PLAY
        var splash0 = Object.FindFirstObjectByType<SplashScreen>();
        if (splash0 != null && splash0.Showing) splash0.Play();
        yield return null;

        _truck = Object.FindFirstObjectByType<TruckController>();
        _bay = Object.FindFirstObjectByType<CargoBay>();
        _ui = Object.FindFirstObjectByType<LoadoutPanel>();
        _gate = Object.FindFirstObjectByType<DeliveryGate>();
        _feed = Object.FindFirstObjectByType<MempoolFeed>();

        _feed.Offers = new List<MempoolFeed.Tx>
        {
            new MempoolFeed.Tx { txid = "aaaa", feeSats = 5000, vsize = 200, valueSats = 100_000_000 },
            new MempoolFeed.Tx { txid = "bbbb", feeSats = 3000, vsize = 150, valueSats =  50_000_000 },
        };
        yield return null;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        // Never hand the next test a slowed world. The death sequence drops
        // timeScale, and a test that ends while the truck is burning leaves it
        // there - the next test then runs at a third speed and quietly does a
        // third of the driving it thinks it does.
        Time.timeScale = 1f;

        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    /// <summary>Put the truck in the gate mouth, body and all.</summary>
    IEnumerator DriveToTheGate()
    {
        var body = _truck.GetComponent<Rigidbody>();
        var at = new Vector3(_gate.gateX + 3f, _truck.transform.position.y, 0f);
        body.linearVelocity = Vector3.zero;
        body.angularVelocity = Vector3.zero;
        body.position = at;
        _truck.transform.position = at;
        yield return null;
        yield return null;
    }

    [Test]
    public void ThereIsAGateAtTheFarEnd()
    {
        Assert.IsNotNull(_gate, "kein Lieferziel in der Szene");
        Assert.Greater(_gate.gateX, 100f, "das Ziel steht nicht am anderen Ende");
        Assert.Less(_truck.spawnPosition.x, 0f, "der Spawn liegt nicht gegenueber");

        // The two posts and a beam are gone: the end of the map is a building
        // now, and its collision shell is what is always there - the model
        // itself streams in a few seconds later. So this asks for the wall
        // rather than the posts.
        var shell = _gate.transform.Find("MinerShell");
        Assert.IsNotNull(shell, "keine Fassade am Ziel");
        Assert.Greater(shell.GetComponentsInChildren<BoxCollider>(true).Length, 3,
            "die Fassade hat zu wenige Kollisionsflaechen, um eine Wand zu sein");
    }

    [UnityTest]
    public IEnumerator ArrivingWithFreightBanksTheFees()
    {
        _ui.Auto();
        _ui.Confirm();
        yield return null;

        long expected = _bay.FeeCarried;
        Assert.Greater(expected, 0, "nichts geladen");

        yield return DriveToTheGate();

        Assert.AreEqual(expected, _gate.SatsDelivered, "die Gebuehren wurden nicht verbucht");
        Assert.AreEqual(1, _gate.Runs, "die Fahrt wurde nicht gezaehlt");
    }

    [UnityTest]
    public IEnumerator DeliveringStartsTheNextRunAtTheRamp()
    {
        _ui.Auto();
        _ui.Confirm();
        yield return null;
        yield return DriveToTheGate();

        Assert.IsFalse(_bay.IsLoaded, "die Ladung bleibt nach der Lieferung an Bord");

        // Die Rampe oeffnet mit Verzoegerung, nicht sofort.
        //
        // Sie oeffnete frueher im selben Frame wie die Ankunft und deckte damit
        // die Score-Karte zu - die Fahrt wurde bewertet und der Spieler sah die
        // Rechnung nie. Erst pruefen, dass sie noch ZU ist, dann warten.
        Assert.IsFalse(_ui.IsOpen,
            "die Rampe deckt die Score-Karte sofort wieder zu");
        yield return new WaitForSecondsRealtime(_gate.scoreHoldSeconds + 0.5f);

        Assert.IsTrue(_ui.IsOpen, "die Rampe geht nach der Lieferung nicht wieder auf");
        Assert.IsTrue(_truck.controlsLocked, "der Truck ist nach der Lieferung nicht gesperrt");
        Assert.Less(Vector3.Distance(_truck.transform.position, _truck.spawnPosition), 6f,
            "der Truck steht nach der Lieferung nicht wieder am Spawn");
    }

    [UnityTest]
    public IEnumerator AnEmptyTruckIsNotADelivery()
    {
        // through the gate with nothing aboard
        _ui.Confirm();                     // nothing ticked, so nothing loaded
        yield return DriveToTheGate();

        Assert.AreEqual(0, _gate.Runs, "eine leere Fahrt wurde als Lieferung gewertet");
        Assert.AreEqual(0, _gate.SatsDelivered);
    }

    [UnityTest]
    public IEnumerator TwoRunsAddUp()
    {
        _ui.Auto(); _ui.Confirm(); yield return null;
        long first = _bay.FeeCarried;
        yield return DriveToTheGate();

        _ui.Auto(); _ui.Confirm(); yield return null;
        long second = _bay.FeeCarried;
        yield return DriveToTheGate();

        Assert.AreEqual(first + second, _gate.SatsDelivered, "die Wertung summiert nicht");
        Assert.AreEqual(2, _gate.Runs);
    }
}
