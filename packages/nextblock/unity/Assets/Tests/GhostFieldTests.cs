// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Arena;

/// <summary>
/// THE OTHER TRUCK IS DRAWN FROM THE PAGE'S PICTURES, AND FROM NOTHING ELSE.
///
/// Measured before this slice: `GhostTruck.Show` had no caller in this project
/// at all, and `arena.jslib` had no ghost entry point - a picture was produced
/// by the node, delivered on the socket and decoded by the client, and then
/// drawn by nobody.
///
/// Spec 0.10: "Ghost snapshots are never inputs to this calculation." So the
/// field below places trucks and does nothing else: the pose is the frame's,
/// there is no integrator inventing one between two pictures, and PhysX is
/// given nothing to work with - which `GhostTests` measures for one ghost and
/// these measure for a field of them, drawn live from a queue.
/// </summary>
public class GhostFieldTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    static GhostField Field(params GhostPicture[] pictures)
    {
        var queue = new Queue<GhostPicture>(pictures);
        var field = new GameObject("ghosts").AddComponent<GhostField>();
        field.Source = () => queue.Count > 0 ? queue.Dequeue() : (GhostPicture?)null;
        return field;
    }

    const int ONE = 65536;

    /// <summary>
    /// THREE PICTURES, TWO TRUCKS, EACH WHERE ITS OWN FRAME SAYS.
    /// </summary>
    /// A ghost eases onto its newest picture over the frames after it - 10 Hz
    /// pictures on a 60 Hz screen - so the pose is read once it has ARRIVED.
    /// The metre it is asserted to is the same metre it always was.
    [UnityTest]
    public IEnumerator PicturesBecomeTrucksWhereTheirFramesSay()
    {
        var field = Field(
            new GhostPicture("aaaaaaaa", 3 * ONE, 4 * ONE, 90 * ONE, 100),
            new GhostPicture("bbbbbbbb", -7 * ONE, 11 * ONE, 0, 100),
            new GhostPicture("aaaaaaaa", 5 * ONE, 4 * ONE, 90 * ONE, 140));

        Assert.AreEqual(3, field.Draw(10), "the field did not take every picture it was offered");
        Assert.AreEqual(2, field.Trucks, "three pictures of two entries made a truck each time");
        Assert.AreEqual(3, field.Shown);

        var trucks = field.GetComponentsInChildren<GhostTruck>(true);
        Assert.AreEqual(2, trucks.Length);
        // THE FIELD STOPS DRAWING WHILE THE TRUCKS ARRIVE. `Update` calls
        // `Draw(PerFrame)` every frame, so waiting for a ghost to reach its
        // picture would hand it the NEXT ones - which is drawing, not
        // arriving, and would assert about a picture this test never named.
        field.enabled = false;
        for (var f = 0; f < 600 && trucks.Any(t => !t.Settled); f++) yield return null;

        // THE POSE IS THE LAST FRAME'S, not an average and not a guess: the
        // first entry moved from x=3 to x=5 and the field shows where the
        // second picture said, to the metre the words name.
        var moved = trucks.First(t => t.gameObject.name.EndsWith("aaaaaaaa"));
        Assert.AreEqual(5f, moved.transform.position.x, 0.0001f, "the truck is not where its last picture said");
        Assert.AreEqual(4f, moved.transform.position.z, 0.0001f);

        var other = trucks.First(t => t.gameObject.name.EndsWith("bbbbbbbb"));
        Assert.AreEqual(-7f, other.transform.position.x, 0.0001f);
        Assert.AreEqual(11f, other.transform.position.z, 0.0001f);
    }

    /// <summary>
    /// A DRAWN GHOST CARRIES NO PHYSICS, however many of them there are.
    /// </summary>
    [Test]
    public void ADrawnFieldGivesPhysXNothing()
    {
        var field = Field(
            new GhostPicture("aaaaaaaa", 0, 0, 0, 1),
            new GhostPicture("bbbbbbbb", ONE, ONE, 0, 1));
        field.Draw(10);

        Assert.AreEqual(0, field.GetComponentsInChildren<Collider>(true).Length,
            "a drawn ghost carries a collider, so it can be hit");
        Assert.AreEqual(0, field.GetComponentsInChildren<Rigidbody>(true).Length,
            "a drawn ghost carries a rigidbody, so PhysX will move it");
        foreach (var ghost in field.GetComponentsInChildren<GhostTruck>(true))
            Assert.IsFalse(ghost.CarriesPhysics(), "a drawn ghost carries physics");
    }

    /// <summary>
    /// AND THE WORLD THE CORE IS GIVEN DOES NOT GROW BY ONE BOX.
    ///
    /// `WorldSolids.Gather` uploads every scene box into the simulation as a
    /// wall. That is the second door letter 18 found and shut, and it was shut
    /// against a ghost nobody had drawn yet. This measures it against a LIVE
    /// one, taken from the queue, which is the case that will actually exist.
    /// </summary>
    [Test]
    public void ALiveGhostIsNotAWall()
    {
        var wall = GameObject.CreatePrimitive(PrimitiveType.Cube);
        wall.transform.position = new Vector3(20f, 0f, 20f);

        WorldSolids.Gather(null, out var without);

        var field = Field(
            new GhostPicture("aaaaaaaa", 20 * ONE, 21 * ONE, 0, 1),
            new GhostPicture("bbbbbbbb", 22 * ONE, 21 * ONE, 0, 1));
        field.Draw(10);
        Assert.AreEqual(2, field.Trucks, "no ghost was drawn, so this measures nothing");

        WorldSolids.Gather(null, out var with);
        TestContext.WriteLine($"solids without the ghosts: {without}, with them drawn: {with}");
        Assert.AreEqual(without, with,
            "the world the core is given grew when a ghost was drawn: a picture became a wall");
        Assert.GreaterOrEqual(without, 1, "the scene has no solids at all, so equality proves nothing");
    }

    /// <summary>
    /// A picture with no entry is not a truck. Nothing invents an identity.
    /// </summary>
    [UnityTest]
    public IEnumerator ANewRoundsWatchClearsEveryTruckOfTheLastRound()
    {
        // 2026-09-17 17:12: "after the next round suddenly 3 ghosts in the game". The page sends one clear record
        // (tick -2) when it starts watching a new round; every truck of the last one goes, and the new round's draw.
        var field = Field(
            new GhostPicture("aaaaaaaa", 3 * ONE, 4 * ONE, 0, 100),
            new GhostPicture("bbbbbbbb", 5 * ONE, 4 * ONE, 0, 100),
            new GhostPicture("cccccccc", 7 * ONE, 4 * ONE, 0, 100),
            new GhostPicture("00000000", 0, 0, 0, GhostField.ClearTick),
            new GhostPicture("dddddddd", 9 * ONE, 4 * ONE, QUARTER, 3));
        Assert.AreEqual(5, field.Draw(10));
        yield return null;
        Assert.AreEqual(1, field.Trucks, "trucks of the last round stayed after the new watch");
        Assert.AreEqual(1, field.Cleared);
        Assert.AreEqual(1, field.GetComponentsInChildren<GhostTruck>(true).Length);
        Assert.IsTrue(field.Pictures.ContainsKey("dddddddd") && field.Pictures.Count == 1);

        // AND THE NEW ROUND'S TRUCK STANDS AND POINTS AT ITS FIRST PICTURE IN THE FRAME IT WAS DRAWN (the owner
        // 2026-09-18 05:45). That is the half of "after PLAY the other truck is missing, then in the wrong place" the
        // wire cannot answer: the wire says when the first picture arrived, this says the pose the hull is in when it
        // does. The trucks above stood at 3, 5 and 7 m facing zero; this one is 9 m away and a quarter turn round, so a
        // hull left over from the last round, or one walking out of the last round's pose, is a fact here and not an
        // impression.
        var made = field.GetComponentInChildren<GhostTruck>(true);
        Assert.IsNotNull(made, "the new round drew no truck at all");
        Assert.IsTrue(made.Settled, "the new round's truck is not on its own first picture");
        Assert.AreEqual(9f, made.transform.position.x, 0.001f,
            "the new round's truck is not at its first picture's x: it is where the last round left one");
        Assert.AreEqual(4f, made.transform.position.z, 0.001f, "the new round's truck is not at its first picture's z");
        Assert.AreEqual(0f, Mathf.DeltaAngle(ArenaCore.Degrees(QUARTER), made.transform.rotation.eulerAngles.y), 0.01f,
            "the new round's truck is not pointing the way its first picture says");
    }

    /// <summary>A quarter turn in the core's own word, the way a heading is carried.</summary>
    const int QUARTER = 16384;

    [Test]
    public void APictureWithNoEntryDrawsNothing()
    {
        var field = Field(new GhostPicture("", 0, 0, 0, 1));
        field.Draw(10);
        Assert.AreEqual(0, field.Trucks);
        Assert.AreEqual(0, field.Shown);
    }

    /// <summary>
    /// AN ENTRY ITS PLAYER LEFT IS TAKEN AWAY, AND NOTHING ELSE IS.
    ///
    /// Measured 2026-09-10 on the Daily: this field kept a truck per entry and
    /// never removed one, so after a reload it held 9 and 11 trucks, 8 and 10 of
    /// them abandoned entries standing frozen, and a watched player's reload left
    /// its 105-picture entry frozen beside the new one. The page now sends a
    /// retire - the same twelve words, tick -1 - for an entry that was left.
    /// </summary>
    [UnityTest]
    public IEnumerator ARetiredEntryLeavesNoTruckBehind()
    {
        var field = Field(
            new GhostPicture("aaaaaaaa", 3 * ONE, 4 * ONE, 0, 100),
            new GhostPicture("bbbbbbbb", -7 * ONE, 11 * ONE, 0, 100),
            new GhostPicture("aaaaaaaa", 0, 0, 0, -1),
            new GhostPicture("cccccccc", 0, 0, 0, -1));   // never drawn: nothing to take away
        field.enabled = false;

        Assert.AreEqual(4, field.Draw(10), "the field did not take every word it was offered");
        Assert.AreEqual(1, field.Trucks, "the retired entry's truck is still in the field");
        Assert.AreEqual(1, field.Retired, "a retire of an entry never drawn counted, or the real one did not");
        Assert.AreEqual(2, field.Shown, "a retire was counted as a picture shown");

        yield return null;   // Destroy takes effect at the end of the frame
        var left = field.GetComponentsInChildren<GhostTruck>(true);
        Assert.AreEqual(1, left.Length, "the retired truck is still standing in the scene");
        Assert.IsTrue(left[0].gameObject.name.EndsWith("bbbbbbbb"), "the wrong truck was taken away");
    }

    /// <summary>
    /// The field takes what it is asked for and leaves the rest for the next
    /// frame, so a backlog cannot stall drawing.
    /// </summary>
    [UnityTest]
    public IEnumerator ADrainTakesWhatItWasAskedFor()
    {
        var many = Enumerable.Range(0, 10)
            .Select(i => new GhostPicture("aaaaaaaa", i * ONE, 0, 0, i)).ToArray();
        var field = Field(many);

        Assert.AreEqual(4, field.Draw(4));
        Assert.AreEqual(4, field.Shown);
        Assert.AreEqual(1, field.Trucks, "ten pictures of one entry made more than one truck");
        var only = field.GetComponentInChildren<GhostTruck>();
        field.enabled = false;                 // see above: arriving, not drawing
        for (var f = 0; f < 600 && !only.Settled; f++) yield return null;
        Assert.AreEqual(3f, only.transform.position.x, 0.0001f);

        Assert.AreEqual(6, field.Draw(100), "the rest was not there for the next frame");
        for (var f = 0; f < 600 && !only.Settled; f++) yield return null;
        Assert.AreEqual(9f, only.transform.position.x, 0.0001f);
        Assert.AreEqual(0, field.Draw(100), "an empty queue still drew something");
    }

    /// <summary>
    /// THE DEBUG LABEL OVER A GHOST (2026-09-17 19:15): the page's line for each truck - entry, name, then the age
    /// and arrows - lands on the truck of that entry, two lines, and a line that is not one is dropped.
    /// </summary>
    [Test]
    public void TheDebugLabelNamesTheTruckAndSaysItsAgeAndMove()
    {
        var labels = GhostField.ParseLabels("aaaaaaaa\tAlice\t20ms \u2191\u2192\nbbbbbbbb\tOther\t~140ms\nbroken line");
        Assert.AreEqual(2, labels.Count, "a line that is not entry, name and age was kept");
        Assert.AreEqual("Alice", labels["aaaaaaaa"][0]);
        Assert.AreEqual("20ms \u2191\u2192", labels["aaaaaaaa"][1]);
        Assert.AreEqual("~140ms", labels["bbbbbbbb"][1]);
        Assert.AreEqual(0, GhostField.ParseLabels("").Count);
    }
}
