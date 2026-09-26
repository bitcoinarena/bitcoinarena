using NUnit.Framework;
using UnityEngine;

/// <summary>
/// THE DRIVE STARTS BEHIND THE TRUCK (the owner 2026-09-26 14:08, "on drive start the camera goes top-down"). PLAY starts a
/// 4.2 s fly-in from 52 m over the field, looking west at the post office, and the cargo panel did not stop it. ROLL OUT
/// ends it: the camera is at the follow's rest behind the truck at once, not gliding down from the flight's height.
/// </summary>
public class RollOutEndsFlyInTests
{
    [Test]
    public void EndFlyInStopsTheFlightAndSitsBehindTheTruck()
    {
        var truck = new GameObject("truck");
        var cam = new GameObject("chase");
        try
        {
            truck.transform.position = new Vector3(-100.4f, 0.5f, -3.4f);
            truck.transform.rotation = Quaternion.Euler(0f, 90f, 0f);            // east, towards the miner
            var chase = cam.AddComponent<ChaseCamera>();
            chase.target = truck.transform;

            chase.FlyIn(new Vector3(0f, 52f, 0f), new Vector3(-114f, 20f, 0f), 4.2f);
            Assert.IsTrue(chase.Flying, "PLAY's flight is running under the cargo panel");

            chase.EndFlyIn();
            Assert.IsFalse(chase.Flying, "ROLL OUT ends it");
            var rest = truck.transform.position + Vector3.left * chase.distance + Vector3.up * chase.height;
            Assert.That(Vector3.Distance(cam.transform.position, rest), Is.LessThan(0.01f),
                $"9 m behind and 4.2 m above the truck, not over the field: at {cam.transform.position}");
            Assert.That(Vector3.Angle(Vector3.ProjectOnPlane(cam.transform.forward, Vector3.up), Vector3.right), Is.LessThan(0.5f),
                "looking east down the road, where the miner is");
            Assert.That(cam.transform.forward.y, Is.LessThan(0f).And.GreaterThan(-0.6f), "down at the road ahead, not straight down");
        }
        finally { Object.DestroyImmediate(cam); Object.DestroyImmediate(truck); }
    }
}
