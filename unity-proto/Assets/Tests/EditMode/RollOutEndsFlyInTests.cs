// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Reflection;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// ROLL OUT STAYS FIRST PERSON (2026-09-29 12:45, PLAYTEST-ROLL-1245: "when he does roll out, the view suddenly
/// becomes top-down instead of first person. It must stay first person"). PLAY starts a 4.2 s fly-in from 52 m over the
/// field, and ROLL OUT ends it: the camera is at once behind the truck - `distance` back, `height` up, looking down the
/// road ahead, not down on the ground - on a phone held upright and on a desktop, and it stays behind the truck as it
/// drives. Never the top-down: not from the fly-in, not after the overview, not after a swipe.
/// </summary>
public class RollOutEndsFlyInTests
{
    static readonly Vector3 Gate = new Vector3(108f, 0.5f, -3.4f);          // the miner's doorway, east

    static void Frame(ChaseCamera chase)
    {
        typeof(ChaseCamera).GetMethod("LateUpdate", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(chase, null);
    }

    /// <summary>The first-person drive view: the follow mode, behind the truck, looking along the road, the truck in frame.</summary>
    static void AssertFirstPerson(ChaseCamera chase, Camera cam, Transform truck, string when)
    {
        Assert.AreEqual(ChaseCamera.Mode.Follow, chase.View, $"{when}: the drive view is behind the truck, not {chase.View}");
        Assert.IsFalse(chase.DestinationInFocus, $"{when}: no top-down holding the gate");
        var f = cam.transform.forward;
        Assert.That(f.y, Is.GreaterThan(-0.6f), $"{when}: looking along the road, not steeply down: {f}");
        var toTruck = truck.position - cam.transform.position;
        Assert.That(Vector3.Dot(Vector3.ProjectOnPlane(toTruck, Vector3.up).normalized, Vector3.ProjectOnPlane(truck.forward, Vector3.up).normalized),
            Is.GreaterThan(0.7f), $"{when}: the camera is behind the truck, facing where it drives");
        var v = cam.WorldToViewportPoint(truck.position);
        Assert.That(v.z, Is.GreaterThan(0f), $"{when}: the truck is in front of the camera: {v}");
        Assert.That(v.x, Is.InRange(0.02f, 0.98f), $"{when}: the truck is in the frame: {v}");
        Assert.That(v.y, Is.InRange(0.02f, 0.98f), $"{when}: the truck is in the frame: {v}");
    }

    [TestCase(390f / 844f, TestName = "phone upright")]
    [TestCase(1280f / 720f, TestName = "desktop")]
    public void RollOutStaysFirstPersonBehindTheTruck(float aspect)
    {
        var truck = new GameObject("truck");
        var go = new GameObject("chase");
        try
        {
            truck.transform.position = new Vector3(-100.4f, 0.5f, -3.4f);          // at the post office's ramp
            truck.transform.rotation = Quaternion.Euler(0f, 90f, 0f);
            var cam = go.AddComponent<Camera>();
            cam.aspect = aspect;
            var chase = go.AddComponent<ChaseCamera>();
            chase.target = truck.transform;

            chase.FlyIn(new Vector3(0f, 52f, 0f), new Vector3(-114f, 20f, 0f), 4.2f);
            Assert.IsTrue(chase.Flying, "PLAY's flight is running under the cargo panel");

            chase.destination = Gate;                                          // LoadoutPanel names the gate before ROLL OUT
            chase.EndFlyIn();
            Assert.IsFalse(chase.Flying, "ROLL OUT ends it");
            AssertFirstPerson(chase, cam, truck.transform, "at roll out");
            Assert.That(Vector3.Distance(go.transform.position, truck.transform.position), Is.LessThan(chase.distance + chase.height + 1f),
                "at once behind the truck, not a glide down from the flight's height");

            // and it stays so while the truck drives
            for (int step = 0; step < 6; step++)
            {
                truck.transform.position += new Vector3(30f, 0f, step % 2 == 0 ? 6f : -6f);
                for (int f = 0; f < 240; f++) Frame(chase);
                AssertFirstPerson(chase, cam, truck.transform, $"driving, the truck at x {truck.transform.position.x:F0}");
            }
        }
        finally { Object.DestroyImmediate(go); Object.DestroyImmediate(truck); }
    }

    [Test]
    public void RollOutFromTheOverviewOrAfterASwipeIsFirstPersonToo()
    {
        var truck = new GameObject("truck");
        var go = new GameObject("chase");
        try
        {
            truck.transform.position = new Vector3(-100.4f, 0.5f, -3.4f);
            truck.transform.rotation = Quaternion.Euler(0f, 90f, 0f);
            var cam = go.AddComponent<Camera>();
            cam.aspect = 390f / 844f;
            var chase = go.AddComponent<ChaseCamera>();
            chase.target = truck.transform;
            chase.destination = Gate;

            // the overview on, then ROLL OUT: back behind the truck when it closes
            chase.Toggle();
            Assert.AreEqual(ChaseCamera.Mode.God, chase.View);
            chase.EndFlyIn();
            chase.Toggle();
            for (int f = 0; f < 240; f++) Frame(chase);
            AssertFirstPerson(chase, cam, truck.transform, "the overview closed after roll out");

            // a swipe, then the next ROLL OUT: behind the truck again, the look dropped
            chase.useExternalPointer = true;
            var from = new Vector3(Screen.width * 0.25f, Screen.height * 0.6f, 0f);
            chase.externalPointerHeld = true; chase.externalPointerAt = from; Frame(chase);
            for (int i = 1; i <= 10; i++) { chase.externalPointerAt = from + Vector3.right * (Screen.width * 0.05f * i); Frame(chase); }
            chase.externalPointerHeld = false; Frame(chase);
            chase.EndFlyIn();
            Assert.AreEqual(0f, chase.OrbitYaw, 0.001f, "ROLL OUT drops the look-around");
            AssertFirstPerson(chase, cam, truck.transform, "the next roll out");
        }
        finally { Object.DestroyImmediate(go); Object.DestroyImmediate(truck); }
    }
}
