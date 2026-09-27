using System.Reflection;
using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE DRIVE STARTS TOP-DOWN, THE DESTINATION IN FRAME (the owner 2026-09-26 14:08, "on drive start the camera goes
/// top-down"; 2026-09-27 11:31, "The destination stays in focus unless he swipes away himself"). PLAY starts a 4.2 s
/// fly-in from 52 m over the field, and ROLL OUT ends it: the camera is at once over the truck, looking steeply down,
/// with the truck and the miner's gate both inside the frame - on a phone held upright and on a desktop - and it keeps
/// them there as the truck drives. A swipe hands the view over: the gate is no longer held while he looks. (That the look
/// then comes back is CameraNoseTests' in PlayMode, where the clock runs.)
/// </summary>
public class RollOutEndsFlyInTests
{
    static readonly Vector3 Gate = new Vector3(108f, 0.5f, -3.4f);          // the miner's doorway, east

    static void Frame(ChaseCamera chase)
    {
        typeof(ChaseCamera).GetMethod("LateUpdate", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(chase, null);
    }

    static void AssertInFrame(Camera cam, Vector3 p, string what)
    {
        var v = cam.WorldToViewportPoint(p);
        Assert.That(v.z, Is.GreaterThan(0f), $"{what} is in front of the camera: {v}");
        Assert.That(v.x, Is.InRange(0.02f, 0.98f), $"{what} is inside the frame, across: {v}");
        Assert.That(v.y, Is.InRange(0.02f, 0.98f), $"{what} is inside the frame, up and down: {v}");
    }

    [TestCase(390f / 844f, TestName = "phone upright")]
    [TestCase(1280f / 720f, TestName = "desktop")]
    public void RollOutGoesTopDownWithTheTruckAndTheGateInFrame(float aspect)
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

            chase.destination = Gate;
            chase.EndFlyIn();
            Assert.IsFalse(chase.Flying, "ROLL OUT ends it");
            Assert.AreEqual(ChaseCamera.Mode.Overhead, chase.View, "the drive view is the top-down");
            Assert.IsTrue(chase.DestinationInFocus);
            Assert.That(go.transform.forward.y, Is.LessThan(-0.9f), $"looking steeply down, not along the road: {go.transform.forward}");
            AssertInFrame(cam, truck.transform.position, "the truck at roll out");
            AssertInFrame(cam, Gate, "the miner's gate at roll out");
            // clear of the pads along the bottom: a quarter of the way up, the gate high above it
            Assert.That(cam.WorldToViewportPoint(truck.transform.position).y, Is.EqualTo(0.25f).Within(0.02f), "the truck a quarter up the screen");
            Assert.That(cam.WorldToViewportPoint(Gate).y, Is.EqualTo(0.85f).Within(0.02f), "the gate near the top");

            // and it stays so while the truck drives there
            for (int step = 0; step < 6; step++)
            {
                truck.transform.position += new Vector3(30f, 0f, step % 2 == 0 ? 6f : -6f);
                for (int f = 0; f < 240; f++) Frame(chase);
                AssertInFrame(cam, truck.transform.position, $"the truck at x {truck.transform.position.x:F0}");
                AssertInFrame(cam, Gate, $"the gate with the truck at x {truck.transform.position.x:F0}");
            }
        }
        finally { Object.DestroyImmediate(go); Object.DestroyImmediate(truck); }
    }

    [Test]
    public void ASwipeTakesTheViewAndTheNextRollOutHoldsTheGateAgain()
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
            chase.EndFlyIn();
            Assert.IsTrue(chase.DestinationInFocus);

            // a drag across half the screen, off the pads
            chase.useExternalPointer = true;
            var from = new Vector3(Screen.width * 0.25f, Screen.height * 0.6f, 0f);
            chase.externalPointerHeld = true; chase.externalPointerAt = from; Frame(chase);
            for (int i = 1; i <= 10; i++) { chase.externalPointerAt = from + Vector3.right * (Screen.width * 0.05f * i); Frame(chase); }
            chase.externalPointerHeld = false; Frame(chase);
            Assert.IsFalse(chase.DestinationInFocus, "he swiped away himself");
            float yaw = chase.OrbitYaw;
            Assert.That(Mathf.Abs(yaw), Is.GreaterThan(20f), $"the drag turned the view: {yaw}");

            for (int f = 0; f < 60; f++) Frame(chase);
            AssertInFrame(cam, truck.transform.position, "the truck is what the view follows while he looks");

            // the next drive starts top-down on the gate again
            chase.EndFlyIn();
            Assert.IsTrue(chase.DestinationInFocus, "a new ROLL OUT holds the gate again");
        }
        finally { Object.DestroyImmediate(go); Object.DestroyImmediate(truck); }
    }

    [Test]
    public void TheOverviewToggleComesBackToTheTopDown()
    {
        var truck = new GameObject("truck");
        var go = new GameObject("chase");
        try
        {
            go.AddComponent<Camera>();
            var chase = go.AddComponent<ChaseCamera>();
            chase.target = truck.transform;
            chase.destination = Gate;
            chase.EndFlyIn();
            chase.Toggle();
            Assert.AreEqual(ChaseCamera.Mode.God, chase.View);
            chase.Toggle();
            Assert.AreEqual(ChaseCamera.Mode.Overhead, chase.View);
        }
        finally { Object.DestroyImmediate(go); Object.DestroyImmediate(truck); }
    }
}
