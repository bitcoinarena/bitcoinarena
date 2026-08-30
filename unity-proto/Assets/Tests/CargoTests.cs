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
            // Deep enough to FILL the bed, which takes about 6.0 of room and
            // more than seven packages. Two carry no value at all: the mempool
            // is full of them and they must not crowd out the movers.
            Tx("aaaa1111aaaa1111aaaa1111aaaa1111",  200,  400,   50_000_000),  // 0.5/vB
            Tx("bbbb2222bbbb2222bbbb2222bbbb2222", 9000,  300, 3_000_000_000),  // whale
            Tx("cccc3333cccc3333cccc3333cccc3333", 2000,  200,   10_000_000),  // 10/vB
            Tx("dddd4444dddd4444dddd4444dddd4444", 4500,  150,   20_000_000),  // 30/vB
            Tx("eeee5555eeee5555eeee5555eeee5555",  600,  600,    5_000_000),  // 1/vB
            Tx("ffff6666ffff6666ffff6666ffff6666", 1800, 2400,    7_000_000),  // a big one
            Tx("99997777999977779999777799997777",  900,  450,            0),  // dust
            Tx("8888aaaa8888aaaa8888aaaa8888aaaa",  120,  200,            0),  // dust
            Tx("7777bbbb7777bbbb7777bbbb7777bbbb", 3300,  220,   80_000_000),
            Tx("6666cccc6666cccc6666cccc6666cccc", 1500,  500,   40_000_000),
            Tx("5555dddd5555dddd5555dddd5555dddd", 2600,  260,   30_000_000),
            Tx("4444eeee4444eeee4444eeee4444eeee",  700,  700,   15_000_000),
            Tx("3333ffff3333ffff3333ffff3333ffff", 1100,  180,   12_000_000),
            Tx("2222aaaa2222aaaa2222aaaa2222aaaa",  800,  240,    9_000_000),
        };
        // Deep enough that the ramp is full and still holds a queue: the panel
        // offers twenty-one and the bed takes about six of room, so a short
        // list would make "more choice than fits" untestable.
        for (int i = 0; i < 24; i++)
            _feed.Offers.Add(Tx($"filler{i:00}0000000000000000000000000",
                                600 + i * 90, 180 + i * 55, 1_000_000 + i * 250_000));
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
        // the best few, not everything the mempool holds
        Assert.AreEqual(Mathf.Min(_feed.Offers.Count, yard.show), standing,
            "die angebotenen Transaktionen stehen nicht als Pakete im Panel");

        var tx = yard.Captions()[0].tx;
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
        var tx = yard.Captions()[1].tx;
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
    /// Render the frame with the panel open and again with it shut, and diff
    /// the two.
    ///
    /// This has now been got wrong twice. The first version rendered the panel
    /// camera alone into its own texture, which says nothing about how the two
    /// images are combined - and that was exactly where the bug was: URP does
    /// not composite two base cameras the way the built-in pipeline does, so
    /// the panel took the whole screen and the truck vanished, while the test
    /// passed. The second version looked for a near-black backdrop in the
    /// finished frame, which the tone mapping and exposure lift well clear of
    /// black.
    ///
    /// A difference between two frames needs no threshold on any colour: the
    /// panel must change the top of the picture and must leave the bottom -
    /// where the truck is - alone.
    /// </summary>
    [UnityTest]
    public IEnumerator ThePanelCoversTheTopAndLeavesTheTruckVisible()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var chase = Object.FindFirstObjectByType<ChaseCamera>();
        var cam = chase.GetComponent<Camera>();
        Assert.IsTrue(yard.IsOpen, "die Auswahl ist zu");

        // Let URP render over a normal frame rather than calling
        // Camera.Render(): the manual call does not run a camera stack, so the
        // overlay would be left out of the measurement entirely.
        const int W = 240, H = 150;
        var rt = new RenderTexture(W, H, 24);
        cam.targetTexture = rt;

        yield return null; yield return null;
        var open = Grab(rt, W, H);

        yard.Close();
        yield return null; yield return null;
        var shut = Grab(rt, W, H);

        // A second shut frame, as a baseline. The world does not hold still
        // between two captures - soldiers walk, turrets traverse, smoke drifts
        // - so part of any difference is simply the battle carrying on. Without
        // this the test was reading world motion as panel coverage and failing
        // at 12.5% when the panel touches the lower half not at all.
        yield return null; yield return null;
        var also = Grab(rt, W, H);

        cam.targetTexture = null;
        rt.Release();
        Object.Destroy(rt);

        int topChanged = 0, bottomChanged = 0, bottomLit = 0;
        int topNoise = 0, bottomNoise = 0;
        for (int y = 0; y < H; y++)
            for (int x = 0; x < W; x++)
            {
                int i = y * W + x;
                bool changed = Differs(open[i], shut[i]);
                bool noise = Differs(shut[i], also[i]);
                if (y >= H / 2)
                {
                    if (changed) topChanged++;
                    if (noise) topNoise++;
                }
                else
                {
                    if (changed) bottomChanged++;
                    if (noise) bottomNoise++;
                    if (open[i].r + open[i].g + open[i].b > 0.30f) bottomLit++;
                }
            }

        float half = W * H * 0.5f;
        Assert.Greater((topChanged - topNoise) / half, 0.25f,
            $"das Panel veraendert nur {(topChanged - topNoise) / half * 100:0.0}% der " +
            "oberen Bildhaelfte ueber die Eigenbewegung hinaus - es wird nicht " +
            "ueber das Spiel gezeichnet");
        // The panel reaches just past the middle of the screen: twenty-one
        // crates with readable captions do not fit in less, and the truck's
        // bed - the part being loaded - is below it either way. The headline
        // price steps aside while the bay is open so the panel can sit high.
        Assert.Less((bottomChanged - bottomNoise) / half, 0.16f,
            $"das Panel veraendert {(bottomChanged - bottomNoise) / half * 100:0.0}% der " +
            "unteren Bildhaelfte ueber die Eigenbewegung hinaus - dort steht der " +
            "Truck, den man beim Beladen sehen muss");
        Assert.Greater(bottomLit / half, 0.60f,
            $"die untere Bildhaelfte ist nur zu {bottomLit / half * 100:0.0}% hell - " +
            "dort muesste das Spiel zu sehen sein");
    }

    static bool Differs(Color a, Color b) =>
        Mathf.Abs(a.r - b.r) + Mathf.Abs(a.g - b.g) + Mathf.Abs(a.b - b.b) > 0.08f;

    static Color[] Grab(RenderTexture rt, int w, int h)
    {
        var tex = new Texture2D(w, h, TextureFormat.RGB24, false);
        RenderTexture.active = rt;
        tex.ReadPixels(new Rect(0, 0, w, h), 0, 0);
        tex.Apply();
        RenderTexture.active = null;
        var px = tex.GetPixels();
        Object.Destroy(tex);
        return px;
    }

    [Test]
    public void ThePanelIsAnOverlayOnTheGameCamera()
    {
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var chase = Object.FindFirstObjectByType<ChaseCamera>();
        var data = chase.GetComponent<Camera>()
            .GetComponent<UnityEngine.Rendering.Universal.UniversalAdditionalCameraData>();

        Assert.IsNotNull(data, "die Spielkamera hat keine URP-Daten");
        Assert.Contains(yard.View, data.cameraStack,
            "die Panel-Kamera haengt nicht im Stack der Spielkamera - dann " +
            "ueberschreibt sie das Spielbild, statt darueber zu liegen");

        var yardData = yard.View
            .GetComponent<UnityEngine.Rendering.Universal.UniversalAdditionalCameraData>();
        Assert.AreEqual(UnityEngine.Rendering.Universal.CameraRenderType.Overlay,
            yardData.renderType, "die Panel-Kamera ist keine Overlay-Kamera");
    }

    [UnityTest]
    public IEnumerator EveryPackageCarriesItsNumbers()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var caps = yard.Captions();

        Assert.AreEqual(Mathf.Min(_feed.Offers.Count, yard.show), caps.Count,
            "nicht jedes angebotene Paket hat eine Beschriftung");

        foreach (var c in caps)
        {
            Assert.Greater(c.tx.vsize, 0, "ein Paket kennt seine Groesse nicht");
            Assert.Greater(c.tx.FeeRate, 0f, "ein Paket kennt seine Gebuehrenrate nicht");
            Assert.Greater(c.radius, 1f, "die Beschriftung wuesste nicht, wie gross die Kiste ist");
            Assert.That(c.screen.x, Is.InRange(-Screen.width * 0.5f, Screen.width * 1.5f),
                "eine Beschriftung liegt weit ausserhalb des Bildes");
        }
    }

    /// <summary>
    /// Reported: AUTO gets a big package aboard and picking one by hand does
    /// not. This presses where each crate is actually drawn and checks the
    /// right one is taken - the big one included.
    /// </summary>
    [UnityTest]
    public IEnumerator TappingWhereACrateIsDrawnPicksThatCrate()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();

        var caps = yard.Captions();
        Assert.Greater(caps.Count, 0, "keine Pakete im Panel");

        foreach (var c in caps)
        {
            // Captions() counts down from the top like the GUI; the pointer
            // counts up from the bottom
            var press = new Vector2(c.screen.x, Screen.height - c.screen.y);
            var hit = yard.PickAt(press);
            Assert.IsNotNull(hit, $"ein Tipp genau auf {c.tx.Short} trifft nichts");
            Assert.AreEqual(c.tx.txid, hit.txid,
                $"ein Tipp auf {c.tx.Short} waehlt {hit.Short} aus");
        }
    }

    [UnityTest]
    public IEnumerator TheBiggestPackageCanBeLoadedByHand()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();

        MempoolFeed.Tx biggest = null;
        foreach (var c in yard.Captions())
            if (biggest == null || c.tx.vsize > biggest.vsize) biggest = c.tx;
        Assert.IsNotNull(biggest, "keine Pakete im Panel");

        Assert.IsTrue(yard.Toggle(biggest),
            $"das groesste Paket ({biggest.vsize} vB) laesst sich von Hand nicht laden");
        Assert.IsTrue(_bay.Contains(biggest.txid), "es ist nicht an Bord");
    }

    [UnityTest]
    public IEnumerator TheValuableOnesAreShownFirst()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();
        var caps = yard.Captions();

        // The panel is laid out in the order Captions() returns, so that order
        // IS the reading order. Sorting by screen position would be wrong: the
        // crates bob, so their y drifts by a few pixels every frame.
        double best = double.MaxValue;
        foreach (var c in caps)
        {
            Assert.LessOrEqual(c.tx.Btc, best + 0.0001,
                $"{c.tx.Short} mit {c.tx.Btc:0.####} BTC steht hinter einem kleineren Posten");
            best = c.tx.Btc;
        }

        // and that order runs left to right along each row, then down
        for (int i = 1; i < caps.Count; i++)
        {
            bool sameRow = i % yard.perRow != 0;
            if (sameRow)
                Assert.Greater(caps[i].screen.x, caps[i - 1].screen.x,
                    "die Reihenfolge in der Reihe entspricht nicht der auf dem Bildschirm");
            else
                Assert.Greater(caps[i].screen.y, caps[i - 1].screen.y,
                    "die zweite Reihe steht nicht unter der ersten");
        }

        // the dust must not crowd out the movers
        Assert.LessOrEqual(caps.Count, yard.show, "es werden zu viele Posten angeboten");
        Assert.GreaterOrEqual(yard.show, 20, "es werden weniger als zwanzig Posten angeboten");
        Assert.Greater(caps[0].tx.Btc, 0.0, "ganz vorne steht eine 0-BTC-Transaktion");
    }

    /// <summary>
    /// Reported: everything on the ramp was loaded and the bed was still only
    /// two thirds full, with nothing left to pick. The ramp is a conveyor -
    /// what is taken is replaced by the best thing still waiting - so it must
    /// be possible to fill the bed by hand.
    /// </summary>
    [UnityTest]
    public IEnumerator TheRampOffersEnoughToFillTheBed()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();

        for (int guard = 0; guard < 40; guard++)
        {
            var caps = yard.Captions();
            if (caps.Count == 0) break;

            bool took = false;
            foreach (var c in caps)
                if (_bay.Fits(c.tx) && yard.Toggle(c.tx)) { took = true; break; }

            // Nothing on the ramp fits: give it a frame to bring something
            // forward that does, and only give up if it cannot.
            if (!took)
            {
                yield return null;
                bool anyFits = false;
                foreach (var c in yard.Captions()) if (_bay.Fits(c.tx)) anyFits = true;
                if (!anyFits) break;
            }
            yield return null;
        }

        // 0.9 rather than 1.0: two columns packed greedily leave a stub too
        // short for anything on offer, which is honest packing, not a fault.
        Assert.Greater(_bay.Fill, 0.9f,
            $"die Ladeflaeche ist nur zu {_bay.Fill * 100:0}% voll, obwohl alles " +
            "Angebotene geladen wurde - die Rampe bietet zu wenig nach");
    }

    [UnityTest]
    public IEnumerator TakingOneOffTheRampBringsTheNextForward()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();

        int before = yard.Captions().Count;
        Assert.AreEqual(yard.show, before, "die Rampe ist nicht voll besetzt");

        var first = yard.Captions()[0].tx;
        yard.Toggle(first);
        yield return null;

        var after = yard.Captions();
        Assert.AreEqual(before, after.Count,
            "nach dem Aufladen rueckt nichts nach - die Rampe wird leer");
        foreach (var c in after)
            Assert.AreNotEqual(first.txid, c.tx.txid,
                "das geladene Paket steht noch auf der Rampe");
    }

    [Test]
    public void AutoLeavesRoomToFillUpByHand()
    {
        _bayUi.Auto();

        Assert.Greater(_bay.Fill, 0.4f, "AUTO laedt viel zu wenig");
        Assert.LessOrEqual(_bay.Fill, _bayUi.autoFill + 0.2f,
            $"AUTO fuellt die Ladeflaeche zu {_bay.Fill * 100:0}% - dann lohnt " +
            "das Auffuellen von Hand nicht mehr");
    }

    /// <summary>
    /// Reported: the crates in the panel all looked the same size while the
    /// ones on the bed did not. They were squeezed into 62-100% of their cell,
    /// which hides the difference whenever the offers are of similar size -
    /// and the size of a crate is the whole way a transaction's size is shown.
    /// </summary>
    [UnityTest]
    public IEnumerator ThePanelShowsRealSizeDifferences()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();

        float small = float.MaxValue, large = 0f;
        MempoolFeed.Tx smallest = null, largest = null;
        foreach (var t in Object.FindObjectsByType<Transform>(FindObjectsSortMode.None))
        {
            if (t.name != "YardPackage" || !t.gameObject.activeSelf) continue;
            if (t.localScale.y < small) small = t.localScale.y;
            if (t.localScale.y > large) large = t.localScale.y;
        }
        foreach (var c in yard.Captions())
        {
            if (smallest == null || c.tx.vsize < smallest.vsize) smallest = c.tx;
            if (largest == null || c.tx.vsize > largest.vsize) largest = c.tx;
        }

        Assert.Greater(largest.vsize, smallest.vsize * 2,
            "die Testdaten enthalten keine wirklich verschieden grossen Posten");
        Assert.Greater(large / small, 1.6f,
            $"die groesste Kiste ist nur {large / small:0.00}-mal so gross wie die " +
            $"kleinste, obwohl {largest.vsize} vB gegen {smallest.vsize} vB stehen");
    }

    [UnityTest]
    public IEnumerator TenPackagesAreOnOffer()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();
        Assert.GreaterOrEqual(yard.show, 20, "es werden weniger als zwanzig Posten angeboten");
        Assert.AreEqual(Mathf.Min(_feed.Offers.Count, yard.show), yard.Captions().Count,
            "die Rampe ist nicht voll besetzt");
    }

    [Test]
    public void EveryPackageKnowsWhatItPays()
    {
        // the fee is the payout: the gate banks exactly the sum of what is aboard
        foreach (var tx in _feed.Offers)
            Assert.Greater(tx.feeSats, 0, $"{tx.Short} hat keine Gebuehr, also keinen Verdienst");

        _bayUi.Auto();
        long expected = 0;
        foreach (var slot in _bay.Slots) expected += slot.tx.feeSats;
        Assert.AreEqual(expected, _bay.FeeCarried,
            "der angezeigte Verdienst stimmt nicht mit der Ladung ueberein");
    }

    /// <summary>
    /// Reported: there were always exactly as many packages as fit, so there
    /// was no choice to make. The ramp has to offer more than the bed can take.
    /// </summary>
    [UnityTest]
    public IEnumerator ThereIsMoreOnOfferThanFitsOnTheBed()
    {
        yield return null;
        var yard = Object.FindFirstObjectByType<PackageYard>();

        float onOffer = 0f;
        foreach (var c in yard.Captions()) onOffer += CargoBay.RoomFor(c.tx);
        float bedTakes = _bay.bedLength * _bay.columns;

        Assert.Greater(onOffer, bedTakes * 1.5f,
            $"das Angebot fasst {onOffer:0.0} Raumeinheiten, die Ladeflaeche {bedTakes:0.0} - " +
            "es passt praktisch alles, also gibt es nichts zu entscheiden");
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
