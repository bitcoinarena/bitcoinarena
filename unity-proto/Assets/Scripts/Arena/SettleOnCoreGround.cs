// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System.Collections.Generic;
using UnityEngine;

namespace Arena
{
    /// <summary>
    /// Keeps things that were set down once sitting on the ground the CORE says.
    ///
    /// Most of the map follows the ground because something asks for it every
    /// frame. The map's edge barriers do not: `Bootstrap.BuildBoundary` samples
    /// the relief once, at scene build, and never looks again. That was already
    /// only half true - the terrain IS the fee histogram and moves under them
    /// all session - and a crater makes it plainly false, because a strike at
    /// the seam can take the ground out from under a wall and leave it standing
    /// on nothing.
    ///
    /// So: register what was placed, and put it back whenever the drawn ground
    /// moves. `MempoolTerrain.Version` counts every rebuild, and the terrain now
    /// rebuilds for a crater as well as for a mempool poll, so one watch covers
    /// both.
    ///
    /// No new rule and no new sampling. Each thing is set down again at exactly the
    /// point it was placed from, with exactly the lift it was given; only the
    /// surface underneath is the core's rather than Unity's.
    /// </summary>
    public class SettleOnCoreGround : MonoBehaviour
    {
        public MempoolTerrain terrain;

        readonly List<(Transform t, float x, float z, float lift)> _held =
            new List<(Transform, float, float, float)>();
        int _seen = -1;

        /// <summary>Take this over, at the point and lift it was placed with.</summary>
        public void Hold(Transform t, float x, float z, float lift)
        {
            if (t != null) _held.Add((t, x, z, lift));
        }

        void Update()
        {
            if (terrain == null || terrain.Version == _seen) return;
            _seen = terrain.Version;
            foreach (var (t, x, z, lift) in _held)
                if (t != null) t.position = new Vector3(x, Surface(x, z) + lift, z);
        }

        /// <summary>
        /// The core's surface - relief less craters - or, where no core answers,
        /// the same analytic relief `BuildBoundary` used at scene build.
        /// </summary>
        public float Surface(float x, float z) =>
            ArenaCore.HasSurface ? ArenaCore.SurfaceAt(x, z)
                                : (terrain != null ? terrain.SampleWorld(x, z) : 0f);
    }
}
