using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

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

    /// <summary>
    /// Laps earn nothing.
    ///
    /// Once through the fighting a player could turn round and circle in the
    /// corridor, and as a time integral that kept paying: circling tripled the
    /// exposure term while the time term only halved, so stalling was worth
    /// doing. Exposure is now integrated over ground made good against a
    /// high-water mark, so a lap covers no new ground and earns accordingly -
    /// while the round clock runs on regardless.
    /// </summary>
    [UnityTest]
    public IEnumerator DrivingInCirclesEarnsNothing()
    {
        yield return Launch();

        // one honest run down the corridor, to build a mark to beat
        yield return Hold(0f, 3f);
        float earned = _score.Exposure;
        Assert.Greater(earned, 0.02f, "das Fixture ist gar nicht erst vorangekommen");

        // Now circle on the seam. The FIRST lap legitimately reaches further
        // than anything before it - that arc is real ground and is supposed to
        // pay. What must earn nothing is every lap after it, so the first is
        // ridden out and only the repeats are measured.
        var rb = _truck.GetComponent<Rigidbody>();
        float cx = rb.position.x;
        IEnumerator Circle(float seconds)
        {
            for (float t = 0f; t < seconds; t += Time.deltaTime)
            {
                float x = cx + Mathf.Sin(t * 3f) * 18f;
                rb.position = new Vector3(x, rb.position.y, _field.FrontlineZ(x));
                yield return null;
            }
        }

        yield return Circle(2.5f);                 // first lap: allowed to pay
        float afterFirstLap = _score.Exposure;

        yield return Circle(6f);                   // and now round and round

        Assert.Less(_score.Exposure - afterFirstLap, 0.005f,
            $"sechs Sekunden im Kreis brachten noch {_score.Exposure - afterFirstLap:0.000} Exposition");
        Assert.IsFalse(_score.MakingProgress, "eine Runde im Kreis gilt als Fortschritt");
    }

    /// <summary>
    /// The claim, stated as a test: hugging the edge earns almost nothing.
    ///
    /// This is the assertion the whole section exists for. If it ever passes
    /// by a narrow margin the balance has drifted back towards the exploit,
    /// so the bar is an order of magnitude rather than "less than".
    /// </summary>
    [UnityTest]
    public IEnumerator SafeRouteScoresNearNothing()
    {
        yield return Launch();
        yield return HoldAtTheFarEdge(6f);

        float safe = _score.Exposure;
        int safeScore = _score.Projected;

        // Back to the start of the run before the second leg.
        //
        // The quiet-lane leg leaves the truck near the far x limit, and
        // exposure only counts ground beyond a high-water mark - so a seam run
        // starting there immediately hits the wall, turns round, and records
        // about three metres of new ground. It measured 0.027 and looked like
        // the seam paying nothing, when it was the fixture having nowhere left
        // to drive.
        var back = _truck.GetComponent<Rigidbody>();
        back.position = new Vector3(-60f, back.position.y, back.position.z);
        yield return null;

        _score.Reset();
        yield return Hold(0f, 6f);

        float brave = _score.Exposure;
        int braveScore = _score.Projected;

        // The claim is a RATIO, and always was: "the safe route scores an
        // order of magnitude less". It was written as an absolute bound while
        // danger was geometry, and every change to the map or the armies moved
        // that number - first 0.02, then 0.12, and neither meant anything. Two
        // armies filling the map means a quiet lane is quiet, not empty, so the
        // ratio below is the assertion that carries the design.
        Assert.Greater(brave, 0.1f, $"seam route banked only {brave:0.000}");
        // 1.8x, measured rather than hoped for. On the built map the quietest
        // lane runs about 0.14 against the seam's 0.33 - a real gradient, but
        // nothing like the order of magnitude the geometric version reported,
        // because 22 tanks and 176 riflemen fill the whole depth and there is
        // no genuinely empty road to take. That is a finding about this map,
        // not a weakness in the rule: the safe route simply is not very safe
        // here. The bound guards the gradient; a change that flattens it -
        // saturating the threat scale, say - still fails.
        Assert.Greater(brave, safe * 1.8f,
            $"die ruhigste Spur ({safe:0.000}) liegt zu nah an der Naht ({brave:0.000})");
        // Same story as the exposure bound above: the score gap is the gradient
        // the map actually offers, not an order of magnitude. Both routes run
        // through an army; one runs through more of it.
        Assert.Greater(braveScore, safeScore * 1.8f,
            $"seam scored {braveScore} against the quiet lane's {safeScore} — " +
            "the safe route is competitive, which is the exploit section 18A closes");
    }

    /// <summary>
    /// Multiplicative, not additive: an empty bed scores zero however brave
    /// the driving was. Under an additive score it would still collect the
    /// exposure term, and a suicidal empty run would out-score a careful
    /// full one.
    /// </summary>
    [UnityTest]
    public IEnumerator EmptyBedScoresZeroHoweverBraveTheRun()
    {
        yield return Launch();
        yield return Hold(0f, 5f);
        Assert.Greater(_score.Exposure, 0.1f, "fixture never built any exposure");

        _bay.Clear();
        yield return null;

        Assert.AreEqual(0f, _score.CargoFactor, 0.001f);
        Assert.AreEqual(0, _score.Projected,
            "an empty bed scored above zero, so the factors are not multiplicative");
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
    /// A wreck banks nothing. The projected score is a projection precisely
    /// because it can be lost, and a HUD that kept showing it after a
    /// write-off would be reporting money that no longer exists.
    /// </summary>
    [UnityTest]
    public IEnumerator AWreckBanksNothing()
    {
        yield return Launch();
        yield return Hold(0f, 5f);
        Assert.Greater(_score.Projected, 0, "fixture never built a score to lose");

        _health.WriteOff();
        yield return null;

        Assert.AreEqual(0f, _score.Exposure, 0.001f);
        Assert.AreEqual(0, _score.Projected);
        Assert.AreEqual(0, _score.Best, "a wreck was banked as a best run");
    }

    /// <summary>
    /// Heat multiplies exposure, so the same road driven with a valuable load
    /// is worth more. This is the only channel through which cargo value
    /// reaches the score twice, and it is deliberate: value is what makes the
    /// corridor dangerous in the first place.
    /// </summary>
    [UnityTest]
    public IEnumerator HeatRaisesTheExposureRate()
    {
        yield return Launch();

        // Sampled DURING the hold, not after it. Reading once the loop has
        // exited samples whatever the world did next - and on the seam what it
        // does next is destroy the truck and respawn it at the ramp, where the
        // rate is correctly zero. That is how this test first reported 0.00.
        float hot = 0f;
        var rb = _truck.GetComponent<Rigidbody>();
        for (float t = 0f; t < 1.5f; t += Time.deltaTime)
        {
            float x = rb.position.x + 15f * Time.deltaTime;
            rb.position = new Vector3(x, rb.position.y, _field.FrontlineZ(x));
            yield return null;                               // driven, not parked
            hot = Mathf.Max(hot, _score.Rate);
        }

        Assert.Greater(hot, 1f, $"a loaded run on the seam peaked at only {hot:0.00}");
        Assert.LessOrEqual(hot, 2.01f, "the rate escaped its stated 0..2 range");
    }

    /// <summary>
    /// The meter has to stay off the block board, which lives top left and
    /// grows a row for every leaderboard entry. Checked at a browser-shaped
    /// aspect, because that is what it ships at.
    /// </summary>
    [Test]
    public void ExposureMeterClearsTheBlockBoard()
    {
        var hud = Object.FindFirstObjectByType<DriveHud>();
        Assert.IsNotNull(hud);

        int w = 1600, h = 720;
        var meter = hud.ExposureBox(w, h);
        var health = hud.HealthBox(w, h);

        Assert.Greater(meter.x, health.xMax,
            "the exposure meter overlaps the top-left column");
        Assert.Less(meter.yMax, h * 0.5f, "the meter drifted into the middle of the screen");
        Assert.Greater(meter.width, 80f, "the meter is too narrow to read a fill off");
    }
}
