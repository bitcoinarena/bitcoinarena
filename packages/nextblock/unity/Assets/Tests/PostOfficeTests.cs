// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The building the run starts from: the bay the truck is parked in, the wall
/// that makes the bays the only way out, and the live displays.
/// </summary>
public class PostOfficeTests
{
    PostOffice _post;
    TruckController _truck;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        LogAssert.ignoreFailingMessages = true;
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
        yield return new WaitForSeconds(2.5f);
        for (float t = 0f; t < 30f && GameObject.Find("MempoolPostOffice") == null;
             t += Time.deltaTime)
            yield return null;
        _post = Object.FindFirstObjectByType<PostOffice>();
        _truck = Object.FindFirstObjectByType<TruckController>();
        yield return null;
        LogAssert.ignoreFailingMessages = false;
    }

    [UnityTearDown]
    public IEnumerator TearDown() { Time.timeScale = 1f; yield return null; }

    /// <summary>
    /// Solo, the player gets the middle bay - and has to actually be in it,
    /// not merely near the building.
    /// </summary>
    [Test]
    public void TheTruckStartsInTheMiddleBay()
    {
        Assert.IsNotNull(_post, "kein Post Office in der Szene");
        var bay = _post.BayFor(PostOffice.SoloBay);

        float off = Vector2.Distance(
            new Vector2(bay.x, bay.z),
            new Vector2(_truck.spawnPosition.x, _truck.spawnPosition.z));
        Assert.Less(off, 2f,
            $"der Spawn steht {off:0.0} m neben der Solo-Bay (Spawn z=" +
            $"{_truck.spawnPosition.z:0.0}, Bay z={bay.z:0.0})");

        // and in the middle of the rank, not in the corner of the map: the
        // run from the last bay is made along the boundary, where there is no
        // war to drive through
        Assert.Less(Mathf.Abs(bay.z), 12f,
            $"die Solo-Bay steht bei z={bay.z:0.0} am Kartenrand statt in der Mitte");

        // and pointing out of it
        Assert.Greater(Vector3.Dot(_truck.spawnRotation * Vector3.forward, Vector3.right), 0.9f,
            "der Truck steht nicht in Fahrtrichtung aus der Bay");
    }

    /// <summary>The bays are on a 6.8 m pitch and Bay 24 is the far one.</summary>
    [Test]
    public void TheBaysAreEvenlySpacedAcrossTheMap()
    {
        float first = _post.BayFor(0).z, second = _post.BayFor(1).z, last = _post.BayFor(23).z;
        Assert.AreEqual(6.8f, second - first, 0.01f, "das Portraster stimmt nicht");
        Assert.AreEqual(156.4f, last - first, 0.1f, "die 24 Bays spannen nicht die Front");
    }

    /// <summary>
    /// The facade is a wall. The building spans the map, so without collision
    /// the start of the map has no boundary at all.
    /// </summary>
    [Test]
    public void OnlyTheBaysLetYouThrough()
    {
        var shell = GameObject.Find("PostOfficeShell");
        Assert.IsNotNull(shell, "keine Fassade am Post Office");
        Assert.Greater(shell.GetComponentsInChildren<BoxCollider>(true).Length, 20,
            "die Fassade hat zu wenige Flaechen fuer 24 Tore");
    }

    /// <summary>
    /// The building stands ON the ground, and the truck stands on top of it.
    ///
    /// It did neither. The apron is one 26 x 168 m slab laid at a single
    /// sampled height, the terrain under it was still rolling, and the truck
    /// was parked at the height of a sample taken 78 m away - so the loading
    /// dock hung several metres over the ground and the player spawned
    /// underneath his own building, looking up at it.
    /// </summary>
    [UnityTest]
    public IEnumerator TheBuildingSitsOnTheGroundAndTheTruckOnIt()
    {
        var apron = GameObject.Find("ground_apron");
        Assert.IsNotNull(apron, "keine Vorfahrt am Post Office");
        var slab = apron.GetComponent<Renderer>().bounds;
        var terrain = _post.terrain;

        // the slab, along its whole 168 m
        for (int i = 0; i <= 8; i++)
        {
            float z = Mathf.Lerp(slab.min.z, slab.max.z, i / 8f);
            foreach (float x in new[] { slab.min.x + 1f, slab.center.x, slab.max.x - 1f })
            {
                float ground = terrain.SampleSurface(x, z);
                Assert.Less(Mathf.Abs(slab.max.y - ground), 0.6f,
                    $"die Vorfahrt liegt bei ({x:0}, {z:0}) {slab.max.y - ground:0.00} m " +
                    "ueber dem Boden - das Gebaeude schwebt");
            }
        }

        // and the truck is on top of the slab, not under it
        yield return new WaitForSeconds(1.5f);
        var truck = _truck.transform.position;
        Assert.Greater(truck.y, slab.max.y - 1f,
            $"der Truck steht {slab.max.y - truck.y:0.0} m unter der Vorfahrt");
        Assert.Less(truck.y - terrain.SampleSurface(truck.x, truck.z), 2.5f,
            "der Truck schwebt ueber dem Boden");
    }

    /// <summary>
    /// The wall is a barrier in front of the building, not around the truck.
    ///
    /// The slabs used to run six metres FORWARD of the facade, onto the apron
    /// the truck is parked on - an invisible wall in front of the doors.
    /// </summary>
    [Test]
    public void TheBarrierStandsAtTheFacadeAndNotOnTheApron()
    {
        var shell = GameObject.Find("PostOfficeShell");
        Assert.IsNotNull(shell, "keine Fassade am Post Office");

        var spawn = _truck.spawnPosition;
        foreach (var box in shell.GetComponentsInChildren<BoxCollider>(true))
        {
            var b = box.bounds;
            Assert.LessOrEqual(b.max.x, _post.postX + 0.5f,
                $"{box.name} steht {b.max.x - _post.postX:0.0} m vor der Fassade " +
                "auf der Vorfahrt");
            Assert.IsFalse(b.Contains(spawn),
                $"der Spawn steckt in {box.name}");
        }
    }

    /// <summary>Every plate carries live data, and none of it is a placeholder.</summary>
    [UnityTest]
    public IEnumerator TheDisplaysCarryLiveData()
    {
        Assert.IsNotNull(GameObject.Find("MempoolPostOffice"),
            "das Modell ist nicht gestreamt worden");
        yield return new WaitForSeconds(4f);

        int filled = 0;
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            if (!tm.name.EndsWith("_text")) continue;
            if (!string.IsNullOrEmpty(tm.text) && tm.text != "—") filled++;
        }
        Assert.Greater(filled, 12,
            $"nur {filled} Anzeigen tragen Daten - Gebuehren, Zaehler und Bloecke fehlen");

        // the goggles wall carries the projected block
        var goggles = GameObject.Find("goggles_screen");
        Assert.IsNotNull(goggles, "keine Goggles-Wand");
        // The wall rebuilds on its own clock, so give it one turn of that.
        var wall = Object.FindFirstObjectByType<GogglesWall>();
        Assert.IsNotNull(wall, "keine Goggles-Komponente");
        yield return new WaitForSeconds(wall.rebuildSeconds + 2f);

        var mesh = WallMesh();
        Assert.IsNotNull(mesh, "die Goggles-Wand hat kein Netz");
        Assert.Greater(mesh.vertexCount, 8 * 4,
            $"nur {mesh.vertexCount / 4} Kacheln auf der Goggles-Wand");
    }

    /// <summary>The one mesh the whole wall is drawn as.</summary>
    static Mesh WallMesh()
    {
        var go = GameObject.Find("GogglesMesh");
        var mf = go != null ? go.GetComponent<MeshFilter>() : null;
        return mf != null ? mf.sharedMesh : null;
    }

    /// <summary>
    /// The wall moves.
    ///
    /// mempool.space's own graph tweens every transaction to its new place
    /// over a second and flies new arrivals in from off the edge - see
    /// block-scene.ts, animationDuration = 1000. This drew forty quads off a
    /// twelve-second poll and then never moved again, which is a photograph of
    /// a mempool rather than a mempool.
    /// </summary>
    [UnityTest]
    public IEnumerator TheGogglesAnimate()
    {
        var wall = Object.FindFirstObjectByType<GogglesWall>();
        Assert.IsNotNull(wall, "keine Goggles-Komponente");
        yield return new WaitForSeconds(wall.rebuildSeconds + 2f);

        var mesh = WallMesh();
        Assume.That(mesh, Is.Not.Null);
        Assume.That(mesh.vertexCount, Is.GreaterThan(0),
            "ohne Netzverbindung ist auf der Wand nichts zu animieren");

        var before = mesh.vertices;
        float moved = 0f;
        for (float t = 0f; t < 2f && moved <= 0.02f; t += Time.deltaTime)
        {
            yield return null;
            var now = mesh.vertices;
            int n = Mathf.Min(before.Length, now.Length);
            for (int i = 0; i < n; i++)
                moved = Mathf.Max(moved, Vector3.Distance(before[i], now[i]));
        }
        Assert.Greater(moved, 0.02f,
            "auf der Goggles-Wand bewegt sich in zwei Sekunden nichts");
    }

    /// <summary>
    /// The goggles are drawn with a shader that survives a player build.
    ///
    /// The wall was blank in the browser and correct in the editor, which is
    /// the signature of shader stripping: a build only contains shaders
    /// something in it references, every material in this scene is URP/Lit,
    /// and the wall was asking for URP/Unlit - so Shader.Find returned null in
    /// the build alone and the tiles had no material at all. An editor test
    /// cannot see that directly, because in the editor every shader is
    /// findable. What it CAN check is the rule underneath: draw with a shader
    /// the scene already uses, and the build cannot strip it.
    /// </summary>
    [UnityTest]
    public IEnumerator TheGogglesUseAShaderTheBuildWillKeep()
    {
        var wall = Object.FindFirstObjectByType<GogglesWall>();
        Assert.IsNotNull(wall, "keine Goggles-Komponente");
        yield return new WaitForSeconds(wall.rebuildSeconds + 1.5f);

        var inScene = new System.Collections.Generic.HashSet<string>();
        foreach (var r in Object.FindObjectsByType<Renderer>(FindObjectsSortMode.None))
            foreach (var m in r.sharedMaterials)
                if (m != null && m.shader != null && r.gameObject.name != "GogglesMesh")
                    inScene.Add(m.shader.name);

        var drawn = GameObject.Find("GogglesMesh");
        Assert.IsNotNull(drawn, "die Goggles-Wand wurde nie gebaut");
        var mat = drawn.GetComponent<MeshRenderer>().sharedMaterial;
        Assert.IsNotNull(mat, "die Wand hat kein Material");
        Assert.IsTrue(inScene.Contains(mat.shader.name),
            $"die Wand zeichnet mit \"{mat.shader.name}\", den sonst nichts in der " +
            "Szene benutzt - der Build wirft ihn raus und die Wand ist wieder leer");
    }

    /// <summary>
    /// The lettering fills its plate without running off it.
    ///
    /// The model ships every display as a blank quad of a known size, and the
    /// text hung on it was scaled to a height picked by hand - 1.4 m for three
    /// lines on an 8.2 m block face, which from the road is a blank building.
    /// Both bounds matter: too small is unreadable, too large runs over the
    /// frame, and only measuring both catches the swap of one fault for the
    /// other.
    /// </summary>
    [UnityTest]
    public IEnumerator TheLetteringFillsItsPlates()
    {
        yield return new WaitForSeconds(4f);

        // Per PLATE, not per text. A mined block's face carries two: the
        // height, set large, and the transaction count and age under it at a
        // third of the size. What has to be legible is the plate, so the test
        // asks whether the BIGGEST thing on each one fills it.
        var biggest = new System.Collections.Generic.Dictionary<Transform, float>();
        int checkedPlates = 0;
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            if (!tm.name.EndsWith("_text") && !tm.name.EndsWith("_height")) continue;
            var plate = tm.transform.parent;
            var mf = plate != null ? plate.GetComponent<MeshFilter>() : null;
            if (mf == null || mf.sharedMesh == null) continue;
            if (string.IsNullOrEmpty(tm.text) || tm.text == "—") continue;

            // THE DRAWN PLATE, in world metres, which is the same number
            // `PostOffice.Room` fits against. It used to read
            // `mf.sharedMesh.bounds` - the mesh the plate was authored with -
            // and so did the fit, so both agreed with each other and neither
            // agreed with the screen: the whitepaper measured 89% full here
            // while it was drawn four times taller and seven times wider than
            // its plate, sprawled across the depot. One stale frame, twice.
            var mr = tm.GetComponent<MeshRenderer>();
            var room = PostOffice.Room(plate);
            // ONE SPACE FOR BOTH SIDES. `Room` answers in the plate's own axes; this used to answer in WORLD ones,
            // and measured plate by plate the two are not the same box - a fee plate is 5.2 x 1.5 of its own and
            // 0.0 x 1.5 x 5.2 in the world, because it is turned a quarter round. The world box is never smaller
            // than the drawn text, so the overflow check below was passing on luck, and the fill check underneath it
            // was being fed a size larger than what is on the wall - this makes that one STRICTER, not looser.
            var drawn = PostOffice.Face(PostOffice.Drawn(mr.localBounds.size, tm.transform.lossyScale));
            float w = drawn.x, h = drawn.y;

            Assert.LessOrEqual(w, room.x + 0.01f,
                $"{plate.name}: \"{tm.text}\" ist {w:0.0} m breit auf {room.x:0.0} m Platte");
            Assert.LessOrEqual(h, room.y + 0.01f,
                $"{plate.name}: \"{tm.text}\" ist {h:0.0} m hoch auf {room.y:0.0} m Platte");

            float fills = Mathf.Max(w / room.x, h / room.y);
            biggest[plate] = Mathf.Max(biggest.TryGetValue(plate, out var was) ? was : 0f, fills);
            checkedPlates++;
        }

        foreach (var pair in biggest)
            Assert.Greater(pair.Value, 0.55f,
                $"{pair.Key.name}: die groesste Beschriftung fuellt nur {pair.Value:0%} " +
                "der Platte - das ist aus Fahrerperspektive nicht lesbar");
        Assert.Greater(checkedPlates, 12,
            $"nur {checkedPlates} beschriftete Platten gefunden");
    }

    /// <summary>
    /// THE WHITEPAPER IS ON ITS PLAQUE, NOT OVER THE LOT (2026-09-18 22:16, photographed from spectate: "the
    /// Bitcoin whitepaper text on the MEMPOOL facade is TOO LARGE. It spills off the plaque").
    ///
    /// `TheLetteringFillsItsPlates` above could not catch this. It measures the text against the plate's renderer, and
    /// static batching had replaced BOTH with the combined building - so the two agreed with each other, the running
    /// build logged "94% x 92%", and the page was still drawn across the depot. This test refuses that shape of
    /// answer: a plaque on a building is a small part of it, and the words have to be inside the plaque's own box.
    /// </summary>
    [UnityTest]
    public IEnumerator TheWhitepaperIsInsideItsPlaque()
    {
        yield return new WaitForSeconds(4f);

        TextMesh paper = null;
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
            if (tm.name.StartsWith("whitepaper_print")) paper = tm;
        Assert.IsNotNull(paper, "no whitepaper lettering in the scene");

        var plate = paper.transform.parent;
        Assert.IsNotNull(plate, "the whitepaper lettering hangs on nothing");
        var plateR = plate.GetComponent<Renderer>();
        Assert.IsNotNull(plateR, "the whitepaper plate draws nothing");

        // The BUILDING it is a plaque on - not `plate.root`, which is the whole world and made this guard meaningless
        // (it measured a 2120 m "building" and let anything through).
        Transform model = plate;
        while (model.parent != null && model.name != "MempoolPostOffice") model = model.parent;
        var whole = new Bounds(plate.position, Vector3.zero);
        foreach (var r in model.GetComponentsInChildren<Renderer>(true)) whole.Encapsulate(r.bounds);

        // The plaque in its own axes, the BUILDING as a world box - deliberately: the question here is not a face but
        // "how big is the thing this hangs on", and the ratio is what the answer rides on.
        var plateFace = PostOffice.Room(plate);
        var wholeFace = PostOffice.Face(whole.size);
        Assert.Less(plateFace.x, wholeFace.x * 0.25f,
            $"the whitepaper's plate is {plateFace.x:0.0} m across a {wholeFace.x:0.0} m building - that is not a "
            + "plaque, it is the batched mesh of the whole thing");

        // And the words are on it. Bounds are world-axis boxes, so a hair of tolerance for a plate at an angle.
        var text = paper.GetComponent<MeshRenderer>();
        var drawn = PostOffice.Face(PostOffice.Drawn(text.localBounds.size, paper.transform.lossyScale));
        Assert.LessOrEqual(drawn.x, plateFace.x + 0.05f,
            $"the whitepaper is {drawn.x:0.0} m wide on a {plateFace.x:0.0} m plaque");
        Assert.LessOrEqual(drawn.y, plateFace.y + 0.05f,
            $"the whitepaper is {drawn.y:0.0} m tall on a {plateFace.y:0.0} m plaque");

        // Still worth reading from the yard: it fills the plaque it is on.
        Assert.Greater(Mathf.Max(drawn.x / plateFace.x, drawn.y / plateFace.y), 0.55f,
            $"the whitepaper fills only {Mathf.Max(drawn.x / plateFace.x, drawn.y / plateFace.y):0%} of its plaque");
        Debug.Log($"[whitepaper] plaque {plateFace.x:0.00} x {plateFace.y:0.00} m on a {wholeFace.x:0.0} m building, "
                  + $"text {drawn.x:0.00} x {drawn.y:0.00} m");
    }

    /// <summary>
    /// The block band reads as a block explorer: English, and every mined
    /// block carries its own height.
    /// </summary>
    [UnityTest]
    public IEnumerator TheBlockBandIsInEnglishAndNumbered()
    {
        var stats = Object.FindFirstObjectByType<ChainStats>();
        for (float t = 0f; t < 25f && stats.Recent.Count == 0; t += Time.deltaTime)
            yield return null;
        Assume.That(stats.Recent.Count, Is.GreaterThan(0),
            "kein Blockstand von mempool.space - ohne Netz ist hier nichts zu pruefen");
        yield return new WaitForSeconds(2.5f);

        // The building is STREAMED. Alone this test has time for it to land;
        // in a full suite the download is slower and the block band does not
        // exist yet, so the test measured an empty wall and blamed the wiring.
        for (float t = 0f; t < 20f; t += Time.deltaTime)
        {
            bool up = false;
            foreach (var tr in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
                if (tr.name.StartsWith("mined_face_") && !tr.name.Contains("plate")) { up = true; break; }
            if (up) break;
            yield return null;
        }
        yield return new WaitForSeconds(1.5f);

        int mined = 0, numbered = 0;
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            var plate = tm.transform.parent;
            if (plate == null || !plate.name.StartsWith("mined_face_")) continue;
            if (tm.text == "—") continue;

            if (tm.name.EndsWith("_height"))
            {
                // the number, on its own, large and in its own colour
                var digits = tm.text.Replace(",", "").Replace(".", "");
                if (int.TryParse(digits, out int height) && height > 800000) numbered++;
                Assert.Greater(tm.color.r + tm.color.g, tm.color.b * 1.5f,
                    "die Blocknummer ist nicht farbig abgesetzt");
                continue;
            }

            mined++;
            StringAssert.DoesNotContain("vor ", tm.text,
                $"der Block spricht Deutsch: \"{tm.text}\"");
            // "just now" is what a block found seconds ago says, and it is as
            // English as "9 minutes ago". The claim being made here is that
            // the band is not in German, not that every phrasing ends in one
            // particular word.
            Assert.IsTrue(tm.text.Contains("ago") || tm.text.Contains("just now"),
                $"dem Block fehlt das Alter in Worten: \"{tm.text}\"");
        }
        Assert.Greater(mined, 3, $"nur {mined} geminte Bloecke tragen Text");
        Assert.AreEqual(mined, numbered,
            "nicht jeder alte Block traegt seine Blocknummer");

        // and the projected side counts UP from the tip, so the block nearest
        // the divider is the one being mined next
        var labels = new System.Collections.Generic.List<int>();
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            var plate = tm.transform.parent;
            // Read off the FACE, not the caption strip.
            //
            // The projected block's height used to be on the thin strip above
            // it - 1.1 m against an 8.2 m face - and it is now drawn large on
            // the face itself, laid out like the mined side. The strip is
            // deliberately blank: in this model it sits over the same face, so
            // wiring both put the number on every block twice. What is being
            // claimed here has not changed - the projected side counts up from
            // the tip - only where it is written.
            if (plate == null || !plate.name.StartsWith("next_face_")) continue;
            if (!tm.name.EndsWith("_height")) continue;
            if (!plate.name.EndsWith("_00") && !plate.name.EndsWith("_04")) continue;
            if (int.TryParse(tm.text.Replace(",", "").Replace(".", ""), out int h))
                labels.Add(plate.name.EndsWith("_00") ? h : -h);
        }
        Assert.AreEqual(2, labels.Count, "die Blockbeschriftung fehlt");
        int first = Mathf.Max(labels[0], labels[1]), fifth = -Mathf.Min(labels[0], labels[1]);
        Assert.AreEqual(stats.Recent[0].height + 1, first,
            "der naechste Block ist nicht als Tip + 1 beschriftet");
        Assert.AreEqual(first + 4, fifth,
            "die projizierten Bloecke sind nicht aufsteigend beschriftet");
    }

    [UnityTest]
    public IEnumerator InspectModeFliesFreeWithoutStartingTheRun()
    {
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        var spec = Object.FindFirstObjectByType<SpectatorCamera>();
        Assert.IsNotNull(spec, "keine Spectator-Kamera");

        splash.Spectate();
        yield return new WaitForSeconds(0.6f);

        Assert.IsTrue(spec.Active, "der Inspect-Modus ist nicht aktiv");
        Assert.IsTrue(_truck.controlsLocked, "die Runde hat gestartet, statt nur zu schauen");

        var was = spec.transform.position;
        spec.Go(SpectatorCamera.Spot.Miner);
        yield return null;
        Assert.Greater(Vector3.Distance(was, spec.transform.position), 50f,
            "der Sprung zum Miner bewegt die Kamera nicht");
    }
}
