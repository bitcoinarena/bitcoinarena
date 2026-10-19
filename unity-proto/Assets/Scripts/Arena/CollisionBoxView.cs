// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

namespace Arena
{
    /// <summary>
    /// THE COLLISION IS VISIBLE (2026-09-25 20:56, again 20:57: visible collisions, before testnet - the miner and
    /// the post office, "the post office is the mempool building").
    ///
    /// What is coloured is what the truck is resolved against: the core's own boxes (st.solids, rules/map.js), read back
    /// through <see cref="ArenaCore.Solids"/> - not a renderer's bounds and not a tag, which are what Unity draws and not
    /// what the core stops the truck on. Only the boxes the truck's body can reach are drawn, by the core's own vertical
    /// rule (solids.js pushOut): a box whose foot is above the ground plus BODY_HEIGHT is a lintel the truck drives under.
    ///
    /// Translucent faces with solid edges, depth-tested and not written to depth, so the building stays drawn and
    /// readable through the colour. No collider: this is a picture of the collision, not a second one.
    /// </summary>
    public class CollisionBoxView : MonoBehaviour
    {
        /// <summary>solids.js BODY_HEIGHT, 3.26 m: a box whose foot is higher than this above the floor is driven under.</summary>
        public const int BodyHeight = 213811;

        public static readonly Color PostOffice = new Color(0.10f, 0.85f, 1.00f, 0.30f);
        public static readonly Color Miner = new Color(1.00f, 0.25f, 0.85f, 0.30f);
        const float EdgeAlpha = 0.95f;

        /// <summary>The core's pushOut test, for a box standing on <paramref name="floor"/>: can the truck's body reach it?</summary>
        public static bool TruckCanHit(int yLow, int yHigh, int floor) => yLow <= floor + BodyHeight && yHigh >= floor;

        /// <summary>Which building a box belongs to: the post office stands west of the centre line, the miner east.</summary>
        public static Color ColourOf(int cx) => cx < 0 ? PostOffice : Miner;

        readonly int[] _words = new int[6 * 256];
        int[] _drawn = new int[0];
        int _epoch = int.MinValue;
        float _askedAt = -10f;
        Mesh _mesh;
        Material _material;

        /// <summary>How many boxes are drawn, and how many the core holds - read by the measurement.</summary>
        public int Drawn { get; private set; }
        public int Held { get; private set; }

        void Update()
        {
            if (!ArenaCore.Available) return;
            if (Time.unscaledTime - _askedAt < 0.5f && _epoch == ArenaCore.ReliefEpoch) return;
            _askedAt = Time.unscaledTime;
            int n = ArenaCore.Solids(_words);
            n = Mathf.Min(n, _words.Length / 6);
            if (_epoch == ArenaCore.ReliefEpoch && Same(n)) return;
            _epoch = ArenaCore.ReliefEpoch;
            _drawn = new int[n * 6];
            System.Array.Copy(_words, _drawn, n * 6);
            Build(n);
        }

        bool Same(int n)
        {
            if (_drawn.Length != n * 6) return false;
            for (int i = 0; i < n * 6; i++) if (_drawn[i] != _words[i]) return false;
            return true;
        }

        void Build(int n)
        {
            if (_mesh == null)
            {
                _mesh = new Mesh { name = "core collision boxes" };
                _mesh.MarkDynamic();
                gameObject.AddComponent<MeshFilter>().sharedMesh = _mesh;
                _material = new Material(Shader.Find("Sprites/Default")) { renderQueue = 3100 };
                var r = gameObject.AddComponent<MeshRenderer>();
                r.sharedMaterials = new[] { _material, _material };
                r.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
                r.receiveShadows = false;
            }
            var verts = new List<Vector3>();
            var colours = new List<Color>();
            var faces = new List<int>();
            var edges = new List<int>();
            int drawn = 0;
            const float ONE = ArenaCore.ONE;
            for (int i = 0; i < n; i++)
            {
                int o = i * 6;
                int cx = _words[o], cz = _words[o + 1], hx = _words[o + 2], hz = _words[o + 3];
                int yLow = _words[o + 4], yHigh = _words[o + 5];
                int floor = Mathf.RoundToInt(ArenaCore.SurfaceAt(cx / ONE, cz / ONE) * ONE);
                if (!TruckCanHit(yLow, yHigh, floor)) continue;
                drawn++;
                var lo = new Vector3((cx - hx) / ONE, yLow / ONE, (cz - hz) / ONE);
                var hi = new Vector3((cx + hx) / ONE, yHigh / ONE, (cz + hz) / ONE);
                var c = ColourOf(cx);
                AddBox(verts, colours, faces, edges, lo, hi, c, new Color(c.r, c.g, c.b, EdgeAlpha));
            }
            Held = n;
            Drawn = drawn;
            _mesh.Clear();
            _mesh.SetVertices(verts);
            _mesh.SetColors(colours);
            _mesh.subMeshCount = 2;
            _mesh.SetIndices(faces, MeshTopology.Triangles, 0);
            _mesh.SetIndices(edges, MeshTopology.Lines, 1);
            _mesh.RecalculateBounds();
            Debug.Log($"[collision] the core holds {n} boxes; {drawn} the truck can hit are drawn "
                      + $"({CountWest(n)} post office, {drawn - CountWest(n)} miner)");
        }

        int CountWest(int n)
        {
            int k = 0;
            const float ONE = ArenaCore.ONE;
            for (int i = 0; i < n; i++)
            {
                int o = i * 6;
                int floor = Mathf.RoundToInt(ArenaCore.SurfaceAt(_words[o] / ONE, _words[o + 1] / ONE) * ONE);
                if (_words[o] < 0 && TruckCanHit(_words[o + 4], _words[o + 5], floor)) k++;
            }
            return k;
        }

        static readonly int[] Quads =
        {
            0, 1, 2, 3,   4, 7, 6, 5,   0, 4, 5, 1,   3, 2, 6, 7,   0, 3, 7, 4,   1, 5, 6, 2,
        };
        static readonly int[] Lines = { 0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7 };

        static void AddBox(List<Vector3> v, List<Color> c, List<int> faces, List<int> edges,
                           Vector3 lo, Vector3 hi, Color face, Color edge)
        {
            var corners = new[]
            {
                new Vector3(lo.x, lo.y, lo.z), new Vector3(hi.x, lo.y, lo.z), new Vector3(hi.x, lo.y, hi.z), new Vector3(lo.x, lo.y, hi.z),
                new Vector3(lo.x, hi.y, lo.z), new Vector3(hi.x, hi.y, lo.z), new Vector3(hi.x, hi.y, hi.z), new Vector3(lo.x, hi.y, hi.z),
            };
            int f = v.Count;
            foreach (var p in corners) { v.Add(p); c.Add(face); }
            for (int q = 0; q < Quads.Length; q += 4)
            {
                faces.Add(f + Quads[q]); faces.Add(f + Quads[q + 1]); faces.Add(f + Quads[q + 2]);
                faces.Add(f + Quads[q]); faces.Add(f + Quads[q + 2]); faces.Add(f + Quads[q + 3]);
            }
            int e = v.Count;
            foreach (var p in corners) { v.Add(p); c.Add(edge); }
            foreach (int l in Lines) edges.Add(e + l);
        }
    }
}
