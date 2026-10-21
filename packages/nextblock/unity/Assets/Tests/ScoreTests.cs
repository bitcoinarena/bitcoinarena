// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// FIVE TESTS THAT USED TO LIVE HERE NOW LIVE IN `packages/nextblock/test`.
///
/// `RunScore` had a second scoring formula for when no core is answering, and
/// in the editor no core ever is - so these were measuring Unity's arithmetic
/// and calling it the score. The formula is deleted, so their rules moved to
/// where the core actually runs, each with a mutant that kills it:
///
///   an empty bed collapses a score that was already built
///   nothing accrues while the truck is still on the apron
///   a wreck banks nothing, however much the run had earned
///   the seam banks more than the quiet lane for the same ground made good
///   heat raises what a metre of ground is worth
///
/// The bounds moved with them but the NUMBERS did not: the C# asserted 1.8x
/// between the seam and the quiet lane, measured against its own threat model
/// and its own fixture. Measured in the core at equal ground made good the
/// gradient is edge 110.4, then 145.9, 155.7, seam 178.9 - 1.62x - and the
/// core test asserts 1.5x with the monotonic ordering beside it. Transplanting
/// 1.8 would have been copying a constant into different units.
///
/// What is left in this file is Unity's own behaviour: where boxes sit, what
/// the HUD shows, and that the run does not start under spawn protection.
/// </summary>
/// <summary>
/// The scoring rule from section 18A of multiplayer_p2p.md.
///
/// These tests are unusual for this project: most of them check that the game
/// does what the code says, and these check that the code does what the SPEC
/// says. The spec's whole claim is that exposure has to be multiplicative,
/// because an additive score makes the map edge the best play — the same
/// exploit as "carry only the cheapest parcels", one costume over.
///
/// So the assertions are deliberately written against the claim rather than
/// the implementation. A future refactor that quietly turns the formula
/// additive would leave every line of RunScore looking reasonable and would
/// fail SafeRouteScoresNearNothing, which is the point.
/// </summary>
public class ScoreTests
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
    RunScore _score;
    CargoBay _bay;
    TruckController _truck;
    TruckHealth _health;
    Battlefield _field;
    LoadoutPanel _ui;
    MempoolFeed _feed;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        // Model streaming is orthogonal to scoring and it is noisy: the
        // high-detail FBX assets are not in this working copy, so Addressables
        // logs a missing-key error per model and the test framework fails the
        // test on it. Ignoring is scoped to the setup window only - the
        // assertions below run with error checking back on, so a real fault in
        // RunScore still fails the test.
        LogAssert.ignoreFailingMessages = true;

        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        var streamer = Object.FindFirstObjectByType<ModelStreamer>();
        if (streamer != null) streamer.enabled = false;

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        _score = Object.FindFirstObjectByType<RunScore>();
        _bay = Object.FindFirstObjectByType<CargoBay>();
        _truck = Object.FindFirstObjectByType<TruckController>();
        _health = Object.FindFirstObjectByType<TruckHealth>();
        _field = Object.FindFirstObjectByType<Battlefield>();
        _ui = Object.FindFirstObjectByType<LoadoutPanel>();
        _feed = Object.FindFirstObjectByType<MempoolFeed>();

        Assert.IsNotNull(_score, "Bootstrap did not build a RunScore");

        _feed.Offers = new List<MempoolFeed.Tx>
        {
            new MempoolFeed.Tx { txid = "aaaa", feeSats = 5000, vsize = 400, valueSats = 100_000_000 },
            new MempoolFeed.Tx { txid = "bbbb", feeSats = 4000, vsize = 400, valueSats =  90_000_000 },
            new MempoolFeed.Tx { txid = "cccc", feeSats = 3000, vsize = 400, valueSats =  80_000_000 },
            new MempoolFeed.Tx { txid = "dddd", feeSats = 2000, vsize = 400, valueSats =  70_000_000 },
        };
        yield return null;
        LogAssert.ignoreFailingMessages = false;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        LogAssert.ignoreFailingMessages = true;   // teardown tears down noisily
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
        LogAssert.ignoreFailingMessages = false;
    }

    /// <summary>
    /// Loads freight and reports the truck as under way, so exposure accrues.
    ///
    /// Both conditions matter and both bit me: an empty bed makes the cargo
    /// factor zero (so every score is zero and every test passes vacuously),
    /// and spawn protection suppresses accrual (so every score is zero for a
    /// completely different reason).
    /// </summary>
    IEnumerator Launch()
    {
        foreach (var tx in _feed.Offers) _bay.TryAdd(tx);
        Assert.IsTrue(_bay.IsLoaded, "test fixture failed to load the bed");

        // Shut the bay. An open bay now holds spawn protection outright, so a
        // fixture that loads the bed directly and never confirms leaves the
        // truck immortal and every exposure assertion below vacuous.
        _ui.Confirm();
        yield return null;

        // Leave the ramp, and leave it PROPERLY - out to the middle of the map.
        //
        // Spawn protection lifts on movement, and the rigidbody owns the
        // transform, so the body is what has to be moved. Nudging it a few
        // metres is not enough any more: the apron pays no exposure at all, and
        // when the tape put the frontline near the spawn a fixture that stayed
        // close measured that rule instead of the one under test.
        var rb = _truck.GetComponent<Rigidbody>();
        rb.position = new Vector3(0f, rb.position.y + 0.5f, rb.position.z + 40f);
        yield return new WaitForSeconds(0.4f);
        Assert.IsFalse(_health.IsInvulnerable, "truck never left spawn protection");
        Assert.Greater(Vector3.Distance(rb.position, _truck.spawnPosition),
                       _score.spawnFreeRadius,
                       "das Fixture steht noch auf dem Vorfeld, wo nichts verdient wird");

        // These tests measure SCORING, not survival, and driving the seam for
        // six seconds means driving into a tank - which writes the truck off,
        // ends the run and zeroes the exposure under test. Damage is disarmed
        // here; AWreckBanksNothing calls WriteOff() directly and is unaffected.
        _health.crashSpeed = 9999f;
        _health.armour = 9999f;

        // Kinematic from here on. These fixtures place the truck frame by
        // frame, and a dynamic body fights every placement: the suspension
        // pushes back, the wheels grip, and the resulting jitter measured about
        // 1.8 m/s of "movement" for a truck that was standing still. That is
        // enough to defeat the idle rule, so a parked truck scored and a driven
        // one did not - both fixtures were measuring physics, not scoring.
        rb.isKinematic = true;
    }

    /// <summary>Parks the truck at a z offset from the frontline and holds it there.</summary>
    IEnumerator Hold(float offsetFromFront, float seconds)
    {
        var rb = _truck.GetComponent<Rigidbody>();
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        float limit = terrain.width * 0.42f;
        float dir = 1f;
        float t = 0f;
        while (t < seconds)
        {
            // Driven ALONG the corridor, not parked in it. Idling earns nothing
            // by design now, and the wheel colliders brake whenever the
            // throttle is idle - so a fixture that only sets a velocity reads
            // as stationary and measures the idle rule instead of this one.
            float x = rb.position.x + dir * 15f * Time.deltaTime;
            if (Mathf.Abs(x) > limit) { dir = -dir; x = rb.position.x; }
            rb.position = new Vector3(x, rb.position.y, _field.FrontlineZ(x) + offsetFromFront);
            t += Time.deltaTime;
            yield return null;
        }
    }

    /// <summary>
    /// Drives the QUIETEST lane the map offers, found by sampling.
    ///
    /// The far edge is not it. Danger is now counted as guns actually in
    /// range, and both armies fill the whole depth of the map - so hugging the
    /// z-edge means driving through the rear of an army rather than away from
    /// one. The safe route this test is about is wherever the fewest units
    /// are, which has to be looked for rather than assumed.
    /// </summary>
    IEnumerator HoldAtTheFarEdge(float seconds)
    {
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        float edge = terrain.depth * 0.5f - 6f;
        float limit = terrain.width * 0.42f;
        float dir = 1f;
        var rb = _truck.GetComponent<Rigidbody>();

        for (float t = 0f; t < seconds; t += Time.deltaTime)
        {
            float x = rb.position.x + dir * 15f * Time.deltaTime;
            if (Mathf.Abs(x) > limit) { dir = -dir; x = rb.position.x; }

            // the emptiest lane at this x, sampled fresh: the armies move
            float bestZ = 0f, bestThreat = float.MaxValue;
            for (float z = -edge; z <= edge; z += 7f)
            {
                float th = _score.ThreatAt(new Vector3(x, rb.position.y, z));
                if (th < bestThreat) { bestThreat = th; bestZ = z; }
            }

            rb.position = new Vector3(x, rb.position.y, bestZ);   // driven, not parked
            yield return null;
        }
    }

    /// <summary>
    /// Standing still earns nothing, wherever you are standing.
    ///
    /// The frontline moves with the price and sometimes drifts to within a few
    /// dozen metres of the spawn point. A truck parked there, loaded and doing
    /// absolutely nothing, was being paid exposure - and parking ON the seam
    /// paid best of all, which would have made "stop and wait" the strongest
    /// opening in the game.
    /// </summary>
    [UnityTest]
    public IEnumerator IdlingEarnsNothingEvenOnTheSeam()
    {
        yield return Launch();

        var rb = _truck.GetComponent<Rigidbody>();

        // Parked at ONE fixed spot on the seam, captured once. Re-reading the
        // frontline every frame would move the truck with it - the tape shifts
        // the front between frames and the fixture would then be driving, which
        // is the opposite of what this test is about.
        var spot = new Vector3(rb.position.x, rb.position.y,
                               _field.FrontlineZ(rb.position.x));

        // Settle first, THEN measure. Moving onto the spot is itself a
        // movement, and taking the peak from the first frame recorded that
        // one jump rather than the standing still that follows it.
        for (float t = 0f; t < 0.4f; t += Time.deltaTime)
        {
            rb.position = spot;
            yield return null;
        }

        float peak = 0f;
        for (float t = 0f; t < 1.5f; t += Time.deltaTime)
        {
            rb.position = spot;
            yield return null;
            peak = Mathf.Max(peak, _score.Rate);
        }

        Assert.AreEqual(0f, peak, 0.001f,
            $"a parked truck on the frontline earned at {peak:0.00}");
        Assert.IsFalse(_score.MakingProgress, "Stillstand gilt als Fortschritt");
    }

    /// <summary>The apron is safe ground and pays nothing, wherever the tape puts the front.</summary>
    [UnityTest]
    public IEnumerator TheSpawnApronNeverEarns()
    {
        yield return Launch();

        var rb = _truck.GetComponent<Rigidbody>();
        // parked ON the spawn point, and moving, so only the apron rule applies
        for (float t = 0f; t < 0.6f; t += Time.deltaTime)
        {
            // criss-crossing the apron at speed, so only the apron rule can
            // be what holds the rate at zero
            rb.position = _truck.spawnPosition
                        + new Vector3(Mathf.Sin(t * 30f) * 4f, 0f, Mathf.Cos(t * 30f) * 4f);
            yield return null;
            Assert.AreEqual(0f, _score.Rate, 0.001f,
                "der Spawnpunkt zahlt Exposition");
        }
    }




    /// <summary>Sitting in the loading bay must not bank par time or exposure.</summary>
    [UnityTest]
    public IEnumerator NothingAccruesBeforeLeavingTheRamp()
    {
        foreach (var tx in _feed.Offers) _bay.TryAdd(tx);
        yield return new WaitForSeconds(1.2f);

        Assert.IsTrue(_health.IsInvulnerable, "fixture left spawn unexpectedly");
        Assert.IsFalse(_score.Running, "the run started while still under protection");
        Assert.AreEqual(0f, _score.Exposure, 0.001f);
    }



    /// <summary>
    /// The meter sits UNDER the condition bar, in the same column.
    ///
    /// This test used to require the opposite - that the meter be to the RIGHT
    /// of the whole left column - because the meter lived under the wanted
    /// stars in the top right corner. the owner asked for condition and danger
    /// stacked on 2026-09-06: they are the two numbers a driver reads about
    /// the run he is in, and they were at opposite ends of the screen. The
    /// requirement is reversed rather than relaxed, and it is checked at the
    /// sizes the game is actually played at rather than one.
    /// </summary>
    [Test]
    public void TheDangerMeterSitsUnderTheConditionBar()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.IsNotNull(hud);

        foreach (var size in new[] { new Vector2(1600, 720), new Vector2(1920, 1080),
                                     new Vector2(844, 390), new Vector2(1366, 768) })
        {
            int w = (int)size.x, h = (int)size.y;
            var meter = hud.ExposureBox(w, h);
            var health = hud.HealthBox(w, h);
            string at = $"at {w}x{h}";

            Assert.AreEqual(health.x, meter.x, 0.01f, $"the two are not in one column {at}");
            Assert.AreEqual(health.width, meter.width, 0.01f,
                $"the two are not the same width {at}");
            Assert.GreaterOrEqual(meter.y, health.yMax,
                $"the danger meter starts before the condition bar ends {at}");
            Assert.IsFalse(meter.Overlaps(health), $"they overlap {at}");
            Assert.Less(meter.yMax, h * 0.6f, $"the meter drifted into the middle {at}");
            Assert.Greater(meter.width, 80f, $"the meter is too narrow to read a fill off {at}");
        }
    }
}
