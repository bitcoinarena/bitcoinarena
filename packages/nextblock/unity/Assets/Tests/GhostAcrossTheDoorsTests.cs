// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;
using Arena;

/// <summary>
/// CAN THE PLAYER SEE THE OTHER TRUCK AT ALL - FROM THEIR OWN CAMERA, AT THE DOORS THE PROTOCOL PARKS THEM AT.
///
/// 2026-09-17 19:15 and again 05:45: two tabs should see each other. Every number measured on that letter so
/// far says WHEN a picture is drawn - the pose at the land frame is 38 ms old at the median on the Daily, and the
/// facing with it. None of them says the two trucks are in ONE FRAME, and an empty apron is what the 19:15 screenshot
/// shows.
///
/// The protocol parks one player per door: `rng.js` gives 24 doors, `sim.js` a 6.8 m pitch, and a bay per seed, so two
/// independent seats are a mean 54 m apart along the frontage and up to 156 m. `GhostOnScreenTests` cannot answer this
/// - it builds its own camera and points it AT the ghost, which proves the truck is drawable. This uses the camera the
/// player actually has, looking where it actually looks, and asks two things a player would ask: is the body in the
/// frustum, and does the label land on the screen.
///
/// IT MEASURES AND PRINTS. What is asserted is only what must be true for the measurement to mean anything - that the
/// player has a camera, and that a truck at the player's OWN door is framed. Which of the other 23 doors are framed is
/// the number this exists to produce, not a rule this file decides.
/// </summary>
public class GhostAcrossTheDoorsTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    const float ONE = 65536f;

    [UnityTest]
    public IEnumerator HowManyOfTheTwentyFourDoorsThePlayersOwnCameraFrames()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;
        yield return null;

        var field = Object.FindFirstObjectByType<GhostField>();
        var driver = Object.FindFirstObjectByType<CoreDrivenTruck>();
        var chase = Object.FindFirstObjectByType<ChaseCamera>();
        var post = Object.FindFirstObjectByType<PostOffice>();
        Assert.IsNotNull(field, "the player builds no ghost field");
        Assert.IsNotNull(driver, "the world has no local truck");
        Assert.IsNotNull(chase, "the player has no chase camera, so there is nothing to be seen from");
        Assert.IsNotNull(post, "the world has no post office, so there are no doors to park at");
        var eye = chase.GetComponent<Camera>();
        Assert.IsNotNull(eye, "the chase camera carries no Camera");

        // THE GROUND AND THE CAMERA FIRST. The terrain is streamed and the chase camera swings in behind the truck over
        // the first frames; measuring before either has settled measures the harness.
        //
        // AND IT MUST BE THE DRIVING CAMERA. `SpectatorCamera` lives on the same object and can switch the chase
        // behaviour off and take over the view - which is what happened the first time this ran: the camera sat 130 m
        // away looking 88 per cent straight down, and an overview like that frames all 24 doors and proves nothing
        // about what a player driving sees. So the free camera is switched off here, and the pose is CHECKED below
        // rather than assumed: 9 m behind and 4.2 m up is what `ChaseCamera` settles to.
        foreach (var spec in Object.FindObjectsByType<SpectatorCamera>(FindObjectsSortMode.None)) spec.enabled = false;
        chase.enabled = true;
        // AND IT NEEDS THE TRUCK. `Bootstrap.BuildCamera` hands the chase camera the truck in a player; in this harness
        // the camera it finds has no target, and a `ChaseCamera` without one returns out of LateUpdate and sits in the
        // pose it booted in - 221 m out, looking 88 per cent down, which framed all 24 doors and meant nothing. Handing
        // it the truck is handing it what a player's camera has; where it then puts itself is its own rule.
        if (chase.target == null)
        {
            chase.target = driver.transform;
            var body = driver.GetComponent<Rigidbody>();
            if (body != null) chase.targetBody = body;
        }
        // AND IN THE VIEW A PLAYER DRIVES IN. `ChaseCamera` boots in God here - measured: 174 m up, forward
        // (0.01, -0.88, 0.47) - and an overview frames all 24 doors, which is why the first run of this said 24 of 24
        // and meant nothing. `Toggle` is the same call the camera key makes.
        if (chase.View == ChaseCamera.Mode.God) chase.Toggle();
        // AND THE DRIVE VIEW ROLL OUT PUTS UP, BEHIND THE TRUCK (2026-09-29 12:45): the same call LoadoutPanel makes
        var gateForView = Object.FindFirstObjectByType<DeliveryGate>();
        chase.destination = gateForView != null ? gateForView.Mouth : (Vector3?)null;
        chase.EndFlyIn();
        for (var settle = 0; settle < 150; settle++) yield return null;

        // WHICH CAMERA IS WHICH, PRINTED RATHER THAN ASSUMED. Two runs put the eye 221 and 219 m out with the same
        // forward vector, so the next thing to do is not a third guess at the pose: it is to name every camera in the
        // world, say which one `Camera.main` is - `GhostField.OnGUI` draws its labels through that one - and print the
        // chase camera's own state.
        foreach (var c in Object.FindObjectsByType<Camera>(FindObjectsSortMode.None))
            TestContext.WriteLine($"camera '{c.name}' tag {c.tag} depth {c.depth} enabled {c.isActiveAndEnabled} "
                                  + $"at ({c.transform.position.x:F1}, {c.transform.position.y:F1}, {c.transform.position.z:F1}) "
                                  + $"forward {c.transform.forward} {(c == Camera.main ? "<- Camera.main" : "")}"
                                  + $"{(c.gameObject == chase.gameObject ? " <- the chase camera's object" : "")}");
        TestContext.WriteLine($"chase: object '{chase.gameObject.name}', enabled {chase.isActiveAndEnabled}, "
                              + $"view {chase.View}, target {(chase.target == null ? "none" : chase.target.name)}, "
                              + $"at ({chase.transform.position.x:F1}, {chase.transform.position.y:F1}, {chase.transform.position.z:F1})");
        TestContext.WriteLine($"truck '{driver.gameObject.name}' at ({driver.transform.position.x:F1}, "
                              + $"{driver.transform.position.y:F1}, {driver.transform.position.z:F1})");

        var fromTruck = Vector3.Distance(eye.transform.position, driver.transform.position);
        TestContext.WriteLine($"camera {fromTruck:F1} m from the truck, forward {eye.transform.forward}, "
                              + $"fov {eye.fieldOfView:F0}");
        // THE VIEW A PLAYER DRIVES IN IS BEHIND THE TRUCK (2026-09-29 12:45, first person), not the overview and not
        // a top-down: the drive view's mode, looking at this truck - not at the middle of the field
        Assert.AreEqual(ChaseCamera.Mode.Follow, chase.View, "this is not the view a player drives from");
        var truckInView = eye.WorldToViewportPoint(driver.transform.position);
        Assert.IsTrue(truckInView.z > 0f && truckInView.x is > 0f and < 1f && truckInView.y is > 0f and < 1f,
            $"the drive view does not have the truck in it ({fromTruck:F0} m away, at {truckInView})");

        field.Source = () => (GhostPicture?)null;
        var me = driver.transform.position;
        var framed = 0;
        var labelled = 0;
        var checkedDoors = 0;
        var cued = 0;
        var otherDoors = 0;
        var ownDoorFramed = false;
        var ownDoorAtEdge = true;
        TestContext.WriteLine($"the player stands at ({me.x:F1}, {me.z:F1}), camera at "
                              + $"({eye.transform.position.x:F1}, {eye.transform.position.z:F1}) looking {eye.transform.forward}");
        TestContext.WriteLine("door    where            apart     in frame   label on screen   cue");

        for (var bay = 0; bay < PostOffice.SoloBay + 11 && bay < 24; bay++)
        {
            var at = post.BayFor(bay);
            var picture = new GhostPicture(
                new string('b', 64),
                Mathf.RoundToInt(at.x * ONE), Mathf.RoundToInt(at.z * ONE),
                Mathf.RoundToInt(driver.transform.rotation.eulerAngles.y / 360f * ONE), 11);
            field.Show(picture);
            yield return null;

            var ghost = field.GetComponentInChildren<GhostTruck>(true);
            Assert.IsNotNull(ghost, $"no truck was drawn for door {bay}");
            var renderer = ghost.GetComponentInChildren<Renderer>(true);
            Assert.IsNotNull(renderer, "the drawn truck has nothing to draw with");
            var planes = GeometryUtility.CalculateFrustumPlanes(eye);
            var inFrame = GeometryUtility.TestPlanesAABB(planes, renderer.bounds);

            // AND THE LABEL, WHICH IS DRAWN WHERE `GhostField.OnGUI` PUTS IT: over the hull, skipped behind the camera,
            // and clipped by the screen like any other GUI rectangle.
            var p = eye.WorldToScreenPoint(ghost.transform.position + Vector3.up * 3.8f);
            var onScreen = p.z > 0f && p.x > 0f && p.x < Screen.width && p.y > 0f && p.y < Screen.height;

            // AND THE CUE THE PLAYER GETS EITHER WAY (2026-09-18 06:45, the named pick). The two lines are
            // over the hull when the hull is on screen and pinned to the rim of the screen when it is not - the same
            // rule `OnGUI` draws with, asked here as a function so it can be counted.
            var size = Mathf.Max(13, Screen.height / 48);
            var spot = GhostField.SpotFor(eye, ghost.transform.position + Vector3.up * 3.8f,
                                          Screen.width, Screen.height, 160f, size * 3f);
            var onTheScreen = spot.At.x >= 0f && spot.At.x <= Screen.width
                              && spot.At.y >= 0f && spot.At.y <= Screen.height;

            var apart = Vector3.Distance(driver.transform.position, ghost.transform.position);
            TestContext.WriteLine($"{bay,4}    ({at.x,7:F1}, {at.z,7:F1})  {apart,6:F1} m   "
                                  + $"{(inFrame ? "yes" : "no "),-9}  {(onScreen ? "yes" : "no "),-16}  "
                                  + $"{(onTheScreen ? (spot.AtEdge ? "edge marker" : "on the hull") : "NONE")} "
                                  + $"at ({spot.At.x:F0}, {spot.At.y:F0})");
            checkedDoors++;
            if (inFrame) framed++;
            if (onScreen) labelled++;
            if (onTheScreen) cued++;
            if (apart >= 3f) otherDoors++;
            if (apart < 3f) { ownDoorFramed = inFrame; ownDoorAtEdge = spot.AtEdge; }
        }

        TestContext.WriteLine($"of {checkedDoors} doors the player's own camera frames {framed} "
                              + $"and puts a label on screen for {labelled}; every door with a cue: {cued} of {checkedDoors} "
                              + $"({otherDoors} of them not the player's own)");
        Assert.Greater(checkedDoors, 0, "no door was measured");
        Assert.IsTrue(ownDoorFramed, "the player cannot even see a truck at their own door, so nothing here measures doors");

        // EVERY OTHER DOOR IS FINDABLE. Three of the 24 are in frame; the rest were nothing at all before the marker,
        // and a player cannot be asked to hunt for the truck they are supposed to be racing.
        Assert.AreEqual(checkedDoors, cued,
            $"only {cued} of {checkedDoors} doors give the player any cue, so a truck at one of the others is invisible");
        Assert.AreEqual(23, otherDoors, "the table did not measure the other 23 doors");
        // AND ONE TRUCK IS ONE LABEL: a hull on screen is named over the hull, not a second time at the rim.
        Assert.IsFalse(ownDoorAtEdge, "a truck standing in front of the player was marked at the edge as well");
    }

    /// <summary>
    /// AND THE LABEL IS DRAWN THROUGH THE CAMERA THAT RENDERS, NOT THROUGH A TAG NOBODY SETS.
    ///
    /// `GhostField.OnGUI` returned on a null `Camera.main`, and `Camera.main` is the first camera tagged MainCamera -
    /// which nothing in this build is: `Bootstrap` makes the chase camera in code and never sets the tag.
    /// `StrikeTheatre` had already found and written this down twice for its own distances. So the debug overlay - the
    /// name and the age over each truck, the one number a player has for the lag (2026-09-17 19:15) - drew
    /// nothing in a player, while every Editor test that makes its own camera saw it.
    ///
    /// This measures the world `Bootstrap` actually builds: no tagged camera, and a label eye all the same.
    /// </summary>
    [UnityTest]
    public IEnumerator TheLabelEyeIsTheCameraThatRendersAndNotATagNobodySets()
    {
        new GameObject("Bootstrap").AddComponent<Bootstrap>();
        yield return null;
        yield return null;
        for (var settle = 0; settle < 60; settle++) yield return null;

        var tagged = 0;
        foreach (var c in Object.FindObjectsByType<Camera>(FindObjectsSortMode.None))
            if (c.CompareTag("MainCamera")) tagged++;
        TestContext.WriteLine($"cameras in the player's world: {Camera.allCamerasCount}, tagged MainCamera: {tagged}, "
                              + $"Camera.main: {(Camera.main == null ? "null" : Camera.main.name)}, "
                              + $"label eye: {(GhostField.LabelEye() == null ? "null" : GhostField.LabelEye().name)}");

        // WHAT IS PINNED is that the overlay has an eye, not that the tag is missing: tagging a camera later is a fix
        // this must not then call a failure.
        Assert.IsNotNull(GhostField.LabelEye(),
            "the ghost labels have no camera to be drawn through, so nothing is drawn over any truck");
        if (Camera.main == null)
            Assert.AreEqual(0, tagged, "Camera.main is null although a camera is tagged, so this measures something else");

        // AND IT IS NOT THE YARD CAMERA. `PackageYard` builds one 2000 m under the map that culls everything but the
        // yard layer, and turns it on whenever the loadout panel is open. It is a second enabled camera, so "the first
        // enabled camera" could be it - and then every label and rim marker would be placed from under the map for as
        // long as the panel was open. A camera that culls the truck's layer cannot be the eye it is labelled through.
        var yard = Object.FindFirstObjectByType<PackageYard>();
        Camera yardCam = null;
        foreach (var c in Object.FindObjectsByType<Camera>(FindObjectsSortMode.None))
            if (c.name == "YardCamera") yardCam = c;
        if (yardCam != null)
        {
            yardCam.enabled = true;
            yield return null;
            var eye = GhostField.LabelEye(0);
            TestContext.WriteLine($"with the yard camera on ({yardCam.transform.position.y:F0} m, mask "
                                  + $"{yardCam.cullingMask}), the label eye is "
                                  + $"{(eye == null ? "null" : eye.name)} at {(eye == null ? Vector3.zero : eye.transform.position)}");
            Assert.IsNotNull(eye, "the loadout panel took the ghost labels' camera away");
            Assert.AreNotEqual(yardCam, eye,
                "the ghost labels are being placed from the yard camera, 2000 m under the map");
            yardCam.enabled = false;
        }
        else TestContext.WriteLine("no yard camera in this world, so the second-camera case is not measured here");
        Assert.IsNotNull(yard, "the player's world has no package yard, so the panel camera was never built");
    }
}
