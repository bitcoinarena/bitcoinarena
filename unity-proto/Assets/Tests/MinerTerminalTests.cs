// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
    ///
    /// The other giveaway, and the one that survived three attempts at the
    /// first, is that the fan is DEFORMED. This used to assert that a single
    /// pose of the blade assembly had a square bounding box, on the theory
    /// that a disc measures the same across both of its in-plane axes. Seven
    /// blades 51.4 degrees apart have no four-fold symmetry, so their box is
    /// 11.0 x 14.5 however true the disc runs - and the only way to pass that
    /// assertion was to squash the fan into a 31 percent ellipse, which is
    /// precisely what made it look like it was wobbling. What is checked now
    /// is the thing that is actually wrong when a fan eiert: an in-plane
    /// scale that is not uniform, and a hub that moves while it turns.
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

        var hub = Find("fan_hub_01");
        Assert.IsNotNull(hub, "keine Nabe an Fan_01");
        var hubWas = hub.GetComponent<Renderer>().bounds.center;

        var start = Sweep();
        var swept = start;
        float wander = 0f;
        for (float t = 0f; t < 1.2f; t += Time.deltaTime)
        {
            yield return null;
            swept.Encapsulate(Sweep());
            wander = Mathf.Max(wander,
                Vector3.Distance(hubWas, hub.GetComponent<Renderer>().bounds.center));
        }

        Assert.Greater(Quaternion.Angle(Quaternion.identity, fan.localRotation), 1f,
            "der Luefter dreht sich gar nicht");

        // Undeformed in the plane it turns in.
        //
        // Scale and rotation only commute when the scale is uniform across the
        // rotation's plane. Anything else and the blades are squashed by a
        // different amount at every angle, which is a wobble that no amount of
        // getting the axle right can fix.
        // Axle-agnostic: the flattening runs along the axle, so the two
        // LARGEST components of the scale are the ones in the plane of
        // rotation, whichever way the exporter laid the node out.
        var spin = Object.FindFirstObjectByType<MinerSpin>();
        void PlaneIsUniform(Vector3 v, float tolerance, string what)
        {
            float a = Mathf.Abs(v.x), b = Mathf.Abs(v.y), c = Mathf.Abs(v.z);
            float small = Mathf.Min(a, Mathf.Min(b, c));
            float one = Mathf.Max(a, Mathf.Max(b, c));
            float two = a + b + c - small - one;
            Assert.Less(Mathf.Abs(one - two) / Mathf.Max(0.001f, one), tolerance,
                $"{what} steht auf {v} - in der Drehebene ist das keine " +
                "gleichmaessige Skalierung, und das eiert");
        }
        PlaneIsUniform(fan.localScale, 0.01f, "der Luefter");
        PlaneIsUniform(fan.lossyScale, 0.02f, "die Scheibe in der Welt");

        // And it turns about its hub rather than around it.
        Assert.Less(wander, 0.15f,
            $"die Nabe wandert beim Drehen {wander:0.00} m - der Luefter laeuft " +
            "exzentrisch");

        // Deep enough to sit in its housing: the disc is authored 7.2 m deep
        // against a 2.3 m ring, and is flattened along its axle at setup.
        var rs2 = fan.GetComponentsInChildren<Renderer>(true);
        var fb = rs2[0].bounds; foreach (var r in rs2) fb.Encapsulate(r.bounds);
        float thin = Mathf.Min(fb.size.x, Mathf.Min(fb.size.y, fb.size.z));
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
        float passes = spin.fanRpm / 60f * spin.bladeCount;
        Assert.Less(passes, 8f,
            $"{passes:0.0} Fluegeldurchgaenge pro Sekunde - das aliast auf 30 fps");
    }

    /// <summary>
    /// Seven blades, one shape, evenly spaced.
    ///
    /// The model puts them in the right PLACES - a ring of seven at radius
    /// 5.2, exact - and then pitches each about a fixed axis instead of about
    /// its own radius, so only the first one is right and the fourth is 61
    /// degrees out. Cut from the identical mesh, blade 0 reaches from radius
    /// 5.00 to 6.24 and blade 2 from 3.59 to 7.25. That is not a fan at rest
    /// and it cannot become one by turning.
    /// </summary>
    [UnityTest]
    public IEnumerator TheBladesAreOneBladeSevenTimes()
    {
        var fan = Find("Fan_01");
        Assert.IsNotNull(fan, "kein Fan_01 in der Szene");
        yield return null;

        var blades = new System.Collections.Generic.List<Transform>();
        foreach (Transform c in fan) if (c.name.Contains("blade")) blades.Add(c);
        Assert.AreEqual(7, blades.Count, "der Luefter hat nicht sieben Fluegel");

        // Each blade's reach from the axle, measured on its own geometry.
        var axle = Vector3.forward;
        var near = new System.Collections.Generic.List<float>();
        var far = new System.Collections.Generic.List<float>();
        var angles = new System.Collections.Generic.List<float>();
        foreach (var b in blades)
        {
            var mb = b.GetComponent<MeshFilter>().sharedMesh.bounds;
            float lo = 99f, hi = 0f;
            for (int c = 0; c < 8; c++)
            {
                var corner = new Vector3((c & 1) == 0 ? mb.min.x : mb.max.x,
                                         (c & 2) == 0 ? mb.min.y : mb.max.y,
                                         (c & 4) == 0 ? mb.min.z : mb.max.z);
                var local = fan.InverseTransformPoint(b.TransformPoint(corner));
                float r = new Vector2(local.x, local.y).magnitude;
                lo = Mathf.Min(lo, r); hi = Mathf.Max(hi, r);
            }
            near.Add(lo); far.Add(hi);
            var at = fan.InverseTransformPoint(b.position);
            angles.Add(Mathf.Atan2(at.y, at.x) * Mathf.Rad2Deg);
            Assert.AreEqual(blades[0].localScale.x, b.localScale.x, 0.01f,
                $"{b.name} ist anders skaliert als der erste Fluegel");
        }

        // Congruent: every blade covers the same band of the disc as the
        // first. The model gives them the same mesh and seven different
        // attitudes, so blade 0 sweeps 5.00 to 6.24 m and blade 2 sweeps 3.59
        // to 7.25 - which is what made the fan look bent while standing still.
        for (int i = 1; i < blades.Count; i++)
        {
            Assert.AreEqual(near[0], near[i], 0.2f,
                $"{blades[i].name} beginnt bei {near[i]:0.00} m statt bei {near[0]:0.00} m");
            Assert.AreEqual(far[0], far[i], 0.2f,
                $"{blades[i].name} reicht bis {far[i]:0.00} m statt bis {far[0]:0.00} m");
        }

        // And pitched, rather than feathered: a blade that presents its edge
        // to the air spans a hand's width of the disc and reads as a strut.
        // The housing opens to 7.85 m and the hub is 2.4.
        Assert.Greater(far[0] - near[0], 3f,
            $"die Fluegel ueberdecken nur {far[0] - near[0]:0.00} m der Scheibe - " +
            "sie stehen auf Fahnenstellung und sehen aus wie Streben");
        Assert.LessOrEqual(far[0], 7.9f,
            $"die Fluegelspitzen stehen bei {far[0]:0.00} m im Ring");

        angles.Sort();
        for (int i = 1; i < angles.Count; i++)
            Assert.AreEqual(360f / blades.Count, angles[i] - angles[i - 1], 1.5f,
                $"die Fluegel stehen nicht gleichmaessig: {angles[i] - angles[i - 1]:0.0} " +
                "Grad zwischen zweien");
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
            Assert.Greater(lines[i].text.Length, 12, $"Zeile {i} zeigt keine txid");

            // " BTC" or " sat", not a bitcoin glyph: the amounts carry a
            // spelled-out unit, because most mempool transactions are small
            // enough that BTC rounds them to nothing. They live in their own
            // right-aligned column beside the ids.
            var amount = Find("TerminalAmount" + i).GetComponent<TextMesh>().text;
            bool unit = amount.EndsWith(" BTC") || amount.EndsWith(" sat");
            Assert.IsTrue(unit, $"Zeile {i} zeigt keinen Betrag mit Einheit: \"{amount}\"");
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

            // The amount is its own text now, right-aligned in a column, so
            // that three amounts under one another share an edge instead of
            // starting wherever the txid before them happened to end.
            var amount = Find("TerminalAmount" + i);
            Assert.IsNotNull(amount, $"Zeile {i} hat keine Betragsspalte");
            string text = amount.GetComponent<TextMesh>().text;
            bool unit = text.EndsWith(" BTC") || text.EndsWith(" sat");
            Assert.IsTrue(unit, $"Zeile {i} \"{text}\" nennt keine Einheit");
            Assert.IsFalse(text.Contains("0.000 "),
                $"Zeile {i} zeigt einen auf null gerundeten Betrag: \"{text}\"");
        }

        // and the amounts line up: one column, one right edge
        float edge = float.NaN;
        for (int i = 1; i < 4; i++)
        {
            var b = Find("TerminalAmount" + i).GetComponent<MeshRenderer>().bounds;
            // the panel's own left-right runs along world z
            float right = b.min.z;
            if (float.IsNaN(edge)) edge = right;
            Assert.AreEqual(edge, right, 0.6f,
                $"die Betraege stehen nicht buendig: Zeile {i} endet {right - edge:0.0} m versetzt");
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
        var stats = Object.FindFirstObjectByType<ChainStats>();
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        var bars = new Transform[24];
        for (int i = 0; i < 24; i++)
        {
            bars[i] = Find($"bar_{i:00}");
            Assert.IsNotNull(bars[i], $"bar_{i:00} fehlt");
        }

        // wait for a fee curve to exist at all, then for the easing to settle
        for (float t = 0f; t < 25f && stats.FeeCurve(24) == null; t += Time.deltaTime)
            yield return null;
        yield return new WaitForSeconds(3f);

        var curve = stats.FeeCurve(24);
        Assume.That(curve, Is.Not.Null,
            "keine Gebuehrenkurve von mempool.space - ohne Netz ist hier nichts zu pruefen");

        // not all the same height - a flat wall of bars is a loop, not data
        float lo = 9f, hi = 0f;
        foreach (var b in bars) { lo = Mathf.Min(lo, b.localScale.y); hi = Mathf.Max(hi, b.localScale.y); }
        Assert.Greater(hi - lo, 0.05f,
            $"alle Balken stehen gleich hoch ({lo:0.00}..{hi:0.00}) - sie zeigen keine Daten");

        // And they are THAT data. The chart used to scroll a rolling average
        // with a random 0.72-1.34 multiplier on every new sample, which moved
        // convincingly and meant nothing; what is checked now is that the wall
        // agrees with the curve it claims to be drawing - the dearest bucket
        // has to stand taller than the cheapest.
        int rich = 0, poor = 0;
        for (int i = 1; i < 24; i++)
        {
            if (curve[i] > curve[rich]) rich = i;
            if (curve[i] < curve[poor]) poor = i;
        }
        if (curve[rich] > curve[poor] * 1.2f)
            Assert.Greater(bars[rich].localScale.y, bars[poor].localScale.y,
                $"Balken {rich} zahlt {curve[rich]:0.0} sat/vB und steht niedriger als " +
                $"Balken {poor} mit {curve[poor]:0.0} - die Wand zeigt nicht ihre eigenen Daten");

        // And each bar is coloured by what it pays, not painted alike.
        //
        // Read back under the name the MATERIAL uses: the building comes in
        // through glTFast, so its colour is "baseColorFactor" and not URP's
        // own "_BaseColor" - asking for the wrong one returns black for every
        // bar, which looks exactly like a chart that was never coloured.
        Color Painted(Transform bar)
        {
            var r = bar.GetComponent<Renderer>();
            var block = new MaterialPropertyBlock();
            r.GetPropertyBlock(block);
            var mat = r.sharedMaterial;
            if (mat != null && mat.HasProperty("baseColorFactor"))
                return block.GetColor("baseColorFactor");
            return block.GetColor("_BaseColor");
        }
        var dear = Painted(bars[rich]);
        var cheap = Painted(bars[poor]);
        if (curve[rich] > curve[poor] * 2f)
            Assert.Greater(Vector4.Distance(dear, cheap), 0.05f,
                "teure und billige Balken haben dieselbe Farbe - die Skala sagt nichts");
    }
}
