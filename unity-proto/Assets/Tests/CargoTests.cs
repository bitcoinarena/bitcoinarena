using System.Collections;
using System.Collections.Generic;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// The loading bay: pick freight, then drive. The part worth testing is the
/// gate - that the truck really is held until something is aboard - and that
/// Auto picks the load the next block would.
/// </summary>
public class CargoTests
{
    GameObject _boot;
    TruckController _truck;
    TruckHealth _health;
    LoadoutPanel _bayUi;
    CargoBay _bay;
    MempoolFeed _feed;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        _truck = Object.FindFirstObjectByType<TruckController>();
        _health = Object.FindFirstObjectByType<TruckHealth>();
        _bayUi = Object.FindFirstObjectByType<LoadoutPanel>();
        _bay = Object.FindFirstObjectByType<CargoBay>();
        _feed = Object.FindFirstObjectByType<MempoolFeed>();

        // a fixed yard, so the test does not depend on what the mempool holds
        _feed.Offers = new List<MempoolFeed.Tx>
        {
            Tx("aaaa1111aaaa1111aaaa1111aaaa1111",  200,  400,   50_000_000),  // 0.5/vB
            Tx("bbbb2222bbbb2222bbbb2222bbbb2222", 9000,  300, 3_000_000_000),  // 30/vB, whale
            Tx("cccc3333cccc3333cccc3333cccc3333", 2000,  200,   10_000_000),  // 10/vB
            Tx("dddd4444dddd4444dddd4444dddd4444", 4500,  150,   20_000_000),  // 30/vB
            Tx("eeee5555eeee5555eeee5555eeee5555",  600,  600,    5_000_000),  // 1/vB
            Tx("ffff6666ffff6666ffff6666ffff6666", 1800,  120,    7_000_000),  // 15/vB
            Tx("99997777999977779999777799997777",  900,  450,    9_000_000),  // 2/vB
        };
        yield return null;
    }

    static MempoolFeed.Tx Tx(string id, long fee, int vsize, long value) =>
        new MempoolFeed.Tx { txid = id, feeSats = fee, vsize = vsize, valueSats = value };

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

    [Test]
    public void TheBayIsOpenWhenTheTruckSpawns()
    {
        Assert.IsNotNull(_bayUi, "keine Laderampe in der Szene");
        Assert.IsTrue(_bayUi.IsOpen, "die Laderampe geht beim Spawn nicht auf");
        Assert.IsTrue(_truck.controlsLocked, "der Truck ist waehrend des Beladens nicht gesperrt");
        Assert.IsFalse(_bay.IsLoaded, "der Truck ist beladen, bevor etwas gewaehlt wurde");
    }

    /// <summary>The whole point of the gate.</summary>
    [UnityTest]
    public IEnumerator TheTruckCannotDriveOffUnloaded()
    {
        var from = _truck.transform.position;
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(2f);
        _truck.useExternalInput = false;

        float moved = Vector3.Distance(from, _truck.transform.position);
        Assert.Less(moved, 1.5f, $"der Truck ist unbeladen {moved:0.0} m weit gefahren");
    }

    [Test]
    public void AutoTakesTheBestPayingLoadThatFits()
    {
        _bayUi.Auto();

        Assert.Greater(_bay.Count, 0, "Auto laedt nichts");
        Assert.Greater(_bay.Fill, 0.6f, $"Auto laesst die Ladeflaeche zu {(1 - _bay.Fill) * 100:0}% leer");

        // Highest fee rate first, so whatever is left behind must pay no more
        // than the worst thing that got on.
        float worstAboard = float.MaxValue;
        foreach (var s in _bay.Slots) worstAboard = Mathf.Min(worstAboard, s.tx.FeeRate);
        foreach (var tx in _feed.Offers)
            if (!_bay.Contains(tx.txid))
                Assert.LessOrEqual(tx.FeeRate, worstAboard + 0.01f,
                    $"{tx.Short} zahlt {tx.FeeRate:0.0} sat/vB und blieb stehen, " +
                    $"waehrend {worstAboard:0.0} geladen wurde");
        _bayUi.Confirm();
    }

    [Test]
    public void PackagesComeInDifferentSizes()
    {
        var small = new MempoolFeed.Tx { txid = "s", feeSats = 100, vsize = 180, valueSats = 1 };
        var big = new MempoolFeed.Tx { txid = "b", feeSats = 100, vsize = 2000, valueSats = 1 };
        var whale = new MempoolFeed.Tx { txid = "w", feeSats = 100, vsize = 180, valueSats = 3_000_000_000 };

        Assert.Less(CargoBay.CrateSize(small), CargoBay.CrateSize(big),
            "eine grosse Transaktion ergibt kein groesseres Paket");
        Assert.Greater(CargoBay.CrateSize(whale), CargoBay.CrateSize(small),
            "ein Whale faellt nicht auf");
        Assert.AreNotEqual(CargoBay.CrateColour(whale), CargoBay.CrateColour(small),
            "ein Whale hat keine eigene Farbe");
    }

    [Test]
    public void TheBedFillsUpAndThenRefuses()
    {
        // big packages, so the bed runs out before the list does
        int taken = 0;
        for (int i = 0; i < 40; i++)
        {
            var tx = new MempoolFeed.Tx
            {
                txid = "big" + i, feeSats = 1000, vsize = 2000, valueSats = 1_000_000,
            };
            if (_bay.TryAdd(tx)) taken++;
            else
            {
                Assert.Greater(taken, 0, "die Ladeflaeche nimmt gar nichts an");
                Assert.Greater(_bay.Fill, 0.7f,
                    $"abgelehnt, obwohl erst {_bay.Fill * 100:0}% belegt sind");
                return;
            }
        }
        Assert.Fail("die Ladeflaeche nimmt unbegrenzt Pakete an");
    }

    [Test]
    public void TakingOneOffMakesRoomAgain()
    {
        var fat = new MempoolFeed.Tx { txid = "fat", feeSats = 1, vsize = 3000, valueSats = 1 };
        while (_bay.TryAdd(new MempoolFeed.Tx
               { txid = System.Guid.NewGuid().ToString("N"), feeSats = 1, vsize = 3000, valueSats = 1 })) { }

        Assert.IsFalse(_bay.Fits(fat), "die Ladeflaeche ist nicht voll");
        var first = _bay.Slots[0].tx.txid;
        _bay.Remove(first);
        Assert.IsTrue(_bay.Fits(fat), "nach dem Abladen ist wieder kein Platz");
    }

    [UnityTest]
    public IEnumerator LoadingReleasesTheTruck()
    {
        _bayUi.Auto();
        _bayUi.Confirm();
        yield return null;

        Assert.IsFalse(_bayUi.IsOpen, "die Rampe bleibt nach dem Beladen offen");
        Assert.IsFalse(_truck.controlsLocked, "der Truck bleibt nach dem Beladen gesperrt");
        Assert.IsTrue(_bay.IsLoaded, "nichts geladen");

        var from = _truck.transform.position;
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(2.5f);
        _truck.useExternalInput = false;

        Assert.Greater(Vector3.Distance(from, _truck.transform.position), 2f,
            "der Truck faehrt auch beladen nicht los");
    }

    [UnityTest]
    public IEnumerator TheLoadIsVisibleOnTheBed()
    {
        _bayUi.Auto();
        _bayUi.Confirm();
        yield return null;

        int crates = 0;
        foreach (var t in _truck.GetComponentsInChildren<Transform>(true))
            if (t.name == "Package") crates++;

        Assert.AreEqual(_bay.Count, crates, "die Ladung ist auf dem Truck nicht zu sehen");

        // and it sits ON the bed, not on the roof of the cab: the measured
        // load floor is y 0.36 in the truck's frame, the cab roof is y 1.56
        foreach (var t in _truck.GetComponentsInChildren<Transform>(true))
        {
            if (t.name != "Package") continue;
            var local = _truck.transform.InverseTransformPoint(t.position);
            Assert.Less(local.y, 1.3f,
                $"das Paket sitzt bei y={local.y:0.00} - das ist auf dem Fuehrerhaus");
            Assert.Less(local.z, 0.6f,
                $"das Paket sitzt bei z={local.z:0.00} - das ist vor der Ladeflaeche");
        }
    }

    [UnityTest]
    public IEnumerator ARespawnOpensTheBayAgainAndDropsTheLoad()
    {
        _bayUi.Auto();
        _bayUi.Confirm();
        yield return null;
        Assert.IsTrue(_bay.IsLoaded);

        // Wait for the CONDITION, not for a fixed number of frames. Spawn
        // protection is cleared in TruckHealth.Update, and destroying the truck
        // before that ran is silently ignored - which showed up as this test
        // failing one run in two.
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
        for (int i = 0; i < 30 && _health.IsInvulnerable; i++) yield return null;
        Assert.IsFalse(_health.IsInvulnerable, "der Truck steht abseits des Spawns und ist noch geschuetzt");

        _health.respawnSeconds = 1f;
        _health.WriteOff();
        Assert.IsTrue(_health.IsDestroyed, "der Truck liess sich nicht zerstoeren");
        float t0 = Time.realtimeSinceStartup;
        while (_health.IsDestroyed && Time.realtimeSinceStartup - t0 < 8f) yield return null;
        yield return null;

        Assert.IsTrue(_bayUi.IsOpen, "nach dem Respawn geht die Rampe nicht wieder auf");
        Assert.IsFalse(_bay.IsLoaded, "die Ladung ueberlebt die Zerstoerung des Trucks");
        Assert.IsTrue(_truck.controlsLocked, "der Truck ist nach dem Respawn nicht gesperrt");
    }

    [UnityTest]
    public IEnumerator TappingACrateLoadsItOntoTheTruck()
    {
        var yard = Object.FindFirstObjectByType<PackageYard>();
        Assert.IsNotNull(yard, "kein Lagerplatz in der Szene");
        Assert.IsTrue(yard.IsOpen, "der Lagerplatz ist beim Spawn nicht offen");

        int standing = 0;
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
            if (t.name == "YardPackage") standing++;
        Assert.AreEqual(_feed.Offers.Count, standing,
            "die wartenden Transaktionen stehen nicht als Pakete im Lager");

        var tx = _feed.Offers[0];
        Assert.IsTrue(yard.Toggle(tx), "das Paket liess sich nicht aufladen");
        yield return null;

        Assert.IsTrue(_bay.Contains(tx.txid), "das angetippte Paket ist nicht auf dem Truck");
        Assert.AreEqual(1, _bay.Count);

        // and tapping it again puts it back
        Assert.IsTrue(yard.Toggle(tx), "das Paket liess sich nicht abladen");
        yield return null;
        Assert.IsFalse(_bay.Contains(tx.txid), "das Paket blieb nach dem Abladen an Bord");
    }

    [UnityTest]
    public IEnumerator ACrateOnTheBedIsNotAlsoInTheYard()
    {
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var tx = _feed.Offers[1];
        yard.Toggle(tx);
        yield return null;

        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
            if (t.name == "YardPackage" && t.gameObject.activeSelf)
                Assert.That(Mathf.Abs(t.localScale.y - CargoBay.CrateSize(tx)), Is.GreaterThan(0.001f),
                    "das geladene Paket steht immer noch im Lager");
    }

    /// <summary>
    /// Built, lit and active is not the same as visible. The first yard was
    /// laid out behind the truck in world axes, so every crate sat behind the
    /// camera and looked like nothing at all - reported as "no packages are
    /// shown". This checks they are in shot of the camera that draws them.
    /// </summary>
    [UnityTest]
    public IEnumerator TheYardIsInTheCameraView()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var cam = yard.View;
        Assert.IsNotNull(cam, "die Auswahl hat keine eigene Kamera");
        Assert.IsTrue(cam.enabled, "die Kamera der Auswahl ist aus");

        int total = 0, onScreen = 0;
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
        {
            if (t.name != "YardPackage" || !t.gameObject.activeSelf) continue;
            total++;
            var vp = cam.WorldToViewportPoint(t.position);
            if (vp.z > 0f && vp.x > 0f && vp.x < 1f && vp.y > 0f && vp.y < 1f) onScreen++;
        }

        Assert.Greater(total, 0, "es stehen gar keine Pakete im Lager");
        Assert.GreaterOrEqual(onScreen, total - 1,
            $"nur {onScreen} von {total} Paketen sind im Bild - der Rest steht ausserhalb der Kamera");
    }

    /// <summary>
    /// The panel must be a panel: its own camera, its own layer, and nothing
    /// of it standing in the world where the game is played.
    /// </summary>
    [UnityTest]
    public IEnumerator TheSelectionIsAPanelNotSceneryOnTheField()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var chase = Object.FindFirstObjectByType<ChaseCamera>();
        var gameCam = chase.GetComponent<Camera>();

        Assert.AreEqual(0, gameCam.cullingMask & (1 << PackageYard.YardLayer),
            "die Spielkamera sieht die Auswahl-Ebene - dann stehen die Pakete im Feld");
        Assert.Greater(yard.View.depth, gameCam.depth,
            "die Auswahl wird hinter dem Spiel gezeichnet");

        int crates = 0;
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
        {
            if (t.name != "YardPackage") continue;
            crates++;
            Assert.AreEqual(PackageYard.YardLayer, t.gameObject.layer,
                "ein Paket liegt nicht auf der Auswahl-Ebene");
            Assert.Less(t.position.y, -100f,
                $"ein Paket steht bei y={t.position.y:0} im Spielfeld statt im Panel");
        }
        Assert.Greater(crates, 0, "keine Pakete im Panel");
    }

    [UnityTest]
    public IEnumerator ThePackagesTurnAndEachHasItsOwnColour()
    {
        var yard = Object.FindFirstObjectByType<PackageYard>();

        Transform sample = null;
        var seen = new List<Color>();
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
        {
            if (t.name != "YardPackage") continue;
            if (sample == null) sample = t;
            var r = t.GetComponent<Renderer>();
            if (r != null && r.sharedMaterial != null) seen.Add(r.sharedMaterial.color);
        }
        Assert.IsNotNull(sample, "keine Pakete");

        var was = sample.localRotation;
        yield return new WaitForSecondsRealtime(0.5f);
        Assert.Greater(Quaternion.Angle(was, sample.localRotation), 2f,
            "die Pakete drehen sich nicht");

        // every crate its own colour
        for (int i = 0; i < seen.Count; i++)
            for (int j = i + 1; j < seen.Count; j++)
                Assert.Greater(
                    Mathf.Abs(seen[i].r - seen[j].r) + Mathf.Abs(seen[i].g - seen[j].g) +
                    Mathf.Abs(seen[i].b - seen[j].b), 0.05f,
                    $"Paket {i} und {j} haben dieselbe Farbe");
    }

    [Test]
    public void SmallPackagesTurnFasterThanBigOnes()
    {
        var small = new MempoolFeed.Tx { txid = "small", feeSats = 100, vsize = 180, valueSats = 1 };
        var big = new MempoolFeed.Tx { txid = "big", feeSats = 100, vsize = 2400, valueSats = 1 };
        Assert.Less(CargoBay.CrateSize(small), CargoBay.CrateSize(big),
            "die Groesse haengt nicht an der Transaktionsgroesse");
    }

    /// <summary>
    /// Count the pixels. Every other check here can pass while the panel draws
    /// nothing at all - the crates hang 2000 m under the world, and whether
    /// light reaches them there is an assumption, not a fact. This renders the
    /// panel camera and looks at what came out.
    /// </summary>
    [UnityTest]
    public IEnumerator ThePanelActuallyDrawsSomething()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var cam = yard.View;

        var rt = new RenderTexture(320, 200, 24);
        var shot = new Texture2D(320, 200, TextureFormat.RGB24, false);
        var wasClear = cam.clearFlags;
        var wasBg = cam.backgroundColor;
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = Color.magenta;          // nothing in the panel is magenta
        cam.targetTexture = rt;
        cam.Render();

        RenderTexture.active = rt;
        shot.ReadPixels(new Rect(0, 0, 320, 200), 0, 0);
        shot.Apply();
        RenderTexture.active = null;

        cam.targetTexture = null;
        cam.clearFlags = wasClear;
        cam.backgroundColor = wasBg;

        int drawn = 0, lit = 0;
        foreach (var px in shot.GetPixels())
        {
            bool background = px.r > 0.85f && px.g < 0.2f && px.b > 0.85f;
            if (background) continue;
            drawn++;
            if (px.r + px.g + px.b > 0.25f) lit++;    // not a black silhouette
        }
        Object.Destroy(shot);
        rt.Release();
        Object.Destroy(rt);

        float share = drawn / (320f * 200f);
        Assert.Greater(share, 0.10f,
            $"das Auswahlfenster fuellt nur {share * 100:0.0}% des Bildes - es zeichnet praktisch nichts");
        Assert.Greater(lit / (float)Mathf.Max(1, drawn), 0.5f,
            "das Panel wird gezeichnet, ist aber schwarz - dort unten kommt kein Licht an");
    }

    [Test]
    public void TheApiShapeIsParsed()
    {
        const string json =
            "[{\"txid\":\"abc123abc123abc123\",\"fee\":4200,\"vsize\":140,\"value\":123456789}," +
            "{\"txid\":\"def456def456def456\",\"fee\":900,\"vsize\":300,\"value\":5000}]";

        var list = MempoolFeed.Parse(json, 10);
        Assert.AreEqual(2, list.Count, "die Antwort von /api/mempool/recent wird nicht gelesen");
        Assert.AreEqual("abc123abc123abc123", list[0].txid);
        Assert.AreEqual(30f, list[0].FeeRate, 0.01f, "die Gebuehrenrate stimmt nicht");
        Assert.AreEqual(1.23456789, list[0].Btc, 0.0001);
    }
}
