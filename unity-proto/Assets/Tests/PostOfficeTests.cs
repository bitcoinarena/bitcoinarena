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

        // the goggles wall is built from the same offers the yard is
        var goggles = GameObject.Find("goggles_screen");
        Assert.IsNotNull(goggles, "keine Goggles-Wand");
        // The wall rebuilds on its own clock, so give it one turn of that.
        var wall = Object.FindFirstObjectByType<GogglesWall>();
        Assert.IsNotNull(wall, "keine Goggles-Komponente");
        yield return new WaitForSeconds(wall.rebuildSeconds + 1.5f);

        int tiles = 0;
        foreach (Transform c in goggles.transform) if (c.name.StartsWith("tile")) tiles++;
        Assert.Greater(tiles, 8, $"nur {tiles} Kacheln auf der Goggles-Wand");
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
        yield return new WaitForSeconds(wall.rebuildSeconds + 2f);

        var inScene = new System.Collections.Generic.HashSet<string>();
        foreach (var r in Object.FindObjectsByType<Renderer>(FindObjectsSortMode.None))
            foreach (var m in r.sharedMaterials)
                if (m != null && m.shader != null && !m.name.StartsWith("tile"))
                    inScene.Add(m.shader.name);

        var screen = GameObject.Find("goggles_screen");
        int tiles = 0;
        foreach (Transform c in screen.transform)
        {
            if (!c.name.StartsWith("tile")) continue;
            tiles++;
            var m = c.GetComponent<MeshRenderer>().sharedMaterial;
            Assert.IsNotNull(m, "eine Kachel hat gar kein Material");
            Assert.IsNotNull(m.shader, "eine Kachel hat keinen Shader");
            Assert.IsTrue(inScene.Contains(m.shader.name),
                $"die Kacheln zeichnen mit \"{m.shader.name}\", den sonst nichts in der " +
                "Szene benutzt - der Build wirft ihn raus und die Wand ist wieder leer");
        }
        Assert.Greater(tiles, 8, $"nur {tiles} Kacheln");
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

        int checkedPlates = 0;
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            if (!tm.name.EndsWith("_text")) continue;
            var plate = tm.transform.parent;
            var mf = plate != null ? plate.GetComponent<MeshFilter>() : null;
            if (mf == null || mf.sharedMesh == null) continue;
            if (string.IsNullOrEmpty(tm.text) || tm.text == "—") continue;

            var room = mf.sharedMesh.bounds.size;
            var mr = tm.GetComponent<MeshRenderer>();
            float k = tm.transform.localScale.x;
            float w = mr.localBounds.size.x * k, h = mr.localBounds.size.y * k;

            Assert.LessOrEqual(w, room.x + 0.01f,
                $"{plate.name}: \"{tm.text}\" ist {w:0.0} m breit auf {room.x:0.0} m Platte");
            Assert.LessOrEqual(h, room.y + 0.01f,
                $"{plate.name}: \"{tm.text}\" ist {h:0.0} m hoch auf {room.y:0.0} m Platte");

            float fills = Mathf.Max(w / room.x, h / room.y);
            Assert.Greater(fills, 0.55f,
                $"{plate.name}: \"{tm.text}\" fuellt nur {fills:0%} der Platte - " +
                "das ist aus Fahrerperspektive nicht lesbar");
            checkedPlates++;
        }
        Assert.Greater(checkedPlates, 12,
            $"nur {checkedPlates} beschriftete Platten gefunden");
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

        int mined = 0, numbered = 0;
        foreach (var tm in Object.FindObjectsByType<TextMesh>(FindObjectsSortMode.None))
        {
            var plate = tm.transform.parent;
            if (plate == null || !plate.name.StartsWith("mined_face_")) continue;
            if (tm.text == "—") continue;
            mined++;

            StringAssert.DoesNotContain("vor ", tm.text,
                $"der Block spricht Deutsch: \"{tm.text}\"");
            StringAssert.Contains("ago", tm.text,
                $"dem Block fehlt das Alter in Worten: \"{tm.text}\"");

            // the height, as the explorer writes it, on its first line
            var head = tm.text.Split('\n')[0].Replace(",", "").Replace(".", "");
            if (int.TryParse(head, out int height) && height > 800000) numbered++;
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
            if (plate == null || !plate.name.StartsWith("block_label_")) continue;
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
