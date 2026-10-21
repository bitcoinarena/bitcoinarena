// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Arena;

/// <summary>
/// TWO NODES, ONE PAGE, THE OTHER TRUCK ON SCREEN.
///
/// The pictures below are not numbers invented in C#. They are the exact
/// twelve ints `ArenaNextGhost` hands across, captured from a real two-node run
/// by `arena-client/test/two-nodes-play.test.js`: two daemons, two identities,
/// one contract naming both signer nodes, a page that subscribed, and the other
/// player's transcript replayed by the node through `replay.js`. That test
/// checks the poses against the core driven directly; this one checks that a
/// renderer puts them where they say and that PhysX is still given nothing.
///
/// Spec 0.9: another player "must not be able to change my financial odds by
/// ramming me, blocking a road, pushing me, damaging me". So this asserts the
/// truck is VISIBLE and that the world the core is given did not grow by one
/// box - drawn and inert, which is the whole of what a ghost is.
/// </summary>
public class GhostOnScreenTests
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
    /// THE OTHER TRUCK IS DRAWN, WHERE ITS OWN TRANSCRIPT PUT IT, AND MOVES.
    /// </summary>
    /// A ghost eases onto its newest picture over the frames after it - 10 Hz
    /// pictures on a 60 Hz screen - so each pose is read once it has ARRIVED,
    /// to the same millimetre it always was.
    [UnityTest]
    public IEnumerator TheOtherTruckIsOnScreenAndMovesWithItsTranscript()
    {
        var frames = Frames();
        Assert.AreEqual(2, frames.Length, "the fixture no longer carries two pictures");
        var first = Picture(frames[0]);
        var later = Picture(frames[1]);
        Assert.AreEqual(first.Entry, later.Entry, "the two pictures are of different trucks");

        // A BODY WITH A RENDERER AND, AS A REAL MODEL WOULD, A COLLIDER.
        var model = GameObject.CreatePrimitive(PrimitiveType.Cube);
        model.SetActive(false);

        var field = new GameObject("ghosts").AddComponent<GhostField>();
        field.Model = model;

        field.Show(first);
        var ghost = field.GetComponentInChildren<GhostTruck>(true);
        Assert.IsNotNull(ghost, "no truck was drawn for the other identity");
        ghost.gameObject.SetActive(true);
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;

        // WHERE THE TRANSCRIPT PUT IT, to the metre the words name.
        Assert.AreEqual(first.X / ONE, ghost.transform.position.x, 0.001f,
            "the truck is not at the x its own transcript reached");
        Assert.AreEqual(first.Z / ONE, ghost.transform.position.z, 0.001f);

        // ON SCREEN: a camera looking at it has it inside the frustum, and the
        // renderer it is drawn with is enabled. Batchmode presents no frame to
        // capture, so what is measured is what a camera would draw.
        var cam = new GameObject("eye").AddComponent<Camera>();
        cam.transform.position = ghost.transform.position + new Vector3(0f, 12f, -18f);
        cam.transform.LookAt(ghost.transform.position);

        var renderer = ghost.GetComponentInChildren<Renderer>(true);
        Assert.IsNotNull(renderer, "the ghost has nothing to draw with");
        Assert.IsTrue(renderer.enabled, "the ghost's renderer is off, so nobody sees it");
        var planes = GeometryUtility.CalculateFrustumPlanes(cam);
        Assert.IsTrue(GeometryUtility.TestPlanesAABB(planes, renderer.bounds),
            "the other truck is not in the camera's view");

        // AND IT MOVES AS THE TRANSCRIPT SAYS - the second picture, sixty ticks
        // later, is a different place and the same truck.
        field.Show(later);
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;
        Assert.AreEqual(1, field.Trucks, "the second picture made a second truck");
        Assert.AreEqual(later.X / ONE, ghost.transform.position.x, 0.001f,
            "the truck did not move to where its later picture says");
        Assert.AreNotEqual(first.X, later.X, "the run does not move, so this proves nothing");
        Assert.IsTrue(GeometryUtility.TestPlanesAABB(
            GeometryUtility.CalculateFrustumPlanes(cam), renderer.bounds),
            "the truck drove out of view between two pictures 200ms apart");
    }

    /// <summary>
    /// AND IT IS STILL A PICTURE: nothing to ram, nothing to block a road.
    /// </summary>
    [Test]
    public void TheDrawnTruckIsAPictureAndNotASolid()
    {
        var wall = GameObject.CreatePrimitive(PrimitiveType.Cube);
        wall.transform.position = new Vector3(40f, 0f, 40f);
        WorldSolids.Gather(null, out var without);

        var model = GameObject.CreatePrimitive(PrimitiveType.Cube);
        model.SetActive(false);
        var field = new GameObject("ghosts").AddComponent<GhostField>();
        field.Model = model;
        foreach (var w in Frames()) field.Show(Picture(w));
        foreach (var t in field.GetComponentsInChildren<GhostTruck>(true))
            t.gameObject.SetActive(true);

        Assert.AreEqual(1, field.Trucks, "the two pictures are of one truck");
        Assert.AreEqual(0, field.GetComponentsInChildren<Collider>(true).Length,
            "the drawn truck can be rammed");
        Assert.AreEqual(0, field.GetComponentsInChildren<Rigidbody>(true).Length,
            "PhysX was given a body to move");

        WorldSolids.Gather(null, out var with);
        TestContext.WriteLine($"solids without the other truck: {without}, with it drawn: {with}");
        Assert.AreEqual(without, with, "the drawn truck became a wall in the world the core is given");
        Assert.GreaterOrEqual(without, 1, "the scene has no solids, so the equality proves nothing");
    }
}
