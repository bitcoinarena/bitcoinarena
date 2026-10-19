// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Linq;
using System.Collections;
using NUnit.Framework;
using UnityEngine;
using UnityEngine.TestTools;

/// <summary>
/// WheelCollider rigs fail in a small number of well-known ways: the body sinks
/// through the ground, the suspension never settles, or a tall vehicle rolls
/// onto its roof on the first corner. These check the rig actually holds the
/// truck up and drives it, which is the part that cannot be read off the code.
/// </summary>
public class VehicleTests
{
    [TearDown] public void ClearTheWorld() => TestWorld.TearDown();

    GameObject _boot;
    TruckController _truck;
    Rigidbody _rb;

    [UnitySetUp]
    public IEnumerator SetUp()
    {
        _boot = new GameObject("Bootstrap");
        _boot.AddComponent<Bootstrap>();
        yield return null;                            // let Start() build the world

        // Flatten the ground before the truck settles on it. The terrain is the
        // live fee histogram, so every run spawned the truck on a different
        // slope and the drift test passed or failed on whether it happened to
        // start downhill. These test the suspension and the tyre model, not the
        // mempool, so they get a deterministic floor.
        var ground = Object.FindFirstObjectByType<MempoolTerrain>();
        if (ground != null)
        {
            ground.feeHeight = 0f;
            ground.baseRelief = 0f;
            ground.Build();
        }

        yield return new WaitForSeconds(1.5f);        // let the suspension settle

        // AFTER the wait, not before: LoadoutPanel.Start opens the bay, and a
        // release issued before it has run is undone the moment it does.
        LoadAndRelease();
        _truck = Object.FindFirstObjectByType<TruckController>();
        _rb = _truck != null ? _truck.GetComponent<Rigidbody>() : null;
    }

    [UnityTearDown]
    public IEnumerator TearDown()
    {
        // Never hand the next test a slowed world. The death sequence drops
        // timeScale, and a test that ends while the truck is burning leaves it
        // there - the next test then runs at a third speed and quietly does a
        // third of the driving it thinks it does.
        Time.timeScale = 1f;

        foreach (var go in Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None))
            if (go.transform.parent == null) Object.Destroy(go);
        yield return null;
    }


    /// <summary>
    /// Get through the loading bay. The truck is held at the ramp until
    /// freight is aboard, so anything that drives has to load first.
    /// </summary>
    static void LoadAndRelease()
    {
        // Past the title screen first: it holds the truck and keeps the ramp
        // shut until PLAY is pressed, which is the point of it.
        var splash = Object.FindFirstObjectByType<SplashScreen>();
        if (splash != null && splash.Showing) splash.Play();

        var panel = Object.FindFirstObjectByType<LoadoutPanel>();
        if (panel == null) return;

        // Put freight in the yard first. The helper used to lean on whatever
        // the live mempool happened to return, and with an empty feed AUTO
        // loads nothing, LOSFAHREN rightly refuses, and every driving test
        // silently sat at the ramp.
        var feed = Object.FindFirstObjectByType<MempoolFeed>();
        if (feed != null && feed.Offers.Count == 0)
            feed.Offers = new System.Collections.Generic.List<MempoolFeed.Tx>
            {
                new MempoolFeed.Tx
                {
                    txid = "testfreight0000000000000000000000",
                    feeSats = 2400, vsize = 300, valueSats = 25_000_000,
                },
            };

        panel.Auto();
        panel.Confirm();
        Assert.IsFalse(panel.IsOpen, "die Laderampe liess den Truck nicht los");
    }

    [Test]
    public void SceneBuilds()
    {
        Assert.IsNotNull(_truck, "Bootstrap produced no truck");
        Assert.IsNotNull(Object.FindFirstObjectByType<MempoolTerrain>(), "no terrain");
        Assert.IsNotNull(Object.FindFirstObjectByType<ChaseCamera>(), "no camera");
        Assert.AreEqual(4, Object.FindObjectsByType<WheelCollider>(FindObjectsSortMode.None).Length);
    }

    [UnityTest]
    public IEnumerator TruckRestsOnTheGroundInsteadOfSinking()
    {
        float y0 = _rb.position.y;
        yield return new WaitForSeconds(1.5f);
        float drop = y0 - _rb.position.y;
        Assert.Less(drop, 2.0f, $"the truck sank {drop:0.00} units - suspension or collider is wrong");
        Assert.Less(_rb.linearVelocity.magnitude, 1.5f, "the truck never came to rest");
    }

    [UnityTest]
    public IEnumerator StaysUpright()
    {
        yield return new WaitForSeconds(1.5f);
        float tilt = Vector3.Angle(_truck.transform.up, Vector3.up);
        Assert.Less(tilt, 25f, $"the truck is tilted {tilt:0}deg - centre of mass or wheel layout is wrong");
    }

    [UnityTest]
    public IEnumerator DrivesUnderPower()
    {
        Vector3 from = _rb.position;
        // through the real control path, just with the keyboard swapped out
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(3f);
        float travelled = Vector3.Distance(from, _rb.position);
        _truck.useExternalInput = false;
        Assert.Greater(travelled, 5f, $"only travelled {travelled:0.0} units under full power");
    }

    /// <summary>
    /// The handbrake is supposed to break the rear loose, and the honest
    /// measure of that is the rear tyres' own sideways slip - not the hull's
    /// lateral speed, which mostly reports how fast the truck happens to be
    /// going. The first version of this test compared a full-lock phase against
    /// a handbrake phase that ran afterwards at a third of the speed, so it was
    /// really comparing two different velocities and flipped between pass and
    /// fail on noise.
    ///
    /// Both windows are short and back to back, so the two are sampled at
    /// comparable speed.
    /// </summary>
    /// <summary>
    /// Clear the battlefield for the tests that need a clean straight. A speed
    /// probe showed the truck accelerating cleanly to 15.5 m/s and then
    /// dropping to 1.3 m/s at x=-53, because it rams the armies - correct
    /// gameplay, and useless in a tyre test: the entry speed into every
    /// measurement was really "how far did it get before hitting a tank".
    ///
    /// Only the tests that measure the truck alone call this. The tests that
    /// check the truck against the armies obviously must not.
    /// </summary>
    void ClearBattlefield()
    {
        foreach (var army in Object.FindObjectsByType<ArmyRenderer>(FindObjectsSortMode.None))
            army.gameObject.SetActive(false);
    }

    [UnityTest]
    public IEnumerator HandbrakeBreaksTheRearEndLoose()
    {
        ClearBattlefield();
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(10f);         // a drift needs real speed

        _truck.externalSteer = 1f;
        yield return new WaitForSeconds(0.3f);        // let the front bite

        float grippedEntry = _rb.linearVelocity.magnitude;
        float gripped = 0f;
        for (float t = 0f; t < 0.5f; t += Time.fixedDeltaTime)
        {
            gripped = Mathf.Max(gripped, RearSlip());
            yield return new WaitForFixedUpdate();
        }

        _truck.externalHandbrake = true;
        float slidEntry = _rb.linearVelocity.magnitude;
        float slid = 0f;
        for (float t = 0f; t < 0.5f; t += Time.fixedDeltaTime)
        {
            slid = Mathf.Max(slid, RearSlip());
            yield return new WaitForFixedUpdate();
        }
        _truck.useExternalInput = false;
        _truck.externalHandbrake = false;

        Debug.Log($"DRIFT gripped {gripped:0.00} @ {grippedEntry:0.0} m/s -> " +
                  $"slid {slid:0.00} @ {slidEntry:0.0} m/s");

        Assert.Greater(slid, gripped * 1.4f,
            $"handbrake did not break the rear loose: rear sideways slip " +
            $"{gripped:0.00} gripped ({grippedEntry:0.0} m/s) vs {slid:0.00} " +
            $"on the handbrake ({slidEntry:0.0} m/s)");
    }

    /// <summary>Worst sideways slip reported by either handbraked wheel.</summary>
    float RearSlip()
    {
        float worst = 0f;
        foreach (var a in _truck.axles)
        {
            if (a == null || !a.handbraked) continue;
            foreach (var w in new[] { a.left, a.right })
                if (w != null && w.GetGroundHit(out WheelHit hit))
                    worst = Mathf.Max(worst, Mathf.Abs(hit.sidewaysSlip));
        }
        return worst;
    }

    /// <summary>
    /// The short tests all passed while the truck was quietly building up to
    /// 136 m/s and flying off the map: downforce is applied along -transform.up,
    /// which becomes thrust once the hull rolls past 90 degrees. Three seconds
    /// of throttle never got there. Twenty does.
    /// </summary>
    [UnityTest]
    public IEnumerator StaysOnTheMapUnderSustainedThrottle()
    {
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;

        float topSpeed = 0f;
        for (float t = 0f; t < 20f; t += 0.25f)
        {
            topSpeed = Mathf.Max(topSpeed, _rb.linearVelocity.magnitude);
            yield return new WaitForSeconds(0.25f);
        }
        Vector3 p = _rb.position;
        _truck.useExternalInput = false;

        Assert.Less(topSpeed, 45f, $"reached {topSpeed * 3.6f:0} km/h - something is adding energy");
        Assert.Less(Mathf.Abs(p.z), 130f, $"left the map sideways at z={p.z:0}");
        Assert.Greater(p.y, -40f, $"fell out of the world at y={p.y:0}");
    }

    /// <summary>
    /// The whole point of the on-screen pads: a finger on the gas pad has to
    /// drive the truck through exactly the same path the keyboard uses.
    /// </summary>
    [UnityTest]
    public IEnumerator TouchGasDrivesTheTruck()
    {
        var pads = Object.FindFirstObjectByType<TouchControls>();
        Assert.IsNotNull(pads, "the scene has no on-screen controls");
        Vector3 from = _rb.position;

        // a finger in the middle of the gas pad, at the real screen size
        pads.debugPoints = new System.Collections.Generic.List<Vector2>
        {
            TouchPad.RectFor(TouchPad.Pad.Up, Screen.width, Screen.height).center,
        };
        yield return new WaitForSeconds(3f);
        float travelled = Vector3.Distance(from, _rb.position);
        pads.debugPoints = null;

        Assert.Greater(travelled, 5f, $"touch gas moved the truck only {travelled:0.0} units");
    }

    /// <summary>
    /// THE MOUSE, ON THE PAD, ON A DESKTOP (2026-09-18 20:22, HARD: "on desktop the mobile pads are drawn but
    /// do nothing ... Mouse / pointer on a pad = throttle, steer, handbrake").
    ///
    /// The two tests above hand TouchControls a list of points, which skips the part a desktop player uses: whether
    /// the pads are shown at all without a touchscreen, whether the mouse is read, and whether its position - which
    /// Unity gives with y up - lands in the pad rect, which is measured with y down. This presses a real mouse
    /// device instead, so all three are in the measurement.
    /// </summary>
    [UnityTest]
    public IEnumerator AMouseOnTheGasPadDrivesTheTruck()
    {
        var pads = Object.FindFirstObjectByType<TouchControls>();
        Assert.IsNotNull(pads, "the scene has no on-screen controls");

        // A BATCHMODE EDITOR HAS NO GAME VIEW TO FOCUS, and by default the editor routes POINTER input to whichever
        // EditorWindow has focus rather than to the game - so a mouse held on a pad is never seen by player code at
        // all. Both settings are put back afterwards. The pads are not being changed to suit the test: the browser
        // has neither of these rules, and the same press there drove the truck at 10.86 m/s.
        var focus = UnityEngine.InputSystem.InputSystem.settings.backgroundBehavior;
        var editorFocus = UnityEngine.InputSystem.InputSystem.settings.editorInputBehaviorInPlayMode;
        UnityEngine.InputSystem.InputSystem.settings.backgroundBehavior =
            UnityEngine.InputSystem.InputSettings.BackgroundBehavior.IgnoreFocus;
        UnityEngine.InputSystem.InputSystem.settings.editorInputBehaviorInPlayMode =
            UnityEngine.InputSystem.InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
        var mouse = UnityEngine.InputSystem.InputSystem.AddDevice<UnityEngine.InputSystem.Mouse>();
        try
        {
            // The pads are drawn where the browser reports a touch device - the owner's desktop does, a batchmode editor
            // does not - so the test asks for them the way it is meant to be asked for. What is under test is what
            // happens to a MOUSE once they are on the screen.
            pads.forceShow = true;
            Assert.IsTrue(pads.Visible, "the pads are not drawn, so there is nothing to press");

            // The gas pad's own rectangle, flipped back into the input system's y-up screen space.
            var gas = TouchPad.RectFor(TouchPad.Pad.Up, Screen.width, Screen.height).center;
            var at = new Vector2(gas.x, Screen.height - gas.y);
            Vector3 from = _rb.position;

            for (float t = 0f; t < 3f; t += Time.deltaTime)
            {
                UnityEngine.InputSystem.InputSystem.QueueStateEvent(mouse,
                    new UnityEngine.InputSystem.LowLevel.MouseState { position = at }
                        .WithButton(UnityEngine.InputSystem.LowLevel.MouseButton.Left));
                UnityEngine.InputSystem.InputSystem.Update();
                yield return null;
            }
            float travelled = Vector3.Distance(from, _rb.position);
            Assert.Greater(travelled, 5f, $"the mouse held on the gas pad moved the truck only {travelled:0.0} units");
        }
        finally
        {
            pads.forceShow = false;
            UnityEngine.InputSystem.InputSystem.RemoveDevice(mouse);
            UnityEngine.InputSystem.InputSystem.settings.backgroundBehavior = focus;
            UnityEngine.InputSystem.InputSystem.settings.editorInputBehaviorInPlayMode = editorFocus;
        }
    }

    [UnityTest]
    public IEnumerator TouchSteerTurnsTheTruck()
    {
        var pads = Object.FindFirstObjectByType<TouchControls>();
        Assert.IsNotNull(pads, "the scene has no on-screen controls");
        var gas = TouchPad.RectFor(TouchPad.Pad.Up, Screen.width, Screen.height).center;
        var right = TouchPad.RectFor(TouchPad.Pad.Right, Screen.width, Screen.height).center;

        pads.debugPoints = new System.Collections.Generic.List<Vector2> { gas };
        yield return new WaitForSeconds(3f);
        float headingBefore = _truck.transform.eulerAngles.y;

        // two fingers at once, which GUI.Button could never have done
        pads.debugPoints = new System.Collections.Generic.List<Vector2> { gas, right };
        yield return new WaitForSeconds(2.5f);
        float delta = Mathf.DeltaAngle(headingBefore, _truck.transform.eulerAngles.y);
        pads.debugPoints = null;

        Assert.Greater(delta, 5f, $"touch steer turned the truck {delta:0.0} degrees, expected a right turn");
    }

    /// <summary>
    /// RE-STATED FOR RULING 4 (2026-09-22): "the map edge is a CLAMP, not a wall. The core owes
    /// no wall solids, and the client stops drawing walls the core does not build."
    ///
    /// This test was named TheEdgeOfTheWorldIsAWall and it asserted exactly the rule that was
    /// withdrawn: it buried the throttle at the south edge and failed with "die Wand haelt nicht" if
    /// the truck got past terrain.depth/2 + 2. There is no wall now, and nothing in the CLIENT holds
    /// the truck - `sim.js` clamps every unit and the truck to +-HALF_X / +-HALF_Z after its pushes,
    /// which is the authority, and PhysX is never the simulator (multiplayer_p2p.md).
    ///
    /// So what is checked here is the client's half of the ruling: the four boundary colliders are
    /// GONE from the scene. The clamp itself is the core's and is measured in `packages/nextblock` - men
    /// written to twice HALF come back inside in one step - because a PhysX rigidbody driven here has
    /// no core behind it and proves nothing about a rule the core owns.
    /// </summary>
    [UnityTest]
    public IEnumerator TheEdgeOfTheWorldIsAClampAndNotAWall()
    {
        Assert.IsNotNull(Object.FindFirstObjectByType<Bootstrap>());
        yield return null;

        var named = Object.FindObjectsByType<BoxCollider>(FindObjectsSortMode.None)
            .Select(c => c.name)
            .Where(nm => nm.StartsWith("Wall_") || nm.StartsWith("Barrier_"))
            .ToArray();
        Assert.IsEmpty(named,
            "die Begrenzungswaende stehen noch in der Szene: " + string.Join(", ", named)
            + " - der Rand ist ein Clamp im Core, und der Client zeichnet keine Waende, "
            + "die der Core nicht baut");
    }

    /// <summary>
    /// WITHDRAWN with ruling 4 and kept as a body only - see the note above. It drove a PhysX rigidbody
    /// at the edge and asked a collider to stop it.
    /// </summary>
    IEnumerator TheEdgeOfTheWorldIsAWall_Withdrawn()
    {
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();

        // point it at the south edge and bury the throttle
        _truck.transform.rotation = Quaternion.LookRotation(Vector3.forward, Vector3.up);
        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;

        float worst = 0f;
        for (float t = 0f; t < 18f; t += 0.25f)
        {
            worst = Mathf.Max(worst, Mathf.Abs(_rb.position.z));
            yield return new WaitForSeconds(0.25f);
        }
        _truck.useExternalInput = false;

        Assert.LessOrEqual(worst, terrain.depth * 0.5f + 2f,
            $"der Truck kam bis z={worst:0.0} - die Wand haelt nicht");
        Assert.Greater(_rb.position.y, -20f, "durch den Boden gefallen");
    }

    /// <summary>
    /// Both of these went unnoticed because nothing checked the scene had
    /// actually been wired up: AddComponent runs Awake before the caller can
    /// hand over the terrain and the renderer, so the ground kept its plain
    /// material and the roads were built flat at y=0, buried.
    /// </summary>
    [UnityTest]
    public IEnumerator GroundIsPaintedWithTheTerritoryTexture()
    {
        yield return new WaitForSeconds(1f);
        var territory = Object.FindFirstObjectByType<TerritoryMap>();
        Assert.IsNotNull(territory, "keine Territoriumskarte in der Szene");
        Assert.IsNotNull(territory.Texture, "Textur wurde nie erzeugt");
        Assert.IsTrue(territory.IsBound, "Textur haengt nicht am Bodenmaterial");

        // and it has to actually contain both sides
        var px = territory.Texture.GetPixels32();
        int green = 0, red = 0;
        foreach (var c in px) { if (c.g > c.r + 8) green++; else if (c.r > c.g + 8) red++; }
        Assert.Greater(green, px.Length / 20, "kein Bullen-Gebiet auf der Karte");
        Assert.Greater(red, px.Length / 20, "kein Baeren-Gebiet auf der Karte");
    }

    [UnityTest]
    public IEnumerator RoadsAreBuiltOnTheGroundWithMaterials()
    {
        yield return new WaitForSeconds(1f);
        var roads = Object.FindFirstObjectByType<RoadNetwork>();
        Assert.IsNotNull(roads, "kein Strassennetz in der Szene");
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();

        int checkedLanes = 0;
        foreach (var lane in RoadModel.Order)
        {
            var mesh = roads.Meshes[lane];
            Assert.Greater(mesh.vertexCount, 0, $"{lane} hat kein Mesh");

            var renderer = GameObject.Find($"Road_{lane}")?.GetComponent<MeshRenderer>();
            Assert.IsNotNull(renderer?.sharedMaterial, $"{lane} hat kein Material");

            // UVs must be in TILE units, measured along the road. Scaling them
            // here AND in the material gave 4600 repeats of a 2k asphalt photo
            // over one road - which renders as noise, not as a surface.
            var uv = mesh.uv;
            var vertsForUv = mesh.vertices;
            Assert.AreEqual(vertsForUv.Length, uv.Length, $"{lane}: UVs passen nicht zu den Eckpunkten");
            // ALONG THE CENTRELINE, which is what the UVs are measured along (RoadNetwork.Rebuild's `run`). This
            // walked the strip two vertices at a time, from when a station was two vertices wide; it has been five
            // across since the ribbon was laid on the chart, so the walk was hopping sideways across the road and
            // adding those hops to the length. It stayed inside the band by luck, and the luck ran out when the
            // ribbon was cut back to the miner's door: 58.5 m a tile reported on a road that tiles every 4.
            int across = RoadNetwork.Across, mid = across / 2;
            float span = 0f, length = 0f;
            for (int i = mid + across; i < vertsForUv.Length; i += across)
            {
                length += Vector3.Distance(vertsForUv[i - across], vertsForUv[i]);
                span = Mathf.Max(span, uv[i].y);
            }
            // one tile every four metres, give or take the road's own curvature
            float metresPerTile = length / Mathf.Max(span, 0.001f);
            Assert.That(metresPerTile, Is.InRange(2f, 7f),
                $"{lane}: eine Kachel alle {metresPerTile:0.0} m - Kachelung wurde doppelt angewandt");

            // A road wound the wrong way is drawn every frame and culled as a
            // back face: present in the scene, invisible from above.
            var normals = mesh.normals;
            Assert.Greater(normals.Length, 0, $"{lane} hat keine Normalen");
            float up = 0f;
            foreach (var nrm in normals) up += nrm.y;
            Assert.Greater(up / normals.Length, 0.5f,
                $"{lane} zeigt nach unten (mittleres n.y={up / normals.Length:0.00}) - von oben unsichtbar");

            // every vertex must sit near the terrain, not at y=0
            // against the DRAWN surface, not the analytic one: a road that
            // follows the curve but not the triangles disappears into the ground
            var verts = mesh.vertices;
            for (int i = 0; i < verts.Length; i += 13)
            {
                float drawn = terrain.SampleSurface(verts[i].x, verts[i].z);
                float above = verts[i].y - drawn;
                Assert.Greater(above, -0.05f,
                    $"{lane} steckt bei x={verts[i].x:0} im Boden: y={verts[i].y:0.00}, Oberflaeche {drawn:0.00}");
                Assert.Less(above, 1.6f,
                    $"{lane} schwebt bei x={verts[i].x:0} ueber dem Boden: y={verts[i].y:0.00}, Oberflaeche {drawn:0.00}");
            }
            checkedLanes++;
        }
        Assert.AreEqual(RoadModel.Order.Length, checkedLanes);
    }

    [UnityTest]
    public IEnumerator BothArmiesAreOnTheFieldAndOnTheGround()
    {
        yield return new WaitForSeconds(2f);
        var field = Object.FindFirstObjectByType<Battlefield>();
        Assert.IsNotNull(field?.Army, "keine Armeen in der Szene");
        Assert.Greater(field.Army.Armour.Count, 4, "zu wenig Panzer");
        Assert.Greater(field.Army.Infantry.Count, 20, "zu wenig Infanterie");

        Assert.IsNotNull(Object.FindFirstObjectByType<ArmyRenderer>(), "die Armeen werden nicht gezeichnet");

        // both sides present, and nobody parked inside anybody else
        int bull = 0, bear = 0;
        foreach (var v in field.Army.Armour) { if (v.side == Army.Side.Bull) bull++; else bear++; }
        Assert.Greater(bull, 0, "keine Bullen-Panzer");
        Assert.Greater(bear, 0, "keine Baeren-Panzer");

        for (int i = 0; i < field.Army.Armour.Count; i++)
            for (int j = i + 1; j < field.Army.Armour.Count; j++)
            {
                var a = field.Army.Armour[i]; var b = field.Army.Armour[j];
                float d = Mathf.Sqrt((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z));
                Assert.Greater(d, 4f, $"zwei Panzer stecken ineinander (Abstand {d:0.0})");
            }
    }

    [UnityTest]
    public IEnumerator ArmiesFightNearTheSeamRatherThanWanderingOff()
    {
        // Twelve seconds, not six. Reinforcements used to appear at a random
        // depth - as little as thirty metres behind the line - and now every
        // unit walks in from the edge of the field at 79 m, which is the point
        // of the change. The claim being tested is unchanged: more than half
        // the armour SETTLES near the seam. It just has further to walk first.
        yield return new WaitForSeconds(12f);
        var field = Object.FindFirstObjectByType<Battlefield>();

        int nearFront = 0;
        foreach (var v in field.Army.Armour)
            if (Mathf.Abs(v.z - field.FrontlineZ(v.x)) < 60f) nearFront++;

        Assert.Greater(nearFront, field.Army.Armour.Count / 2,
            "die Haelfte der Panzer haelt sich nicht in der Naehe der Front auf");
    }

    /// <summary>A tank is a thing in the way, not scenery you drive through.</summary>
    [UnityTest]
    public IEnumerator ArmourBlocksTheTruck()
    {
        yield return new WaitForSeconds(1.5f);
        var field = Object.FindFirstObjectByType<Battlefield>();
        Assert.IsNotNull(field?.Army);

        // park a tank squarely in the truck's path and hold it there
        var target = field.Army.Armour[0];
        Vector3 start = _rb.position;
        _truck.transform.rotation = Quaternion.LookRotation(Vector3.right, Vector3.up);
        float blockX = start.x + 22f;
        target.x = blockX; target.z = start.z;

        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;

        float furthest = start.x;
        for (float t = 0f; t < 12f; t += 0.1f)
        {
            // the army keeps stepping, so pin the blocker every frame
            target.x = blockX; target.z = start.z; target.hp = 99f;
            furthest = Mathf.Max(furthest, _rb.position.x);
            yield return new WaitForSeconds(0.1f);
        }
        _truck.useExternalInput = false;

        Assert.Less(furthest, blockX + 4f,
            $"der Truck ist durch den Panzer hindurchgefahren (bis x={furthest:0.0}, Panzer bei {blockX:0.0})");
        Assert.Greater(furthest, start.x + 6f, "der Truck ist gar nicht erst losgefahren");
    }

    [UnityTest]
    public IEnumerator UnitsDoNotShoveEachOtherWithPhysics()
    {
        yield return new WaitForSeconds(2f);
        // hulls and soldiers share a layer whose self-collision is off, so the
        // Army logic is the only thing deciding where they stand
        Assert.IsTrue(Physics.GetIgnoreLayerCollision(ArmyRenderer.UnitLayer, ArmyRenderer.UnitLayer),
            "Einheiten kollidieren miteinander - Physik und Army-Logik streiten um dieselben Positionen");

        var hull = GameObject.Find("Hull");
        Assert.IsNotNull(hull, "kein Panzerrumpf in der Szene");
        Assert.IsNotNull(hull.GetComponent<BoxCollider>(), "Panzer ohne Collider");
        Assert.IsTrue(hull.GetComponent<Rigidbody>().isKinematic, "Panzer ist nicht kinematisch");
        Assert.AreEqual(ArmyRenderer.UnitLayer, hull.layer);

        // Infantry deliberately has NO collider: it is meant to be driven
        // through, and a two-tonne truck bouncing off a man it is running over
        // reads as a bug rather than as a casualty.
        var soldier = GameObject.Find("Soldier");
        Assert.IsNotNull(soldier, "kein Soldat in der Szene");
        Assert.IsNull(soldier.GetComponent<Collider>(),
            "der Soldat hat einen Collider - der Truck wuerde an ihm abprallen statt ihn zu ueberfahren");

        // a turret sits inside its own hull, so it must NOT carry one
        var turret = GameObject.Find("Turret");
        Assert.IsNull(turret?.GetComponent<BoxCollider>(), "Turm hat einen Collider und kaempft mit dem Rumpf");
    }

    /// <summary>
    /// Reported as: after hitting anything, the truck can no longer drive. The
    /// armies do not know the truck exists, so they walked into it - and a
    /// kinematic body teleported into a dynamic one every frame wedges it.
    /// </summary>
    [UnityTest]
    public IEnumerator TheTruckCanDriveOnAfterHittingTheArmy()
    {
        yield return new WaitForSeconds(1.5f);
        var field = Object.FindFirstObjectByType<Battlefield>();
        Assert.IsNotNull(field?.Army);

        // bury the truck in a crowd
        Vector3 p = _rb.position;
        _truck.transform.rotation = Quaternion.LookRotation(Vector3.right, Vector3.up);
        for (int i = 0; i < field.Army.Armour.Count; i++)
        {
            field.Army.Armour[i].x = p.x + 3f + i * 2f;
            field.Army.Armour[i].z = p.z;
        }
        for (int i = 0; i < Mathf.Min(20, field.Army.Infantry.Count); i++)
        {
            field.Army.Infantry[i].x = p.x + 2f + i;
            field.Army.Infantry[i].z = p.z + (i % 3) - 1f;
        }

        _truck.useExternalInput = true;
        _truck.externalThrottle = 1f;
        yield return new WaitForSeconds(4f);      // shove into them

        // Armour is meant to stop the truck, so the test is NOT that it drives
        // on through. It is that the truck still answers the controls: wedged
        // means it cannot move at all, in any direction.
        Vector3 stuck = _rb.position;
        _truck.externalThrottle = -1f;
        yield return new WaitForSeconds(5f);
        float backedOff = Vector3.Distance(stuck, _rb.position);
        _truck.useExternalInput = false;

        Assert.Greater(backedOff, 6f,
            $"nach der Kollision nur {backedOff:0.0} Einheiten zurueckgesetzt - der Truck steckt fest");
    }

    /// <summary>
    /// The overview has to actually show everything. Checking the height would
    /// only prove the camera went up; this projects the four corners of the map
    /// and requires all of them to land on screen, so the framing stays right
    /// if the field size or the lens ever changes.
    /// </summary>
    [UnityTest]
    public IEnumerator GodViewFramesTheWholeBattlefield()
    {
        yield return new WaitForSeconds(1f);
        var chase = Object.FindFirstObjectByType<ChaseCamera>();
        var cam = chase.GetComponent<Camera>();
        var terrain = Object.FindFirstObjectByType<MempoolTerrain>();
        // THE DRIVE STAYS FIRST PERSON (2026-09-29 12:45, PLAYTEST-ROLL-1245): ROLL OUT leaves the camera behind the truck
        Assert.AreEqual(ChaseCamera.Mode.Follow, chase.View, "startet nicht hinter dem Truck");

        chase.Toggle();
        Assert.AreEqual(ChaseCamera.Mode.God, chase.View);
        yield return new WaitForSeconds(2f);      // let it ease into place

        float hw = terrain.width * 0.5f, hd = terrain.depth * 0.5f;
        foreach (var corner in new[]
        {
            new Vector3(-hw, 0f, -hd), new Vector3(hw, 0f, -hd),
            new Vector3(-hw, 0f, hd), new Vector3(hw, 0f, hd),
        })
        {
            var v = cam.WorldToViewportPoint(corner);
            Assert.Greater(v.z, 0f, $"Ecke {corner} liegt hinter der Kamera");
            Assert.IsTrue(v.x is >= 0f and <= 1f && v.y is >= 0f and <= 1f,
                $"Ecke {corner} liegt ausserhalb des Bildes bei {v.x:0.00}/{v.y:0.00}");
        }

        Assert.Greater(cam.transform.position.y, 60f, "die Uebersicht ist nicht ueber dem Feld");
    }

    [UnityTest]
    public IEnumerator GodViewTogglesBackToTheChaseCam()
    {
        yield return new WaitForSeconds(1f);
        var chase = Object.FindFirstObjectByType<ChaseCamera>();
        chase.Toggle();
        yield return new WaitForSeconds(1.5f);
        Vector3 up = chase.transform.position;

        chase.Toggle();
        Assert.AreEqual(ChaseCamera.Mode.Follow, chase.View, "zurueck hinter den Truck, nicht in eine Draufsicht");
        yield return new WaitForSeconds(2.5f);

        // back over the truck, not over the middle of the field: the truck is in the frame again
        var v = chase.GetComponent<Camera>().WorldToViewportPoint(_truck.transform.position);
        Assert.IsTrue(v.z > 0f && v.x is >= 0f and <= 1f && v.y is >= 0f and <= 1f,
            $"die Fahrtansicht zeigt den Truck nicht: {v}");
        Assert.AreNotEqual(up, chase.transform.position, "die Kamera bleibt in der Uebersicht stehen");
    }

}
