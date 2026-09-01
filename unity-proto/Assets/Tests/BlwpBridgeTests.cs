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
