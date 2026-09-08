using System.Collections.Generic;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using Blwp;

/// <summary>
/// THE OTHER TRUCK IS DRAWN FROM THE PAGE'S PICTURES, AND FROM NOTHING ELSE.
///
/// Measured before this slice: `GhostTruck.Show` had no caller in this project
/// at all, and `blwp.jslib` had no ghost entry point - a picture was produced
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
    [Test]
    public void PicturesBecomeTrucksWhereTheirFramesSay()
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
    [Test]
    public void APictureWithNoEntryDrawsNothing()
    {
        var field = Field(new GhostPicture("", 0, 0, 0, 1));
        field.Draw(10);
        Assert.AreEqual(0, field.Trucks);
        Assert.AreEqual(0, field.Shown);
    }

    /// <summary>
    /// The field takes what it is asked for and leaves the rest for the next
    /// frame, so a backlog cannot stall drawing.
    /// </summary>
    [Test]
    public void ADrainTakesWhatItWasAskedFor()
    {
        var many = Enumerable.Range(0, 10)
            .Select(i => new GhostPicture("aaaaaaaa", i * ONE, 0, 0, i)).ToArray();
        var field = Field(many);

        Assert.AreEqual(4, field.Draw(4));
        Assert.AreEqual(4, field.Shown);
        Assert.AreEqual(1, field.Trucks, "ten pictures of one entry made more than one truck");
        Assert.AreEqual(3f, field.GetComponentInChildren<GhostTruck>().transform.position.x, 0.0001f);

        Assert.AreEqual(6, field.Draw(100), "the rest was not there for the next frame");
        Assert.AreEqual(9f, field.GetComponentInChildren<GhostTruck>().transform.position.x, 0.0001f);
        Assert.AreEqual(0, field.Draw(100), "an empty queue still drew something");
    }
}
