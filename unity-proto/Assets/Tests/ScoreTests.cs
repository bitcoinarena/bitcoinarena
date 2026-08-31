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

        // leave the ramp: spawn protection lifts on movement, and the rigidbody
        // owns the transform, so the body is what has to be moved
        var rb = _truck.GetComponent<Rigidbody>();
        rb.position += new Vector3(0f, 0f, 40f);
        yield return new WaitForSeconds(0.4f);
        Assert.IsFalse(_health.IsInvulnerable, "truck never left spawn protection");
    }

    /// <summary>Parks the truck at a z offset from the frontline and holds it there.</summary>
    IEnumerator Hold(float offsetFromFront, float seconds)
    {
        var rb = _truck.GetComponent<Rigidbody>();
        float t = 0f;
        while (t < seconds)
        {
            float x = rb.position.x;
            rb.position = new Vector3(x, rb.position.y, _field.FrontlineZ(x) + offsetFromFront);
            rb.linearVelocity = Vector3.zero;
            t += Time.deltaTime;
            yield return null;
        }
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
        yield return Hold(_score.corridorHalfWidth * 2.5f, 6f);

        float safe = _score.Exposure;
        int safeScore = _score.Projected;

        _score.Reset();
        yield return Hold(0f, 6f);

        float brave = _score.Exposure;
        int braveScore = _score.Projected;

        Assert.Less(safe, 0.02f, $"edge route banked exposure {safe:0.000}");
        Assert.Greater(brave, 0.1f, $"seam route banked only {brave:0.000}");
        Assert.Greater(braveScore, safeScore * 10 + 10,
            $"seam scored {braveScore} against the edge's {safeScore} — " +
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
            float x = rb.position.x;
            rb.position = new Vector3(x, rb.position.y, _field.FrontlineZ(x));
            rb.linearVelocity = Vector3.zero;
            yield return null;
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
