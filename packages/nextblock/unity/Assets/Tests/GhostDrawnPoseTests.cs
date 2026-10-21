// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Arena;

/// <summary>
/// THE BODY THAT IS DRAWN, AGAINST THE TWELVE INTS IT WAS DRAWN FROM.
///
/// Letter 36's two-Chrome retests failed with the chip saying five players and
/// one truck on the screen. Everything up to C# is now measured without a
/// browser: the daemon's replay, the socket, the page's field, and - since
/// `two-tabs.test.js` learned to call the SHIPPED `ArenaNextGhost` - the twelve
/// ints themselves, field for field. `GhostField` is in no scene; `Bootstrap`
/// builds it, and the strings prove that wiring is inside the player that
/// shipped.
///
/// What was never measured is the last step: where the BODY ends up. A truck
/// drawn at its ints and a truck drawn nowhere look the same through a
/// windscreen, and so does a truck drawn correctly 156 m down the apron - 24
/// doors at 6.8 m, one per player seed, since 20c3950.
///
/// So this drives the real `Bootstrap` field with the real pictures a real
/// driver produced over a real 2-of-2 round (`live-drive-ghosts.txt`, written
/// by `two-tabs.test.js` from the shipped bridge), through `Source` - the same
/// door `FromBridge` comes in by - and reads the transform off the drawn
/// object. Nothing here invents a pose.
/// </summary>
public class GhostDrawnPoseTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    const float ONE = 65536f;

    static int[][] Frames()
    {
        var path = Path.Combine(Application.dataPath, "Tests", "Fixtures", "live-drive-ghosts.txt");
        Assert.IsTrue(File.Exists(path), "the live-drive pictures are missing: " + path);
        var frames = File.ReadAllLines(path)
            .Where(l => l.Length > 0 && !l.StartsWith("#"))
            .Select(l => l.Split(' ').Select(int.Parse).ToArray())
            .ToArray();
        Assert.GreaterOrEqual(frames.Length, 4, "the capture is too short to show a truck moving");
        return frames;
    }

    /// <summary>Every drawn ghost has arrived on the picture it was last given.</summary>
    static bool Settled(GhostField field)
    {
        foreach (var g in field.GetComponentsInChildren<GhostTruck>(true))
            if (!g.Settled) return false;
        return true;
    }

    static GhostPicture Picture(int[] w)
    {
        var entry = new System.Text.StringBuilder(64);
        for (var i = 0; i < 8; i++) entry.Append(w[i].ToString("x8"));
        return new GhostPicture(entry.ToString(), w[8], w[9], w[10], w[11]);
    }

    /// <summary>
    /// EVERY PICTURE, PUT WHERE ITS OWN INTS SAY, BY `Update` AND NOT BY HAND.
    ///
    /// `Show` is called by nobody in a player: `Update` calls `Draw(PerFrame)`,
    /// which pulls from `Source` - the bridge in a page, this capture here. So
    /// the frames are fed one per rendered frame and the pose is read back
    /// after the frame, which is the only order that proves the renderer ran.
    /// </summary>
    [UnityTest]
    public IEnumerator TheDrawnTruckIsWhereItsIntsPutIt()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;
        yield return null;

        var field = Object.FindFirstObjectByType<GhostField>();
        Assert.IsNotNull(field, "the player builds no ghost field, so no other truck is ever drawn");
        Assert.IsTrue(field.isActiveAndEnabled, "the field is off, so its Update never runs");
        Assert.IsNotNull(field.Model, "the field has no body to draw a ghost with");

        // LET THE GROUND ARRIVE BEFORE ANY PICTURE IS DRAWN. The terrain is
        // streamed and the rest a ghost is given is sampled from it at the
        // moment it is shown - so a picture drawn while the relief is still
        // loading is held against a ground that has since moved. Measured: the
        // first frames put the local truck 3.4 m below where it settles.
        for (var settle = 0; settle < 60; settle++) yield return null;

        var frames = Frames();
        // ONE PICTURE PER FRAME, WHICH IS WHAT A PAGE HOLDS.
        //
        // `Update` calls `Draw(PerFrame)` and PerFrame is 24, so a source that
        // holds the whole capture is drained in the FIRST frame and every
        // assertion below then reads the LAST pose - which is what this test
        // did when it was first written, and it read as the renderer putting
        // the truck a metre from where its ints said. The bridge holds what
        // arrived since the last frame; the pictures are 5 Hz and the frames
        // are not, so that is one or none. `handed` is what makes it one.
        var next = 0;
        var handed = false;
        field.Source = () =>
        {
            if (handed || next >= frames.Length) return (GhostPicture?)null;
            handed = true;
            return Picture(frames[next++]);
        };

        var driver = Object.FindFirstObjectByType<CoreDrivenTruck>();
        Assert.IsNotNull(driver, "the world has no core-driven truck to take a surface from");

        GhostTruck ghost = null;
        var seen = 0;
        var poses = new List<Vector3>();
        foreach (var w in frames)
        {
            var want = Picture(w);
            // ONE FRAME. `Update` runs, `Draw(PerFrame)` pulls one - the source
            // answers null to its second call - and `Show` places it.
            handed = false;
            yield return null;
            seen++;
            Assert.AreEqual(seen, next, $"frame {seen} did not take exactly one picture");

            // AND THEN THE FRAMES BETWEEN PICTURES. `ArenaNet.BatchEvery` is a
            // tenth of a second and a page draws sixty times a second, so a
            // ghost that only moved when a picture landed would stand still
            // for six frames and jump. It eases onto the newest picture and
            // stops there, so what is asserted below is the SETTLED pose - the
            // same millimetre as before, read when the truck has arrived
            // rather than while it is still on its way.
            for (var f = 0; f < 600 && !Settled(field); f++) yield return null;

            ghost = field.GetComponentInChildren<GhostTruck>(true);
            Assert.IsNotNull(ghost, $"nothing was drawn for picture {seen}");
            Assert.AreEqual(1, field.Trucks, "one entry was drawn as more than one truck");
            // AND IT IS IN THE SCENE. A template is kept inactive so it is not
            // itself drawn, and a clone inherits that: a ghost nobody activates
            // is at the right place and on nobody's screen, which is the same
            // as no ghost at all. `enabled` on the renderer does not say this.
            Assert.IsTrue(ghost.gameObject.activeInHierarchy,
                $"the truck drawn for picture {seen} is not active, so nobody sees it");

            var at = ghost.transform.position;
            var facing = ghost.transform.rotation.eulerAngles.y;
            var wantX = want.X / ONE;
            var wantZ = want.Z / ONE;
            var wantY = driver.RideAt(wantX, wantZ, ArenaCore.Degrees(want.Heading));
            var wantFacing = ArenaCore.Degrees(want.Heading);
            TestContext.WriteLine(
                $"tick {want.Tick,4}  ints x {want.X,9} z {want.Z,9} h {want.Heading,6}"
                + $"  ->  drawn ({at.x,8:F3}, {at.y,7:F3}, {at.z,8:F3}) facing {facing,7:F3} deg"
                + $"  wanted ({wantX,8:F3}, {wantY,7:F3}, {wantZ,8:F3}) facing {wantFacing,7:F3}");

            Assert.AreEqual(wantX, at.x, 0.001f, "the drawn truck is not at the x its ints name");
            Assert.AreEqual(wantZ, at.z, 0.001f, "the drawn truck is not at the z its ints name");
            Assert.AreEqual(wantY, at.y, 0.05f, "the drawn truck is not standing on the ground");
            Assert.AreEqual(0f, Mathf.DeltaAngle(wantFacing, facing), 0.01f,
                "the drawn truck faces somewhere its ints never pointed");
            poses.Add(at);
        }

        Assert.AreEqual(frames.Length, seen, "not every picture was drawn");

        // AND IT IS AN EASE, NOT A SNAP. One more picture, read one frame in:
        // a ghost that jumped would already be on it, and a ghost that never
        // moved would still be behind it. Neither is what a live truck looks
        // like.
        var moving = field.GetComponentInChildren<GhostTruck>(true);
        var wasAt = moving.transform.position;
        var wasFacing = moving.transform.rotation.eulerAngles.y;
        var jump = frames[frames.Length - 1].ToArray();
        jump[8] += Mathf.RoundToInt(6f * ONE);          // six metres down the map
        jump[10] += Mathf.RoundToInt(ONE / 8f);         // and a forty-five degree turn with it
        next = frames.Length;                            // the source is spent
        field.Show(Picture(jump));
        yield return null;
        var oneFrameIn = moving.transform.position;
        var target = new Vector3(jump[8] / ONE, moving.Wanted.y, jump[9] / ONE);
        TestContext.WriteLine($"one frame after a 6 m picture the ghost has moved "
                              + $"{Vector3.Distance(wasAt, oneFrameIn):F3} m of "
                              + $"{Vector3.Distance(wasAt, target):F3} m");
        // AND IT STANDS ON THE PICTURE THAT LANDED, IN THAT FRAME (2026-09-18 05:10). It used to walk there over a
        // whole interval and so was still on the picture before it when the next one arrived: measured against the wire,
        // the picture was 22 ms old at the median while the drawn pose was 322 ms. The PLACE is the newest picture's at
        // once; what is walked round is the hull's facing, which is not a place.
        Assert.Greater(Vector3.Distance(wasAt, oneFrameIn), 0.001f,
            "the ghost did not move at all on the frame after a new picture");
        Assert.Less(Vector3.Distance(oneFrameIn, target), 0.001f,
            "the ghost is not standing on the picture that landed: it is still walking to it");
        // AND POINTING THE WAY IT SAYS, IN THE SAME FRAME (2026-09-18 05:45). The place bound here first and the
        // facing was still turned from the pose before it over one ease, so the hull carried the whole-interval lag the
        // place had just lost: measured on the Daily against the same land-frame clock over 5813 pictures, the place
        // was 38 ms old at the median and the facing 138 ms, p90 52 against 156, 32 places over 300 ms against 67 facings.
        var facingOneFrameIn = moving.transform.rotation.eulerAngles.y;
        var wantedFacing = ArenaCore.Degrees(jump[10]);
        TestContext.WriteLine($"one frame after a 45 deg picture the ghost points {facingOneFrameIn:F3} deg, "
                              + $"from {wasFacing:F3}, wanted {wantedFacing:F3}");
        Assert.AreEqual(0f, Mathf.DeltaAngle(wantedFacing, facingOneFrameIn), 0.01f,
            "the ghost is not pointing the way the picture that landed says: it is still turning to it");
        for (var f = 0; f < 600 && !Settled(field); f++) yield return null;
        Assert.Less(Vector3.Distance(moving.transform.position, target), 0.001f,
            "the ghost never arrived on the picture it was given");
        ghost = moving;

        // ACROSS THE GROUND, not through the air: the first frame is drawn
        // before the terrain has settled under it, so a truck that never left
        // its door still gains three metres of height between picture one and
        // picture two. Following is an x/z fact.
        var first = new Vector2(poses[0].x, poses[0].z);
        var last = new Vector2(poses[poses.Count - 1].x, poses[poses.Count - 1].z);
        TestContext.WriteLine($"the capture moves {Vector2.Distance(first, last):F3} m across the ground");
        Assert.Greater(Vector2.Distance(first, last), 0.5f,
            "the capture never moves across the ground, so nothing here proves the truck follows");

        // AND THE BODY IS THE THING THAT MOVED, not an empty transform with the
        // model left standing at the origin. `Model` is a template with a
        // renderer; a clone whose renderer is somewhere else is invisible where
        // the ints say and visible where they do not.
        var renderer = ghost.GetComponentInChildren<Renderer>(true);
        Assert.IsNotNull(renderer, "the drawn truck has nothing to draw with");
        Assert.IsTrue(renderer.enabled, "the drawn truck's renderer is off");
        var body = renderer.bounds.center;
        TestContext.WriteLine($"renderer bounds centre ({body.x:F3}, {body.y:F3}, {body.z:F3}), "
                              + $"size {renderer.bounds.size}, root at {ghost.transform.position}");
        Assert.AreEqual(ghost.transform.position.x, body.x, 1.5f,
            "the body that is drawn is not at the transform the ints moved");
        Assert.AreEqual(ghost.transform.position.z, body.z, 4.0f,
            "the body that is drawn is not at the transform the ints moved");
    }

    /// <summary>
    /// ONE FRAME FOR BOTH TRUCKS, WHICH IS WHAT 17:05 WAS ABOUT.
    ///
    /// The test above proves a ghost is drawn at the numbers it was given. It
    /// cannot prove those numbers mean the same thing as the local truck's,
    /// and that is exactly the gap the 17:05 photograph fell through: one tab
    /// drew the other truck on the grass at -69,-57 m while that truck stood
    /// on its yellow bay. The cause was upstream - the page seeded its core
    /// with a constant while the committee replayed the entry with the round's
    /// own seed, so the two trucks were in different WORLDS - and the C# side
    /// still owes a guarantee it never gave: a pose is a pose.
    ///
    /// So this takes the LOCAL truck's own core pose, hands it to the field as
    /// somebody else's picture, and requires the ghost to be drawn where the
    /// local truck is drawn. A viewer-bay origin, a publisher-bay origin, a
    /// PhysX position read instead of a core one, a metre that is not 1/65536:
    /// every one of those puts the two apart, and none of them can hide here.
    /// </summary>
    [UnityTest]
    public IEnumerator AGhostAtTheLocalTrucksOwnPoseIsDrawnWhereTheLocalTruckIs()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;
        yield return null;

        var field = Object.FindFirstObjectByType<GhostField>();
        var driver = Object.FindFirstObjectByType<CoreDrivenTruck>();
        Assert.IsNotNull(field, "the player builds no ghost field");
        Assert.IsNotNull(driver, "the world has no local truck to compare against");

        // LET THE GROUND ARRIVE FIRST. The terrain is streamed and the local
        // truck settles onto it over the first frames - measured in the
        // capture test above, its height moves 3.4 m between picture one and
        // picture two. Comparing before that is comparing two different
        // grounds, which is a fact about the harness and not about the frame
        // both trucks are drawn in.
        for (var settle = 0; settle < 30; settle++) yield return null;

        // THE LOCAL TRUCK'S OWN PLACE, in the words a picture carries. Read off
        // the transform it is actually drawn at, so nothing here assumes which
        // number the renderer used.
        var me = driver.transform.position;
        var mine = new GhostPicture(
            new string('a', 64),
            Mathf.RoundToInt(me.x * ONE), Mathf.RoundToInt(me.z * ONE),
            Mathf.RoundToInt(driver.transform.rotation.eulerAngles.y / 360f * ONE), 7);

        field.Source = () => (GhostPicture?)null;
        field.Show(mine);
        yield return null;
        // AND READ THE LOCAL TRUCK AGAIN ON THE SAME FRAME the ghost was drawn
        // on. One frame of settling in between would be a difference nobody
        // could act on.
        me = driver.transform.position;

        var ghost = field.GetComponentInChildren<GhostTruck>(true);
        Assert.IsNotNull(ghost, "no truck was drawn for the other identity");
        var them = ghost.transform.position;
        TestContext.WriteLine(
            $"local truck drawn at ({me.x:F3}, {me.y:F3}, {me.z:F3}); a ghost at the same core "
            + $"pose drawn at ({them.x:F3}, {them.y:F3}, {them.z:F3})");

        Assert.AreEqual(me.x, them.x, 0.001f,
            "a ghost at the local truck's own x is not drawn at the local truck's x");
        Assert.AreEqual(me.z, them.z, 0.001f,
            "a ghost at the local truck's own z is not drawn at the local truck's z");

        // AND THE HEIGHT IS THE PAGE'S OWN RESTING RULE AT THAT POSE, which is
        // not the same claim as "the same y as the local truck" - and the
        // difference is the Editor, not the code. There is no core here, so
        // `Driving` is false and PhysX places the local truck; its y is a
        // physics result and owes the core's rule nothing. What CAN be checked,
        // and is what a ghost gets wrong when it gets it wrong, is that the
        // picture is resting by the same function the core-driven truck is
        // resting by: a y of zero, a single sample under the middle, or a body
        // offset dropped all fail here.
        Assert.IsFalse(driver.Driving,
            "the core is driving in the Editor, so this test is comparing something else");
        var want = driver.RideAt(me.x, me.z, driver.transform.rotation.eulerAngles.y);
        Assert.AreEqual(want, them.y, 0.001f,
            "a ghost is not resting by the rule this page rests a truck with");
    }

    /// <summary>
    /// AND WHETHER THE PLAYER IS LOOKING AT IT.
    ///
    /// This is the other half of the 11:51 report, and it is a different fault
    /// with a different fix: a truck drawn exactly where its ints say, 60 m
    /// down the frontage, is off screen for a watcher parked at their own door.
    /// The numbers are printed either way, so the two Chromes have something to
    /// be held against instead of an impression.
    /// </summary>
    [UnityTest]
    public IEnumerator TheDrawnTruckIsMeasuredAgainstWhereThePlayerIsLooking()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;
        yield return null;

        var field = Object.FindFirstObjectByType<GhostField>();
        Assert.IsNotNull(field, "the player builds no ghost field");
        var last = Picture(Frames().Last());
        field.Show(last);
        var ghost = field.GetComponentInChildren<GhostTruck>(true);
        Assert.IsNotNull(ghost, "no truck was drawn for the other identity");
        yield return null;

        var driver = Object.FindFirstObjectByType<CoreDrivenTruck>();
        var cam = Object.FindFirstObjectByType<ChaseCamera>();
        Assert.IsNotNull(driver, "the world has no local truck");
        Assert.IsNotNull(cam, "the player has no chase camera");
        var eye = cam.GetComponent<Camera>();
        Assert.IsNotNull(eye, "the chase camera carries no Camera");

        var me = driver.transform.position;
        var them = ghost.transform.position;
        var apart = Vector3.Distance(me, them);
        var renderer = ghost.GetComponentInChildren<Renderer>(true);
        var planes = GeometryUtility.CalculateFrustumPlanes(eye);
        var framed = GeometryUtility.TestPlanesAABB(planes, renderer.bounds);
        TestContext.WriteLine(
            $"local truck at ({me.x:F2}, {me.z:F2}), other truck at ({them.x:F2}, {them.z:F2}), "
            + $"{apart:F1} m apart; camera at ({eye.transform.position.x:F2}, "
            + $"{eye.transform.position.z:F2}) looking {eye.transform.forward}; "
            + $"in frustum: {framed}");

        // WHAT IS PINNED is the number, not the answer: how far apart two doors
        // put two trucks is the round's business, and a test that demanded they
        // be close would be demanding the bays go away.
        Assert.Greater(apart, 0f, "the two trucks are at the same place, so the bays did nothing");
        Assert.IsTrue(renderer.enabled, "the other truck's renderer is off, so framing is moot");
    }
}
