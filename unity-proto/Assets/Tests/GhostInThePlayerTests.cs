// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Arena;

/// <summary>
/// THE OTHER TRUCK, IN THE PLAYER THAT SHIPS - not in a field a test built.
///
/// `GhostOnScreenTests` proves the field draws what it is given. It builds the
/// field itself, so it says nothing at all about whether the PAGE has one, what
/// body it draws with, which way that body faces, or what it stands on. Those
/// are the three ways a ghost is wrong in a way a player would see instantly:
/// missing, sunk, or facing the wrong way.
///
/// The pictures are the same real two-node capture the on-screen test uses -
/// two daemons, two identities, one contract, the other player's transcript
/// replayed through `replay.js`.
/// </summary>
public class GhostInThePlayerTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    const float ONE = 65536f;

    static int[][] Frames()
    {
        var path = Path.Combine(Application.dataPath, "Tests", "Fixtures", "two-node-ghosts.txt");
        Assert.IsTrue(File.Exists(path), "the two-node pictures are missing: " + path);
        return File.ReadAllLines(path)
            .Where(l => l.Length > 0 && !l.StartsWith("#"))
            .Select(l => l.Split(' ').Select(int.Parse).ToArray())
            .ToArray();
    }

    static GhostPicture Picture(int[] w)
    {
        var entry = new System.Text.StringBuilder(64);
        for (var i = 0; i < 8; i++) entry.Append(w[i].ToString("x8"));
        return new GhostPicture(entry.ToString(), w[8], w[9], w[10], w[11]);
    }

    /// <summary>
    /// THE PAGE HAS A FIELD, AND IT HAS SOMETHING TO DRAW WITH.
    ///
    /// `GhostField` was a component nothing constructed: not in the scene, not
    /// added by `Bootstrap`, referenced by no shipping script. Every test of it
    /// made its own, so the whole set was green while the built player drained
    /// no pictures at all and drew no truck - the JS side filled a queue on the
    /// other side of a bridge nobody called.
    /// </summary>
    [UnityTest]
    public IEnumerator ThePlayerBuildsAFieldForTheOtherTrucks()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;

        var field = Object.FindFirstObjectByType<GhostField>();
        Assert.IsNotNull(field, "the player builds no ghost field, so no other truck is ever drawn");
        Assert.IsNotNull(field.Model, "the field has no body to draw a ghost with");
        Assert.IsNotNull(field.Model.GetComponentInChildren<Renderer>(true),
            "the ghost body has no renderer, so a drawn ghost is invisible");
        Assert.IsNotNull(field.Rest, "nothing tells a ghost what ground it stands on");
    }

    /// <summary>
    /// AND IT FACES WHERE ITS TRANSCRIPT SAYS.
    ///
    /// The heading word is the core's, and the core measures a heading in
    /// TURNS: `ArenaCore.Degrees` is `(w &amp; 0xFFFF) * 360 / 65536`, which is
    /// why the M1 build reads out "heading 90" at 16384. Dividing that word by
    /// 65536 gives 0.25, so a truck driving east was drawn pointing north -
    /// 360 times too small, on the same word the local truck reads correctly.
    /// </summary>
    /// A ghost eases onto its newest picture over the frames after it, so the
    /// heading is read once it has ARRIVED - the same hundredth of a degree.
    [UnityTest]
    public IEnumerator TheOtherTruckFacesWhereItsTranscriptSaysItDoes()
    {
        var frames = Frames();
        var first = Picture(frames[0]);
        var later = Picture(frames[1]);

        var model = GameObject.CreatePrimitive(PrimitiveType.Cube);
        model.SetActive(false);
        var field = new GameObject("ghosts").AddComponent<GhostField>();
        field.Model = model;

        field.Show(first);
        var ghost = field.GetComponentInChildren<GhostTruck>(true);
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;
        float drawn = ghost.transform.rotation.eulerAngles.y;
        float wanted = ArenaCore.Degrees(first.Heading);
        TestContext.WriteLine($"heading word {first.Heading}: drawn {drawn:F3} deg, "
                              + $"transcript {wanted:F3} deg");
        Assert.AreEqual(0f, Mathf.DeltaAngle(wanted, drawn), 0.01f,
            "the other truck is drawn facing somewhere its transcript never pointed");

        field.Show(later);
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;
        Assert.AreEqual(0f, Mathf.DeltaAngle(ArenaCore.Degrees(later.Heading),
                                             ghost.transform.rotation.eulerAngles.y), 0.01f,
            "the truck did not turn with its own transcript");
        Assert.AreNotEqual(first.Heading, later.Heading,
            "the run never turns, so this proves nothing");
    }

    /// <summary>
    /// AND IT STANDS ON THE GROUND, not in it.
    ///
    /// `GhostTruck.Show` keeps whatever y the object had, and a fresh object
    /// has none - so every ghost stood at y = 0 while the map it is drawn on is
    /// the fee histogram and moves. On this map that is metres under the road.
    /// </summary>
    [Test]
    public void TheGhostStandsOnTheGroundItIsGiven()
    {
        var frames = Frames();
        var first = Picture(frames[0]);

        var model = GameObject.CreatePrimitive(PrimitiveType.Cube);
        model.SetActive(false);
        var field = new GameObject("ghosts").AddComponent<GhostField>();
        field.Model = model;
        field.Rest = (x, z, heading) => 7.5f;   // a ground with a value nobody defaults to

        field.Show(first);
        var ghost = field.GetComponentInChildren<GhostTruck>(true);
        TestContext.WriteLine($"ghost y {ghost.transform.position.y:F3} against a ground of 7.5");
        Assert.AreEqual(7.5f, ghost.transform.position.y, 0.001f,
            "the drawn truck ignores the ground it was given");
    }

    /// <summary>
    /// IN THE BUILT WORLD: on the surface the local truck uses, not under it.
    /// </summary>
    [UnityTest]
    public IEnumerator TheGhostInThePlayerIsNotUnderTheRoad()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;
        yield return null;

        var field = Object.FindFirstObjectByType<GhostField>();
        Assert.IsNotNull(field, "the player builds no ghost field");

        var first = Picture(Frames()[0]);
        field.Show(first);
        var ghost = field.GetComponentInChildren<GhostTruck>(true);
        Assert.IsNotNull(ghost, "no truck was drawn for the other identity");
        Assert.IsTrue(ghost.gameObject.activeInHierarchy,
            "the drawn truck is switched off, so nobody sees it");

        var driver = Object.FindFirstObjectByType<CoreDrivenTruck>();
        Assert.IsNotNull(driver, "the world has no core-driven truck to take a surface from");
        float x = first.X / ONE, z = first.Z / ONE;
        float surface = driver.Ground(x, z);
        float y = ghost.transform.position.y;
        TestContext.WriteLine($"ghost at ({x:F2}, {z:F2}) y {y:F3}, surface {surface:F3}, "
                              + $"body above ground {driver.BodyAboveGround:F3}");
        Assert.AreEqual(surface + driver.BodyAboveGround, y, 0.05f,
            "the other truck is not standing on the ground the local truck stands on");
    }

    /// <summary>
    /// THE DRAWN POSE, IN THE SHIPPING PLAYER, AGAINST THE TRANSCRIPT.
    ///
    /// Not a field this test built: the one `Bootstrap` builds, with the body
    /// it chose and the rest it wired. The twelve ints are handed in through
    /// the field's own `Source`, which is the door `Draw` takes either way -
    /// the only difference from a live page is where the ints came from, and
    /// `two-nodes-play.test.js` already measures that half against two real
    /// daemons at delta zero.
    ///
    /// The residual is REPORTED in metres and degrees rather than assumed: a
    /// Q16.16 word divided into a float is not exact, and a number nobody
    /// prints is a number nobody checks.
    /// </summary>
    [UnityTest]
    public IEnumerator TheDrawnPoseIsTheTranscriptPose()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;
        yield return null;

        var field = Object.FindFirstObjectByType<GhostField>();
        Assert.IsNotNull(field, "the player builds no ghost field");

        var frames = Frames();
        var queue = new System.Collections.Generic.Queue<GhostPicture>();
        foreach (var w in frames) queue.Enqueue(Picture(w));
        field.Source = () => queue.Count > 0 ? queue.Dequeue() : (GhostPicture?)null;

        // WHAT THE WORLD THE CORE IS GIVEN LOOKS LIKE WITH NOBODY DRAWN.
        WorldSolids.Gather(null, out var without);

        Assert.AreEqual(1, field.Draw(1), "the player drew none of the pictures it was given");
        var ghost = field.GetComponentInChildren<GhostTruck>(true);
        Assert.IsNotNull(ghost, "no truck was drawn for the other identity");
        // The field stops drawing while the truck arrives, or waiting would
        // hand it the next picture instead of letting it reach this one.
        field.enabled = false;
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;

        var first = Picture(frames[0]);
        var at = ghost.transform.position;
        float dx = at.x - first.X / ONE, dz = at.z - first.Z / ONE;
        float dh = Mathf.DeltaAngle(ArenaCore.Degrees(first.Heading),
                                    ghost.transform.rotation.eulerAngles.y);
        TestContext.WriteLine($"tick {first.Tick}: drawn ({at.x:F4}, {at.z:F4}) "
            + $"heading {ghost.transform.rotation.eulerAngles.y:F4} | transcript "
            + $"({first.X / ONE:F4}, {first.Z / ONE:F4}) heading "
            + $"{ArenaCore.Degrees(first.Heading):F4} | delta x {dx:F6} z {dz:F6} "
            + $"heading {dh:F6}");
        Assert.AreEqual(0f, dx, 0.0001f, "the drawn truck is not at the x its transcript reached");
        Assert.AreEqual(0f, dz, 0.0001f);
        Assert.AreEqual(0f, dh, 0.0001f);

        // AND IT MOVES with the second picture, sixty ticks later.
        var later = Picture(frames[1]);
        field.enabled = true;
        Assert.AreEqual(1, field.Draw(1), "the second picture was not drawn");
        Assert.AreEqual(1, field.Trucks, "the second picture made a second truck");
        // The field stops again while the truck walks onto this picture, or
        // waiting would hand it the one after and assert about neither.
        field.enabled = false;
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;
        var moved = ghost.transform.position;
        float dx2 = moved.x - later.X / ONE, dz2 = moved.z - later.Z / ONE;
        TestContext.WriteLine($"tick {later.Tick}: drawn ({moved.x:F4}, {moved.z:F4}) "
            + $"| delta x {dx2:F6} z {dz2:F6} | it moved {(moved - at).magnitude:F3} m");
        Assert.AreEqual(0f, dx2, 0.0001f, "the truck did not move to where its later picture says");
        Assert.AreEqual(0f, dz2, 0.0001f);
        Assert.Greater((moved - at).magnitude, 0.5f, "the run does not move, so this proves nothing");

        // AND THE WORLD THE CORE IS GIVEN DID NOT GROW BY A BOX.
        WorldSolids.Gather(null, out var with);
        TestContext.WriteLine($"solids without the other truck {without}, with it drawn {with}; "
            + $"colliders {field.GetComponentsInChildren<Collider>(true).Length}, "
            + $"rigidbodies {field.GetComponentsInChildren<Rigidbody>(true).Length}");
        Assert.AreEqual(without, with, "the drawn truck became a wall in the world the core is given");
        Assert.AreEqual(0, field.GetComponentsInChildren<Collider>(true).Length);
        Assert.AreEqual(0, field.GetComponentsInChildren<Rigidbody>(true).Length);
    }
}
