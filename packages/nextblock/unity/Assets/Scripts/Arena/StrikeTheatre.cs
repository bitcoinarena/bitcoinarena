// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

namespace Arena
{
    /// <summary>
    /// The liquidation strike, as the player sees it: an aircraft comes in, an
    /// atom bomb falls off it, the ground opens, and what is left glows.
    ///
    /// THEATRE, AND ONLY THEATRE. The core has no aircraft and no bomb. It
    /// consumes a liquidation, picks a point near the front, and digs the hole
    /// in that same tick - `sim.js` step 0. Nothing here is asked, nothing here
    /// is remembered, and nothing here can change where the crater is or how
    /// deep it goes. Take this component out and the simulation is identical;
    /// only the picture is poorer.
    ///
    /// Which is also why the timing runs the other way round from what it looks
    /// like. The hole exists the instant the strike arms; the bomb is drawn
    /// falling INTO a crater that is already there, and `MempoolTerrain` holds
    /// the ground shut for `craterRevealDelay` seconds so the two line up. The
    /// numbers here and that delay are one setting in two places:
    ///
    ///   104 m of run-in at 26 m/s                      ->  4.00 s in sight
    ///   release 61 m short, 22 m up, drawn at 8 m/s^2   ->  2.35 s of fall
    ///                                                        6.35 s, call it 6.4
    ///
    /// The fall is deliberately slow. At a real 30 m/s^2 from 22 m it was over
    /// in 1.21 s - two frames at the rate a headless browser renders, and not
    /// long enough for a player to see what left the aircraft either. A retarded
    /// fall is also what a free-fall nuclear weapon actually does, so that the
    /// aircraft dropping it can get away.
    ///
    /// The altitude came down from 70 m to 22 and the speed from 60 m/s to 26,
    /// both measured rather than guessed: `WorldToScreenPoint` against the live
    /// chase camera put the first cut 57 degrees off the camera axis for the
    /// whole of its approach, in a frame 90 degrees wide, and 33 degrees up in
    /// a frame that only looks 20 degrees above the horizon. A bomber the
    /// player never sees is not theatre. At these numbers it is in shot from
    /// about 2.9 s to 8.6 s - the release and the impact both inside that.
    ///
    /// The altitude came down twice, from 70 m to 45 to 22, each time because
    /// the photographs showed the same thing: the chase camera sits low and
    /// pitched down, so anything much above fifteen degrees of elevation spends
    /// the whole run above the top of the frame. A bomber the player never sees
    /// is not theatre.
    ///
    /// The models are STAND-INS, built from primitives on purpose: the shape of
    /// the aircraft is not what this step is for, and a placeholder that says so
    /// is better than one pretending to be finished work.
    /// </summary>
    public class StrikeTheatre : MonoBehaviour
    {
        public MempoolTerrain terrain;
        public RoadNetwork roads;
        public CombatFx fx;
        public GameAudio audio;


        /// <summary>How far short of the impact the bomb leaves the aircraft.</summary>
        const float ReleaseLead = 61f;
        const float Speed = 26f;          // m/s along the run-in
        const float Altitude = 22f;       // above the surface at the impact
        const float RunIn = 3.5f;         // seconds of approach before the release
        const float Gravity = 8f;         // drawn, not simulated - see the class note
        const float RunOut = 5f;          // seconds the aircraft stays visible after release

        Transform _plane, _bomb;
        Vector3 _from, _to, _impact;
        float _t = -1f, _fall = -1f;
        float _saidFly = -99f;
        int _seenStrikes = -1;

        Material _metal, _bombSkin, _glow;
        Renderer _skirtR;
        Vector3 _skirtRestPos;
        readonly List<Transform> _glows = new List<Transform>();
        int _seenTerrain = -1;
        MaterialPropertyBlock _block;

        void Awake()
        {
            _block = new MaterialPropertyBlock();
            var shader = Shader.Find("Universal Render Pipeline/Lit");
            if (shader == null)
            {
                // URP/Unlit is not referenced by any material in this scene, so a
                // player build strips it and Shader.Find returns null in the
                // browser while working perfectly in the editor. Lit or nothing.
                Debug.LogWarning("[strike] no URP/Lit in this build - no bomber, no glow");
                enabled = false;
                return;
            }
            Debug.Log("[strike] theatre ready");
            _metal = Skin(shader, new Color(0.62f, 0.64f, 0.67f), 0.55f,
                          new Color(0.16f, 0.17f, 0.19f));
            _bombSkin = Skin(shader, new Color(0.20f, 0.21f, 0.23f), 0.35f,
                             new Color(0.10f, 0.10f, 0.11f));

            // These numbers are deliberately the ones from before. Turning the
            // emission down was tried twice - 1.4, then 0.34 - and the crater
            // was still a painted plate, just a darker one, because the fault
            // was never the shade: it was an opaque surface laid over the whole
            // floor. What changed is what this material is drawn ON. See
            // ContaminationMesh.
            // Same recipe as everything else this component makes: built from
            // Shader.Find with _EMISSION on, because that is the only kind of
            // runtime material this build has been shown to draw.
            _fire = Skin(shader, new Color(1f, 0.85f, 0.6f), 0.1f,
                         new Color(1f, 0.62f, 0.22f));

            _glow = new Material(shader);
            _glow.SetColor("_BaseColor", new Color(0.10f, 0.14f, 0.08f));
            _glow.SetFloat("_Smoothness", 0.05f);
            _glow.EnableKeyword("_EMISSION");
            _glow.SetColor("_EmissionColor", new Color(0.10f, 0.34f, 0.09f));

        }

        /// <summary>
        /// A painted surface - and it MUST be built exactly like this.
        ///
        /// Measured, because two earlier cuts drew nothing at all. Three
        /// identical four-metre cubes were parked side by side over the start
        /// bay in a real WebGL build: one from a bare `new Material(URP/Lit)`,
        /// one copied off a scene material, and one with `_EMISSION` switched
        /// on. Photographed - only the emissive one appeared. The other two
        /// were active, enabled, on layer 0, inside the camera's culling mask,
        /// projecting inside the frame with positive depth, and reported
        /// `isVisible` true. They simply did not draw: this build has no
        /// compiled shader variant for them.
        ///
        /// So every material this component makes carries the keyword, and the
        /// emission is a real value rather than near-black.
        /// </summary>
        Material Skin(Shader shader, Color baseColour, float smoothness, Color glow)
        {
            var m = new Material(shader);
            m.SetColor("_BaseColor", baseColour);
            m.SetFloat("_Smoothness", smoothness);
            m.EnableKeyword("_EMISSION");
            m.SetColor("_EmissionColor", glow);
            return m;
        }

        void Update()
        {
            if (!ArenaCore.Available) return;
            Fly(Time.deltaTime);
            Column(Time.deltaTime);
            Glow();

            // THE SERIAL, not `StrikeArmed`. `K_STATE` is set for exactly one
            // tick, and the core is stepped at 60 Hz from a frame loop: at the
            // ~2 fps a headless browser manages, a single frame runs thirty
            // ticks and reads the state once at the end, so the armed tick is
            // gone before anything can see it. Measured - the first cut of this
            // watched `StrikeArmed` and never launched once. `K_SERIAL` only
            // goes up, so an increment cannot be missed however slow the frame.
            int strikes = ArenaCore.StrikeCount;
            if (strikes == _seenStrikes) return;
            bool first = _seenStrikes < 0;
            _seenStrikes = strikes;
            Spent(strikes);
            if (first) return;                    // a reload, not a fresh strike
            Launch(ArenaCore.StrikeAt(0f));
        }

        /* ------------------------------------------------------- the run-in */

        void Launch(Vector3 at)
        {
            _impact = new Vector3(at.x, Ground(at.x, at.z), at.z);

            // In along x from the WEST, always. The far east end of the map is
            // where the drop-off rig stands, and it is tall: measured against
            // the live chase camera, an aircraft coming in over it was on
            // screen and behind the building for its whole approach. The west
            // end is open ground and open sky.
            const float dir = 1f;
            float y = _impact.y + Altitude;
            _from = new Vector3(_impact.x - dir * (ReleaseLead + Speed * RunIn), y, _impact.z);
            _to = new Vector3(_impact.x + dir * Speed * RunOut, y, _impact.z);

            // A long being liquidated is a BULL blown out of its position, so
            // bear is the other one. One boolean, and it is the only place the
            // side is decided. Which model that side flies is Wearing().
            //
            // `_armedSide`, NOT `_nextIsBear`: the side is handed over the
            // moment the core's serial is seen to move, by whoever sees it
            // first. Reading the live latch here drew the side of a liquidation
            // that had arrived AFTER this strike was already dug. See Spent().
            string wearing = Wearing(_armedSide);
            var skin = wearing == "bear" ? _bearAirframe
                     : wearing == "bull" ? _bullAirframe
                     : _airframe;

            if (_plane != null && wearing != _wearing) { Destroy(_plane.gameObject); _plane = null; }
            if (_plane == null)
            {
                _plane = skin != null ? Dress(skin, 34f, Vector3.zero) : BuildPlane();
                _wearing = wearing;
            }
            // EVERY sortie, not only when the skin changes. Logging the change
            // alone made a count of three strikes look like a count of one.
            Debug.Log($"[strike] airframe {wearing}");
            if (_bomb == null)
                // Nose from +Y round to +Z, the direction the flight code points it.
                _bomb = _bombModel != null ? Dress(_bombModel, 4f, new Vector3(90f, 0f, 0f)) : BuildBomb();
            _plane.gameObject.SetActive(true);
            _bomb.gameObject.SetActive(false);
            _plane.SetPositionAndRotation(_from, Quaternion.LookRotation(new Vector3(dir, 0f, 0f)));
            _t = 0f;
            _fall = -1f;
            Debug.Log($"[strike] bomber away for {_impact.x:F1},{_impact.z:F1}");
        }

        /// <summary>
        /// Where a thing sits in the picture the player is driving with: is it
        /// in front of the camera, what rect does it take, how much of that
        /// rect survives the frame edges, and what share of the frame it is.
        /// The same probe the cap used, because the cap turned out to be
        /// entirely above the screen while every other number looked healthy.
        /// </summary>
        static string InFrame(Renderer r)
        {
            if (r == null) return "none";
            var cam = Camera.main;
            if (cam == null)
                foreach (var c in Camera.allCameras)
                    if (c != null && c.isActiveAndEnabled) { cam = c; break; }
            if (cam == null) return "no camera";
            var b = r.bounds;
            float x0 = float.MaxValue, y0 = float.MaxValue;
            float x1 = float.MinValue, y1 = float.MinValue;
            bool front = false;
            for (int i = 0; i < 8; i++)
            {
                var corner = b.center + Vector3.Scale(b.extents,
                    new Vector3((i & 1) == 0 ? -1 : 1, (i & 2) == 0 ? -1 : 1,
                                (i & 4) == 0 ? -1 : 1));
                var sp = cam.WorldToScreenPoint(corner);
                if (sp.z > 0f) front = true;
                x0 = Mathf.Min(x0, sp.x); x1 = Mathf.Max(x1, sp.x);
                y0 = Mathf.Min(y0, sp.y); y1 = Mathf.Max(y1, sp.y);
            }
            float ox = Mathf.Max(0f, Mathf.Min(x1, Screen.width) - Mathf.Max(x0, 0f));
            float oy = Mathf.Max(0f, Mathf.Min(y1, Screen.height) - Mathf.Max(y0, 0f));
            float share = front ? 100f * ox * oy / (Screen.width * Screen.height) : 0f;
            return $"seen {r.isVisible}, front {front}, rect {x0:F0},{y0:F0} "
                 + $"{(x1 - x0):F0}x{(y1 - y0):F0}, on screen {ox:F0}x{oy:F0} px = {share:F1}%"
                 + (y1 > Screen.height ? ", CLIPPED at the top" : "");
        }

        void Fly(float dt)
        {
            if (_t < 0f) return;
            _t += dt;

            // THE APPROACH, in the driving picture. Six seconds pass between
            // the warning and the hole, and if the aircraft and the bomb are
            // off the top of the frame the player sees a crater with no cause
            // - which is exactly what the cap was doing.
            if (_t - _saidFly > 1.0f)
            {
                _saidFly = _t;
                var pr = _plane != null && _plane.gameObject.activeSelf
                       ? _plane.GetComponentInChildren<Renderer>() : null;
                var br = _bomb != null && _bomb.gameObject.activeSelf
                       ? _bomb.GetComponentInChildren<Renderer>() : null;
                Debug.Log($"[fly] t={_t:F1}s plane {(pr != null ? InFrame(pr) : "not up")}");
                if (br != null) Debug.Log($"[fly] t={_t:F1}s bomb  {InFrame(br)}");
            }

            float ran = Speed * _t;
            float toRelease = Vector3.Distance(_from, _impact) - ReleaseLead;
            Vector3 dir = (_to - _from).normalized;

            if (_plane != null && _plane.gameObject.activeSelf)
            {
                _plane.position = _from + dir * ran;
                if (ran > toRelease + Speed * RunOut) _plane.gameObject.SetActive(false);
            }

            // THE SOUND OF THE RUN. Nearness is taken from the aircraft to the
            // truck rather than to the impact: what the player hears is a
            // plane passing over THEM.
            if (audio == null) audio = FindFirstObjectByType<GameAudio>();
            if (audio != null)
            {
                // NOT `Camera.main`. It is null in this build - the camera
                // that renders is not tagged MainCamera, which is why the cap
                // probe needed this same fallback - so the ear was falling
                // back to the impact point and the drone's nearness was the
                // distance from the plane to the hole rather than to the
                // player. Measured as silent-in-practice, and reported before
                // it was fixed.
                float near = 0f;
                if (_plane != null && _plane.gameObject.activeSelf)
                {
                    var cam = Camera.main;
                    if (cam == null)
                        foreach (var c in Camera.allCameras)
                            if (c != null && c.isActiveAndEnabled) { cam = c; break; }
                    var ear = cam != null ? cam.transform.position : _impact;
                    float d = Vector3.Distance(_plane.position, ear);
                    near = Mathf.Clamp01(1f - d / 260f);
                }
                audio.Bomber(near);
            }

            // Release: the bomb keeps the aircraft's speed along the run and
            // falls under a gravity chosen so it arrives where the core already
            // put the hole.
            if (_fall < 0f && ran >= toRelease)
            {
                _fall = 0f;
                if (_bomb != null)
                {
                    _bomb.gameObject.SetActive(true);
                    _bomb.position = _from + dir * toRelease;
                }
                if (audio != null) audio.BombAway();
            }
            if (_fall < 0f) return;

            _fall += dt;
            float drop = 0.5f * Gravity * _fall * _fall;
            if (_bomb != null && _bomb.gameObject.activeSelf)
            {
                var p = _from + dir * ran;
                p.y -= drop;
                // Nose over as it falls, which is the whole read on a falling bomb.
                float pitch = Mathf.Atan2(Gravity * _fall, Speed) * Mathf.Rad2Deg;
                _bomb.SetPositionAndRotation(p, Quaternion.LookRotation(dir) * Quaternion.Euler(pitch, 0f, 0f));

                if (p.y <= _impact.y)
                {
                    _bomb.gameObject.SetActive(false);
                    if (fx != null) { fx.Blast(_impact, 26f); fx.Flash(_impact + Vector3.up * 6f, 18f); }
                    RaiseColumn(_impact);
                    // Lazily, because Bootstrap builds the audio and this in an
                    // order that is not this component's business to depend on.
                    // WHICH ASSIGNMENT ACTUALLY PROVIDED IT. Bootstrap's line
                    // for this sits inside BuildArmies behind
                    // `if (_strike != null)`, and the theatre is made later, so
                    // it is skipped - the same way the crater wipe's `fx` was.
                    // It also looks up `GameAudio` before that component
                    // exists. If anything is heard it is this lazy fetch, and
                    // this says so rather than leaving it to be read off the
                    // source.
                    bool wired = audio != null;
                    if (audio == null) audio = FindFirstObjectByType<GameAudio>();
                    Debug.Log($"[voice] strike: wired by Bootstrap {wired}, "
                              + $"found lazily {(!wired && audio != null)}, "
                              + $"audio {(audio != null ? "present" : "MISSING")}, "
                              + $"clip {(audio != null && audio.StrikeClip != null ? "yes" : "none")}");
                    if (audio != null) audio.Strike();
                    Debug.Log($"[strike] impact at {_impact.x:F1},{_impact.z:F1}");
                }
            }
            if (_t > 20f)
            {
                _t = -1f;
                if (_plane != null) _plane.gameObject.SetActive(false);
                if (audio != null) audio.Bomber(0f);
            }
        }

        /* ------------------------------------------------------- the column */

        // A mushroom is a shape over time, so all of it is time. The stem
        // reaches its full height in Rise seconds, the cap swells with it and
        // then flattens, the whole thing cools from white through orange to
        // ash, and it is gone by Gone.
        const float Rise = 3.0f;          // seconds to full height
        const float Gone = 8.0f;          // seconds until nothing is left
        const float StemHigh = 55f;       // metres
        const float StemWide = 7f;
        const float CapWide = 34f;

        Transform _stem, _cap, _skirt;
        Transform _mushroom;
        GameObject _mushroomModel;
        Vector3 _mushroomFull = Vector3.one;
        Vector3 _mushroomSize;   // the modelled size, measured once at full scale
        float _saidRest = -1f;   // so the resting is reported once a strike
        float _saidSkirt = -1f;  // and the skirt's own footing on its own clock
        float _cloudFloor, _stemFoot, _skirtUnderside;
        int _restings;
        bool _countedWreckage;

        /// <summary>How many times the cloud has been resting. Zero means the
        /// resting never ran, and anything read off it is not a measurement.</summary>
        public int Restings => _restings;

        /// <summary>
        /// One step of the cloud. `Update` runs this, and it is reachable so a
        /// PlayMode test can drive it: `Update` gives up on `ArenaCore.Available`
        /// and the editor's core is a stub, so nothing here would ever run in
        /// a test otherwise.
        /// </summary>
        public void StepCloud(float dt) => Column(dt);

        /// <summary>
        /// AND THE CAP GOES WITH THE THEATRE.
        ///
        /// `CapCentre` is static, and `Column` only clears it where the cloud
        /// reaches `Gone`. A theatre that goes away while a cloud is standing -
        /// a restart, a scene change, a round that ends on a strike - therefore
        /// left the last cap's world position published for good, and every
        /// driving camera afterwards pitched up at a cloud that was not there.
        /// Measured in the a14 probe, where a strike in one test tilted the
        /// camera in the NEXT one.
        /// </summary>
        void OnDisable() => CapCentre = null;

        /// <summary>The crater floor under the cloud: the core's own surface.</summary>
        public float CloudFloor => _cloudFloor;
        /// <summary>The lowest point of everything that is not the dust skirt.</summary>
        public float StemFoot => _stemFoot;
        /// <summary>The lowest point of the dust skirt.</summary>
        public float SkirtUnderside => _skirtUnderside;
        MeshRenderer[] _mushroomSkins;
        Transform _skirt3, _core3, _cap3;

        /// <summary>
        /// Where the head of the standing cloud is, for the driving camera.
        /// Null while nothing is standing. Read only - the camera raises its
        /// look point towards this; nothing about the strike depends on it.
        /// </summary>
        public static Vector3? CapCentre { get; private set; }
        Vector3 _skirtRest = Vector3.one, _coreRest = Vector3.one;
        Color _dust = new Color(0.43f, 0.32f, 0.20f);
        float _saidHeat = -99f;
        Material _fire;
        float _cloud = -1f;
        Vector3 _cloudAt;
        int _impactTick = -1;    // the core's tick when the bomb landed, not the page's clock

        /// <summary>
        /// Put a column over the impact.
        ///
        /// The blast `CombatFx` draws is 26 m of fireball, which is what a tank
        /// gets. An atom bomb is not a bigger tank: what says what it was is the
        /// column standing over the field for several seconds after the flash,
        /// long enough that a player who was looking the other way still turns
        /// and sees it.
        ///
        /// Theatre, like the aircraft. Nothing here is asked by the core, the
        /// core has no cloud, and the crater was dug before this is drawn.
        /// </summary>
        /// <summary>Take the streamed mushroom in place of the three primitives.</summary>
        public void SetMushroom(GameObject prefab)
        {
            if (prefab == null) return;
            _mushroomModel = prefab;
            if (_mushroom != null) { Destroy(_mushroom.gameObject); _mushroom = null; }
            Debug.Log("[strike] mushroom model taken");
        }

        /// <summary>
        /// Stand a cloud at a point on the ground. The strike path calls this;
        /// it is public so a PlayMode test can drive the real thing rather
        /// than a copy of it, because the editor's core is a stub and no
        /// liquidation will ever arrive in one.
        /// </summary>
        /// <summary>
        /// How much of the battlefield is still standing inside the hole. The
        /// contract's word is that a liquidation WIPES its radius; nothing in
        /// this build removes anything, so this counts what survives.
        /// </summary>
        void CountTheWreckage(Vector3 at)
        {
            // NOT AT THE MOMENT OF IMPACT. `terrain.DrawnCraters` is the
            // terrain's own list and it does not carry the new hole until it
            // has rebuilt, so a count taken in `RaiseColumn` found no radius
            // and said nothing at all.
            // AND IT ALWAYS SAYS SOMETHING. Two builds of this returned early
            // and printed nothing, which reads exactly like "no wrecks" and is
            // not the same claim at all.
            if (terrain == null) { Debug.Log("[crater] no terrain"); return; }
            float r = 0f, nearest = float.MaxValue;
            foreach (var c in terrain.DrawnCraters)
            {
                float d = (new Vector2(c.x, c.z) - new Vector2(at.x, at.z)).magnitude;
                if (d < nearest) { nearest = d; r = c.y; }
            }
            if (terrain.DrawnCraters.Count == 0)
            {
                Debug.Log($"[crater] the terrain has drawn no craters at all");
                return;
            }
            int hulls = 0, inside = 0;
            foreach (var h in FindObjectsByType<BurntOutHull>(FindObjectsSortMode.None))
            {
                hulls++;
                var p = h.transform.position;
                if ((new Vector2(p.x, p.z) - new Vector2(at.x, at.z)).magnitude <= r) inside++;
            }
            int wiped = fx != null ? fx.ClearWrecksIn(at, r) : 0;
            int leftInside = 0;
            foreach (var h in FindObjectsByType<BurntOutHull>(FindObjectsSortMode.None))
            {
                var p = h.transform.position;
                if ((new Vector2(p.x, p.z) - new Vector2(at.x, at.z)).magnitude <= r) leftInside++;
            }
            Debug.Log($"[crater] nearest crater {nearest:F1} m away, r {r:F1} m, "
                      + $"{terrain.DrawnCraters.Count} open: {inside} wreck(s) inside it of "
                      + $"{hulls} on the field, wiped {wiped}, {leftInside} left inside");
        }

        public void RaiseColumn(Vector3 at)
        {
            _countedWreckage = false;
            _cloudAt = at;
            _cloud = 0f;
            _impactTick = ArenaCore.Available ? ArenaCore.State[Layout.O_TICK] : -1;
            _saidRest = -1f;
            _saidSkirt = -1f;    // or the second cloud says nothing until t=3.0s
            _saidHeat = -99f;

            // THE MESH IF THERE IS ONE. The primitives - a cylinder, a sphere
            // and a flatter sphere - were always a stand-in, and they read as
            // one on a phone. They stay as the fallback for the seconds before
            // the model has streamed, and for a build that has not got it.
            if (_mushroomModel != null)
            {
                if (_mushroom == null)
                {
                    _mushroom = Dress(_mushroomModel, StemHigh, Vector3.zero);
                    _mushroomSkins = _mushroom.GetComponentsInChildren<MeshRenderer>();
                    foreach (var mr in _mushroomSkins)
                    {
                        mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                        // The keyword, once, on this instance's own materials.
                        // Without it a URP material ignores _EmissionColor
                        // entirely - measured earlier in this build, where three
                        // identical cubes were parked over the start bay and
                        // only the emissive one drew at all.
                        foreach (var m in mr.materials) m.EnableKeyword("_EMISSION");
                    }
                    _mushroomFull = _mushroom.localScale;
                    {
                        var ms = _mushroom.GetComponentsInChildren<Renderer>();
                        var mb = ms[0].bounds;
                        for (int k = 1; k < ms.Length; k++) mb.Encapsulate(ms[k].bounds);
                        _mushroomSize = mb.size;
                    }

                    // THE PARTS ARE IN THE ASSET. The GLB carries five named
                    // nodes - stem, cap, crown_billow, dust_skirt and
                    // fireball_core - and scaling the parent moved all five on
                    // one curve, which is why the cloud read as a blob and the
                    // dust along the ground disappeared. The old primitives
                    // read as a mushroom because the stem, the cap and the
                    // skirt grew on curves of their own; these are the same
                    // curves, applied to the pieces that were already there.
                    _skirt3 = Find(_mushroom, "dust_skirt");
                    _core3 = Find(_mushroom, "fireball_core");
                    // THE CAP, for M1.d: whether the head of the cloud is in
                    // the picture the player is actually driving with. The
                    // node names in the GLB are stem, cap, crown_billow,
                    // dust_skirt and fireball_core.
                    _cap3 = Find(_mushroom, "cap");
                    // THE DUST IS NOT SMOKE, and it was being painted as if it
                    // were. The GLB authors `dust_skirt` as a warm brown -
                    // 0.434, 0.323, 0.202 - fully opaque, and the cooling drive
                    // overwrote that with the cloud's ash grey. Same colour as
                    // the column, and opaque over the grass, so from above the
                    // ring merged into the mass instead of reading as dust on
                    // the ground.
                    //
                    // Its own colour is kept, and the material is made
                    // transparent so the ground shows through and the rim has
                    // an edge. This is a runtime change to the instance's own
                    // material - the asset on disk is untouched.
                    if (_skirt3 != null)
                    {
                        var sr = _skirt3.GetComponent<Renderer>();
                        _skirtR = sr;
                        if (sr != null)
                        {
                            var m0 = sr.material;
                            _dust = m0.HasProperty("_BaseColor")
                                  ? m0.GetColor("_BaseColor") : new Color(0.43f, 0.32f, 0.20f);
                            // WHETHER THE TRANSPARENCY WRITES BELOW CAN LAND
                            // AT ALL. `_Surface` and `_ZWrite` are URP Lit's
                            // property names; a Shader Graph only has the
                            // properties its author exposed, and `SetFloat` on
                            // a name a material does not carry is silently
                            // ignored. So these two booleans say whether the
                            // block under this is a fix or a no-op, and they
                            // are printed rather than assumed.
                            Debug.Log($"[cloud] dust material: shader {m0.shader.name}, "
                                      + $"queue {m0.renderQueue}, colour "
                                      + $"{_dust.r:F2},{_dust.g:F2},{_dust.b:F2},a{_dust.a:F2}, "
                                      + $"_Surface {m0.HasProperty("_Surface")}, "
                                      + $"_ZWrite {m0.HasProperty("_ZWrite")}");
                            // THE MATERIAL IS THE ASSET'S OWN. Four recipes
                            // were tried on this slot - a transparent blend,
                            // an alpha cut, and Skin()'s plain opaque brown
                            // that already draws the bomber and the fireball -
                            // and every one of them photographed as nothing,
                            // because the skirt was 23 m underground. None of
                            // them was ever the hole, so none of them stays.
                            // The GLB's own warm brown is what a dust skirt
                            // should be, and it is left exactly as authored.
                        }
                    }
                    _skirtRest = _skirt3 != null ? _skirt3.localScale : Vector3.one;
                    _skirtRestPos = _skirt3 != null ? _skirt3.localPosition : Vector3.zero;
                    // WHICH HIERARCHY THIS ACTUALLY IS. If the skirt were the
                    // same transform as the column, the only way to raise it
                    // would be to raise the whole cloud - and that would move
                    // the stem and cap, which already draw correctly.
                    if (_skirt3 != null)
                        Debug.Log($"[cloud] skirt transform: own={(_skirt3 != _mushroom)} "
                                  + $"parent={(_skirt3.parent != null ? _skirt3.parent.name : "none")} "
                                  + $"localPos {_skirtRestPos.x:F2},{_skirtRestPos.y:F2},{_skirtRestPos.z:F2}");
                    _coreRest = _core3 != null ? _core3.localScale : Vector3.one;
                    Debug.Log($"[cloud] parts: skirt {(_skirt3 != null ? "yes" : "MISSING")}, "
                              + $"fireball {(_core3 != null ? "yes" : "MISSING")}, "
                              + $"{_mushroomSkins.Length} renderers");
                }
                _mushroom.gameObject.SetActive(true);
                if (_stem != null)
                    foreach (var t in new[] { _stem, _cap, _skirt }) t.gameObject.SetActive(false);
                // The size it ACTUALLY came out at, from the renderers, not
                // the number that was asked for. `Dress` scales on the longest
                // side, and whether that side is the height or the cap's width
                // decides whether a 55 m column or a 55 m saucer is standing
                // there.
                // MEASURED AT FULL SCALE, ONCE, at dress time - not here.
                //
                // This line used to measure the renderers at the instant of
                // launch, and it told a lie I believed and filed as a bug: the
                // FIRST strike of a round read "drawn 32.5 x 55.0 x 32.4 m"
                // and every later one "drawn 2.6 x 2.8 x 2.6 m". The model was
                // never re-scaled. `Column` sets the scale on the NEXT frame,
                // so at launch the transform still carries the previous
                // cloud's fade floor - `Mathf.Max(0.05f, f)` - and 55 x 0.05
                // is 2.75. The clouds were full size all along: strikes two,
                // three and four measured 49.2, 48.9 and 49.1 m across the
                // skirt at t=1.7 s against the first's 48.7 m.
                //
                // The size a cloud comes out at is a property of the dressed
                // model, so it is measured where the model is dressed, and the
                // scale the transform happens to be carrying is printed beside
                // it rather than mistaken for it.
                var rs = _mushroom.GetComponentsInChildren<Renderer>();
                float atNow = _mushroomFull.y > 0.0001f
                            ? _mushroom.localScale.y / _mushroomFull.y : 0f;
                string size = $"{_mushroomSize.x:F1} x {_mushroomSize.y:F1} x "
                            + $"{_mushroomSize.z:F1} m modelled, {rs.Length} renderer(s), "
                            + $"growing from {100f * atNow:F0}% of it";
                Debug.Log($"[cloud] mushroom MESH at {at.x:F1},{at.z:F1}, asked for "
                          + $"{StemHigh:F0} m, drawn {size}");
                return;
            }

            Debug.Log($"[cloud] primitives at {at.x:F1},{at.z:F1} - no mesh streamed yet");
            if (_stem == null)
            {
                _stem = Part(transform, PrimitiveType.Cylinder, Vector3.zero,
                             Vector3.one, Vector3.zero, _fire);
                _cap = Part(transform, PrimitiveType.Sphere, Vector3.zero,
                            Vector3.one, Vector3.zero, _fire);
                _skirt = Part(transform, PrimitiveType.Sphere, Vector3.zero,
                              Vector3.one, Vector3.zero, _fire);
                foreach (var t in new[] { _stem, _cap, _skirt })
                    t.GetComponent<MeshRenderer>().shadowCastingMode =
                        UnityEngine.Rendering.ShadowCastingMode.Off;
            }
            foreach (var t in new[] { _stem, _cap, _skirt }) t.gameObject.SetActive(true);
        }

        /// <summary>A child by name, anywhere under the dressed model.</summary>
        static Transform Find(Transform root, string name)
        {
            foreach (var t in root.GetComponentsInChildren<Transform>())
                if (t.name == name) return t;
            return null;
        }

        /// <summary>
        /// White, then orange, then ash. The colour IS the clock, and it is one
        /// function so the mesh and the primitive fallback cannot drift apart.
        /// </summary>
        static void Heat(float t, out Color body, out Color glow)
        {
            float heat = Mathf.Exp(-1.5f * t);
            glow = Color.Lerp(new Color(0.28f, 0.26f, 0.24f),
                              new Color(1f, 0.62f, 0.22f), heat) * (0.25f + 1.9f * heat);
            body = Color.Lerp(new Color(0.34f, 0.32f, 0.30f),
                              new Color(1f, 0.85f, 0.6f), heat);
        }

        void Column(float dt)
        {

            if (_cloud < 0f) return;
            _cloud += dt;
            if (_cloud > Gone)
            {
                _cloud = -1f;
                CapCentre = null;
                if (_mushroom != null) _mushroom.gameObject.SetActive(false);
                if (_stem != null)
                    foreach (var t in new[] { _stem, _cap, _skirt }) t.gameObject.SetActive(false);
                return;
            }

            // THE ANCHOR IS RE-READ FROM THE CORE, EVERY FRAME (2026-09-16).
            //
            // `_cloudAt` is taken at the bomb run, and the bowl is dug 384 ticks
            // after the blast - so the height in it is the ground as it stood
            // BEFORE the crater existed and it never changed again. Measured on
            // the Daily: it sat frozen at 3.46 while the core's surface beneath
            // it fell to -0.65, a stale anchor 4.11 m up in the air.
            //
            // Only the height is re-read. Where the bomb fell is a fact about
            // the strike and does not move; how high the ground is there is a
            // fact about the core, and the core is the only thing that knows it.
            // Everything below hangs off this one point, so the whole
            // hierarchy - stem, cap and skirt - goes down with the bowl together.
            _cloudAt.y = CoreGround(_cloudAt.x, _cloudAt.z);

            // The mesh grows and goes on the SAME clock the primitives used, so
            // the shape changed and the timing did not: full height in `Rise`
            // seconds, nothing left by `Gone`.
            if (_mushroom != null && _mushroomModel != null)
            {
                // IT GOES OUT, IT DOES NOT SHRINK. the owner, 17:45 on the
                // phone: "when the liquidation mesh expires it must vanish,
                // not scale down". It used to be multiplied by a fade that ran
                // to a 5% floor, so a 55 m cloud became a three-metre bud
                // hovering over the crater and then blinked out - which reads
                // as a model failing, not as smoke clearing.
                //
                // It grows and then holds its size. `Gone` still ends it, and
                // the parts keep their own curves - the fireball still dies
                // back and the dust still spreads - so what leaves the picture
                // is a full-sized cloud, at once.
                float g = 1f - Mathf.Exp(-3.2f * _cloud);
                _mushroom.localScale = _mushroomFull * g;
                _mushroom.position = _cloudAt;

                // THE SKIRT TAKES ITS SHAPE BEFORE ANYTHING IS SEATED.
                //
                // The spread used to be applied below, after the resting had
                // already chosen where the parent goes. Once the skirt counts
                // towards that choice, setting it afterwards would seat the
                // cloud on LAST frame's disc while this one is still growing -
                // a lag that shows as the dust sinking and popping back on a
                // curve. Same formula, same curve, read in the right order.
                if (_skirt3 != null)
                {
                    // 1.5 times the cap, which is what the primitive skirt
                    // reached: `CapWide * 1.5` against the cap's `CapWide`.
                    // The asset's skirt starts at about the cap's own width -
                    // measured 31.8 m against 32.5 - so 0.6 more of it lands on
                    // the same figure.
                    //
                    // 1.0 was tried and rejected on the picture, not on a
                    // number: it took the disc to 59.6 m and 59.2% of it clear
                    // of the column, against 36.9% before, and the skirt
                    // on/off deltas on the rim were +0.2, -1.9 and -0.1 -
                    // inside the grass controls' own noise. A wider disc is
                    // not a ring.
                    float spread = 1f + 0.6f * (1f - Mathf.Exp(-1.1f * _cloud));
                    _skirt3.localScale = new Vector3(_skirtRest.x * spread,
                                                     _skirtRest.y,
                                                     _skirtRest.z * spread);
                    _skirt3.localPosition = _skirtRestPos;
                }

                // AND THE WHOLE CLOUD STANDS ON ITS LOWEST POINT (2026-09-16).
                //
                // `_cloudAt` is the impact point on the ground, and putting the
                // transform there put the model's ORIGIN there - which is its
                // middle, measured y -27.5 .. +23.0 about it on a model 55.0 m
                // tall. So half the cloud was under the surface: the stem's
                // foot was buried and the player saw a cap sitting on the
                // grass with no column beneath it.
                //
                // The lowest point of the WHOLE hierarchy is what rests on the
                // core's surface - the skirt included, because the skirt is
                // what the player sees meeting the ground. It used to be the
                // lowest point of everything EXCEPT the skirt, and the skirt
                // lifted itself separately onto the highest of five samples;
                // that is two objects seated by two rules, and it is what put
                // the dust 6.34 m into the air over the road deck.
                //
                // It has a measured price, and it is not hidden: the authored
                // skirt hangs 0.69 m to 1.04 m BELOW the stem's foot, so with
                // the disc on the ground the stem stands that much proud of the
                // crater floor. `TheStemStandsOnTheCraterFloorRatherThanUnderIt`
                // is red on exactly that number and stays red until the asset
                // is reauthored. Ground contact is what the player sees; the
                // stem's foot inside the column is not.
                if (_mushroomSkins != null && _mushroomSkins.Length > 0)
                {
                    var colB = new Bounds(_cloudAt, Vector3.zero);
                    bool anyCol = false;
                    foreach (var mr in _mushroomSkins)
                    {
                        if (mr == null) continue;
                        if (!anyCol) { colB = mr.bounds; anyCol = true; }
                        else colB.Encapsulate(mr.bounds);
                    }
                    if (anyCol)
                    {
                        float floor = CoreGround(_cloudAt.x, _cloudAt.z);
                        float gap = floor - colB.min.y;      // + buried, - floating
                        _mushroom.position += Vector3.up * gap;

                        // ASK THE RENDERERS AGAIN. Reporting `colB.min.y + gap`
                        // is a tautology - it is the floor by construction
                        // whether the transform moved or not - and a test
                        // built on it passed with the resting deleted.
                        _cloudFloor = floor;

                        // AND `_stemFoot` STAYS THE STEM'S OWN FOOT. The skirt
                        // is deliberately left out of this second pass: it is
                        // the seating bounds above that had to grow to take the
                        // disc in, not the meaning of the word. Folding the
                        // skirt in here would make `_stemFoot` the same number
                        // as the floor by construction and turn a red test
                        // green without moving anything - the tautology this
                        // block already carries a warning about.
                        var after = new Bounds(_cloudAt, Vector3.zero);
                        bool anyAfter = false;
                        foreach (var mr in _mushroomSkins)
                        {
                            if (mr == null || mr.transform == _skirt3) continue;
                            if (!anyAfter) { after = mr.bounds; anyAfter = true; }
                            else after.Encapsulate(mr.bounds);
                        }
                        _stemFoot = anyAfter ? after.min.y : float.NaN;
                        _restings++;
                        if (_cloud - _saidRest > 1.2f || _saidRest < 0f)
                        {
                            _saidRest = _cloud;
                            Debug.Log($"[cloud] stem footing t={_cloud:F1}s: lowest point was {colB.min.y:F2}, "
                                      + $"crater floor {floor:F2}, "
                                      + $"{(gap > 0f ? "buried" : "floating")} {Mathf.Abs(gap):F2} m "
                                      + $"-> lowest point now {floor:F2}, "
                                      + $"stem foot {_stemFoot:F2} = {(_stemFoot - floor):F2} m proud of the floor");

                            // THE CORE'S OWN CLOCK, BECAUSE THE PAGE'S IS NOT IT (2026-09-16).
                            //
                            // The bowl is dug 384 ticks after the core consumes the liquidation, and the
                            // cloud's clock starts at the IMPACT - the bomb run sits between the two and has
                            // never been measured. A prediction that the cloud spends 80% of its life on
                            // pre-crater ground was made from those two numbers and measured wrong, because
                            // the gap between them was assumed to be nothing.
                            //
                            // Wall seconds cannot answer it: under swiftshader this page runs at roughly half
                            // real-time, so a timestamp gap is a different quantity from a tick gap. The raw
                            // words are printed instead - impact tick, tick now, and the nearest slot's dig
                            // tick and radius - and the delay itself is NOT copied into C#: the liquidation's
                            // consume tick is `dig - CRATER_DELAY` and that arithmetic is done off the core's
                            // own numbers, where the constant lives. A radius of 0 with a dig tick set is a
                            // slot armed and not yet dug, which is exactly the state this is here to catch.
                            int tickNow = ArenaCore.Available ? ArenaCore.State[Layout.O_TICK] : -1;
                            int slot = -1, dig = 0, radw = 0;
                            float near = float.MaxValue;
                            if (ArenaCore.Available)
                                for (int i = 0; i < Layout.MAX_CRATERS; i++)
                                {
                                    int b = Layout.O_CRATERS + i * Layout.C_WORDS;
                                    if (ArenaCore.State[b + Layout.C_DIG] == 0 && ArenaCore.State[b + Layout.C_R] <= 0) continue;
                                    float dx = ArenaCore.Metres(ArenaCore.State[b + Layout.C_X]) - _cloudAt.x;
                                    float dz = ArenaCore.Metres(ArenaCore.State[b + Layout.C_Z]) - _cloudAt.z;
                                    float d2 = dx * dx + dz * dz;
                                    if (d2 >= near) continue;
                                    near = d2; slot = i;
                                    dig = ArenaCore.State[b + Layout.C_DIG];
                                    radw = ArenaCore.State[b + Layout.C_R];
                                }
                            Debug.Log($"[cloud] clock t={_cloud:F1}s: impact tick {_impactTick}, tick now {tickNow}, "
                                      + $"nearest slot {slot}"
                                      + (slot < 0 ? " none" : $" {Mathf.Sqrt(near):F1} m from the cloud")
                                      + $", dig tick {dig}, radius "
                                      + (radw > 0 ? $"{ArenaCore.Metres(radw):F1} m dug" : "0 (armed, not dug)"));
                        }
                    }
                }

                // THE HEAT, on the mesh. The primitives cooled white through
                // orange to ash across the eight seconds and the mesh wore one
                // colour for its whole life, which is a fireball that never
                // goes out. Same curve, same clock - the colour IS the clock -
                // driven through a property block so the streamed materials
                // are not written to.
                // THE SKIRT IS READ HERE, NOT SHAPED HERE. Its spread and its
                // authored local position are both set above, before the
                // seating, because the seating now counts the disc in. The
                // rationale for the 1.5 curve lives with the code that applies
                // it rather than being repeated here.
                if (_skirt3 != null)
                {
                    // AND THIS IS WHERE IT IS READ, NOT WHERE IT IS PLACED.
                    //
                    // The disc is shaped and reset to its authored local
                    // position above, before the seating, so that the resting
                    // can see it. What is left here is measurement: where the
                    // underside ended up once the parent had been seated, and
                    // which ground that is. Nothing below moves anything.
                    if (_skirtR != null)
                    {
                        var sb = _skirtR.bounds;

                        // AND IT RIDES THE PARENT (2026-09-16). It used to
                        // lift ITSELF onto the highest of five `Ground()`
                        // samples, on the reasoning that a wide disc must clear
                        // the tallest ground beneath it. That rule was measured
                        // on the Daily and it is what put the skirt in the sky:
                        // at t=1.8 s its underside stood at 5.69 while the
                        // core's surface under it was -0.65 - 6.34 m of air,
                        // the centre hanging 5.59 m clear and the north edge
                        // 7.88 m. It was resting on the road deck's high side.
                        //
                        // The seating is now done once, on the parent, against
                        // the core's own surface. A second lift here would be a
                        // second opinion about the ground - the exact thing the
                        // funnel in `RoadNetwork.Ground` exists to prevent - so
                        // the skirt stays where the model authored it and the
                        // whole hierarchy moves as one.
                        _skirtUnderside = sb.min.y;   // measured, not assumed

                        // WHAT THE SKIRT IS STANDING ON, AND WHICH GROUND THAT IS (2026-09-16).
                        //
                        // The stem and the crater floor are already reported by the `[cloud] stem footing`
                        // line above; this is the smallest print that adds the rest. The skirt no longer
                        // seats itself at all - it rides the parent, which rests on the lowest point of the
                        // whole hierarchy against the core's surface - so its underside IS the seating, and
                        // reading it against `SurfaceAt` is the check on that seating rather than a note
                        // about a second rule.
                        //
                        // `Ground()` is printed beside it only as the old road-deck answer, to keep the gap
                        // that caused this visible: it is the deck where there is one, `SurfaceAt` is always
                        // the core. `_cloudAt.y` is re-read from the core every frame now, so it follows the
                        // bowl the strike digs 384 ticks after the blast instead of standing at the height
                        // taken at the bomb run. Nothing here changes a position.
                        if (_cloud - _saidSkirt > 1.2f || _saidSkirt < 0f)
                        {
                            _saidSkirt = _cloud;
                            float coreAtSkirt = ArenaCore.HasSurface ? ArenaCore.SurfaceAt(sb.center.x, sb.center.z) : float.NaN;
                            float coreAtImpact = ArenaCore.HasSurface ? ArenaCore.SurfaceAt(_cloudAt.x, _cloudAt.z) : float.NaN;
                            Debug.Log($"[cloud] skirt footing t={_cloud:F1}s: underside {_skirtUnderside:F2}, "
                                      + $"Ground(skirt) {Ground(sb.center.x, sb.center.z):F2}, "
                                      + $"SurfaceAt(skirt) {coreAtSkirt:F2}; anchor y {_cloudAt.y:F2} re-read from the core, "
                                      + $"SurfaceAt(impact) {coreAtImpact:F2}, floor {_cloudFloor:F2}, stem foot {_stemFoot:F2}");
                        }
                    }
                }

                // The fire goes out long before the smoke does, so the core
                // shrinks away on a curve of its own instead of riding the
                // whole cloud down.
                if (_core3 != null)
                {
                    float core = Mathf.Exp(-1.1f * _cloud);
                    _core3.localScale = _coreRest * Mathf.Max(0.001f, core);
                }

                // The head's position, published for the driving camera. Set
                // every frame the cloud is up and cleared when it is gone, so
                // the camera has nothing to hold on to between strikes.
                if (_cap3 != null)
                {
                    var capR = _cap3.GetComponent<Renderer>();
                    CapCentre = capR != null ? capR.bounds.center : (Vector3?)null;
                }

                Heat(_cloud, out var meshBody, out var meshGlow);
                if (_mushroomSkins != null)
                    foreach (var mr in _mushroomSkins)
                    {
                        if (mr == null) continue;
                        // Dust is not flame. The skirt takes the same body
                        // colour and a fraction of the glow, or the ground
                        // ring reads as a second fireball.
                        bool dust = _skirt3 != null && mr.transform == _skirt3;
                        mr.GetPropertyBlock(_block);
                        if (dust)
                        {
                            // DUST IS NOT SMOKE. The cooling curve drives the
                            // column from a white flash down to ash grey, and
                            // it was being written over the skirt as well, so
                            // the ground dust wore the same colour as the mass
                            // above it. It keeps the warm brown the asset
                            // ships with instead.
                            mr.SetPropertyBlock(null);
                            continue;
                        }
                        else
                        {
                            _block.SetColor("_BaseColor", meshBody);
                            _block.SetColor("_EmissionColor", meshGlow);
                        }
                        mr.SetPropertyBlock(_block);
                    }
                if (_cloud - _saidHeat > 1.2f)
                {
                    _saidHeat = _cloud;
                    // The skirt's own width, in world metres. Driving it is
                    // one thing; a ring that actually spreads while the column
                    // shrinks is the thing worth reading, and a photograph of
                    // a two-second event keeps missing it.
                    string ring = "none";
                    // AND WHETHER IT IS ON SCREEN AT ALL. A skirt 48 m wide
                    // that photographs as nothing has two possible causes -
                    // it is drawn and invisible, or it is not drawn - and the
                    // renderer answers which. The rect is in pixels from the
                    // bottom left of the camera that is actually rendering.
                    string seen = "no camera";
                    if (_skirt3 != null)
                    {
                        var sr = _skirt3.GetComponent<Renderer>();
                        if (sr != null)
                        {
                            ring = $"{sr.bounds.size.x:F1} x {sr.bounds.size.z:F1} m";
                            // NOT `Camera.main` alone - it returned null in
                            // the player, because the camera that renders this
                            // build is not tagged MainCamera. Whatever is
                            // enabled and rendering is the camera the picture
                            // came out of.
                            var cam = Camera.main;
                            if (cam == null)
                                foreach (var c in Camera.allCameras)
                                    if (c != null && c.isActiveAndEnabled) { cam = c; break; }
                            if (cam != null)
                            {
                                var b = sr.bounds;
                                float x0 = float.MaxValue, y0 = float.MaxValue;
                                float x1 = float.MinValue, y1 = float.MinValue;
                                for (int i = 0; i < 8; i++)
                                {
                                    var corner = b.center + Vector3.Scale(b.extents,
                                        new Vector3((i & 1) == 0 ? -1 : 1,
                                                    (i & 2) == 0 ? -1 : 1,
                                                    (i & 4) == 0 ? -1 : 1));
                                    var sp = cam.WorldToScreenPoint(corner);
                                    x0 = Mathf.Min(x0, sp.x); x1 = Mathf.Max(x1, sp.x);
                                    y0 = Mathf.Min(y0, sp.y); y1 = Mathf.Max(y1, sp.y);
                                }
                                // AND THE COLUMN'S OWN RECT, because what a
                                // ring needs is room outside the cap. Bright
                                // pixels cannot find the cap - by 1.5 s it has
                                // cooled to a mid grey - so it is measured
                                // from the renderers, like the skirt.
                                float cx0 = float.MaxValue, cy0 = float.MaxValue;
                                float cx1 = float.MinValue, cy1 = float.MinValue;
                                if (_mushroomSkins != null)
                                    foreach (var other in _mushroomSkins)
                                    {
                                        if (other == null || other.transform == _skirt3) continue;
                                        var ob = other.bounds;
                                        for (int i = 0; i < 8; i++)
                                        {
                                            var corner = ob.center + Vector3.Scale(ob.extents,
                                                new Vector3((i & 1) == 0 ? -1 : 1,
                                                            (i & 2) == 0 ? -1 : 1,
                                                            (i & 4) == 0 ? -1 : 1));
                                            var sp2 = cam.WorldToScreenPoint(corner);
                                            cx0 = Mathf.Min(cx0, sp2.x); cx1 = Mathf.Max(cx1, sp2.x);
                                            cy0 = Mathf.Min(cy0, sp2.y); cy1 = Mathf.Max(cy1, sp2.y);
                                        }
                                    }
                                // WHERE THE GROUND IS UNDER THE WHOLE DISC,
                                // not only under its middle. The lift rests
                                // the mesh's lowest vertex on Ground() at the
                                // centre; the terrain rolls, so the rim can
                                // still be under it. The mesh's underside is
                                // taken as `bounds.min.y` - the streamed mesh
                                // has Read/Write off, so its vertices cannot
                                // be walked - and extY says how flat that is.
                                float rr = Mathf.Max(b.extents.x, b.extents.z);
                                var probe = new (string, float, float)[]
                                {
                                    ("centre", 0f, 0f), ("N", 0f, rr), ("E", rr, 0f),
                                    ("S", 0f, -rr), ("W", -rr, 0f),
                                };
                                var tab = new System.Text.StringBuilder();
                                foreach (var (nm, dx, dz) in probe)
                                {
                                    float gy = Ground(b.center.x + dx, b.center.z + dz);
                                    tab.Append($" {nm} g{gy:F2} buried{(gy - b.min.y):+0.00;-0.00}");
                                }
                                Debug.Log($"[cloud] ground under the skirt: mesh y {b.min.y:F2}"
                                          + $"..{b.max.y:F2} extY {b.size.y:F2} r {rr:F1} m;{tab}");
                                Debug.Log($"[cloud] column rect {cx0:F0},{cy0:F0} "
                                          + $"{(cx1 - cx0):F0}x{(cy1 - cy0):F0} px vs skirt "
                                          + $"{x0:F0},{y0:F0} {(x1 - x0):F0}x{(y1 - y0):F0} px");
                                seen = $"visible {sr.isVisible}, rect {x0:F0},{y0:F0} "
                                     + $"{(x1 - x0):F0}x{(y1 - y0):F0} px of "
                                     + $"{Screen.width}x{Screen.height}, "
                                     // WHERE IT IS IN THE WORLD, at the frame
                                     // that is photographed rather than at
                                     // dress time. A disc that is drawing but
                                     // sits under the terrain photographs
                                     // exactly like one that never rasterizes.
                                     + $"y {b.min.y:F2}..{b.max.y:F2} ground "
                                     + $"{Ground(b.center.x, b.center.z):F2} at "
                                     + $"{b.center.x:F1},{b.center.z:F1}";
                            }
                        }
                    }
                    string whole = "none";
                    if (_mushroomSkins != null && _mushroomSkins.Length > 0)
                    {
                        var wb = _mushroomSkins[0].bounds;
                        for (int k = 1; k < _mushroomSkins.Length; k++)
                            wb.Encapsulate(_mushroomSkins[k].bounds);
                        whole = $"{wb.size.x:F1} x {wb.size.y:F1} x {wb.size.z:F1} m";
                    }
                    if (!_countedWreckage && _cloud > 1f)
                    {
                        _countedWreckage = true;
                        CountTheWreckage(_cloudAt);
                    }
                    // IS THE CAP IN THE PICTURE, and how much of it. Not
                    // the column, not the skirt: M1.d says the head of the
                    // cloud is not seen from the driving camera, so the head
                    // is what is measured - in frustum or not, and the share
                    // of the frame it covers.
                    string cap = "no cap";
                    if (_cap3 != null)
                    {
                        var cr = _cap3.GetComponent<Renderer>();
                        var cam3 = Camera.main;
                        if (cam3 == null)
                            foreach (var cc in Camera.allCameras)
                                if (cc != null && cc.isActiveAndEnabled) { cam3 = cc; break; }
                        if (cr != null && cam3 != null)
                        {
                            var cb = cr.bounds;
                            float ax0 = float.MaxValue, ay0 = float.MaxValue;
                            float ax1 = float.MinValue, ay1 = float.MinValue;
                            bool front = false;
                            for (int i = 0; i < 8; i++)
                            {
                                var corner = cb.center + Vector3.Scale(cb.extents,
                                    new Vector3((i & 1) == 0 ? -1 : 1,
                                                (i & 2) == 0 ? -1 : 1,
                                                (i & 4) == 0 ? -1 : 1));
                                var sp3 = cam3.WorldToScreenPoint(corner);
                                if (sp3.z > 0f) front = true;
                                ax0 = Mathf.Min(ax0, sp3.x); ax1 = Mathf.Max(ax1, sp3.x);
                                ay0 = Mathf.Min(ay0, sp3.y); ay1 = Mathf.Max(ay1, sp3.y);
                            }
                            float ox = Mathf.Max(0f, Mathf.Min(ax1, Screen.width) - Mathf.Max(ax0, 0f));
                            float oy = Mathf.Max(0f, Mathf.Min(ay1, Screen.height) - Mathf.Max(ay0, 0f));
                            float share = front ? 100f * ox * oy / (Screen.width * Screen.height) : 0f;
                            cap = $"cap visible {cr.isVisible}, in front {front}, "
                                + $"rect {ax0:F0},{ay0:F0} {(ax1 - ax0):F0}x{(ay1 - ay0):F0}, "
                                + $"on screen {ox:F0}x{oy:F0} px = {share:F1}% of the frame";
                        }
                    }
                    Debug.Log($"[cap] t={_cloud:F1}s {cap}");
                    Debug.Log($"[cloud] t={_cloud:F1}s cloud {whole} body "
                              + $"{meshBody.r:F2},{meshBody.g:F2},{meshBody.b:F2} glow "
                              + $"{meshGlow.r:F2},{meshGlow.g:F2},{meshGlow.b:F2}, "
                              + $"skirt {ring}, {seen}");
                }
                return;
            }

            if (_stem == null) return;
            float rise = Mathf.Clamp01(_cloud / Rise);
            float grow = 1f - Mathf.Exp(-3.2f * _cloud);      // fast, then easing
            float fade = Mathf.Clamp01((Gone - _cloud) / (Gone - Rise));

            float high = StemHigh * rise * fade;
            _stem.localScale = new Vector3(StemWide * grow, high * 0.5f, StemWide * grow);
            _stem.position = _cloudAt + Vector3.up * (high * 0.5f);

            float capw = CapWide * grow * fade;
            _cap.localScale = new Vector3(capw, capw * 0.55f, capw);
            _cap.position = _cloudAt + Vector3.up * high;

            // The skirt is the dust the blast pushes out along the ground, so it
            // spreads wider than the cap and never leaves the surface.
            float skirt = CapWide * 1.5f * grow * fade;
            _skirt.localScale = new Vector3(skirt, skirt * 0.22f, skirt);
            _skirt.position = _cloudAt + Vector3.up * (skirt * 0.08f);

            Heat(_cloud, out var body, out var glow);
            foreach (var t in new[] { _stem, _cap, _skirt })
            {
                var mr = t.GetComponent<MeshRenderer>();
                mr.GetPropertyBlock(_block);
                _block.SetColor("_BaseColor", body);
                _block.SetColor("_EmissionColor", glow);
                mr.SetPropertyBlock(_block);
            }
        }

        /* --------------------------------------------------- the ground left */

        /// <summary>
        /// The contamination in every open crater, rebuilt whenever the drawn
        /// ground moves.
        ///
        /// Keyed to `MempoolTerrain.Version` rather than to the core's crater
        /// list, so the glow cannot appear before the hole it is lying in: the
        /// terrain holds the hole shut until the bomb lands, and this follows
        /// the terrain. The bowl itself is not drawn here - it is the ground.
        /// </summary>
        void Glow()
        {
            if (terrain == null || !ArenaCore.HasSurface) return;
            if (terrain.Version != _seenTerrain)
            {
                _seenTerrain = terrain.Version;
                Rebuild();
                Debug.Log($"[strike] glow follows the ground: {terrain.DrawnCraters.Count} open crater(s)");
            }

            // Contamination does not sit still.
            float pulse = 0.55f + 0.45f * Mathf.Sin(Time.time * 1.7f);   // 0.10 .. 1.00
            for (int i = 0; i < _glows.Count; i++)
            {
                if (!_glows[i].gameObject.activeSelf) continue;
                var mr = _glows[i].GetComponent<MeshRenderer>();
                mr.GetPropertyBlock(_block);
                _block.SetColor("_EmissionColor", new Color(0.10f, 0.34f, 0.09f) * pulse);
                mr.SetPropertyBlock(_block);
            }
        }

        void Rebuild()
        {
            // The terrain's OWN list, not the core's: a crater the ground has
            // not opened yet must not be glowing, and the terrain is the only
            // thing that knows which ones it drew.
            var open = terrain.DrawnCraters;
            int n = open.Count;
            while (_glows.Count < n) _glows.Add(NewGlow());
            for (int i = 0; i < _glows.Count; i++) _glows[i].gameObject.SetActive(i < n);

            for (int i = 0; i < n; i++)
            {
                float r = open[i].y;
                var at = new Vector3(open[i].x, 0f, open[i].z);
                var mf = _glows[i].GetComponent<MeshFilter>();
                ContaminationMesh(mf.sharedMesh, at.x, at.z, r);
                // The mesh is built in WORLD coordinates, so the object itself
                // has to sit at the origin however its parent is placed.
                _glows[i].SetPositionAndRotation(Vector3.zero, Quaternion.identity);
                _glows[i].localScale = Vector3.one;
            }
        }

        Transform NewGlow()
        {
            var go = new GameObject("CraterGlow");
            go.transform.SetParent(transform, true);
            go.AddComponent<MeshFilter>().sharedMesh = new Mesh { name = "CraterGlow" };
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterial = _glow;
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            return go.transform;
        }

        /// <summary>
        /// The contamination on the ground: a band on the crater's own edge and
        /// a scatter of patches inside it, laid on the CORE's surface.
        ///
        /// A FILLED DISC WAS WRONG. It covered the whole bowl, and an opaque
        /// surface does not tint what is under it - it replaces it. Photographed
        /// from the rim the crater read as a flat green plate with the curve
        /// gone, and from the middle the entire frame was green with no ground
        /// left in it. Taking the emission from 1.4 down to 0.34 changed the
        /// shade and not the fault: it was still paint, just darker paint.
        ///
        /// So the floor is left alone and the shape carries itself. The band
        /// sits between 0.90 and 1.00 of the crater's radius, which is the very
        /// line `ArenaCore.Irradiated` tests - `dx*dx + dz*dz < r*r` - so the
        /// player is shown where the dose actually begins rather than a painted
        /// guess at it. The patches say the inside is not clean.
        ///
        /// Every vertex is `ArenaCore.SurfaceAt` plus a little clearance, so this
        /// cannot disagree with the ground it lies on however the crater rule
        /// changes. Nothing here is a second bowl and nothing is simulated.
        /// </summary>
        void ContaminationMesh(Mesh mesh, float cx, float cz, float radius)
        {
            const int Segs = 48;          // the band
            const int Patches = 9, PatchSegs = 8;
            const float Inner = 0.90f;

            var verts = new List<Vector3>(Segs * 2 + Patches * (PatchSegs + 1));
            var tris = new List<int>(Segs * 6 + Patches * PatchSegs * 3);

            // --- the band on the edge ---------------------------------------
            for (int ring = 0; ring < 2; ring++)
            {
                float rr = radius * (ring == 0 ? Inner : 1f);
                for (int s = 0; s < Segs; s++)
                {
                    float a = s * Mathf.PI * 2f / Segs;
                    float x = cx + Mathf.Cos(a) * rr, z = cz + Mathf.Sin(a) * rr;
                    verts.Add(new Vector3(x, Surface(x, z), z));
                }
            }
            for (int s = 0; s < Segs; s++)
            {
                // Wound so the normal is UP. An earlier cut had both loops the
                // other way round and the whole thing was culled - correctly
                // built, correctly placed, and facing the rock.
                int a = s, b = (s + 1) % Segs, c = a + Segs, d = b + Segs;
                tris.Add(a); tris.Add(b); tris.Add(c);
                tris.Add(b); tris.Add(d); tris.Add(c);
            }

            // --- patches inside ---------------------------------------------
            // Placed from the crater's own position, so they are the same every
            // frame and every session: a scatter that crawled about would read
            // as an effect rather than as ground.
            uint seed = (uint)(Mathf.RoundToInt(cx * 8f) * 73856093)
                      ^ (uint)(Mathf.RoundToInt(cz * 8f) * 19349663) ^ 0x9E3779B9u;
            float Next()
            {
                seed = seed * 1664525u + 1013904223u;
                return (seed >> 8) / 16777216f;
            }

            for (int k = 0; k < Patches; k++)
            {
                float ang = Next() * Mathf.PI * 2f;
                float rad = radius * (0.15f + Next() * 0.62f);
                float size = radius * (0.06f + Next() * 0.06f);
                float px = cx + Mathf.Cos(ang) * rad, pz = cz + Mathf.Sin(ang) * rad;

                int b0 = verts.Count;
                verts.Add(new Vector3(px, Surface(px, pz), pz));
                for (int s = 0; s < PatchSegs; s++)
                {
                    float a = s * Mathf.PI * 2f / PatchSegs;
                    float x = px + Mathf.Cos(a) * size, z = pz + Mathf.Sin(a) * size;
                    verts.Add(new Vector3(x, Surface(x, z), z));
                }
                for (int s = 0; s < PatchSegs; s++)
                {
                    tris.Add(b0);
                    tris.Add(b0 + 1 + (s + 1) % PatchSegs);
                    tris.Add(b0 + 1 + s);
                }
            }

            mesh.Clear();
            mesh.SetVertices(verts);
            mesh.SetTriangles(tris, 0);
            mesh.RecalculateNormals();
            mesh.RecalculateBounds();
        }

        /// <summary>
        /// A quarter of a metre of clearance, not a centimetre. This disc is a
        /// coarser grid than the terrain's own, and a coarse chord across a dish
        /// lies below a fine one - so a thin offset buried the glow in the very
        /// bowl it is drawn to fill.
        /// </summary>
        float Surface(float x, float z) => ArenaCore.SurfaceAt(x, z) + 0.25f;

        float Ground(float x, float z) =>
            roads != null ? roads.SurfaceHeight(x, z)
                          : (ArenaCore.HasSurface ? ArenaCore.SurfaceAt(x, z)
                                                 : (terrain != null ? terrain.SampleSurface(x, z) : 0f));

        /// <summary>
        /// THE CORE'S SURFACE, AND NOTHING LAID ON TOP OF IT (2026-09-16).
        ///
        /// `Ground` above answers with the ROAD DECK wherever there is one:
        /// `RoadNetwork.SurfaceHeight` returns the ribbon's own chord plus
        /// `lift` (0.45 m), faded across a 2.6 m shoulder. That is right for a
        /// tyre, which really does stand on the deck, and wrong for a strike,
        /// which is the core's own event happening to the core's own ground.
        ///
        /// Measured on the Daily before this existed: a strike at 4.3,-41.5 -
        /// inside a lane - rested its stem 0.56 m and then 0.75 m above
        /// `SurfaceAt` at the very same x,z, because the deck was standing in
        /// for the ground.
        ///
        /// The fallback is the bare terrain, not `Ground`, so no road can reach
        /// the cloud by another route; it exists only for the Editor, where
        /// `ArenaInit` returns 0 and there is no core to ask.
        /// </summary>
        float CoreGround(float x, float z) =>
            ArenaCore.HasSurface ? ArenaCore.SurfaceAt(x, z)
                                : (terrain != null ? terrain.SampleSurface(x, z) : 0f);

        /* --------------------------------------------------- the stand-ins */

        Transform Part(Transform parent, PrimitiveType kind, Vector3 at, Vector3 scale,
                       Vector3 euler, Material mat)
        {
            var go = GameObject.CreatePrimitive(kind);
            var col = go.GetComponent<Collider>();
            if (col != null) Destroy(col);          // theatre does not collide with anything
            go.transform.SetParent(parent, false);
            go.transform.localPosition = at;
            go.transform.localRotation = Quaternion.Euler(euler);
            go.transform.localScale = scale;
            go.GetComponent<MeshRenderer>().sharedMaterial = mat;
            return go.transform;
        }

        /// <summary>
        /// Take the streamed airframe in place of the primitives.
        ///
        /// It arrives late and it may never arrive at all - a bundle can 404 -
        /// so the primitives stay as the thing that flies until it lands, and
        /// the swap happens between sorties rather than in the middle of one.
        /// </summary>
        public void SetAirframe(GameObject prefab)
        {
            if (prefab == null) return;
            _airframe = prefab;
            if (_plane != null && _wearing == "default") { Destroy(_plane.gameObject); _plane = null; }
            Debug.Log("[strike] airframe model taken");
        }

        /// <summary>Take the streamed bomb in place of the primitive one.</summary>
        public void SetBombModel(GameObject prefab)
        {
            if (prefab == null) return;
            _bombModel = prefab;
            if (_bomb != null) { Destroy(_bomb.gameObject); _bomb = null; }
            Debug.Log("[strike] bomb model taken");
        }

        /// <summary>Take the bull-skinned airframe, if one is ever built.</summary>
        public void SetBullAirframe(GameObject prefab)
        {
            if (prefab == null) return;
            _bullAirframe = prefab;
            Debug.Log("[strike] bull airframe taken");
        }

        /// <summary>Take the bear-skinned airframe.</summary>
        public void SetBearAirframe(GameObject prefab)
        {
            if (prefab == null) return;
            _bearAirframe = prefab;
            Debug.Log("[strike] bear airframe taken");
        }

        /// <summary>
        /// Who submitted the liquidation that is about to arm a strike - and it
        /// comes PAST the core, not through it.
        ///
        /// The core takes a size and nothing else. It has no side word on the
        /// liquidation, no field on the strike, and it must not grow one: which
        /// mesh hangs in the sky cannot be allowed to change a crater, a dose or
        /// a digest. The feed already knows - `MarketFeed.Liquidation.Long`, read
        /// off Binance's "S" == "SELL" - so the picture reads it there and the
        /// simulation never hears about it.
        ///
        /// `null` means nobody knows: the simulated liquidation that fires after
        /// ninety seconds of silence carries no side, so it flies the default
        /// airframe rather than an invented one.
        /// </summary>
        public void NoteSubmitter(bool? bear, double usd, string venue = null)
        {
            // FOLLOW THE ONE THE CORE WILL KEEP. `submitLiquidation` takes the
            // LARGEST size still pending for the next tick, and takes the first
            // of a tie. A latch that simply remembered the last side put one
            // liquidation's airframe over another's crater whenever two landed
            // inside the same tick - rare, and wrong every time it happened.
            // Same rule, mirrored: strictly greater wins, so the first of a tie
            // stays, exactly as it does in the core.
            //
            // COMPARED IN THE CORE'S OWN UNITS, not in dollars. The core sees
            // millions in Q16.16, one step of which is $15.26, so $5,000,000
            // and $5,000,005 are one size to it and it keeps the FIRST. In raw
            // dollars this latch would have kept the second and dressed the
            // bomber in its side over the other one's crater - the same fault
            // one resolution down. `ArenaCore.Scale` is the one place that says
            // what a size is worth.
            //
            // READ THE SERIAL HERE, do not wait for Update to notice it. The
            // core is stepped from `CoreDrivenTruck`'s accumulator and the
            // three components have no fixed Update order, so if that one runs
            // after this component the consumption is seen a frame late. A
            // liquidation arriving in that gap used to compare itself against a
            // size the core had already spent, lose to a dead one, and leave
            // the airframe wearing the wrong side. Measured with a forced
            // order, not guessed: StrikeLatchTests.
            Spent(ArenaCore.StrikeCount);

            // A COLLISION is two liquidations arriving before the core has
            // consumed the pending one - one drain of the sockets, one frame.
            // Logged from both directions, because the loser is the incoming
            // one or the one already waiting depending on which is bigger.
            if (_pendingUsd > 0.0)
            {
                bool incomingWins = usd > _pendingUsd;
                double kept = incomingWins ? usd : _pendingUsd;
                double dropped = incomingWins ? _pendingUsd : usd;
                bool? keptSide = incomingWins ? bear : _nextIsBear;
                bool? droppedSide = incomingWins ? _nextIsBear : bear;
                Debug.Log($"[strike] collision: keep ${kept:N0} {Side(keptSide)}" +
                          $", drop ${dropped:N0} {Side(droppedSide)}");
            }

            int size = ArenaCore.Scale(usd);
            if (size <= _pendingSize) return;
            _pendingSize = size;
            _pendingUsd = usd;
            _nextIsBear = bear;
            _pendingVenue = venue;
        }

        /// <summary>
        /// Which skin a side flies. A side with no model of its own flies the
        /// plain airframe on purpose - there is no bull model yet and none is
        /// faked, so a bull liquidation is drawn by the aircraft that has no
        /// side rather than by the wrong one, and "primitives" is the stand-in
        /// built from boxes when nothing has been streamed at all.
        ///
        /// Its own method so that the choice can be read back without a camera,
        /// a shader or a launch: StrikeLatchTests asks it what the bomber for a
        /// given side would wear.
        /// </summary>
        public string Wearing(bool? side)
        {
            if (side == true && _bearAirframe != null) return "bear";
            if (side == false && _bullAirframe != null) return "bull";
            return _airframe != null ? "default" : "primitives";
        }

        /// <summary>
        /// The core has taken whatever was pending at `serial`, so the queue
        /// starts empty again - and the side of what it took is HANDED OVER to
        /// the drawing, because by the time the bomber is built the latch may
        /// already hold a newer liquidation's side.
        ///
        /// Idempotent: called from `Update` when the serial is seen to move and
        /// from `NoteSubmitter` before every comparison, whichever gets there
        /// first in a frame. A second call with nothing pending leaves the
        /// handed-over side alone rather than wiping it.
        ///
        /// Public because `Update` cannot stand in for it in a test: it returns
        /// at once unless `ArenaCore.Available`, and the core is a stub outside
        /// a WebGL player. StrikeLatchTests drives this instead.
        /// </summary>
        public void Spent(int serial)
        {
            if (serial == _pendingSerial) return;
            if (_pendingUsd > 0.0)
            {
                // The one the core KEPT, not the last one that arrived and not
                // a sum of everything the feed saw. The latch already follows
                // the core's own rule - largest wins, first of a tie, compared
                // in the core's units - so what it is holding when the serial
                // moves is the liquidation that dug this crater. Its size and
                // its venue go over together, because a size off one order and
                // a venue off another would name a liquidation that never
                // happened.
                _armedSide = _nextIsBear;
                _armedUsd = _pendingUsd;
                _armedVenue = _pendingVenue;
            }
            _pendingSerial = serial;
            _pendingUsd = 0.0;
            _pendingSize = 0;
            _nextIsBear = null;
            _pendingVenue = null;
        }

        static string Side(bool? bear) => bear == null ? "no side" : (bear.Value ? "bear" : "bull");

        /// <summary>What the latch is holding for the core's next tick. Tests.</summary>
        public double PendingUsd => _pendingUsd;
        /// <summary>The side of what it is holding, null for none. Tests.</summary>
        public bool? PendingSide => _nextIsBear;
        /// <summary>The side of the liquidation the core has already taken.</summary>
        public bool? ArmedSide => _armedSide;

        /// <summary>What the core actually took for the crater standing now.</summary>
        public double ArmedUsd => _armedUsd;

        /// <summary>Which exchange that one came off, or null if nobody sent it.</summary>
        public string ArmedVenue => _armedVenue;

        bool? _nextIsBear;
        bool? _armedSide;
        double _armedUsd;
        string _pendingVenue, _armedVenue;
        double _pendingUsd;
        int _pendingSize;                 // the same size in the core's units
        int _pendingSerial = -1;
        string _wearing = "";
        GameObject _airframe, _bearAirframe, _bullAirframe, _bombModel;

        /// <summary>
        /// Sit a streamed model in the same box the primitives occupied.
        ///
        /// A model carries whatever units and whatever pose its author used, so
        /// nothing about it is worth trusting sight unseen. It is straightened
        /// first, then its own renderer bounds are measured, then it is scaled
        /// on its longest side to the size the flight was worked out against -
        /// 34 m for the airframe, which is the span the run-in, the altitude
        /// and the framing were all measured with.
        /// </summary>
        Transform Dress(GameObject prefab, float longest, Vector3 preRotate)
        {
            var go = Instantiate(prefab);
            go.name = prefab.name + "_flying";
            foreach (var c in go.GetComponentsInChildren<Collider>(true)) Destroy(c);

            // Straighten it before measuring. The bomb in this pack is authored
            // standing on its tail - measured 5.62 x 10.79 x 5.62 m, the long
            // axis on Y - and a bomb that falls pointing at the sky is worse
            // than a capsule.
            go.transform.rotation = Quaternion.Euler(preRotate);

            var rs = go.GetComponentsInChildren<Renderer>(true);
            if (rs.Length == 0) { Debug.LogWarning("[strike] model has no renderer"); return go.transform; }
            var b = rs[0].bounds;
            for (int i = 1; i < rs.Length; i++) b.Encapsulate(rs[i].bounds);
            Debug.Log($"[strike] model raw {b.size.x:F2} x {b.size.y:F2} x {b.size.z:F2} m");

            // Scale on the LONGEST side, whichever it turns out to be. Scaling
            // on the widest horizontal one put a 10.79 m upright bomb at 7.7 m
            // tall, because its widest horizontal side was never the size that
            // mattered.
            float big = Mathf.Max(b.size.x, Mathf.Max(b.size.y, b.size.z));
            if (big > 0.001f) go.transform.localScale *= longest / big;

            // Re-centre on its own middle, so the point the flight code moves is
            // the aircraft and not whatever the exporter called the origin.
            var holder = new GameObject("Bomber").transform;
            holder.SetParent(transform, true);
            go.transform.SetParent(holder, true);
            rs = holder.GetComponentsInChildren<Renderer>(true);
            b = rs[0].bounds;
            for (int i = 1; i < rs.Length; i++) b.Encapsulate(rs[i].bounds);
            go.transform.position -= (b.center - holder.position);
            return holder;
        }

        /// <summary>A stand-in four-engine bomber, about 24 m across the wing.</summary>
        Transform BuildPlane()
        {
            var root = new GameObject("StrikeBomber_StandIn").transform;
            root.SetParent(transform, false);

            Part(root, PrimitiveType.Cylinder, new Vector3(0f, 0f, 0f),
                 new Vector3(2.2f, 11f, 2.2f), new Vector3(90f, 0f, 0f), _metal);  // fuselage
            Part(root, PrimitiveType.Sphere, new Vector3(0f, 0f, 11.4f),
                 new Vector3(2.2f, 2.2f, 3.6f), Vector3.zero, _metal);             // nose
            Part(root, PrimitiveType.Cube, new Vector3(0f, -0.3f, 0.5f),
                 new Vector3(34f, 0.7f, 6f), Vector3.zero, _metal);                // wing
            Part(root, PrimitiveType.Cube, new Vector3(0f, 0.3f, -9f),
                 new Vector3(13f, 0.6f, 3.4f), Vector3.zero, _metal);              // tailplane
            Part(root, PrimitiveType.Cube, new Vector3(0f, 2.8f, -9.2f),
                 new Vector3(0.6f, 5f, 3.6f), Vector3.zero, _metal);               // fin
            foreach (float ex in new[] { -11f, -6f, 6f, 11f })
                Part(root, PrimitiveType.Cylinder, new Vector3(ex, -0.8f, 2f),
                     new Vector3(1.7f, 2.6f, 1.7f), new Vector3(90f, 0f, 0f), _metal);
            return root;
        }

        /// <summary>A stand-in atom bomb: fat body, boxy tail, about 4 m long.</summary>
        Transform BuildBomb()
        {
            var root = new GameObject("AtomBomb_StandIn").transform;
            root.SetParent(transform, false);
            Part(root, PrimitiveType.Capsule, Vector3.zero,
                 new Vector3(1.5f, 1.8f, 1.5f), new Vector3(90f, 0f, 0f), _bombSkin);
            Part(root, PrimitiveType.Cube, new Vector3(0f, 0f, -1.9f),
                 new Vector3(2.1f, 0.16f, 1.4f), Vector3.zero, _bombSkin);
            Part(root, PrimitiveType.Cube, new Vector3(0f, 0f, -1.9f),
                 new Vector3(0.16f, 2.1f, 1.4f), Vector3.zero, _bombSkin);
            return root;
        }
    }
}
