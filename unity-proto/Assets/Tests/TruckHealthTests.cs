using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The truck's condition, its destruction and the wait before it is back.
/// These drive the real scene rather than a rig: the parts that broke in this
/// project were always the wiring between components, never the arithmetic.
/// </summary>
public class TruckHealthTests
{
    GameObject _boot;
    TruckController _truck;
    TruckHealth _health;
    Battlefield _field;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);
        _truck = Object.FindFirstObjectByType<TruckController>();
        _health = Object.FindFirstObjectByType<TruckHealth>();
        _field = Object.FindFirstObjectByType<Battlefield>();
        LoadAndRelease();
    }

    /// <summary>
    /// Choosing freight must not be a way to die.
    ///
    /// The bay locks the controls but not the physics, so a tank blundering
    /// onto the apron could shove the truck past the safe radius while the
    /// player was still reading the yard. Protection latched off, the next
    /// shell wrote the truck off, and the run ended before it began with no
    /// input from the player at all.
    /// </summary>
    [UnityTest]
    public IEnumerator NothingCanHurtTheTruckWhileTheBayIsOpen()
    {
        var ui = Object.FindFirstObjectByType<LoadoutPanel>();
        ui.Open();
        yield return null;
        Assert.IsTrue(ui.IsOpen, "die Rampe ist zu, der Test prueft nichts");

        // shoved well past the safe radius, as a tank would
        var rb = _truck.GetComponent<Rigidbody>();
        rb.position += new Vector3(0f, 0f, _health.safeRadius * 4f);
        yield return new WaitForSeconds(0.4f);

        Assert.IsTrue(_health.IsInvulnerable,
            "der Schutz faellt weg, obwohl der Spieler noch auswaehlt");

        _health.Damage(500f);
        _health.WriteOff();
        yield return null;

        Assert.IsFalse(_health.IsDestroyed,
            "der Truck wurde zerstoert, waehrend die Rampe offen war");
        Assert.AreEqual(1f, _health.Fraction, 0.001f,
            "der Truck hat waehrend der Auswahl Schaden genommen");
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


    /// <summary>
    /// Get through the loading bay. The truck is held at the ramp until
    /// freight is aboard, so anything that drives has to load first.
    /// </summary>
    static void LoadAndRelease()
    {
        // Past the title screen first: it holds the truck and keeps the ramp
        // shut until PLAY is pressed, which is the point of it.
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();

        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        if (panel == null) return;

        // Put freight in the yard first. The helper used to lean on whatever
        // the live mempool happened to return, and with an empty feed AUTO
        // loads nothing, LOSFAHREN rightly refuses, and every driving test
        // silently sat at the ramp.
        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        if (feed != null && feed.Offers.Count == 0)
            feed.Offers = new System.Collections.Generic.List<MempoolFeed.Tx>
            {
                new MempoolFeed.Tx
                {
                    txid = "testfreight0000000000000000000000",
                    feeSats = 2400, vsize = 300, valueSats = 25_000_000,
                },
            };

        panel.Auto();
        panel.Confirm();
        Assert.IsFalse(panel.IsOpen, "die Laderampe liess den Truck nicht los");
    }

    /// <summary>
    /// Get the truck off the apron. It is protected until it has driven clear
    /// of the spawn, so anything testing damage has to leave first.
    /// </summary>
    IEnumerator LeaveSpawn()
    {
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
        // the condition, not a frame count: protection is cleared in Update
        for (int i = 0; i < 30 && _health.IsInvulnerable; i++) yield return null;
        Assert.IsFalse(_health.IsInvulnerable, "der Truck ist abseits des Spawns noch geschuetzt");
    }

    [UnityTest]
    public IEnumerator TheTruckIsProtectedOnTheApron()
    {
        Assert.IsTrue(_health.IsInvulnerable, "der Truck ist am Spawn nicht geschuetzt");

        _health.WriteOff();
        _field.Army.CourierHit.Invoke(500f);
        yield return null;

        Assert.IsFalse(_health.IsDestroyed,
            "der Truck kann am Spawn zerstoert werden - genau das ist die Todesschleife");
        Assert.AreEqual(1f, _health.Fraction, 0.001f, "er nimmt am Spawn Schaden");
    }

    [UnityTest]
    public IEnumerator ProtectionComesBackWithTheRespawn()
    {
        yield return LeaveSpawn();
        _health.respawnSeconds = 1f;
        _health.WriteOff();

        float t0 = Time.realtimeSinceStartup;
        while (_health.IsDestroyed && Time.realtimeSinceStartup - t0 < 8f) yield return null;
        yield return null;

        Assert.IsTrue(_health.IsInvulnerable,
            "nach dem Respawn ist der Truck sofort wieder verwundbar");
    }

    [Test]
    public void AWreckIsMarkedAndATankIsNot()
    {
        var fx = Object.FindFirstObjectByType<CombatFx>();
        fx.Wreck(new Vector3(0f, 0f, 40f), 0f);

        bool marked = false;
        foreach (var h in Object.FindObjectsByType<BurntOutHull>(FindObjectsSortMode.None))
            if (h.GetComponent<Collider>() != null) marked = true;
        Assert.IsTrue(marked, "ein Wrack traegt keine Markierung - es ist von einem Panzer nicht zu unterscheiden");

        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
            if (t.name == "Hull" && t.GetComponent<BoxCollider>() != null)
            {
                Assert.IsNull(t.GetComponentInParent<BurntOutHull>(),
                    "ein lebender Panzer ist als Wrack markiert - dann waere kein Crash mehr toedlich");
                break;
            }
    }

    [Test]
    public void TheTruckStartsWhole()
    {
        Assert.IsNotNull(_health, "der Truck hat keine TruckHealth-Komponente");
        Assert.IsFalse(_health.IsDestroyed);
        Assert.AreEqual(1f, _health.Fraction, 0.001f, "der Truck startet nicht mit vollem Zustand");
    }

    [Test]
    public void TheHudShowsTheCondition()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.IsNotNull(hud, "kein HUD");
        Assert.AreSame(_health, hud.health, "das HUD kennt den Zustand des Trucks nicht");
    }

    [Test]
    public void TheBarSitsDirectlyUnderTheDebugPanel()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        hud.showDiagnostics = true;

        var diag = hud.DiagnosticsBox(1600, 900);
        var bar = hud.HealthBox(1600, 900);

        Assert.GreaterOrEqual(bar.y, diag.yMax,
            "der Zustandsbalken ueberlappt das Debug-Feld");
        Assert.Less(bar.y - diag.yMax, 40f,
            $"der Balken haengt {bar.y - diag.yMax:0} px unter dem Debug-Feld statt direkt darunter");
        Assert.AreEqual(diag.x, bar.x, 0.5f, "der Balken ist nicht am Debug-Feld ausgerichtet");
        Assert.AreEqual(diag.width, bar.width, 0.5f, "der Balken ist nicht so breit wie das Debug-Feld");
    }

    [UnityTest]
    public IEnumerator IncomingFireCostsCondition()
    {
        Assert.IsNotNull(_field?.Army, "keine Armee");
        yield return LeaveSpawn();

        // through the event the armies actually raise, not through Damage()
        _field.Army.CourierHit.Invoke(30f);
        yield return null;

        Assert.Less(_health.Fraction, 1f, "Beschuss hat dem Truck nichts getan");
        Assert.IsFalse(_health.IsDestroyed, "ein einzelner Treffer sollte ihn nicht zerstoeren");
    }

    [UnityTest]
    public IEnumerator EnoughFireWrecksIt()
    {
        yield return LeaveSpawn();
        for (int i = 0; i < 12 && !_health.IsDestroyed; i++)
        {
            _field.Army.CourierHit.Invoke(20f);
            yield return null;
        }
        Assert.IsTrue(_health.IsDestroyed, "der Truck haelt unbegrenzt Beschuss aus");
    }

    [UnityTest]
    public IEnumerator ADestroyedTruckBurns()
    {
        var fx = Object.FindFirstObjectByType<CombatFx>();
        Assert.IsNotNull(fx, "keine Effekte");
        int before = fx.LiveCount;

        yield return LeaveSpawn();
        _health.WriteOff();
        yield return null;

        Assert.Greater(fx.LiveCount, before,
            "beim Zerstoeren des Trucks entsteht kein Wrack und keine Explosion");
    }

    [UnityTest]
    public IEnumerator ItIsBackAtTheSpawnAfterTheWait()
    {
        _health.respawnSeconds = 1.5f;               // the real wait is 5s
        var spawn = _truck.spawnPosition;

        yield return LeaveSpawn();
        _health.WriteOff();
        yield return new WaitForSeconds(0.4f);
        Assert.IsTrue(_health.IsDestroyed, "der Truck ist sofort wieder da");

        yield return new WaitForSeconds(2f);
        Assert.IsFalse(_health.IsDestroyed, "der Truck kommt nach der Wartezeit nicht zurueck");
        Assert.AreEqual(1f, _health.Fraction, 0.001f, "er kommt beschaedigt zurueck");
        Assert.Less(Vector3.Distance(_truck.transform.position, spawn), 6f,
            "er kommt nicht am Spawnpunkt zurueck");
    }

    [UnityTest]
    public IEnumerator TheArmiesLeaveAWreckAlone()
    {
        _health.respawnSeconds = 30f;
        yield return LeaveSpawn();
        _health.WriteOff();
        yield return new WaitForSeconds(0.3f);

        Assert.IsNull(_field.Army.Courier,
            "die Armeen schiessen weiter auf einen bereits brennenden Truck");
    }

    /// <summary>
    /// The one the report was actually about: driving into a tank. This runs
    /// the real thing - full throttle down the field until it hits armour.
    /// </summary>
    [UnityTest]
    public IEnumerator CrashingIntoArmourWritesItOff()
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;

        // 25 seconds, not 12. The terrain is the live fee histogram, so how
        // long the run to the armies takes depends on the slope the truck
        // happens to spawn on - the same live-data variance that made the
        // handbrake test flap. It reaches the war in about 7 seconds on flat
        // ground; the budget is generous so a steep start is not a failure.
        for (float t = 0f; t < 25f && !_health.IsDestroyed; t += 0.25f)
            yield return new WaitForSeconds(0.25f);

        _truck.useExternalInput = false;
        Assert.IsTrue(_health.IsDestroyed,
            "der Truck ist mit Vollgas ins Schlachtfeld gefahren und nicht zerstoert worden");
    }
}
