using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The miner's moving parts and its display.
/// </summary>
public class MinerTerminalTests
{
    GameObject _miner;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        LogAssert.ignoreFailingMessages = true;
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
        yield return new WaitForSeconds(2.5f);
        for (float t = 0f; t < 25f && GameObject.Find("MinerMegastructure") == null;
             t += Time.deltaTime)
            yield return null;
        _miner = GameObject.Find("MinerMegastructure");
        Assert.IsNotNull(_miner, "die Megastruktur ist nicht geladen");
        yield return null;
        LogAssert.ignoreFailingMessages = false;
    }

    [UnityTearDown]
    public IEnumerator TearDown() { Time.timeScale = 1f; yield return null; }

    static Transform Find(string name)
    {
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
            if (t.name == name) return t;
        return null;
    }

    /// <summary>
    /// A fan turning about its real axle sweeps its own disc. One turning
    /// about the wrong axis sweeps a sphere - so the giveaway for a wobble is
    /// the world bounding box growing as it spins.
    /// </summary>
    [UnityTest]
    public IEnumerator TheFansSpinRatherThanWobble()
    {
        var fan = Find("Fan_01");
        Assert.IsNotNull(fan, "kein Fan_01 in der Szene");

        Bounds Sweep()
        {
            var rs = fan.GetComponentsInChildren<Renderer>(true);
            var b = rs[0].bounds;
            foreach (var r in rs) b.Encapsulate(r.bounds);
            return b;
        }

        var start = Sweep();
        var swept = start;
        for (float t = 0f; t < 1.2f; t += Time.deltaTime)
        {
            yield return null;
            swept.Encapsulate(Sweep());
        }

        Assert.Greater(Quaternion.Angle(Quaternion.identity, fan.localRotation), 1f,
            "der Luefter dreht sich gar nicht");

        // 1.4, measured at 1.24 with the axle correct.
        //
        // A fan with pitched blades legitimately sweeps a bigger box than any
        // one pose - seven blades at 31 degrees reach different extents as
        // they come round. What a WRONG axle looks like is a disc 14 m across
        // sweeping a sphere, which is nearer 1.8. The bound separates those
        // two cases rather than demanding a number I liked.
        float grew = swept.size.magnitude / start.size.magnitude;
        Assert.Less(grew, 1.4f,
            $"der Luefter ueberstreicht beim Drehen das {grew:0.00}-fache seines " +
            "Volumens - er taumelt um die falsche Achse");

        // And slowly enough not to alias: a blade must not pass more often
        // than a quarter of the frame rate, or it appears to run backwards.
        var spin = Object.FindFirstObjectByType<MinerSpin>();
        float passes = spin.fanRpm / 60f * spin.bladeCount;
        Assert.Less(passes, 8f,
            $"{passes:0.0} Fluegeldurchgaenge pro Sekunde - das aliast auf 30 fps");
    }

    [UnityTest]
    public IEnumerator TheScreenShowsMiningAndThreeTransactions()
    {
        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        for (float t = 0f; t < 20f && (feed.Offers == null || feed.Offers.Count == 0);
             t += Time.deltaTime)
            yield return null;
        yield return new WaitForSeconds(1f);

        var lines = new TextMesh[4];
        for (int i = 0; i < 4; i++)
        {
            var go = Find("TerminalLine" + i);
            Assert.IsNotNull(go, $"Zeile {i} fehlt auf dem Display");
            lines[i] = go.GetComponent<TextMesh>();
        }

        Assert.AreEqual("MINING", lines[0].text, "die Kopfzeile sagt nicht MINING");

        for (int i = 1; i < 4; i++)
        {
            Assert.IsNotEmpty(lines[i].text, $"Transaktionszeile {i} ist leer");
            StringAssert.Contains("₿", lines[i].text, $"Zeile {i} zeigt keinen Betrag");
            Assert.Greater(lines[i].text.Length, 12, $"Zeile {i} zeigt keine txid");
        }

        // and they are three DIFFERENT transactions, not the same one thrice
        Assert.AreNotEqual(lines[1].text, lines[2].text, "zwei Zeilen zeigen dasselbe");
        Assert.AreNotEqual(lines[2].text, lines[3].text, "zwei Zeilen zeigen dasselbe");
    }

    [UnityTest]
    public IEnumerator TheBarsFollowTheFeeHistogram()
    {
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        var bars = new Transform[24];
        for (int i = 0; i < 24; i++)
        {
            bars[i] = Find($"bar_{i:00}");
            Assert.IsNotNull(bars[i], $"bar_{i:00} fehlt");
        }

        yield return new WaitForSeconds(2.5f);   // let the easing settle

        var profile = terrain.FeeProfile(24);
        Assert.IsNotNull(profile, "das Terrain hat noch kein Gebuehrenprofil");

        // not all the same height - a flat wall of bars is a loop, not data
        float lo = 9f, hi = 0f;
        foreach (var b in bars) { lo = Mathf.Min(lo, b.localScale.y); hi = Mathf.Max(hi, b.localScale.y); }
        Assert.Greater(hi - lo, 0.08f,
            $"alle Balken stehen gleich hoch ({lo:0.00}..{hi:0.00}) - sie zeigen keine Daten");

        // and the tallest bar is where the profile says it should be
        int peakBar = 0, peakData = 0;
        for (int i = 1; i < 24; i++)
        {
            if (bars[i].localScale.y > bars[peakBar].localScale.y) peakBar = i;
            if (profile[i] > profile[peakData]) peakData = i;
        }
        Assert.LessOrEqual(Mathf.Abs(peakBar - peakData), 2,
            $"hoechster Balken bei {peakBar}, hoechster Gebuehrenwert bei {peakData}");
    }
}
