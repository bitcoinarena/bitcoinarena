// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    /// The truck's condition has two owners, and this prints both.
    ///
    /// PRIORITIES (e) says they disagree; that was read off the source and
    /// never measured, so here they are side by side on one run. The game's
    /// copy lives in this component - `maxHealth` 100, and `Damage` takes
    /// `amount / armour` with `armour` 1.5 - and is fed by
    /// `Field.Army.CourierHit` at `Bootstrap.cs:194`. The core's lives in
    /// `T_HP`, starts at the same 100, and is reduced by the shell's full
    /// amount with no armour divisor at all (`sim.js:829`). So the two are
    /// not merely separate, they are on different scales.
    ///
    /// Measurement, not an assertion: it prints TWOOWNERS lines and asserts
    /// only that a core was answering, because a run with no core prints one
    /// flat hundred beside one flat zero and looks like a disagreement.
    ///
    /// AND IN THE EDITOR THERE IS NO CORE. `ArenaCore` compiles its calls to
    /// stubs unless `UNITY_WEBGL && !UNITY_EDITOR`, so `Available` is false
    /// here, `_state` stays zeroed, and every reading below is a zero that
    /// means "not asked" rather than "no health left". Run it against a WebGL
    /// build in a browser; run it here and it fails on purpose, saying so.
    /// That asymmetry is deliberate and the class doc gives the reason - the
    /// alternative is a second implementation of the simulation in C#.
    /// </summary>
    [UnityTest]
    [Explicit("Measurement, not an assertion. Read the TWOOWNERS lines out " +
              "of the log.")]
    public IEnumerator MeasureTheTwoTruckHealths()
    {
        // Through the real control path with the keyboard swapped out.
        // `externalThrottle` on its own does nothing, and the first run of
        // this measurement proved it: the truck sat at x = -100.4 for sixty
        // seconds and reported a tidy zero for everything, which is a null
        // result from a test that could not have fired.
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;

        float coreZero = -1f, gameZero = -1f, stateAt = -1f;
        int lastState = Arena.ArenaCore.RunState;
        Debug.Log($"TWOOWNERS RUN maxHealth={_health.maxHealth} armour={_health.armour} " +
                  $"coreStart={Arena.ArenaCore.TruckHealth:0.00}");

        for (int i = 1; i <= 120; i++)          // 60 s at half-second samples
        {
            yield return new WaitForSeconds(0.5f);
            float t = i * 0.5f;
            float core = Arena.ArenaCore.TruckHealth, game = _health.Health;
            int state = Arena.ArenaCore.RunState;

            if (coreZero < 0f && core <= 0f) coreZero = t;
            if (gameZero < 0f && game <= 0f) gameZero = t;
            if (state != lastState) { stateAt = t; lastState = state; }

            Debug.Log($"TWOOWNERS t={t:0.0} core={core:0.00} game={game:0.00} " +
                      $"runState={state} tick={Arena.ArenaCore.Tick} " +
                      $"x={_truck.transform.position.x:0.0} z={_truck.transform.position.z:0.0}");
        }

        Debug.Log($"TWOOWNERS END coreHitZero={coreZero:0.0} gameHitZero={gameZero:0.0} " +
                  $"runStateChangedAt={stateAt:0.0}");
        Assert.IsTrue(Arena.ArenaCore.Available,
            "kein Core in diesem Lauf - ArenaCore ist ausserhalb von WebGL gestubbt, " +
            "die core-Spalte ist dann durchgehend 0 und vergleicht nichts");
        Assert.Greater(Arena.ArenaCore.Tick, 600, "der Lauf ist gar nicht angelaufen");
    }

    /// <summary>
    /// What `RunOver` and `ClearPath` are actually worth, before (e) deletes
    /// the file they live in.
    ///
    /// Both are outcomes the PLAYER produces and neither has a rule in the
    /// core: driving over riflemen above 2.5 m/s kills them
    /// (`Battlefield.cs:144`, radius 3.6), and infantry are eased out of the
    /// truck's corridor so nobody is left standing in the cab
    /// (`Battlefield.cs:153`, halfWidth 7.5, ahead 26). After (e) they either
    /// vanish from the game or stay in C#, and both of those break the law -
    /// so the port has to be sized first, and it cannot be sized afterwards
    /// because `Army.cs` is gone by then.
    ///
    /// `Battlefield.RunDown` already counts the kills, so nothing in the game
    /// is touched to read it.
    ///
    /// THE CORRIDOR CENSUS BELOW IS NOT WHAT `ClearPath` DOES, and an earlier
    /// version of this comment said it was. Its corridor branch never runs:
    /// the only call is `YieldTo(u, 0f, 0.9f, false, 1.6f)`, with `stepsAside`
    /// false and `rate` zero, so `halfWidth` and `ahead` are dead parameters.
    /// What it actually does is push a man back out to 1.6 m if he is inside
    /// it, so nobody is left standing in the cab - and that is the depth
    /// column, which is the one to compare the core against. The corridor
    /// count is kept only to show how many men the truck passes near.
    ///
    /// Measurement, not an assertion. Watch the speed column: `Battlefield`
    /// takes it from the CORE when the core is driving and from a kinematic
    /// Rigidbody otherwise, and a kinematic body reports zero - so a run with
    /// no core can report no run-overs for a reason that has nothing to do
    /// with the rule.
    /// </summary>
    [UnityTest]
    [Explicit("Measurement, not an assertion. Read the RUNOVER lines out of " +
              "the log.")]
    public IEnumerator MeasureRunOverAndClearPath()
    {
        // Through the real control path with the keyboard swapped out.
        // `externalThrottle` on its own does nothing, and the first run of
        // this measurement proved it: the truck sat at x = -100.4 for sixty
        // seconds and reported a tidy zero for everything, which is a null
        // result from a test that could not have fired.
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        var army = _field.Army;
        var body = _truck.GetComponent<Rigidbody>();
        var driver = _truck.GetComponent<Arena.CoreDrivenTruck>();

        Debug.Log($"RUNOVER RUN coreAvailable={Arena.ArenaCore.Available} " +
                  $"driving={(driver != null && driver.Driving)} " +
                  $"kinematic={(body != null && body.isKinematic)}");

        int corridorPeak = 0, insidePeak = 0, samples = 0, deepTicks = 0;
        long corridorSum = 0;
        float penetration = 0f, deepest = 0f;
        for (int i = 1; i <= 120; i++)
        {
            // Steered at the nearest living rifleman rather than driven
            // straight. Straight ahead the truck crossed the whole map at
            // 20 m/s with `corridor` at zero the entire way - it simply never
            // met anybody, and a rule cannot be sized on a route that misses
            // it. This is the upper bound the port has to cover: what the
            // rule is worth to a player who drives AT the infantry.
            {
                var here = _truck.transform.position;
                float best = float.MaxValue; float bx = 0f, bz = 0f;
                foreach (var u in army.Infantry)
                {
                    if (u.hp <= 0f) continue;
                    float d = (u.x - here.x) * (u.x - here.x) + (u.z - here.z) * (u.z - here.z);
                    if (d < best) { best = d; bx = u.x; bz = u.z; }
                }
                if (best < float.MaxValue)
                {
                    float want = Mathf.Atan2(bx - here.x, bz - here.z) * Mathf.Rad2Deg;
                    float err = Mathf.DeltaAngle(_truck.transform.eulerAngles.y, want);
                    _truck.externalSteer = Mathf.Clamp(err / 30f, -1f, 1f);
                }
            }

            yield return new WaitForSeconds(0.5f);
            var p = _truck.transform.position;
            float heading = _truck.transform.eulerAngles.y * Mathf.Deg2Rad;
            float dirX = Mathf.Sin(heading), dirZ = Mathf.Cos(heading);

            int corridor = 0, inside = 0;
            foreach (var u in army.Infantry)
            {
                if (u.hp <= 0f) continue;
                float ox = u.x - p.x, oz = u.z - p.z;
                float along = ox * dirX + oz * dirZ;
                float across = -ox * dirZ + oz * dirX;
                if (along > -4f && along < 26f && Mathf.Abs(across) < 8.3f) corridor++;
                if (ox * ox + oz * oz < 3.6f * 3.6f) inside++;
                // The quantity ClearPath owns: how far INTO the truck a man is.
                float d = Mathf.Sqrt(ox * ox + oz * oz);
                if (d < 1.6f)
                {
                    float depth = 1.6f - d;
                    penetration += depth;
                    if (depth > deepest) deepest = depth;
                    if (depth > 0.02f) deepTicks++;
                }
            }
            corridorSum += corridor; samples++;
            if (corridor > corridorPeak) corridorPeak = corridor;
            if (inside > insidePeak) insidePeak = inside;

            var v = driver != null && driver.Driving
                ? Arena.ArenaCore.Velocity
                : (body != null ? body.linearVelocity : Vector3.zero);
            Debug.Log($"RUNOVER t={i * 0.5f:0.0} runDown={_field.RunDown} " +
                      $"speed={v.magnitude:0.00} corridor={corridor} within3.6m={inside} " +
                      $"men={army.Infantry.Count} x={p.x:0.0} z={p.z:0.0}");
        }

        Debug.Log($"RUNOVER END runDown={_field.RunDown} corridorPeak={corridorPeak} " +
                  $"corridorMean={(samples > 0 ? corridorSum / (double)samples : 0):0.00} " +
                  $"within3.6mPeak={insidePeak} penetration={penetration:0.000} " +
                  $"deepest={deepest:0.000} deepManSamples={deepTicks}");
        Assert.Greater(samples, 0);
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
    public IEnumerator ACoreWriteOffIsShownWhileTheBayIsOpen()
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

        // Nothing in C# hurts the truck: `Damage` is gone and this class only
        // shows what the core says.
        Assert.AreEqual(1f, _health.Fraction, 0.001f,
            "der Truck hat waehrend der Auswahl Schaden genommen");

        // AND C# DOES NOT REFUSE THE CORE'S VERDICT. This used to call
        // `WriteOff` and assert that a protected truck refused it - which was
        // the veto itself, written down as a test. Measured in a browser with
        // the same injection, run 0 -> 2 and `T_HP` 100 -> 0 forced in the
        // core: the road showed WASTED, the apron with the bay open showed an
        // intact truck. Two engines disagreeing about whether the run is over.
        //
        // The promise this test was named for - choosing freight is not a way
        // to die - is not deleted, it is moved to the engine that owns damage:
        // `practice shields the truck in the core, not in the client` in
        // packages/core. The apron itself is a listed core gap and is now
        // reachable; see PRIORITIES.
        _health.ApplySnapshot(0f, true);
        yield return null;

        Assert.IsTrue(_health.IsDestroyed,
            "C# hat ein Wrack abgelehnt, das der Core schon gesetzt hatte");
        Assert.AreEqual(0f, _health.Fraction, 0.001f,
            "der Zustand folgt dem Core nicht");
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
    public IEnumerator TheApronDoesNotOverruleTheCore()
    {
        Assert.IsTrue(_health.IsInvulnerable, "der Truck ist am Spawn nicht geschuetzt");
        Assert.AreEqual(1f, _health.Fraction, 0.001f, "er nimmt am Spawn Schaden");

        // The write-off is the CORE's to make, and C# shows it. This asserted
        // the opposite - that a protected truck refuses one - and that refusal
        // was a second gate over an M1 outcome. Where the truck may be hurt is
        // a rule about damage and belongs in `sim.js`, which is where the
        // practice shield already is.
        _health.ApplySnapshot(0f, true);
        yield return null;

        Assert.IsTrue(_health.IsDestroyed,
            "C# hat am Spawn ein Wrack abgelehnt, das der Core gesetzt hatte");
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

    /// <summary>
    /// REMOVED, and the claim is on the list instead.
    ///
    /// `TheArmiesLeaveAWreckAlone` asserted `Field.Army.Courier` was null
    /// once the truck was written off - the C# army stops shooting a burning
    /// van. No C# army runs, and the core has no such rule: nothing in it
    /// reads `T_HP`, so a wreck stays a courier target. That is a named gap
    /// in PRIORITIES, not something to keep a red product test alive for, and
    /// not something to re-source to a rule that does not exist.
    /// </summary>

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
