using System.Collections.Generic;
using UnityEngine;

namespace Blwp
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
        int _seenStrikes = -1;

        Material _metal, _bombSkin, _glow;
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
            if (!BlwpCore.Available) return;
            Fly(Time.deltaTime);
            Glow();

            // THE SERIAL, not `StrikeArmed`. `K_STATE` is set for exactly one
            // tick, and the core is stepped at 60 Hz from a frame loop: at the
            // ~2 fps a headless browser manages, a single frame runs thirty
            // ticks and reads the state once at the end, so the armed tick is
            // gone before anything can see it. Measured - the first cut of this
            // watched `StrikeArmed` and never launched once. `K_SERIAL` only
            // goes up, so an increment cannot be missed however slow the frame.
            int strikes = BlwpCore.StrikeCount;
            if (strikes == _seenStrikes) return;
            bool first = _seenStrikes < 0;
            _seenStrikes = strikes;
            if (first) return;                    // a reload, not a fresh strike
            Launch(BlwpCore.StrikeAt(0f));
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
            // side is decided.
            bool bear = _nextIsBear == true && _bearAirframe != null;
            if (_plane != null && bear != _planeIsBear) { Destroy(_plane.gameObject); _plane = null; }
            if (_plane == null)
            {
                var skin = bear ? _bearAirframe : _airframe;
                _plane = skin != null ? Dress(skin, 34f, Vector3.zero) : BuildPlane();
                _planeIsBear = bear;
                Debug.Log($"[strike] airframe {(skin == null ? "primitives" : (bear ? "bear" : "default"))}");
            }
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

        void Fly(float dt)
        {
            if (_t < 0f) return;
            _t += dt;

            float ran = Speed * _t;
            float toRelease = Vector3.Distance(_from, _impact) - ReleaseLead;
            Vector3 dir = (_to - _from).normalized;

            if (_plane != null && _plane.gameObject.activeSelf)
            {
                _plane.position = _from + dir * ran;
                if (ran > toRelease + Speed * RunOut) _plane.gameObject.SetActive(false);
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
                    Debug.Log($"[strike] impact at {_impact.x:F1},{_impact.z:F1}");
                }
            }
            if (_t > 20f) { _t = -1f; if (_plane != null) _plane.gameObject.SetActive(false); }
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
            if (terrain == null || !BlwpCore.HasSurface) return;
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
        /// line `BlwpCore.Irradiated` tests - `dx*dx + dz*dz < r*r` - so the
        /// player is shown where the dose actually begins rather than a painted
        /// guess at it. The patches say the inside is not clean.
        ///
        /// Every vertex is `BlwpCore.SurfaceAt` plus a little clearance, so this
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
        float Surface(float x, float z) => BlwpCore.SurfaceAt(x, z) + 0.25f;

        float Ground(float x, float z) =>
            roads != null ? roads.SurfaceHeight(x, z)
                          : (BlwpCore.HasSurface ? BlwpCore.SurfaceAt(x, z)
                                                 : (terrain != null ? terrain.SampleSurface(x, z) : 0f));

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
            if (_plane != null && !_planeIsBear) { Destroy(_plane.gameObject); _plane = null; }
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

        /// <summary>Take the bear-skinned airframe. There is no bull one yet.</summary>
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
        public void NoteSubmitter(bool? bear) => _nextIsBear = bear;

        bool? _nextIsBear;
        bool _planeIsBear;
        GameObject _airframe, _bearAirframe, _bombModel;

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
