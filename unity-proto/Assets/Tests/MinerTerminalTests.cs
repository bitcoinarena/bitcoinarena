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

        // Undistorted: the fan must carry exactly the building's own scale.
        //
        // It did not, and that was the actual misalignment. Static batching
        // bakes transforms, so the moving parts were reparented out of the way
        // first - but the miner is scaled (1, 0.45, 1) and turned half round,
        // and a non-uniform scale under rotation cannot survive a change of
        // parent. Unity approximates, and the blades came out sheared inside
        // their rings.
        var body = GameObject.Find("MinerMegastructure").transform;
        Assert.Less(Vector3.Distance(fan.lossyScale, body.lossyScale), 0.02f,
            $"der Luefter hat Skalierung {fan.lossyScale} statt {body.lossyScale} - " +
            "er wurde beim Umhaengen verzerrt");

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

    /// <summary>
    /// The lettering fits on the panel, and faces out of it.
    ///
    /// Neither was true and both were visible from across the map: the header
    /// stood three times the height of the screen and hung off the left edge,
    /// and every line read back to front - MINING as ENINIM - because TextMesh
    /// draws on its minus-Z face and the rows had been given the panel's own
    /// orientation. Two things a screenshot catches instantly and no test did,
    /// so here they are.
    /// </summary>
    [UnityTest]
    public IEnumerator TheLetteringFitsThePanelAndFacesOut()
    {
        var screen = Find("terminal_screen");
        Assert.IsNotNull(screen, "keine Anzeigeflaeche am Miner");

        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        for (float t = 0f; t < 20f && (feed.Offers == null || feed.Offers.Count == 0);
             t += Time.deltaTime)
            yield return null;
        yield return new WaitForSeconds(1f);

        var panel = screen.GetComponent<Renderer>().bounds;

        for (int i = 0; i < 4; i++)
        {
            var row = Find("TerminalLine" + i);
            Assert.IsNotNull(row, $"Zeile {i} fehlt");
            var mr = row.GetComponent<MeshRenderer>();
            // z, not x: the panel faces along X, so the lettering lies in the
            // YZ plane and its X extent is the thickness of nothing.
            Assert.Greater(mr.bounds.size.z, 0.5f, $"Zeile {i} ist leer");

            // inside the panel, with a little slack for the glyph overhang
            var b = mr.bounds;
            Assert.LessOrEqual(b.size.y, panel.size.y * 0.34f,
                $"Zeile {i} ist {b.size.y:0.0} m hoch auf einer {panel.size.y:0.0} m " +
                "hohen Flaeche");
            Assert.LessOrEqual(b.size.z, panel.size.z * 1.02f,
                $"Zeile {i} ist {b.size.z:0.0} m breit und laeuft ueber die " +
                $"{panel.size.z:0.0} m breite Flaeche hinaus");
            Assert.Less(Mathf.Abs(b.center.y - panel.center.y), panel.size.y,
                $"Zeile {i} steht ausserhalb der Flaeche");

            // and reads the right way round: the text's own forward has to
            // point the same way as the panel's outward face, not into it
            float facing = Vector3.Dot(row.forward, -screen.forward);
            Assert.Greater(facing, 0.5f,
                $"Zeile {i} zeigt in die Wand - der Text wird spiegelverkehrt gelesen");
        }
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
