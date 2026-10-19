// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

namespace Arena
{
    /// <summary>
    /// Another player's truck, drawn and nothing else.
    ///
    /// Spec 0.9: "Other trucks are visible ghosts with no collision. Another
    /// player must not be able to change my financial odds by ramming me,
    /// blocking a road, pushing me, damaging me, drawing my enemies away,
    /// pulling enemies toward me, sacrificing themselves for me, or colluding
    /// physically."
    ///
    /// Spec 0.10: "Ghost snapshots are never inputs to this calculation."
    ///
    /// THE PROTOCOL ALREADY DECIDED WHERE THIS TRUCK WAS. A GHOSTS frame
    /// carries x, z and heading in Q16.16, bound to the head of the input
    /// chain the picture was taken from, so it is a picture of a run somebody
    /// published inputs for. This class turns those three numbers into a
    /// transform. It does not step anything, it holds no reference to the
    /// core, and it never writes a word of state.
    ///
    /// AND IT CARRIES NO PHYSICS. The local truck has a Rigidbody and
    /// WheelColliders because it is driven; a ghost has neither, because a
    /// ghost that could be collided with is a competitor who can block a road.
    /// The stripping in Awake is not tidying: a prefab, a model import or a
    /// careless edit can add a Collider, and the rule has to survive that
    /// rather than depend on nobody making the mistake. What is removed is
    /// counted and named, so a silent strip cannot hide a prefab that keeps
    /// growing colliders.
    /// </summary>
    [DisallowMultipleComponent]
    public class GhostTruck : MonoBehaviour
    {
        /// <summary>Q16.16, the units the core and the GHOSTS frame keep.</summary>
        public const float ONE = 65536f;

        /// <summary>How many physics parts were found and removed, and where.</summary>
        public int StrippedColliders { get; private set; }
        public int StrippedBodies { get; private set; }
        public string StrippedFrom { get; private set; } = "";

        void Awake() => StripPhysics();

        /// <summary>
        /// And again whenever a child appears.
        ///
        /// Awake runs once. A truck model is STREAMED in this project -
        /// `ModelStreamer` parents it later - and a model arrives with the
        /// colliders its author gave it, so a ghost that only stripped at Awake
        /// would be clean for a second and solid afterwards. Unity calls this
        /// when a child is added, which is exactly that moment.
        /// </summary>
        void OnTransformChildrenChanged() => StripPhysics();

        /// <summary>
        /// Removes every Collider and Rigidbody under this object.
        ///
        /// DestroyImmediate rather than Destroy: Destroy runs at the end of the
        /// frame, so a ghost spawned and stepped in the same frame would have
        /// had a live collider for exactly one physics tick - which is all a
        /// collision needs.
        /// </summary>
        public void StripPhysics()
        {
            StrippedColliders = 0;
            StrippedBodies = 0;
            var found = new System.Text.StringBuilder();

            foreach (var c in GetComponentsInChildren<Collider>(true))
            {
                if (c == null) continue;
                found.Append(c.GetType().Name).Append(" on ").Append(c.name).Append("; ");
                StrippedColliders++;
                DestroyImmediate(c);
            }
            foreach (var rb in GetComponentsInChildren<Rigidbody>(true))
            {
                if (rb == null) continue;
                found.Append("Rigidbody on ").Append(rb.name).Append("; ");
                StrippedBodies++;
                DestroyImmediate(rb);
            }
            StrippedFrom = found.ToString();
        }

        /// <summary>
        /// Place this ghost from a GHOSTS frame's three truck words.
        ///
        /// The words arrive as the protocol's integers and are divided here,
        /// at the edge, where a float is a picture rather than a result. The
        /// core never sees them again.
        /// </summary>
        public void Show(int x, int z, int heading) => Show(x, z, heading, null);

        /// <summary>
        /// The same picture, standing on a ground somebody worked out.
        ///
        /// A GHOSTS frame carries no height and cannot: the map is the fee
        /// histogram and it moves under every player, so where the road is at
        /// this x and z is a fact of THIS page's world, not of that player's
        /// run. `y` null keeps whatever height the object had.
        ///
        /// AND THE HEADING IS IN TURNS. The word is the core's T_HEADING, the
        /// same word `ArenaCore.TruckHeading` reads for the local truck, and the
        /// core measures a heading as a fraction of a full turn in Q16.16 -
        /// 16384 is a quarter turn, which is the 90 degrees the M1 build reads
        /// out at the start line. Dividing it by 65536 the way a metre is
        /// divided gave 0.25 degrees: a truck driving east drawn pointing
        /// north, on a word the local truck has always read correctly.
        /// </summary>
        public void Show(int x, int z, int heading, float? y) => Show(x, z, heading, y, null);

        /// <summary>
        /// The same picture, lying on the ground the way a truck of this shape lies on it.
        ///
        /// `lie` is `CoreDrivenTruck.Lie` at this pose - the pitch and roll of the four contact points, which is how
        /// the LOCAL truck is drawn and carries no physics: there is no rigidbody here, no collider, and nothing is
        /// simulated. Without it a ghost stood dead level on a hillside (2026-09-18 10:42, "ghosts have no
        /// physics, they must climb hills the same as his own truck"). Null keeps the flat heading, which is what a
        /// page with no ground of its own can say.
        /// </summary>
        public void Show(int x, int z, int heading, float? y, Quaternion? lie)
        {
            // THE WHOLE POSE IS THE PICTURE THAT JUST LANDED, IN THIS FRAME (2026-09-18 05:45).
            //
            // The place bound here first and the FACING was still walked from the pose before it over one ease - which
            // left the facing carrying exactly the whole-interval lag the place had just lost: in the frame a picture
            // landed the hull still pointed the way the PREVIOUS picture said. Measured against the same land-frame
            // clock on the Daily over 5813 pictures, the place was 38 ms old at the median and the facing 138 ms - a
            // whole publish interval more, which is the walk and nothing else.
            //
            // A heading is not a place, which is why it was walked - but at ten pictures a second a turn is a few
            // degrees per picture, not a spin, and the 17:05 stutter was a hull crossing metres of ground in one frame.
            // Nothing is extrapolated, no pose is invented between two pictures, and this reads no rigidbody, no
            // collider and no clock: the hull stands and points where the node proved it did, and waits there.
            _want = new Vector3(x / ONE, y ?? transform.position.y, z / ONE);
            _wantHeading = ArenaCore.Degrees(heading);
            _placed = true;
            _lie = lie;
            transform.SetPositionAndRotation(_want, Lying());
        }

        /// <summary>The hull's rotation: the ground's lie at this pose when the page knows it, the flat heading otherwise.</summary>
        Quaternion Lying() => _lie ?? Quaternion.Euler(0f, _wantHeading, 0f);
        Quaternion? _lie;

        /// <summary>The newest picture, exactly - which is where `Show` already put it.</summary>
        public void SnapToPicture()
        {
            if (_placed) transform.SetPositionAndRotation(_want, Lying());
        }

        /// <summary>
        /// Whether this ghost is on the picture it was last given - which is true the moment it is given one.
        ///
        /// This was a distance, then a walk that had to finish. Both were a second idea of arrival beside the
        /// callers': the drawn-pose tests assert to a ten-thousandth of a metre, and the frame a picture lands in is
        /// now the frame the hull stands and points at it. A ghost that was never shown anything is not settled, and
        /// that is the only thing left to say no to.
        /// </summary>
        public bool Settled => _placed;

        /// <summary>The picture this ghost is standing on.</summary>
        public Vector3 Wanted => _want;

        Vector3 _want;
        float _wantHeading;
        bool _placed;

        /// <summary>
        /// A ghost keeps no physics even if something adds it later.
        ///
        /// Called by the test that overlaps ghosts; a caller that spawns one
        /// per frame does not need it, because Awake already ran.
        /// </summary>
        public bool CarriesPhysics()
        {
            return GetComponentInChildren<Collider>(true) != null
                || GetComponentInChildren<Rigidbody>(true) != null;
        }
    }
}
