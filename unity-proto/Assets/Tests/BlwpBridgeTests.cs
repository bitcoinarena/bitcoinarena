using System.Collections;
using System.IO;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Blwp;

/// <summary>
/// The bridge, tested for the things that can be tested without a browser.
///
/// What cannot be checked here is whether the truck drives WELL - that needs a
/// human at the wheel in a WebGL build, and it is the largest open item in the
/// whole estimate. What can be checked, and matters more than it sounds, is
/// that the two sides agree about where every field lives. C# and JavaScript
/// index the same ArrayBuffer by word offset; a disagreement does not throw,
/// it just renders the truck's health as its heading.
/// </summary>
public class BlwpBridgeTests
{
    static string CoreDir =>
        Path.GetFullPath(Path.Combine(Application.dataPath, "..", "..", "packages", "core"));

    [Test]
    public void TheLayoutMatchesTheJavaScriptItWasGeneratedFrom()
    {
        string stateJs = Path.Combine(CoreDir, "src", "state.js");
        if (!File.Exists(stateJs)) Assert.Ignore("core sources not present in this checkout");

        string src = File.ReadAllText(stateJs);

        // Every exported integer constant in state.js must exist in Layout with
        // the same value. Regenerating is one menu item; drifting is silent.
        foreach (var line in src.Split('\n'))
        {
            var m = System.Text.RegularExpressions.Regex.Match(
                line, @"^export const ([A-Z][A-Z0-9_]*) = (\d+);");
            if (!m.Success) continue;

            var field = typeof(Layout).GetField(m.Groups[1].Value);
            Assert.IsNotNull(field,
                $"state.js exports {m.Groups[1].Value} but BlwpLayout.cs has no such constant - " +
                "run Tools > BTC Logistics > Sync Deterministic Core");
            Assert.AreEqual(int.Parse(m.Groups[2].Value), (int)field.GetValue(null),
                m.Groups[1].Value + " disagrees between C# and JavaScript");
        }
    }

    [Test]
    public void TheStateBufferIsTheSizeTheLayoutImplies()
    {
        Assert.AreEqual(Layout.O_UNITS + Layout.MAX_UNITS * Layout.U_WORDS,
                        BlwpCore.State.Length,
                        "the state array and the layout disagree about the buffer");
    }

    [Test]
    public void UnitsConvertTheWayTheCoreMeansThem()
    {
        // Q16.16 metres, and turns rather than degrees. Getting either wrong is
        // a truck that is 65,536 times too far away or spinning 182 times per
        // revolution, so it is worth pinning.
        Assert.AreEqual(1f, BlwpCore.Metres(BlwpCore.ONE), 1e-6f);
        Assert.AreEqual(-2.5f, BlwpCore.Metres(-BlwpCore.ONE * 5 / 2), 1e-4f);
        Assert.AreEqual(0f, BlwpCore.Degrees(0), 1e-4f);
        Assert.AreEqual(90f, BlwpCore.Degrees(16384), 1e-3f);
        Assert.AreEqual(180f, BlwpCore.Degrees(32768), 1e-3f);
        // and it wraps, because the core keeps heading masked to one turn
        Assert.AreEqual(0f, BlwpCore.Degrees(65536), 1e-3f);
    }

    [Test]
    public void OutsideWebGLTheCoreIsAbsentAndSaysSo()
    {
        // The editor has no JavaScript. Falling back to PhysX is correct
        // behaviour rather than a degraded one, and the flag has to be honest
        // about it or a play-mode test would silently measure the wrong thing.
        Assert.IsFalse(BlwpCore.Compiled, "this test runs outside a WebGL build");
        Assert.IsFalse(BlwpCore.Init(1), "a core answered where there is no JavaScript");
        Assert.IsFalse(BlwpCore.Available);
    }

    [Test]
    public void TheBundleIsPresentInTheTemplateAndIsTheRealOne()
    {
        string inTemplate = Path.Combine(Application.dataPath,
            "WebGLTemplates/BtcLogistics/blwp-core.js");
        Assert.IsTrue(File.Exists(inTemplate),
            "the WebGL template has no core bundle - the build would load nothing");

        string text = File.ReadAllText(inTemplate);
        StringAssert.Contains("var BLWP", text, "the bundle does not define BLWP");
        foreach (var name in new[] { "init:", "step:", "hash:", "runScore:" })
            StringAssert.Contains(name, text, "the bundle does not export " + name);

        string html = File.ReadAllText(Path.Combine(Application.dataPath,
            "WebGLTemplates/BtcLogistics/index.html"));
        StringAssert.Contains("blwp-core.js", html,
            "the page never loads the bundle, so the jslib would find no BLWP");
    }

    [UnityTest]
    public IEnumerator TheTruckKeepsItsPhysicsWhenNoCoreAnswers()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        var truck = Object.FindFirstObjectByType<TruckController>();
        var driver = truck.gameObject.AddComponent<CoreDrivenTruck>();
        yield return null;

        Assert.IsFalse(driver.Driving, "the core claimed to drive outside WebGL");
        var rb = truck.GetComponent<Rigidbody>();
        Assert.IsFalse(rb.isKinematic,
            "the truck was switched to kinematic without a core to move it - " +
            "which would leave it frozen rather than falling back");

        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }
}

// Appended: the practice switch. Kept with the bridge tests because that is
// where it lives - it is an input to the core, not a Unity setting.
public class PracticeModeTests
{
    [SetUp] public void Reset() => Blwp.PracticeMode.On = true;

    [Test]
    public void TheSceneSettingDecidesWhenTheUrlIsSilent()
    {
        // No page in the editor, so QueryParam is null and the scene's own
        // value has to stand on its own - both ways round, because a default
        // that can only be turned on is not configurable.
        Blwp.PracticeMode.Configure(false);
        Assert.IsFalse(Blwp.PracticeMode.On, "die Szene wollte aus");
        Assert.AreEqual("scene", Blwp.PracticeMode.Source);

        Blwp.PracticeMode.Configure(true);
        Assert.IsTrue(Blwp.PracticeMode.On, "die Szene wollte an");
    }

    [Test]
    public void TogglingIsRecordedAsThePlayersDoing()
    {
        // Worth separating from the starting value: "practice was on" and
        // "the player turned it on" are different facts.
        Blwp.PracticeMode.Configure(true);
        Blwp.PracticeMode.Toggle();
        Assert.IsFalse(Blwp.PracticeMode.On);
        Assert.AreEqual("player", Blwp.PracticeMode.Source);
    }

    [Test]
    public void ItIsOnByDefaultInThisBuild()
    {
        Assert.IsTrue(Blwp.PracticeMode.On,
            "this build exists to be driven and judged, not survived");
    }

    [Test]
    public void ItReachesTheCoreAsAnInputRatherThanAsASetting()
    {
        // Q16.16, because that is what every other input is. A boolean crossing
        // the boundary would be the one value with its own convention.
        Blwp.PracticeMode.On = true;
        Assert.AreEqual(Blwp.BlwpCore.ONE, Blwp.PracticeMode.Input);
        Blwp.PracticeMode.On = false;
        Assert.AreEqual(0, Blwp.PracticeMode.Input);
    }

    [UnityTest]
    public IEnumerator PracticeShieldsThePhysicsPathToo()
    {
        // The core only drives in a WebGL build. In the editor PhysX drives, and
        // a switch that only worked in the browser would be a switch nobody
        // could test.
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        var health = Object.FindFirstObjectByType<TruckHealth>();
        Blwp.PracticeMode.On = true;
        Assert.IsTrue(health.IsInvulnerable, "practice did not reach TruckHealth");

        health.Damage(500f);
        health.WriteOff();
        yield return null;
        Assert.IsFalse(health.IsDestroyed, "the truck was destroyed while practising");

        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
        Blwp.PracticeMode.On = true;
    }
}

/// <summary>
/// The truck lies on the ground rather than floating dead level over it.
///
/// This is worth a test because the fault is invisible: a truck pinned level
/// looks entirely normal, and the only symptom is that driving down a hill
/// does not feel like driving down a hill. The physics was right and the
/// drawing was not.
/// </summary>
public class TruckLieTests
{
    const float Half = 2.0f, Track = 1.15f;

    static float PitchOf(Quaternion q)
    {
        // Positive = nose up.
        float p = q.eulerAngles.x;
        return -(p > 180f ? p - 360f : p);
    }

    [Test]
    public void FlatGroundLeavesItLevel()
    {
        var q = Blwp.CoreDrivenTruck.Lie(37f, 2f, 2f, 2f, 2f, Half, Track);
        Assert.AreEqual(0f, PitchOf(q), 0.01f, "auf ebenem Boden neigt sich nichts");
        Assert.AreEqual(37f, q.eulerAngles.y, 0.5f, "die Fahrtrichtung darf sich nicht aendern");
    }

    [Test]
    public void GoingDownhillPutsTheNoseDown()
    {
        // Front wheels a metre lower than the rear over a 4 m wheelbase.
        var q = Blwp.CoreDrivenTruck.Lie(0f, 1f, 1f, 2f, 2f, Half, Track);
        float pitch = PitchOf(q);
        Assert.Less(pitch, -10f, $"bergab zeigt die Nase nach unten, gemessen {pitch:0.0} Grad");
        Assert.AreEqual(-Mathf.Atan2(1f, 4f) * Mathf.Rad2Deg, pitch, 1f,
            "der Winkel muss dem Gefaelle entsprechen");
    }

    [Test]
    public void GoingUphillPutsTheNoseUp()
    {
        var q = Blwp.CoreDrivenTruck.Lie(0f, 2f, 2f, 1f, 1f, Half, Track);
        Assert.Greater(PitchOf(q), 10f, "bergauf zeigt die Nase nach oben");
    }

    [Test]
    public void ACrossSlopeRollsIt()
    {
        // Left wheels low, right wheels high.
        var q = Blwp.CoreDrivenTruck.Lie(0f, 1f, 2f, 1f, 2f, Half, Track);
        float roll = q.eulerAngles.z; if (roll > 180f) roll -= 360f;
        Assert.Greater(Mathf.Abs(roll), 10f, "quer zum Hang legt sich der Truck");
        Assert.AreEqual(0f, PitchOf(q), 1f, "quer zum Hang aendert sich die Neigung nicht");
    }

    [Test]
    public void TheLieFollowsTheHeading()
    {
        // Same slope, truck turned 90 degrees: what was pitch is now roll.
        var q = Blwp.CoreDrivenTruck.Lie(90f, 1f, 1f, 2f, 2f, Half, Track);
        Assert.Less(PitchOf(q), -10f,
            "bergab bleibt bergab, in welche Himmelsrichtung auch immer");
    }
}

/// <summary>
/// Dragging looks around, but never at the cost of steering.
///
/// On a phone the pads ARE the controls, and a thumb sliding on one has to
/// steer the truck rather than pan the camera. Getting this wrong does not
/// look like a camera bug - it looks like the steering has died.
/// </summary>
public class CameraDragGuardTests
{
    static Vector3 Centre(TouchPad.Pad pad)
    {
        var r = TouchPad.RectFor(pad, Screen.width, Screen.height);
        // TouchPad works in GUI space, y down; Input.mousePosition is y up.
        return new Vector3(r.center.x, Screen.height - r.center.y, 0f);
    }

    [Test]
    public void ADragStartingOnADrivingPadIsNotALook()
    {
        foreach (TouchPad.Pad pad in System.Enum.GetValues(typeof(TouchPad.Pad)))
            Assert.IsTrue(ChaseCamera.OverAPad(Centre(pad)),
                $"ein Zug auf {pad} wuerde die Kamera schwenken statt zu lenken");
    }

    [Test]
    public void ADragOnTheOpenScreenIsALook()
    {
        // The middle of the screen is where the world is; nothing sits there.
        var middle = new Vector3(Screen.width * 0.5f, Screen.height * 0.55f, 0f);
        Assert.IsFalse(ChaseCamera.OverAPad(middle),
            "in der Bildmitte muss man die Ansicht drehen koennen");
    }
}

/// <summary>
/// The core starts the truck where Unity draws the bay.
///
/// These are two numbers in two languages describing one place, and when they
/// disagree nothing throws. The core spawned the truck at postX itself - the
/// facade line - so it started fourteen metres too far back, buried in the
/// loading dock and clipping through it, with the chase camera pressed against
/// a white slab a couple of metres from the lens. That reads as "the bay is
/// completely white at launch", which is why it went looking for a lighting
/// fault and not for this.
/// </summary>
public class TruckSpawnTests
{
    [UnityTest]
    public IEnumerator TheCoreSpawnsOnTheApronWhereTheBayIs()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);

        var post = Object.FindFirstObjectByType<PostOffice>();
        Assert.IsNotNull(post, "kein Post Office");
        Assert.IsTrue(post.HasBay, "die Bucht steht noch nicht fest");

        var bay = post.BayPosition;
        float coreX = Blwp.Layout.START_X / 65536f;
        float coreZ = Blwp.Layout.START_Z / 65536f;

        Assert.AreEqual(bay.x, coreX, 0.6f,
            $"der Core startet bei x={coreX:0.0}, die Bucht liegt bei x={bay.x:0.0} " +
            "- der Truck steht in der Rampe");
        Assert.AreEqual(bay.z, coreZ, 0.6f,
            $"der Core startet bei z={coreZ:0.0}, die Bucht liegt bei z={bay.z:0.0}");

        Object.Destroy(boot);
    }
}

/// <summary>
/// The core is given the world Unity is actually colliding with.
///
/// Harvested from the scene rather than described a second time: the buildings
/// are already colliders, and writing their geometry out again by hand is how
/// the collision world and the visible world come to disagree.
/// </summary>
public class WorldSolidsTests
{
    GameObject _boot;
    TruckController _truck;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return new WaitForSeconds(1.5f);
        _truck = Object.FindFirstObjectByType<TruckController>();
    }

    [TearDown] public void TearDown() { if (_boot != null) Object.Destroy(_boot); }

    [Test]
    public void TheBuildingsAreInIt()
    {
        var boxes = Blwp.WorldSolids.Gather(_truck.transform, out int n);
        Assert.Greater(n, 10, "die Gebaeude fehlen - der Truck faehrt durch alles hindurch");
        Assert.AreEqual(n * Blwp.WorldSolids.Words, boxes.Length);
    }

    [Test]
    public void ThereIsAWallBehindTheTruckAndADoorwayInFrontOfIt()
    {
        var post = Object.FindFirstObjectByType<PostOffice>();
        Assert.IsNotNull(post);
        var boxes = Blwp.WorldSolids.Gather(_truck.transform, out int n);

        float lane = post.BayPosition.z, spawnX = post.BayPosition.x;
        bool wall = false, lintel = false;
        for (int i = 0; i < n; i++)
        {
            float cx = boxes[i * 6] / 65536f, cz = boxes[i * 6 + 1] / 65536f;
            float hx = boxes[i * 6 + 2] / 65536f, hz = boxes[i * 6 + 3] / 65536f;
            float yLow = boxes[i * 6 + 4] / 65536f;
            if (Mathf.Abs(cz - lane) > hz) continue;
            if (cx + hx > spawnX) continue;
            if (yLow > post.BayPosition.y + 2f) lintel = true; else wall = true;
        }

        Assert.IsTrue(wall, "hinter dem Truck steht keine Wand");
        Assert.IsTrue(lintel,
            "ueber der Einfahrt liegt kein Sturz - dann traegt die Bucht auch keine Hoehe, " +
            "und der Core koennte nicht wissen, dass man darunter durchfaehrt");
    }

    [Test]
    public void TheTruckIsNotAnObstacleToItself()
    {
        foreach (var c in _truck.GetComponentsInChildren<BoxCollider>())
            Assert.IsFalse(Blwp.WorldSolids.IsWorld(c, _truck.transform),
                "der Truck wuerde sich selbst im Weg stehen");
    }

    [Test]
    public void MovingThingsAreNotScenery()
    {
        // A tank has a Rigidbody; it is fought, not driven around.
        var go = new GameObject("Movable");
        go.AddComponent<Rigidbody>();
        var box = go.AddComponent<BoxCollider>();
        Assert.IsFalse(Blwp.WorldSolids.IsWorld(box, _truck.transform));
        Object.Destroy(go);
    }
}

/// <summary>
/// Gunships patrol the front. They do not fly through the depots.
///
/// They held nineteen metres over the ground and ran from -FrontX-30 to
/// +FrontX+40, which put the spawn INSIDE the post office wall - it stands
/// from x -122.4 to -114.4 and reaches 58 m up - and the exit through the
/// miner. A helicopter appeared in a building, flew out of it, crossed the
/// field and vanished into the other one.
/// </summary>
public class GunshipCorridorTests
{
    [Test]
    public void TheCorridorStopsShortOfBothDepots()
    {
        // Measured off the harvested collision world: the miner's leading face
        // is the nearer of the two, and everything has to fit inside it.
        Assert.Less(Army.AirCorridorX, 108.4f,
            "der Korridor reicht in den Miner hinein");
        Assert.Greater(Army.AirCorridorX, Army.FrontX,
            "der Korridor endet vor der Front - die Hubschrauber kaemen nie an");
    }

    [Test]
    public void AGunshipNeverLeavesTheCorridor()
    {
        var army = new Army(1234);
        army.GroundAt = (x, z) => 0f;
        army.FrontlineAt = _ => 0f;

        for (int i = 0; i < 6; i++) army.SendHelicopter(i % 2 == 0 ? Army.Side.Bull : Army.Side.Bear);

        float worst = 0f;
        for (int step = 0; step < 3000; step++)
        {
            army.Update(1f / 60f);
            foreach (var h in army.Helicopters) worst = Mathf.Max(worst, Mathf.Abs(h.x));
            if (step % 400 == 0) army.SendHelicopter(step % 800 == 0 ? Army.Side.Bull : Army.Side.Bear);
        }

        Assert.LessOrEqual(worst, Army.AirCorridorX + 0.5f,
            $"ein Hubschrauber kam bis x={worst:0.0} - das ist im Gebaeude");
    }
}

/// <summary>
/// Reinforcements walk in from the edge; they do not appear in the fighting.
///
/// The spawn depth was random - as little as thirty metres behind the line for
/// infantry - and reinforcements arrive DURING a round, so a squad could
/// simply materialise in plain view of the player. Both step functions already
/// drive a unit towards the line, so arriving at the edge costs nothing but
/// the walk.
/// </summary>
public class ReinforcementTests
{
    [Test]
    public void EveryUnitArrivesAtTheEdgeOfTheField()
    {
        var army = new Army(99);
        army.FrontlineAt = _ => 0f;
        army.GroundAt = (x, z) => 0f;
        army.Populate(12, 40);

        foreach (var u in army.Armour)
            Assert.GreaterOrEqual(Mathf.Abs(u.z), Army.HalfDepth - 3.5f,
                $"ein Panzer erschien bei z={u.z:0.0} statt am Rand ({Army.HalfDepth})");
        foreach (var u in army.Infantry)
            Assert.GreaterOrEqual(Mathf.Abs(u.z), Army.HalfDepth - 3.5f,
                $"ein Soldat erschien bei z={u.z:0.0} statt am Rand ({Army.HalfDepth})");
    }

    [Test]
    public void EachSideArrivesOnItsOwnSide()
    {
        var army = new Army(7);
        army.FrontlineAt = _ => 0f;
        army.GroundAt = (x, z) => 0f;
        army.Populate(8, 24);

        foreach (var u in army.Armour)
            Assert.AreEqual(u.side == Army.Side.Bull ? -1f : 1f, Mathf.Sign(u.z),
                "eine Einheit kam von der gegnerischen Seite herein");
    }

    [Test]
    public void AndThenTheyWalkToTheFront()
    {
        var army = new Army(3);
        army.FrontlineAt = _ => 0f;
        army.GroundAt = (x, z) => 0f;
        army.Populate(6, 18);

        float before = 0f;
        foreach (var u in army.Armour) before += Mathf.Abs(u.z);
        before /= army.Armour.Count;

        for (int i = 0; i < 60 * 20; i++) army.Update(1f / 60f);

        float after = 0f;
        foreach (var u in army.Armour) after += Mathf.Abs(u.z);
        after /= Mathf.Max(1, army.Armour.Count);

        Assert.Less(after, before - 10f,
            $"die Panzer standen nach zwanzig Sekunden noch bei {after:0.0} " +
            $"statt vorgerueckt zu sein (Start {before:0.0})");
    }
}
