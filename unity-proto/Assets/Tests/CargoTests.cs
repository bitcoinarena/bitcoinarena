using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The loading bay: pick freight, then drive. The part worth testing is the
/// gate - that the truck really is held until something is aboard - and that
/// Auto picks the load the next block would.
/// </summary>
public class CargoTests
{
    GameObject _boot;
    TruckController _truck;
    TruckHealth _health;
    LoadoutPanel _bayUi;
    CargoBay _bay;
    MempoolFeed _feed;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        _truck = Object.FindFirstObjectByType<TruckController>();
        _health = Object.FindFirstObjectByType<TruckHealth>();
        _bayUi = Object.FindFirstObjectByType<LoadoutPanel>();
        _bay = Object.FindFirstObjectByType<CargoBay>();
        _feed = Object.FindFirstObjectByType<MempoolFeed>();

        // a fixed yard, so the test does not depend on what the mempool holds
        _feed.Offers = new List<MempoolFeed.Tx>
        {
            Tx("aaaa1111aaaa1111aaaa1111aaaa1111",  200,  400,   50_000_000),  // 0.5/vB
            Tx("bbbb2222bbbb2222bbbb2222bbbb2222", 9000,  300, 3_000_000_000),  // 30/vB, whale
            Tx("cccc3333cccc3333cccc3333cccc3333", 2000,  200,   10_000_000),  // 10/vB
            Tx("dddd4444dddd4444dddd4444dddd4444", 4500,  150,   20_000_000),  // 30/vB
            Tx("eeee5555eeee5555eeee5555eeee5555",  600,  600,    5_000_000),  // 1/vB
            Tx("ffff6666ffff6666ffff6666ffff6666", 1800,  120,    7_000_000),  // 15/vB
            Tx("99997777999977779999777799997777",  900,  450,    9_000_000),  // 2/vB
        };
        yield return null;
    }

    static MempoolFeed.Tx Tx(string id, long fee, int vsize, long value) =>
        new MempoolFeed.Tx { txid = id, feeSats = fee, vsize = vsize, valueSats = value };

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    [Test]
    public void TheBayIsOpenWhenTheTruckSpawns()
    {
        Assert.IsNotNull(_bayUi, "keine Laderampe in der Szene");
        Assert.IsTrue(_bayUi.IsOpen, "die Laderampe geht beim Spawn nicht auf");
        Assert.IsTrue(_truck.controlsLocked, "der Truck ist waehrend des Beladens nicht gesperrt");
        Assert.IsFalse(_bay.IsLoaded, "der Truck ist beladen, bevor etwas gewaehlt wurde");
    }

    /// <summary>The whole point of the gate.</summary>
    [UnityTest]
    public IEnumerator TheTruckCannotDriveOffUnloaded()
    {
        var from = _truck.transform.position;
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(2f);
        _truck.useExternalInput = false;

        float moved = Vector3.Distance(from, _truck.transform.position);
        Assert.Less(moved, 1.5f, $"der Truck ist unbeladen {moved:0.0} m weit gefahren");
    }

    [Test]
    public void AutoTakesTheBestPayingLoadThatFits()
    {
        _bayUi.Auto();
        _bayUi.Confirm();

        Assert.AreEqual(_bay.capacity, _bay.Manifest.Count,
            "Auto fuellt die Ladeflaeche nicht aus");

        // sorted by fee rate, so the 0.5 sat/vB straggler is the one left behind
        foreach (var tx in _bay.Manifest)
            Assert.Greater(tx.FeeRate, 0.6f,
                $"Auto hat {tx.Short} mit {tx.FeeRate:0.0} sat/vB geladen, obwohl besseres da war");
    }

    [UnityTest]
    public IEnumerator LoadingReleasesTheTruck()
    {
        _bayUi.Auto();
        _bayUi.Confirm();
        yield return null;

        Assert.IsFalse(_bayUi.IsOpen, "die Rampe bleibt nach dem Beladen offen");
        Assert.IsFalse(_truck.controlsLocked, "der Truck bleibt nach dem Beladen gesperrt");
        Assert.IsTrue(_bay.IsLoaded, "nichts geladen");

        var from = _truck.transform.position;
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(2.5f);
        _truck.useExternalInput = false;

        Assert.Greater(Vector3.Distance(from, _truck.transform.position), 2f,
            "der Truck faehrt auch beladen nicht los");
    }

    [UnityTest]
    public IEnumerator TheLoadIsVisibleOnTheBed()
    {
        _bayUi.Auto();
        _bayUi.Confirm();
        yield return null;

        int crates = 0;
        foreach (var t in _truck.GetComponentsInChildren<Transform>(true))
            if (t.name == "Package") crates++;

        Assert.AreEqual(_bay.Manifest.Count, crates,
            "die Ladung ist auf dem Truck nicht zu sehen");
    }

    [UnityTest]
    public IEnumerator ARespawnOpensTheBayAgainAndDropsTheLoad()
    {
        _bayUi.Auto();
        _bayUi.Confirm();
        yield return null;
        Assert.IsTrue(_bay.IsLoaded);

        // Wait for the CONDITION, not for a fixed number of frames. Spawn
        // protection is cleared in TruckHealth.Update, and destroying the truck
        // before that ran is silently ignored - which showed up as this test
        // failing one run in two.
        // Move the BODY, not the transform. The truck has a non-kinematic
        // rigidbody, so a transform write is overwritten at the next physics
        // step and the truck is dragged back to the spawn - which is why the
        // protection sometimes never lifted and this failed one run in two.
        var body = _truck.GetComponent<Rigidbody>();
        var away = _truck.spawnPosition + new Vector3(25f, 0f, 0f);
        body.linearVelocity = Vector3.zero;
        body.angularVelocity = Vector3.zero;
        body.position = away;
        _truck.transform.position = away;
        for (int i = 0; i < 30 && _health.IsInvulnerable; i++) yield return null;
        Assert.IsFalse(_health.IsInvulnerable, "der Truck steht abseits des Spawns und ist noch geschuetzt");

        _health.respawnSeconds = 1f;
        _health.WriteOff();
        Assert.IsTrue(_health.IsDestroyed, "der Truck liess sich nicht zerstoeren");
        float t0 = Time.realtimeSinceStartup;
        while (_health.IsDestroyed && Time.realtimeSinceStartup - t0 < 8f) yield return null;
        yield return null;

        Assert.IsTrue(_bayUi.IsOpen, "nach dem Respawn geht die Rampe nicht wieder auf");
        Assert.IsFalse(_bay.IsLoaded, "die Ladung ueberlebt die Zerstoerung des Trucks");
        Assert.IsTrue(_truck.controlsLocked, "der Truck ist nach dem Respawn nicht gesperrt");
    }

    [Test]
    public void TheApiShapeIsParsed()
    {
        const string json =
            "[{\"txid\":\"abc123abc123abc123\",\"fee\":4200,\"vsize\":140,\"value\":123456789}," +
            "{\"txid\":\"def456def456def456\",\"fee\":900,\"vsize\":300,\"value\":5000}]";

        var list = MempoolFeed.Parse(json, 10);
        Assert.AreEqual(2, list.Count, "die Antwort von /api/mempool/recent wird nicht gelesen");
        Assert.AreEqual("abc123abc123abc123", list[0].txid);
        Assert.AreEqual(30f, list[0].FeeRate, 0.01f, "die Gebuehrenrate stimmt nicht");
        Assert.AreEqual(1.23456789, list[0].Btc, 0.0001);
    }
}
