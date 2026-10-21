// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using Arena;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// WHERE THE CLOUD STANDS.
///
/// This exists because a green suite proved nothing about it twice. The dust
/// skirt spent four material passes invisible while every test was green -
/// it was 23 m underground - and once that was fixed the column was found
/// resting the same way, its foot 26 m below the crater floor, again with a
/// green suite. Both had one cause: the streamed model's origin is its
/// MIDDLE, measured y -27.5 .. +23.0 on a model 55.0 m tall, so putting that
/// origin on the ground buries half the cloud.
///
/// The rule is small enough to state and would have caught both in seconds:
/// the stem's foot sits ON the crater floor, and the dust skirt never sinks
/// below it. Nothing here asserts a HEIGHT - the skirt rides the highest
/// ground under its own span, which over a deep bowl is metres above the
/// floor, and that is a recorded choice - only that neither is buried.
///
/// PlayMode, because the resting runs in `Update` and EditMode never calls
/// it. `RaiseColumn` is driven directly: the editor's core is a stub, so no
/// liquidation will ever arrive in one, and a test that waited for a real
/// strike would wait forever.
/// </summary>
public class MushroomRestingTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        // `WastedSequence` slows the clock when the truck is written off, and
        // tearing the scene down mid-sequence leaves it slowed. The next
        // time-sensitive test then measures nothing moving in two seconds -
        // `PostOfficeTests.TheGogglesAnimate` went red exactly that way.
        // `StrikeSeamTests` resets it for the same reason.
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;

        // AND PUT THE SCENE BACK, rather than leaving an empty world behind.
        // Destroying every root leaves nothing for the next fixture to find,
        // and `PostOfficeTests.TheGogglesAnimate` went red on exactly that -
        // green alone, green after StrikeSeamTests which rigs Bootstrap the
        // same way and does not run a round, red after either of these two.
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
    }

    /// <summary>
    /// A stand-in for the streamed GLB, authored with the SAME fault: its
    /// origin is its middle, so half of it hangs below the point it is put
    /// at. If the resting ever goes back to trusting the pivot, this sinks.
    /// </summary>
    static GameObject Model()
    {
        var root = new GameObject("mushroom-stand-in");

        var stem = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
        stem.name = "stem";
        stem.transform.SetParent(root.transform, false);
        stem.transform.localScale = new Vector3(0.3f, 1f, 0.3f);   // 2 m tall about the origin

        var cap = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        cap.name = "cap";
        cap.transform.SetParent(root.transform, false);
        cap.transform.localPosition = new Vector3(0f, 1f, 0f);
        cap.transform.localScale = new Vector3(0.8f, 0.5f, 0.8f);

        // THE SKIRT IS THE LOWEST PART, as it is in the real GLB: there the
        // model runs y -27.5 .. +23.0 and the dust skirt occupies the bottom
        // of it. That is what makes its own resting necessary - putting the
        // COLUMN's foot on the floor leaves the skirt hanging below it - and a
        // stand-in with the skirt tucked up inside the stem cannot show that.
        var skirt = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
        skirt.name = "dust_skirt";                                  // the name the code finds
        skirt.transform.SetParent(root.transform, false);
        skirt.transform.localPosition = new Vector3(0f, -1.4f, 0f);
        skirt.transform.localScale = new Vector3(1f, 0.05f, 1f);

        return root;
    }

    StrikeTheatre _theatre;

    IEnumerator Rig()
    {
        var boot = new GameObject("Bootstrap");
        boot.AddComponent<Bootstrap>();
        for (int i = 0; i < 6; i++) yield return null;

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        _theatre = Object.FindFirstObjectByType<StrikeTheatre>();
        Assert.IsNotNull(_theatre, "no StrikeTheatre in the scene");
        _theatre.SetMushroom(Model());
        yield return null;
    }

    /// <summary>Stand a cloud and let the growth curve run past its rise.</summary>
    IEnumerator CloudAt(Vector3 at)
    {
        _theatre.RaiseColumn(at);
        for (int i = 0; i < 90; i++) { _theatre.StepCloud(1f / 60f); yield return null; }
        Assert.Greater(_theatre.Restings, 0,
                       "the resting never ran, so nothing below is a measurement");
    }

    [UnityTest]
    public IEnumerator TheStemStandsOnTheCraterFloorRatherThanUnderIt()
    {
        yield return Rig();
        yield return CloudAt(new Vector3(12f, 0f, -8f));

        Assert.AreEqual(_theatre.CloudFloor, _theatre.StemFoot, 0.05f,
                        "the stem's foot must sit on the crater floor, not above or below it. "
                        + $"foot {_theatre.StemFoot:F2}, floor {_theatre.CloudFloor:F2}");
    }

    [UnityTest]
    public IEnumerator TheDustSkirtIsNeverBelowTheGround()
    {
        yield return Rig();
        yield return CloudAt(new Vector3(-25f, 0f, 30f));

        Assert.GreaterOrEqual(_theatre.SkirtUnderside, _theatre.CloudFloor - 0.05f,
            "the dust must never sink under the ground it is thrown onto. "
            + $"skirt underside {_theatre.SkirtUnderside:F2}, floor {_theatre.CloudFloor:F2}");
    }

    /// <summary>
    /// The burial grew with the cloud - 17.35 m at t=0.3 s, 26.32 m at
    /// t=1.7 s - because the model is scaled about that same middle. So the
    /// resting is checked while the cloud is still small AND once it is full.
    /// </summary>
    [UnityTest]
    public IEnumerator TheRestingHoldsWhileTheCloudIsStillGrowing()
    {
        yield return Rig();
        _theatre.RaiseColumn(new Vector3(4f, 0f, 4f));

        for (int i = 0; i < 90; i++)
        {
            _theatre.StepCloud(1f / 60f);
            yield return null;
            if (_theatre.Restings == 0) continue;      // the first frames have no cloud yet
            Assert.AreEqual(_theatre.CloudFloor, _theatre.StemFoot, 0.05f,
                            $"the foot left the floor on frame {i}");
            Assert.GreaterOrEqual(_theatre.SkirtUnderside, _theatre.CloudFloor - 0.05f,
                            $"the dust went under the ground on frame {i}");
        }
        // Only that it ran. HOW MANY frames it ran for is a property of the
        // harness, not of the picture: in the full suite the theatre's own
        // Update advances the same cloud, so it reaches `Gone` in fewer
        // explicit steps and a count assertion goes red for no reason. The
        // resting checks inside the loop are what this test is for.
        Assert.Greater(_theatre.Restings, 0, "the resting never ran");
    }
}
