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
        // Round, and inside its housing.
        //
        // The blade disc is authored 11.00 x 14.46 x 7.23 - 31% out of round
        // against a 4 m recess, which is what made it look like it was
        // wobbling however true the axle ran. Both are corrected at setup.
        var rs2 = fan.GetComponentsInChildren<Renderer>(true);
        var fb = rs2[0].bounds; foreach (var r in rs2) fb.Encapsulate(r.bounds);
        var s = fb.size;
        float thin = Mathf.Min(s.x, Mathf.Min(s.y, s.z));
        float p1 = s.x + s.y + s.z - thin - Mathf.Max(s.x, Mathf.Max(s.y, s.z));
        float p2 = Mathf.Max(s.x, Mathf.Max(s.y, s.z));

        Assert.Less(Mathf.Abs(p1 - p2) / p2, 0.08f,
            $"die Luefterscheibe ist {p1:0.0} x {p2:0.0} m - sie ist nicht rund und eiert");
        Assert.Less(thin, 4f,
            $"die Scheibe ist {thin:0.0} m tief und steht aus ihrer 4 m tiefen " +
            "Aussparung heraus");

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

        // Starts with, not equals: the header carries the farm's hashrate now.
        StringAssert.StartsWith("MINING", lines[0].text,
            $"die Kopfzeile sagt nicht MINING: \"{lines[0].text}\"");

        for (int i = 1; i < 4; i++)
        {
            Assert.IsNotEmpty(lines[i].text, $"Transaktionszeile {i} ist leer");
            // " BTC" or " sat", not a bitcoin glyph: the amounts carry a
            // spelled-out unit now, because most mempool transactions are
            // small enough that BTC rounds them to nothing.
            bool unit = lines[i].text.EndsWith(" BTC") || lines[i].text.EndsWith(" sat");
            Assert.IsTrue(unit, $"Zeile {i} zeigt keinen Betrag mit Einheit: \"{lines[i].text}\"");
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

    /// <summary>
    /// The display reads from the left, and every amount carries its unit.
    ///
    /// Both were wrong at once and neither was catchable by looking at the
    /// code: the rows were anchored at the panel's -x end, which measures out
    /// as the driver's RIGHT because the screen's local +x runs to world +z
    /// and the truck drives +x. And every line said 0.000, because real
    /// mempool transactions are a few tens of thousands of satoshis and three
    /// decimals of BTC rounds all of that away.
    /// </summary>
    [UnityTest]
    public IEnumerator TheDisplayReadsFromTheLeftWithUnits()
    {
        var screen = Find("terminal_screen");
        var panel = screen.GetComponent<Renderer>().bounds;

        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        for (float t = 0f; t < 20f && (feed.Offers == null || feed.Offers.Count == 0);
             t += Time.deltaTime)
            yield return null;
        yield return new WaitForSeconds(1.5f);

        for (int i = 0; i < 4; i++)
        {
            var row = Find("TerminalLine" + i);
            var b = row.GetComponent<MeshRenderer>().bounds;

            // The driver goes +x, so their left hand is world +z.
            Assert.Greater(b.center.z - panel.center.z, 0f,
                $"Zeile {i} steht auf der rechten Haelfte - gelesen wird von links");

            if (i == 0) continue;
            string text = row.GetComponent<TextMesh>().text;
            bool unit = text.EndsWith(" BTC") || text.EndsWith(" sat");
            Assert.IsTrue(unit, $"Zeile {i} \"{text}\" nennt keine Einheit");
            Assert.IsFalse(text.Contains("0.000 "),
                $"Zeile {i} zeigt einen auf null gerundeten Betrag: \"{text}\"");
        }
    }

    /// <summary>The ticker moves at ticker speed, not at billboard speed.</summary>
    [UnityTest]
    public IEnumerator TheTickerRollsSeveralTimesASecond()
    {
        var term = Object.FindFirstObjectByType<MinerTerminal>();
        Assert.LessOrEqual(term.rollSeconds, 0.6f,
            $"die Zeilen wechseln nur alle {term.rollSeconds:0.0}s - das ist ein Plakat");

        var row = Find("TerminalLine1").GetComponent<TextMesh>();
        string was = row.text;
        int changes = 0;
        for (float t = 0f; t < 2f; t += Time.deltaTime)
        {
            yield return null;
            if (row.text != was) { changes++; was = row.text; }
        }
        Assert.Greater(changes, 2, $"in zwei Sekunden nur {changes} Wechsel");
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

        // And it MOVES. The chart scrolls a column left every half second, so
        // a wall that is merely accurate but still is the failure this catches
        // - it was exactly that when the bars were set once from the histogram,
        // which changes about three times an hour.
        var before = new float[24];
        for (int i = 0; i < 24; i++) before[i] = bars[i].localScale.y;

        yield return new WaitForSeconds(2f);

        int moved = 0;
        for (int i = 0; i < 24; i++)
            if (Mathf.Abs(bars[i].localScale.y - before[i]) > 0.02f) moved++;
        Assert.Greater(moved, 6,
            $"nur {moved} von 24 Balken haben sich in zwei Sekunden bewegt");
    }
}
