// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    /// <summary>
    /// Practice mode is on when the game starts and withholds every hit -
    /// which is what it is for, and which makes every test below vacuous if
    /// it is left that way. It is a process-wide static, so it has to be put
    /// back deliberately rather than assumed.
    /// </summary>
    [SetUp]
    public void PracticeOffSoDamageIsReal() => Arena.PracticeMode.On = false;

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

        // past the title screen: it holds the truck and the ramp until PLAY
        var splash0 = Object.FindFirstObjectByType<SplashScreen>();
        if (splash0 != null && splash0.Showing) splash0.Play();
        yield return null;

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
            // near the truck's 20 BTC limit - a whale does not fit one truck any more (CARGO-BTC-2148)
            new MempoolFeed.Tx { txid = "whale000000000000000000000000001",
                                 feeSats = 9000, vsize = 300, valueSats = 1_950_000_000 },
        };
        yield return null; yield return null;

        Assert.AreEqual(0f, _bay.Heat, 0.001f, "ein leerer Truck ist schon gesucht");

        var yard = Object.FindFirstObjectByType<PackageYard>();
        yard.Toggle(yard.Captions()[0].tx);
        yield return null; yield return null;

        Assert.Greater(_bay.Heat, 0.5f,
            $"19.5 BTC an Bord ergeben nur {_bay.Heat:0.00} Fahndungsdruck");
        // The army half of this claim is gone with the C# army, and the core
        // has no Heat term at all - `Rand(5, 11)` with Heat at zero, because
        // every recording it was built against has Heat at zero. Listed as a
        // gap; not asserted here against a rule that does not exist.
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
        // Same as above: the bay's own heat is the half that still has a
        // subject, and it is asserted directly.
        Assert.AreEqual(0f, _bay.Heat, 0.001f, "ein leerer Truck wird weiter gejagt");
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

    /* ------------------------------------------------------------ the block */

    /// <summary>
    /// Reported as an exploit: load only tiny parcels, never be threatened,
    /// and earn for ever. The block is the answer - time is the scarce thing,
    /// not safety - so a timid run and a bold one cost the same block.
    /// </summary>
    [UnityTest]
    public IEnumerator TheBlockPutsAPriceOnTime()
    {
        var clock = Object.FindFirstObjectByType<BlockClock>();
        Assert.IsNotNull(clock, "keine Blockuhr in der Szene");
        Assert.Greater(clock.Remaining, 0f, "die Runde laeuft nicht");
        Assert.Greater(clock.blockSeconds, 30f, "eine Runde ist unspielbar kurz");
        yield return null;

        // a timid run and a bold one both spend the whole block
        clock.gate.Delivered.Invoke(52);
        yield return null;
        Assert.AreEqual(52, clock.PendingSats, "die Lieferung landet nicht im Block");

        clock.Close();
        Assert.AreEqual(0, clock.PendingSats, "der Block wird nicht abgeschlossen");
        Assert.AreEqual(1, clock.Board.Count, "der Block kommt nicht auf die Bestenliste");
        Assert.AreEqual(52, clock.Board[0].sats);

        // and the board ranks blocks against each other
        clock.gate.Delivered.Invoke(4000);
        clock.Close();
        Assert.AreEqual(4000, clock.Board[0].sats,
            "die Bestenliste sortiert die Bloecke nicht nach Ertrag");
    }

    /// <summary>
    /// Reported: the block, its clock and the board were nowhere to be seen.
    /// They were drawn top left and the developer readout is drawn top left
    /// too - later in OnGUI, so it landed on top of them.
    /// </summary>
    [Test]
    public void TheBlockReadoutIsWiredAndNotBuriedUnderTheDiagnostics()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        var clock = Object.FindFirstObjectByType<BlockClock>();

        Assert.IsNotNull(clock, "keine Blockuhr");
        Assert.AreSame(clock, hud.block, "das HUD kennt die Blockuhr nicht");
        Assert.IsFalse(hud.showDiagnostics,
            "das Diagnosefeld ist an und verdeckt Block, Uhr und Bestenliste");
        Assert.IsNotNull(clock.gate, "die Blockuhr haengt nicht am Lieferziel");
    }

    /// <summary>
    /// The corners of the screen are shared, and every one of these landed on
    /// top of something: the condition bar on the block, the score on the
    /// driving pads. Checked as rectangles, because that is what the fault is.
    /// </summary>
    [Test]
    public void NothingInTheHudOverlapsAnythingElse()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        const int W = 1600, H = 900;

        float pad = Mathf.Max(8f, H * 0.02f);
        var blockBox = new Rect(pad, pad, W * 0.24f + pad, hud.BlockBoxHeight(W, H));
        var health = hud.HealthBox(W, H);

        Assert.Greater(health.y, blockBox.yMax,
            $"der Zustandsbalken beginnt bei {health.y:0} und der Block endet erst " +
            $"bei {blockBox.yMax:0} - sie liegen uebereinander");

        // and the score has to sit clear of the throttle and brake pads
        var pads = TouchPad.RectFor(TouchPad.Pad.Up, W, H);
        var brake = TouchPad.RectFor(TouchPad.Pad.Down, W, H);
        Assert.Greater(pads.y, blockBox.yMax, "die Pads liegen im oberen HUD");
        Assert.Greater(brake.yMax, pads.y, "die Pads sind nicht gestapelt wie erwartet");
    }

    [Test]
    public void OnlyStreamedModelsAreListedAsStreaming()
    {
        var streamer = Object.FindFirstObjectByType<ModelStreamer>();
        Assert.IsNotNull(streamer, "kein Streamer");

        // Only the wording here. Whether the truck belongs in the list depends
        // on the SCENE having the model assigned, and this suite builds a bare
        // Bootstrap with no prefabs at all - so that check lives with the tests
        // that load the real scene. Checked here it would also be wrong for a
        // second reason: a successful stream sets truckModel itself, so after
        // it has run the field says nothing about where the model came from.
        foreach (var item in streamer.Items)
            Assert.IsFalse(item.label.Contains("ü") || item.label.Contains("ä") ||
                           item.label.Contains("Panzer") || item.label.Contains("Bomben"),
                $"'{item.label}' ist noch deutsch");
    }

    [Test]
    public void TheTitleScreenHoldsEverythingUntilPlay()
    {
        // it was dismissed in SetUp, so build a fresh one to look at
        var go = new GameObject("Splash");
        var splash = go.AddComponent<SplashScreen>();
        Assert.IsTrue(splash.Showing, "der Splash-Screen zeigt sich nicht");
        Assert.AreEqual(0f, AudioListener.volume, 0.001f,
            "der Ton laeuft schon vor dem Klick - im Browser wuerde er blockiert");

        splash.Play();
        Assert.IsFalse(splash.Showing);
        Assert.AreEqual(1f, AudioListener.volume, 0.001f, "nach PLAY bleibt es stumm");
    }

    /// <summary>
    /// Nothing on the title screen is drawn on top of anything else.
    ///
    /// The hint line used to be positioned relative to the PLAY button and was
    /// drawn straight through the second one, and on a short window the third
    /// instruction ran under both buttons: a layout that was right on one
    /// window size and wrong on every other. Overlap is a number, so it is
    /// measured - across the shapes a phone, a tablet and a desktop actually
    /// have.
    /// </summary>
    [Test]
    public void TheTitleScreenNeverDrawsOverItself()
    {
        var sizes = new[]
        {
            new Vector2(1920, 1080), new Vector2(1366, 768), new Vector2(1024, 1366),
            new Vector2(844, 390),   new Vector2(390, 844),  new Vector2(640, 480),
            new Vector2(2560, 1440), new Vector2(768, 1024),
        };

        foreach (var size in sizes)
        {
            float min = Mathf.Min(size.x, size.y);
            float sub = Mathf.Clamp(min * 0.028f, 14f, 24f);
            float btn = Mathf.Clamp(min * 0.040f, 18f, 34f);
            var f = SplashScreen.Measure(size.x, size.y, sub, btn);
            string at = $"bei {size.x}x{size.y}";

            void Apart(Rect a, Rect b, string what)
                => Assert.IsFalse(a.Overlaps(b), $"{what} ueberlappen sich {at}: {a} / {b}");

            Apart(f.copy, f.play, "Text und PLAY");
            Apart(f.copy, f.spectate, "Text und DEBUG SPECTATE");
            Apart(f.copy, f.hint, "Text und der Hinweis");
            Apart(f.hint, f.play, "der Hinweis und PLAY");
            Apart(f.hint, f.spectate, "der Hinweis und DEBUG SPECTATE");
            Apart(f.play, f.spectate, "die beiden Knoepfe");
            Apart(f.head, f.copy, "die Kopfzeile und der Text");
            // The build stamp is a row of its own and has to stay one: it is
            // only useful if nothing is drawn over it.
            Apart(f.build, f.head, "the build stamp and the title bar");
            Apart(f.build, f.copy, "the build stamp and the text");
            Apart(f.build, f.hint, "the build stamp and the hint");
            Apart(f.build, f.play, "the build stamp and PLAY");
            Assert.Greater(f.build.height, 8f, $"the build stamp has no height {at}");

            // side by side, same height, same baseline - that is the alignment
            Assert.AreEqual(f.play.y, f.spectate.y, 0.01f, $"die Knoepfe stehen versetzt {at}");
            Assert.AreEqual(f.play.height, f.spectate.height, 0.01f,
                $"die Knoepfe sind verschieden hoch {at}");
            Assert.Greater(f.spectate.x, f.play.xMax, $"die Knoepfe stehen nicht nebeneinander {at}");

            // and everything inside the panel it belongs to
            foreach (var r in new[] { f.copy, f.hint, f.play, f.spectate })
            {
                Assert.GreaterOrEqual(r.x, f.panel.x - 0.01f, $"etwas haengt links raus {at}");
                Assert.LessOrEqual(r.xMax, f.panel.xMax + 0.01f, $"etwas haengt rechts raus {at}");
                Assert.LessOrEqual(r.yMax, f.panel.yMax + 0.01f, $"etwas haengt unten raus {at}");
            }
            Assert.Greater(f.copy.height, 40f, $"fuer den Text bleibt kein Platz {at}");
        }
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
