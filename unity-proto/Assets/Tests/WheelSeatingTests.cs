using System.Collections;
using Blwp;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// THE TYRE SITS ON THE ROAD, AND THE BOX AROUND IT LIES.
///
/// The browser probe reported a wheel 0.12-0.21 m into the road while
/// driving, and 0.000 standing at the depot. Both numbers came from
/// `ground - Renderer.bounds.min.y`, and `bounds` is axis-aligned in WORLD
/// space: a spinning wheel is reported inside a taller box every frame
/// without one vertex having moved. Measured on the daily, thirteen driving
/// samples: the box's half-height ran 0.539..0.763 m against a seated radius
/// of 0.523 m, and the "bury" ran 0.016..0.240 m - equal to `half-height -
/// 0.523` to within a millimetre in every one of them, while the mesh's own
/// local extents never left 0.415, 0.680, 0.680. The bury WAS the box.
///
/// So this fixture pins the two apart, over rounds, because the report was
/// "worse after round 1 or 2": between rounds the streamed wheels are thrown
/// away and re-instantiated and `CollectWheels` runs again, and a re-collect
/// that came back with a different radius or a different hub is the one thing
/// that could make round three sit lower than round one.
///
/// It measures the REAL streamed wheel. `SmallTruck_Tyre_B_L` and its three
/// siblings do arrive in a batchmode editor, which means the model the
/// browser was photographing is the model under test here. What cannot be
/// done in either place is read its vertices - `isReadable` is false on a
/// streamed mesh and turning Read/Write on was ruled out - so the reading is
/// `WheelSeating.Tyre`, the mesh's CENTRE against the height it is seated at.
/// That is exact rather than approximate for a wheel whose two cross-axle
/// extents are equal, which the log says this one's are: 0.680 and 0.680.
///
/// PlayMode, and the seating is driven directly, for the same reason
/// `MushroomSeatingTests` drives the cloud: `PoseWheels` only runs while the
/// core is driving, and in an editor `BlwpCore` is a stub that will never
/// drive anything. The steer, the speed and the frame time are the core's
/// three numbers, handed in.
/// </summary>
public class WheelSeatingTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        Time.timeScale = 1f;
        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
        UnityEngine.SceneManagement.SceneManager.LoadScene(
            0, UnityEngine.SceneManagement.LoadSceneMode.Single);
        yield return null;
    }

    // The stand-in's own size, in world metres. Deliberately NOT the
    // WheelCollider's 0.550 m: with the two the same, a wheel rolling on the
    // collider's radius and one rolling on the mesh's turn through the same
    // angle, and a test of which it uses proves nothing. The real streamed
    // wheel is 0.523 m against the same collider and has the same property.
    const float TyreRadius = 0.62f;
    const float TyreWidth  = 0.40f;

    Bootstrap _boot;
    CoreDrivenTruck _driver;
    TruckController _rig;
    bool _streamed;                   // true once the real wheels are mounted

    IEnumerator Rig()
    {
        // ONE WORLD, and it is this fixture's. Other fixtures leave theirs
        // standing, and `FindFirstObjectByType` then hands over a LEFTOVER
        // truck - seated by a leftover road network whose terrain has since
        // been destroyed, so its `Ground` answers 0 while its ribbons still
        // hold the mesh they were built with. That is not a fault in the road:
        // it went red at 2.98 m over a road that is fine, in the full suite
        // only, and passed alone.
        TestWorld.TearDown();
        yield return null;

        var boot = new GameObject("Bootstrap");
        _boot = boot.AddComponent<Bootstrap>();
        for (int i = 0; i < 6; i++) yield return null;

        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();
        yield return null;

        _driver = Object.FindFirstObjectByType<CoreDrivenTruck>();
        Assert.IsNotNull(_driver, "no CoreDrivenTruck in the scene");
        _rig = _driver.GetComponent<TruckController>();
        Assert.IsNotNull(_rig, "the core-driven truck has no axles to read");

        // What `Start` does when a core answers. PhysX poses the wheel meshes
        // off its own colliders otherwise, and two owners of one transform
        // measure each other rather than the seating.
        _rig.externallyDriven = true;

        // The streamed truck arrives a little after the world is built. Wait
        // for it rather than racing it: a fixture that sometimes measures a
        // stand-in and sometimes the real model measures neither.
        for (int f = 0; f < 240 && !RealWheels(); f++) yield return null;
        _streamed = RealWheels();
        if (!_streamed) FitStandIns(0);
        yield return null;
    }

    /// <summary>True when the axles hold the streamed model's own wheels.</summary>
    bool RealWheels()
    {
        foreach (var a in _rig.axles)
            if (a != null && a.leftMesh != null && a.leftMesh.name.Contains("Tyre")) return true;
        return false;
    }

    /// <summary>A wheel whose mesh is NOT centred on the transform it hangs from.</summary>
    static Transform StandIn(string name, Transform under)
    {
        var pivot = new GameObject(name).transform;
        pivot.SetParent(under, false);

        var mesh = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        mesh.name = "tyre";
        Object.DestroyImmediate(mesh.GetComponent<Collider>());
        mesh.transform.SetParent(pivot, false);
        // 0.5 is the primitive's own extent, so these are world metres.
        mesh.transform.localScale = new Vector3(TyreWidth, TyreRadius, TyreRadius) / 0.5f;
        // the offset the streamed model has, and the reason `hub` exists
        mesh.transform.localPosition = new Vector3(0f, 0.17f, 0.09f);
        return pivot;
    }

    /// <summary>Only used where the streamed model never turned up.</summary>
    void FitStandIns(int round)
    {
        int n = 0;
        foreach (var a in _rig.axles)
        {
            if (a == null) continue;
            if (a.leftMesh != null && a.leftMesh.name.StartsWith("stand-in"))
                Object.DestroyImmediate(a.leftMesh.gameObject);
            if (a.rightMesh != null && a.rightMesh.name.StartsWith("stand-in"))
                Object.DestroyImmediate(a.rightMesh.gameObject);
            a.leftMesh = StandIn($"stand-in {round}.{n++}", _rig.transform);
            a.rightMesh = StandIn($"stand-in {round}.{n++}", _rig.transform);
        }
        Assert.Greater(n, 0, "the truck has no axles, so nothing below is a measurement");
    }

    /// <summary>
    /// A TRUCK BUILT WITH THE STREAMED MODEL'S SHAPE, and nothing else of it.
    ///
    /// 6.4 m long, which is the length `NormaliseTruckModel` sizes everything
    /// to, and four wheels named the way that function looks for them, each an
    /// empty pivot with its mesh hung off it - the arrangement the real model
    /// has and the reason `hub` exists. Used where a measurement has to be the
    /// same number twice: the streamed model is fetched over the network and a
    /// batchmode run cannot be promised it.
    /// </summary>
    GameObject StandInModel()
    {
        var root = new GameObject("stand-in truck");
        root.transform.position = new Vector3(0f, -500f, 0f);

        var hull = GameObject.CreatePrimitive(PrimitiveType.Cube);
        hull.name = "hull";
        Object.DestroyImmediate(hull.GetComponent<Collider>());
        hull.transform.SetParent(root.transform, false);
        hull.transform.localScale = new Vector3(2.4f, 2.2f, 6.4f);

        var at = new[] { new Vector3(-1.1f, -1.1f, 2.1f), new Vector3(1.1f, -1.1f, 2.1f),
                         new Vector3(-1.1f, -1.1f, -2.1f), new Vector3(1.1f, -1.1f, -2.1f) };
        for (int i = 0; i < at.Length; i++)
        {
            // "wheel" in the name is what NormaliseTruckModel lifts out; the
            // mesh below it must NOT match, or it is lifted out as well.
            var pivot = new GameObject($"wheel_{i}").transform;
            pivot.SetParent(root.transform, false);
            pivot.localPosition = at[i];

            var mesh = GameObject.CreatePrimitive(PrimitiveType.Sphere);
            mesh.name = "rim_mesh";
            Object.DestroyImmediate(mesh.GetComponent<Collider>());
            mesh.transform.SetParent(pivot, false);
            mesh.transform.localScale = new Vector3(TyreWidth, TyreRadius, TyreRadius) / 0.5f;
            mesh.transform.localPosition = new Vector3(0f, 0.17f, 0.09f);
        }
        return root;
    }

    /// <summary>
    /// A new round's worth of wheels: the model is thrown away and put back,
    /// which is the swap the streamer performs and the event that makes
    /// `PoseWheels` measure every radius and hub again.
    /// </summary>
    IEnumerator NewRound(int round, GameObject model = null)
    {
        if (model != null) _boot.SwapTruckModel(model);
        else if (_streamed) _boot.SwapTruckModel(_boot.truckModel);
        else FitStandIns(round);
        yield return null;
    }

    /// <summary>
    /// Rolls for `frames` at a road speed, which is what spins the wheels.
    ///
    /// The frame is let go of FIRST and the wheels posed after, so that when
    /// this returns the seating was computed from the truck's CURRENT pose and
    /// nothing has moved since. The other order failed by 0.295 m: PhysX is
    /// still settling the body, so a wheel seated last frame is read against a
    /// ground the truck has since dropped towards - which measures the
    /// suspension, not the seating. The game has the same property and does
    /// not have the problem: it poses and reads inside one `Update`.
    /// </summary>
    IEnumerator Roll(int frames, float steer, float speed)
    {
        for (int f = 0; f < frames; f++)
        {
            yield return null;
            _driver.PoseWheels(steer, speed, 1f / 60f);
        }
    }

    /// <summary>
    /// EIGHT ROUNDS, and every wheel is read at the end of each one.
    ///
    /// The truck is put on a fresh spot and heading each round, as a roll-out
    /// does, and the wheels are re-streamed, so the radius and the hub are
    /// measured afresh eight times. `StartRound` is not called: it returns on
    /// its first line when the core is not driving, so calling it in an editor
    /// would be a line of test that does nothing and reads as though it did.
    /// </summary>
    [UnityTest]
    public IEnumerator TheTyreStaysOnTheGroundThroughEightRounds()
    {
        yield return Rig();

        for (int round = 1; round <= 8; round++)
        {
            _driver.transform.SetPositionAndRotation(
                new Vector3(-4f + round * 3f, _driver.transform.position.y, 6f - round * 2f),
                Quaternion.Euler(0f, round * 37f, 0f));
            yield return NewRound(round);

            // long enough that the spin passes through several whole turns:
            // 9 m/s over 40 frames on a 0.52 m wheel is about 1.8 rotations.
            yield return Roll(40, 12f, 9f);

            int read = 0;
            for (int i = 0; i < _driver.Wheels.Count; i++)
            {
                if (!_driver.SeatingOf(i, out var seat)) continue;
                read++;
                Assert.AreEqual(0f, seat.Tyre, 0.01f,
                    $"round {round}: wheel {i} ({_driver.Wheels[i].name}) is "
                    + $"{seat.Tyre:F3} m into the road. ground {seat.Ground:F3}, "
                    + $"radius {seat.Radius:F3}, mesh centre {seat.CentreY:F3}");
            }
            Assert.Greater(read, 0, $"round {round} read no wheels at all");
        }
    }

    /// <summary>
    /// THE FINDING ITSELF, held so it cannot be re-discovered as a bug.
    ///
    /// While the wheel turns, `ground - bounds.min.y` reports a bury and the
    /// tyre is on the road. If that ever stops being true - a probe rewritten
    /// to trust `bounds` again, or a seating that starts following the box -
    /// this is the test that says which of the two numbers moved.
    /// </summary>
    [UnityTest]
    public IEnumerator TheWorldBoxClaimsABuryTheTyreDoesNotHave()
    {
        yield return Rig();

        float worstBox = 0f, worstTyre = 0f;
        for (int f = 0; f < 120; f++)
        {
            yield return Roll(1, 0f, 9f);
            for (int i = 0; i < _driver.Wheels.Count; i++)
            {
                if (!_driver.SeatingOf(i, out var seat)) continue;
                worstBox = Mathf.Max(worstBox, seat.Box);
                worstTyre = Mathf.Max(worstTyre, Mathf.Abs(seat.Tyre));
            }
        }

        Assert.Greater(worstBox, 0.05f,
            "the world box did not inflate at all, so this fixture is not "
            + "measuring a turning wheel and proves nothing about the probe");
        Assert.Less(worstTyre, 0.01f,
            $"the tyre moved {worstTyre:F3} m while the box grew {worstBox:F3} m");
    }

    /// <summary>
    /// THE ROAD IS DRAWN WHERE THINGS ARE SEATED ON IT.
    ///
    /// `RoadNetwork` says so itself, in a comment that ends "whether that is
    /// the gap in the photograph is a measurement, not an argument":
    /// `SurfaceHeight` gives the truck the deck lift IN FULL, and the ribbon
    /// mesh lays its vertices at `lift - broken * 0.55` on one edge and
    /// `lift - broken * 0.55 + broken * 0.25` on the other. A worn stretch is
    /// therefore drawn BELOW the height everything standing on it is seated
    /// at, and the tyre floats over the rut by that difference.
    ///
    /// The measurement is taken against the ribbon's OWN vertices rather than
    /// against the formula, so it cannot pass by re-deriving the thing it is
    /// checking. Vertices in a cut section are skipped: a severity over 0.82
    /// has no triangles, so nothing is drawn there to stand on.
    /// </summary>
    [UnityTest]
    public IEnumerator TheRoadIsDrawnWhereThingsAreSeatedOnIt()
    {
        yield return Rig();

        // The network the TRUCK is seated by, not whichever one the scene
        // hands over first. The full suite leaves earlier worlds standing, and
        // a road network whose terrain has since been destroyed answers 0 for
        // the ground while still holding the ribbon it built when the terrain
        // was there: 2.34 m of disagreement about a road that is fine.
        var roads = _driver.roads;
        Assert.IsNotNull(roads, "the truck is not seated by any road network");

        // And it is a LIVE network. A destroyed terrain answers 0 for the
        // ground under every ribbon it still holds, which reads as metres of
        // disagreement about a road nobody has touched.
        Assert.IsNotNull(roads.terrain,
            "the road network the truck is seated by has lost its terrain, so "
            + "its ground is 0 and nothing measured against it means anything");

        // LET THE RIBBON CATCH UP FIRST. The ground comes from a live fetch and
        // reshapes under the road; `RoadNetwork.Update` notices within 0.25 s
        // and rebuilds. Measuring across that window compares a surface
        // sampled now against a mesh built against the heights of a moment
        // ago - it went red at 2.34 m that way, in the full suite only, where
        // the fetch lands mid-test. So the terrain version is held still for
        // two rebuild ticks before anything is read. Nothing is relaxed; the
        // two sides are simply made the same age.
        for (int wait = 0; wait < 20; wait++)
        {
            int was = roads.terrain.Version;
            for (int f = 0; f < 36; f++) yield return null;
            if (roads.terrain.Version == was) break;
        }

        float worst = 0f;
        var where = Vector3.zero;
        int checkedPairs = 0;

        foreach (var mf in roads.GetComponentsInChildren<MeshFilter>())
        {
            if (!mf.name.StartsWith("Road_")) continue;
            var mesh = mf.sharedMesh;
            if (mesh == null) continue;

            var drawn = new System.Collections.Generic.HashSet<int>(mesh.triangles);
            var v = mesh.vertices;
            var l2w = mf.transform.localToWorldMatrix;

            for (int i = 0; i + 1 < v.Length; i += 2)
            {
                if (!drawn.Contains(i) || !drawn.Contains(i + 1)) continue;
                var centre = (l2w.MultiplyPoint3x4(v[i]) + l2w.MultiplyPoint3x4(v[i + 1])) * 0.5f;
                float gap = roads.SurfaceHeight(centre.x, centre.z) - centre.y;
                checkedPairs++;
                if (Mathf.Abs(gap) > Mathf.Abs(worst)) { worst = gap; where = centre; }
            }
        }

        Assert.Greater(checkedPairs, 100,
            "no drawn road was found, so nothing here is a measurement");
        Assert.Less(Mathf.Abs(worst), 0.02f,
            $"a wheel seated on the road stands {worst:F3} m above the ribbon "
            + $"that is drawn there, at ({where.x:F1}, {where.z:F1}). "
            + $"{checkedPairs} drawn cross-sections checked");
    }

    /// <summary>
    /// THE TYRE TURNS ONCE PER CIRCUMFERENCE OF THE TYRE.
    ///
    /// The spin was advanced on the WheelCollider's 0.550 m while every
    /// seating line used the mesh's 0.523 m - the same leftover 3bd4208 took
    /// out of the seating and left behind in the rolling. A wheel that rolls
    /// on a radius 5.2% larger than the one it is drawn as turns that much
    /// too slowly, and slips against the road for the whole drive.
    ///
    /// Measured rather than declared: the wheel's own rotation is summed
    /// frame by frame and compared with the ground covered. Nine metres of
    /// road on the streamed 0.523 m tyre is 986 degrees; on the collider's
    /// 0.550 m it is 937.
    /// </summary>
    [UnityTest]
    public IEnumerator TheWheelRollsOnTheSizeItIsDrawnAs()
    {
        yield return Rig();
        yield return NewRound(1);
        yield return Roll(1, 0f, 0f);

        Assert.IsTrue(_driver.SeatingOf(0, out var seat), "no wheel 0");
        var wheel = _driver.Wheels[0];

        // Without this the test is vacuous, and it silently was: the stand-in
        // was 0.550 m, the collider is 0.550 m, and both radii turn the wheel
        // through the same angle.
        Assert.Greater(Mathf.Abs(seat.Radius - _driver.WheelRadius), 0.02f,
            $"the mesh ({seat.Radius:F3} m) and the collider "
            + $"({_driver.WheelRadius:F3} m) are the same size here, so this "
            + "test cannot tell which of them the wheel rolls on");

        const float Speed = 9f, Dt = 1f / 60f;
        const int Frames = 60;
        var was = wheel.rotation;
        float turned = 0f;
        for (int f = 0; f < Frames; f++)
        {
            yield return Roll(1, 0f, Speed);
            turned += Quaternion.Angle(was, wheel.rotation);
            was = wheel.rotation;
        }

        float ground = Speed * Dt * Frames;
        float wanted = ground / seat.Radius * Mathf.Rad2Deg;
        Assert.AreEqual(wanted, turned, 6f,
            $"{ground:F2} m of road turned the wheel {turned:F0} deg, and a "
            + $"{seat.Radius:F3} m tyre covering it turns {wanted:F0} deg. "
            + $"Rolling radius {_driver.RollRadius:F3} m, collider "
            + $"{_driver.WheelRadius:F3} m");
    }

    /// <summary>
    /// THE TRUCK IS THE SAME SIZE WHICHEVER WAY IT IS POINTING.
    ///
    /// Found by the fixture above rather than looked for: over eight rounds
    /// on eight headings the same wheel was seated on 0.503, 0.488, 0.486,
    /// 0.493, 0.507 and 0.518 m, and the rounds differ by nothing except the
    /// truck's heading. `NormaliseTruckModel` sizes the streamed model by
    /// `6.4 / max(worldBounds.size.x, worldBounds.size.z)`, and those are
    /// WORLD bounds - the same axis-aligned box that made a spinning wheel
    /// look buried. A truck sitting at 45 degrees is measured across its own
    /// diagonal, comes out too long, and is scaled DOWN to compensate.
    ///
    /// The function already knows the difference: two lines further on it
    /// measures the sole again "in the TRUCK's space, not the world's". Only
    /// the length was left in the world's.
    /// </summary>
    [UnityTest]
    public IEnumerator TheModelIsSizedTheSameOnEveryHeading()
    {
        yield return Rig();

        // The stand-in, not whatever the network delivered: this test is a
        // comparison between headings and both sides of it have to be the
        // same model.
        var model = StandInModel();
        float first = float.NaN;
        float worst = 0f;
        foreach (float heading in new[] { 0f, 15f, 30f, 45f, 60f, 90f })
        {
            _driver.transform.rotation = Quaternion.Euler(0f, heading, 0f);
            yield return NewRound(1, model);
            yield return Roll(3, 0f, 0f);

            Assert.IsTrue(_driver.SeatingOf(0, out var seat), $"{heading} deg: no wheel 0");
            if (float.IsNaN(first)) first = seat.Radius;
            worst = Mathf.Max(worst, Mathf.Abs(seat.Radius - first));

            Assert.AreEqual(first, seat.Radius, 0.005f,
                $"the truck streamed in at {heading} deg is a different size than at "
                + $"0 deg: wheel radius {seat.Radius:F3} m against {first:F3} m");
        }
        Assert.Less(worst, 0.005f, $"worst spread {worst:F3} m");
    }

    /// <summary>
    /// And the re-collect is honest: the radius a fresh set of wheels produces
    /// is the same one, round after round. This is "worse after round 1 or 2"
    /// stated as a number - a re-collect returning a different radius or hub
    /// is the only thing that could make round three sit lower than round one.
    /// </summary>
    [UnityTest]
    public IEnumerator EveryRoundMeasuresTheSameWheel()
    {
        yield return Rig();

        float first = float.NaN;
        for (int round = 1; round <= 8; round++)
        {
            yield return NewRound(round);
            yield return Roll(5, 0f, 4f);

            Assert.IsTrue(_driver.SeatingOf(0, out var seat), $"round {round}: no wheel 0");
            if (round == 1) first = seat.Radius;

            Assert.Greater(seat.Radius, 0.1f,
                $"round {round}: a wheel seated on {seat.Radius:F3} m is not a wheel");
            Assert.AreEqual(first, seat.Radius, 0.001f,
                $"round {round} seats on {seat.Radius:F3} m where round 1 seated on {first:F3} m");
        }
    }
}
