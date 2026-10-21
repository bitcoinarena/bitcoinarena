// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Linq;
using System.Reflection;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Arena;

/// <summary>
/// Other players' trucks are pictures, and PhysX must never learn about them.
///
/// Spec 0.9: "Other trucks are visible ghosts with no collision. Another player
/// must not be able to change my financial odds by ramming me, blocking a
/// road, pushing me, damaging me..."
///
/// Spec 0.10: "Ghost snapshots are never inputs to this calculation. Alice's
/// physics cannot change Bob's result."
///
/// The protocol already refuses to let a ghost be an input - it has its own
/// type byte, it carries no authority, and the core's step has no argument one
/// could arrive through. The remaining way a competitor could reach my run is
/// through the ENGINE: a ghost with a collider is a truck I can hit, a road I
/// cannot pass, a body my wheels climb. These measure that PhysX has nothing
/// to work with.
/// </summary>
public class GhostTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    static GameObject SpawnGhost(string name, Vector3 at)
    {
        // Built the way a careless prefab would be: a body, a box, a wheel.
        // If the rule only held for objects that never had physics it would
        // hold for nothing, because a truck model arrives with colliders.
        var go = new GameObject(name);
        go.transform.position = at;
        go.AddComponent<BoxCollider>();
        go.AddComponent<Rigidbody>();

        var wheel = new GameObject("wheel");
        wheel.transform.SetParent(go.transform);
        wheel.AddComponent<SphereCollider>();

        go.AddComponent<GhostTruck>();
        return go;
    }

    /// <summary>
    /// A GHOST HAS NO COLLIDER AND NO RIGIDBODY, and it says what it took off.
    /// </summary>
    [Test]
    public void AGhostCarriesNoPhysicsAtAll()
    {
        var go = SpawnGhost("ghost", Vector3.zero);
        var ghost = go.GetComponent<GhostTruck>();

        Assert.AreEqual(0, go.GetComponentsInChildren<Collider>(true).Length,
            "a ghost kept a collider, so it is something a truck can hit");
        Assert.AreEqual(0, go.GetComponentsInChildren<Rigidbody>(true).Length,
            "a ghost kept a rigidbody, so PhysX is simulating a second truck");
        Assert.IsFalse(ghost.CarriesPhysics());

        // and it is not silent about it: a prefab that keeps growing colliders
        // shows up in the count rather than being quietly cleaned every frame
        Assert.AreEqual(2, ghost.StrippedColliders, "the box and the wheel were not both found");
        Assert.AreEqual(1, ghost.StrippedBodies);
        StringAssert.Contains("BoxCollider", ghost.StrippedFrom);
        StringAssert.Contains("SphereCollider", ghost.StrippedFrom);
        StringAssert.Contains("Rigidbody", ghost.StrippedFrom);
    }

    /// <summary>
    /// TWO GHOSTS ON TOP OF THE TRUCK, AND NOTHING HAPPENS.
    ///
    /// The local truck is a real body with a real collider - that is the point:
    /// if a ghost were a physics object this is where the truck would be pushed
    /// off its line, and 0.9's "ramming me" would be one line of prefab away.
    /// </summary>
    [UnityTest]
    public IEnumerator OverlappingGhostsMoveTheTruckNotOneMillimetre()
    {
        var truck = GameObject.CreatePrimitive(PrimitiveType.Cube);
        truck.name = "local truck";
        truck.transform.position = new Vector3(10f, 1f, 10f);
        var body = truck.AddComponent<Rigidbody>();
        body.useGravity = false;
        body.constraints = RigidbodyConstraints.None;

        var hits = truck.AddComponent<CollisionCounter>();

        // two ghosts, both exactly where the truck is
        SpawnGhost("ghost a", truck.transform.position);
        SpawnGhost("ghost b", truck.transform.position);

        var was = truck.transform.position;
        var wasVelocity = body.linearVelocity;

        for (int i = 0; i < 60; i++) yield return new WaitForFixedUpdate();

        Assert.AreEqual(0, hits.Count, "the truck collided with a ghost");
        Assert.AreEqual(was.x, truck.transform.position.x, 0.0001f, "the truck was pushed in x");
        Assert.AreEqual(was.z, truck.transform.position.z, 0.0001f, "the truck was pushed in z");
        Assert.AreEqual(wasVelocity.magnitude, body.linearVelocity.magnitude, 0.0001f,
            "a ghost gave the truck an impulse");

        // and the control: the same cube WITH physics does move the truck, so
        // the assertion above is not measuring an engine that never collides
        var solid = GameObject.CreatePrimitive(PrimitiveType.Cube);
        solid.name = "a real obstacle";
        solid.transform.position = truck.transform.position;
        var pusher = solid.AddComponent<Rigidbody>();
        pusher.useGravity = false;

        for (int i = 0; i < 60; i++) yield return new WaitForFixedUpdate();

        Assert.Greater(hits.Count, 0,
            "even a solid body did not collide, so this test cannot tell a ghost from a wall");

        // Cleared here rather than left to TearDown: this fixture is the only
        // one in the suite that runs PhysX on bodies of its own, and a test
        // that leaves them for the next fixture to trip over is a test that
        // makes somebody else flaky.
        Object.DestroyImmediate(solid);
        Object.DestroyImmediate(truck);
    }

    /// <summary>
    /// A GHOST NEVER BECOMES A WALL INSIDE THE CORE.
    ///
    /// `WorldSolids.Gather` is how the scene turns into boxes the core will not
    /// let the truck drive through. It scans every BoxCollider in the scene, so
    /// it is a door into the SIMULATION that does not go through step's
    /// arguments at all - and a ghost passes every one of its other exclusions:
    /// it is not a trigger, not on the yard layer, not a child of the truck,
    /// and it has no attachedRigidbody, because the rigidbody was stripped.
    ///
    /// 0.9: another player must not change my odds "by ramming me, BLOCKING A
    /// ROAD, pushing me". A ghost uploaded as a solid is a road blocked.
    /// </summary>
    [Test]
    public void AGhostIsNeverUploadedToTheCoreAsASolid()
    {
        var truck = new GameObject("local truck");

        // a real building: this is the control, and it must be gathered
        var wall = GameObject.CreatePrimitive(PrimitiveType.Cube);
        wall.name = "a building";
        wall.transform.position = new Vector3(50f, 0f, 50f);
        wall.transform.localScale = new Vector3(8f, 4f, 8f);

        Arena.WorldSolids.Gather(truck.transform, out int withoutGhost);
        Assert.Greater(withoutGhost, 0, "the control building was not gathered either");

        // a ghost that has somehow been given a collider AFTER Awake - a
        // streamed model, a prefab edit, a careless AddComponent
        var go = SpawnGhost("ghost", new Vector3(20f, 0f, 20f));
        var late = go.AddComponent<BoxCollider>();
        late.size = new Vector3(4f, 2f, 4f);

        Assert.IsNotNull(go.GetComponent<BoxCollider>(),
            "the fixture did not manage to give the ghost a collider");
        Assert.IsNull(late.attachedRigidbody,
            "the fixture's collider has a rigidbody, so IsWorld would exclude it for the wrong reason");
        Assert.IsFalse(late.isTrigger);

        Assert.IsFalse(Arena.WorldSolids.IsWorld(late, truck.transform),
            "a ghost's collider counted as part of the solid world");

        Arena.WorldSolids.Gather(truck.transform, out int withGhost);
        Assert.AreEqual(withoutGhost, withGhost,
            "a ghost was uploaded to the core as a wall the truck cannot pass");
    }

    /// <summary>
    /// AND A MODEL THAT ARRIVES LATER IS STRIPPED WHEN IT ARRIVES.
    ///
    /// Awake runs once, and this project STREAMS its truck model in -
    /// `ModelStreamer` parents it afterwards, with whatever colliders its
    /// author gave it. A ghost that only stripped at Awake would be clean for
    /// a second and solid after that.
    /// </summary>
    [Test]
    public void AStreamedModelDoesNotGiveAGhostItsPhysicsBack()
    {
        var go = SpawnGhost("ghost", Vector3.zero);
        var ghost = go.GetComponent<GhostTruck>();
        Assert.IsFalse(ghost.CarriesPhysics());

        // the model arrives, carrying what a model carries
        var model = GameObject.CreatePrimitive(PrimitiveType.Capsule);
        model.name = "streamed truck";
        model.AddComponent<Rigidbody>();
        model.transform.SetParent(go.transform);

        Assert.IsFalse(ghost.CarriesPhysics(),
            "a model parented in after Awake left the ghost solid");
        Assert.AreEqual(0, go.GetComponentsInChildren<Collider>(true).Length);
        Assert.AreEqual(0, go.GetComponentsInChildren<Rigidbody>(true).Length);
    }

    /// <summary>
    /// A GHOST HOLDS NO REFERENCE TO THE SIMULATION. Asserted structurally, the
    /// way the core asserts step's argument list: a field that could reach the
    /// core is a field somebody can write through.
    /// </summary>
    [Test]
    public void AGhostCannotReachTheSimulation()
    {
        var fields = typeof(GhostTruck)
            .GetFields(BindingFlags.Instance | BindingFlags.Static
                       | BindingFlags.Public | BindingFlags.NonPublic)
            .Select(f => f.FieldType.Name)
            .Concat(typeof(GhostTruck)
                .GetProperties(BindingFlags.Instance | BindingFlags.Public
                               | BindingFlags.NonPublic)
                .Select(p => p.PropertyType.Name))
            .ToArray();

        foreach (var name in new[] { "ArenaCore", "CoreDrivenTruck", "TruckController", "Rigidbody" })
            CollectionAssert.DoesNotContain(fields, name,
                "a ghost holds a reference it could write the run through");
    }

    /// <summary>
    /// AND IT DRAWS WHAT THE FRAME SAID. The three words are the protocol's
    /// Q16.16 integers; the division happens here, at the edge, where a float
    /// is a picture rather than a result.
    /// </summary>
    /// A ghost walks from its last picture onto its newest over one picture
    /// interval - 10 Hz pictures on a 60 Hz screen - so each pose is read once
    /// it has ARRIVED, to the same ten-thousandth of a metre.
    [UnityTest]
    public IEnumerator AGhostStandsWhereTheFrameSays()
    {
        var go = SpawnGhost("ghost", Vector3.zero);
        var ghost = go.GetComponent<GhostTruck>();

        // A QUARTER TURN, NOT "90 IN Q16.16". The heading word is the core's
        // own T_HEADING and the core measures a heading in TURNS - which is
        // what `ArenaCore.TruckHeading` reads for the local truck, and why the
        // M1 build reads out "heading 90" from the word 16384. This line used
        // to pass `90 * 65536` and expect 90 degrees, which asserted a unit the
        // core does not use; the ghost's own conversion was written to match
        // it, so a truck driving east was drawn pointing north.
        ghost.Show(3 * 65536, -4 * 65536, 16384);
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;

        Assert.AreEqual(3f, go.transform.position.x, 0.0001f);
        Assert.AreEqual(-4f, go.transform.position.z, 0.0001f);
        Assert.AreEqual(90f, go.transform.rotation.eulerAngles.y, 0.01f);
        Assert.AreEqual(ArenaCore.Degrees(16384), go.transform.rotation.eulerAngles.y, 0.01f,
            "a ghost reads the heading word differently from the local truck");

        // negative and fractional words survive: a truck west of the origin at
        // half a metre is ordinary
        ghost.Show(-65536 / 2, -65536 / 2, 0);
        for (var f = 0; f < 600 && !ghost.Settled; f++) yield return null;
        Assert.AreEqual(-0.5f, go.transform.position.x, 0.0001f);
        Assert.AreEqual(-0.5f, go.transform.position.z, 0.0001f);

        // and showing a ghost never gives it physics back
        Assert.IsFalse(ghost.CarriesPhysics());
    }
}

/// <summary>Counts collisions so a test can say none happened.</summary>
public class CollisionCounter : MonoBehaviour
{
    public int Count;
    void OnCollisionEnter(Collision c) => Count++;
    void OnCollisionStay(Collision c) => Count++;
    void OnTriggerEnter(Collider c) => Count++;
}
