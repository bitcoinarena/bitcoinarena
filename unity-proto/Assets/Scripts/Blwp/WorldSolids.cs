using System.Collections.Generic;
using UnityEngine;

namespace Blwp
{
    /// <summary>
    /// Collects the boxes the truck must not drive through, for the core.
    ///
    /// Harvested from the scene rather than described a second time. The
    /// buildings are already colliders that PhysX was resolving against before
    /// the core took the driving over, and writing their geometry out again by
    /// hand is how the collision world and the visible world come to disagree.
    ///
    /// What is deliberately left out:
    ///   - anything with a Rigidbody, which is a moving thing and not scenery
    ///   - triggers, which are there to notice the truck, not to stop it
    ///   - the loading panel's own layer, which is rendered off the map
    ///   - the truck itself
    /// </summary>
    public static class WorldSolids
    {
        public const int Words = 6;      // cx, cz, hx, hz, yLow, yHigh
        public const int Max = 512;

        /// <summary>True if this collider is part of the solid world.</summary>
        public static bool IsWorld(BoxCollider c, Transform truck)
        {
            if (c == null || !c.enabled || c.isTrigger) return false;
            if (!c.gameObject.activeInHierarchy) return false;
            if (c.gameObject.layer == PackageYard.YardLayer) return false;
            if (c.attachedRigidbody != null) return false;
            if (truck != null && c.transform.IsChildOf(truck)) return false;
            return true;
        }

        /// <summary>
        /// The world as Q16.16 boxes. Axis-aligned in XZ, which is what every
        /// static collider in this game is; a rotated one is taken by its
        /// bounds, which is wider than the box but never lets the truck
        /// through something it should not.
        /// </summary>
        public static int[] Gather(Transform truck, out int count)
        {
            var found = new List<int>(Max * Words);
            count = 0;

            foreach (var c in Object.FindObjectsByType<BoxCollider>(FindObjectsSortMode.None))
            {
                if (!IsWorld(c, truck)) continue;
                if (count >= Max) break;

                var b = c.bounds;
                if (b.size.x <= 0.01f || b.size.z <= 0.01f) continue;

                found.Add(Mathf.RoundToInt(b.center.x * 65536f));
                found.Add(Mathf.RoundToInt(b.center.z * 65536f));
                found.Add(Mathf.RoundToInt(b.extents.x * 65536f));
                found.Add(Mathf.RoundToInt(b.extents.z * 65536f));
                found.Add(Mathf.RoundToInt(b.min.y * 65536f));
                found.Add(Mathf.RoundToInt(b.max.y * 65536f));
                count++;
            }
            return found.ToArray();
        }
    }
}
