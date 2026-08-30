using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// Sound, heat, damage that is felt, and the waypoint. None of these are
/// visible in the code being correct - each is a chain from one system to
/// another, and every break in this project so far has been in that chain.
/// </summary>
public class FeatureTests
{
    GameObject _boot;
    TruckController _truck;
    TruckHealth _health;
    Battlefield _field;
    CargoBay _bay;
    LoadoutPanel _panel;
    MempoolFeed _feed;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        _truck = Object.FindFirstObjectByType<TruckController>();
        _health = Object.FindFirstObjectByType<TruckHealth>();
        _field = Object.FindFirstObjectByType<Battlefield>();
        _bay = Object.FindFirstObjectByType<CargoBay>();
        _panel = Object.FindFirstObjectByType<LoadoutPanel>();
        _feed = Object.FindFirstObjectByType<MempoolFeed>();
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }

    /* ------------------------------------------------------------------ sound */

    [UnityTest]
    public IEnumerator TheEngineRunsAndRisesWithTheRevs()
    {
        var audio = Object.FindFirstObjectByType<GameAudio>();
        Assert.IsNotNull(audio, "kein Ton in der Szene");

        AudioSource engine = null;
        foreach (var src in audio.GetComponentsInChildren<AudioSource>())
            if (src.name == "Engine") engine = src;
        Assert.IsNotNull(engine, "kein Motorgeraeusch");
        Assert.IsTrue(engine.isPlaying, "der Motor laeuft nicht");
        Assert.IsNotNull(engine.clip, "der Motor hat keinen Klang");
        Assert.Greater(engine.clip.samples, 1000, "der Motorklang ist leer");

        _panel.Auto(); _panel.Confirm();
        yield return new WaitForSeconds(0.4f);
        float idle = engine.pitch;

        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(4f);
        float driving = engine.pitch;
        _truck.useExternalInput = false;

        Assert.Greater(driving, idle + 0.15f,
            $"die Drehzahl bleibt bei {driving:0.00} stehen (Leerlauf {idle:0.00})");
    }

    [UnityTest]
    public IEnumerator ImpactsAndDeliveriesAreHeard()
    {
        var audio = Object.FindFirstObjectByType<GameAudio>();
        int before = audio.Fired;

        audio.Impact(9f);
        audio.Explosion();
        audio.Delivered();
        yield return null;

        Assert.AreEqual(before + 3, audio.Fired, "die Effekte werden nicht ausgeloest");
    }

    /* ------------------------------------------------------------------- heat */

    [UnityTest]
    public IEnumerator ValuableFreightMakesTheTruckATarget()
    {
        _feed.Offers = new List<MempoolFeed.Tx>
        {
            new MempoolFeed.Tx { txid = "whale000000000000000000000000001",
                                 feeSats = 9000, vsize = 300, valueSats = 4_000_000_000 },
        };
        yield return null; yield return null;

        Assert.AreEqual(0f, _bay.Heat, 0.001f, "ein leerer Truck ist schon gesucht");

        var yard = Object.FindFirstObjectByType<PackageYard>();
        yard.Toggle(yard.Captions()[0].tx);
        yield return null; yield return null;

        Assert.Greater(_bay.Heat, 0.5f,
            $"ein Whale an Bord ergibt nur {_bay.Heat:0.00} Fahndungsdruck");
        Assert.Greater(_field.Army.Heat, 0.5f,
            "die Armeen erfahren nichts davon, was der Truck geladen hat");
    }

    [UnityTest]
    public IEnumerator AnEmptyTruckIsLeftAlone()
    {
        _panel.Auto(); _panel.Confirm();
        yield return null;

        var gate = Object.FindFirstObjectByType<DeliveryGate>();
        var body = _truck.GetComponent<Rigidbody>();
        var at = new Vector3(gate.gateX + 3f, _truck.transform.position.y, 0f);
        body.position = at; _truck.transform.position = at;
        yield return null; yield return null;      // delivered, so the bed is empty

        Assert.IsFalse(_bay.IsLoaded);
        Assert.AreEqual(0f, _field.Army.Heat, 0.001f,
            "ein leerer Truck wird weiter gejagt");
    }

    /* ----------------------------------------------------------------- damage */

    [UnityTest]
    public IEnumerator DamageIsFeltInTheDriving()
    {
        _panel.Auto(); _panel.Confirm();
        yield return null;

        Assert.AreEqual(1f, _truck.condition, 0.001f, "der Truck startet beschaedigt");

        // out of spawn protection, then take a beating
        var body = _truck.GetComponent<Rigidbody>();
        var away = _truck.spawnPosition + new Vector3(25f, 0f, 0f);
        body.linearVelocity = Vector3.zero;
        body.position = away;
        _truck.transform.position = away;
        for (int i = 0; i < 30 && _health.IsInvulnerable; i++) yield return null;

        _field.Army.CourierHit.Invoke(70f);
        yield return null; yield return null;

        Assert.Less(_health.Fraction, 0.7f, "der Treffer hat nichts bewirkt");
        Assert.AreEqual(_health.Fraction, _truck.condition, 0.01f,
            "der Zustand kommt nicht am Fahrverhalten an");
    }

    /* --------------------------------------------------------------- waypoint */

    [Test]
    public void TheHudKnowsWhereTheGateIs()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        var gate = Object.FindFirstObjectByType<DeliveryGate>();

        Assert.IsNotNull(hud.gate, "das HUD kennt das Lieferziel nicht - keine Zielmarkierung");
        Assert.IsNotNull(hud.truck, "das HUD kennt den Truck nicht");
        Assert.Greater(Vector3.Distance(_truck.transform.position,
                                        new Vector3(gate.gateX, 0f, 0f)), 100f,
            "das Ziel liegt in Sichtweite - dann braeuchte es keine Markierung");
    }
}
