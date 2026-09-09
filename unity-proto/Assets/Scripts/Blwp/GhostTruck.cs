using UnityEngine;

namespace Blwp
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
        /// same word `BlwpCore.TruckHeading` reads for the local truck, and the
        /// core measures a heading as a fraction of a full turn in Q16.16 -
        /// 16384 is a quarter turn, which is the 90 degrees the M1 build reads
        /// out at the start line. Dividing it by 65536 the way a metre is
        /// divided gave 0.25 degrees: a truck driving east drawn pointing
        /// north, on a word the local truck has always read correctly.
        /// </summary>
        public void Show(int x, int z, int heading, float? y)
        {
            // WHERE IT IS NOW BECOMES WHERE IT IS COMING FROM.
            _from = _placed ? transform.position : new Vector3(x / ONE, y ?? transform.position.y, z / ONE);
            _fromHeading = _placed ? transform.rotation.eulerAngles.y : BlwpCore.Degrees(heading);
            _want = new Vector3(x / ONE, y ?? transform.position.y, z / ONE);
            _wantHeading = BlwpCore.Degrees(heading);
            _since = 0f;
            // THE FIRST PICTURE IS NOT A MOVE. There is nowhere to come from,
            // and easing in from wherever a fresh clone happened to be is a
            // truck sliding out of the origin.
            if (!_placed) { _placed = true; SnapToPicture(); }
        }

        /// <summary>
        /// BETWEEN PICTURES, BECAUSE THEY ARRIVE AT 10 Hz AND A SCREEN DOES NOT.
        ///
        /// `BlwpNet.BatchEvery` is a tenth of a second, so a picture of another
        /// truck lands at most ten times a second while the page draws sixty
        /// times a second. Placing it and then leaving it is a truck that
        /// stands still for six frames and jumps - 1.5 m at 15 m/s - and that
        /// is the stutter the 17:05 close-out reported, in arithmetic rather
        /// than in impressions. The local truck has never looked like that: it
        /// interpolates between its own last two ticks, every frame, and this
        /// is the same rule for the same reason.
        ///
        /// IT WALKS FROM THE LAST PICTURE TO THIS ONE OVER ONE INTERVAL, and
        /// then it is exactly on it. Not an exponential chase: that never
        /// arrives, and how far it got would depend on the frame rate rather
        /// than on the clock - which in a headless batch run, where frames are
        /// a third of a millisecond apart, is the difference between arriving
        /// and crawling.
        ///
        /// EASING IS PER FRAME AND NOT PER PICTURE. `Draw(PerFrame)` can take
        /// several pictures in one frame - a backlog after a slow socket - and
        /// there is no time between them to interpolate across, so `Show` only
        /// says where the truck is going and this decides how far it got.
        ///
        /// IT ONLY EVER MOVES TOWARDS A PICTURE THAT ARRIVED. Nothing here
        /// predicts where the other truck is going: a ghost is a picture (0.10)
        /// and an extrapolated one would be this page inventing somebody else's
        /// position. `k` is clamped at one, so the truck stops on the newest
        /// picture and waits there for the next.
        /// </summary>
        void Update() { if (_placed) Ease(Time.deltaTime); }

        void Ease(float dt)
        {
            if (dt <= 0f || Settled) return;
            _since += dt;
            var k = Mathf.Clamp01(_since / PictureSeconds);
            if (k >= 1f) { SnapToPicture(); return; }
            transform.SetPositionAndRotation(
                Vector3.Lerp(_from, _want, k),
                Quaternion.Euler(0f, Mathf.LerpAngle(_fromHeading, _wantHeading, k), 0f));
        }

        /// <summary>The newest picture, exactly - what a settled ghost is at.</summary>
        public void SnapToPicture()
        {
            _since = PictureSeconds;
            transform.SetPositionAndRotation(_want, Quaternion.Euler(0f, _wantHeading, 0f));
        }

        /// <summary>
        /// Whether this ghost has reached the picture it was last given, and
        /// "reached" means ON it rather than near it.
        ///
        /// This was a distance - within a millimetre - and that is a second,
        /// looser idea of arrival than the callers have: the drawn-pose tests
        /// assert to a ten-thousandth of a metre, so a ghost could be settled
        /// and still be 0.3 mm short of the picture, which is a red test that
        /// comes and goes with the frame rate. The walk ENDS at one interval
        /// and `SnapToPicture` puts the truck exactly on the words, so that
        /// moment is the answer and there is no threshold to disagree about.
        /// </summary>
        public bool Settled => _placed && _since >= PictureSeconds;

        /// <summary>The picture this ghost is moving onto.</summary>
        public Vector3 Wanted => _want;

        /// <summary>
        /// `BlwpNet.BatchEvery` in seconds: a tenth. A truck that took longer
        /// would be permanently behind its own picture; one that took less
        /// would be a snap with extra steps.
        /// </summary>
        const float PictureSeconds = 0.1f;

        Vector3 _from, _want;
        float _fromHeading, _wantHeading, _since;
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
