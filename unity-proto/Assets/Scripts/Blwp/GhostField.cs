using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Blwp
{
    /// <summary>
    /// One picture of somebody else's truck, as it crosses the bridge.
    ///
    /// The three truck words are the core's own integers (Q16.16), taken from
    /// a replay of what that player published, and `Tick` is the tick they
    /// were taken at. Nothing here is a claim about damage, cargo, score or
    /// arrival - spec 0.9 gives those to the leaderboard, from signed results,
    /// not to a 5 Hz picture.
    /// </summary>
    public readonly struct GhostPicture
    {
        public readonly string Entry;
        public readonly int X;
        public readonly int Z;
        public readonly int Heading;
        public readonly int Tick;

        public GhostPicture(string entry, int x, int z, int heading, int tick)
        {
            Entry = entry; X = x; Z = z; Heading = heading; Tick = tick;
        }
    }

    /// <summary>
    /// THE OTHER TRUCKS ON SCREEN, AND NOTHING ELSE.
    ///
    /// Spec 0.10: another player's truck is a PICTURE, never an input to this
    /// player's simulation. So this drains the page's queue and calls
    /// `GhostTruck.Show`, and that is the whole of it: no rigidbody, no
    /// collider, no velocity, no contact, no scoring, no delivery. The core
    /// owns all of those and is driven by this player's own inputs alone.
    ///
    /// THE POSE IS THE FRAME'S. There is no integrator here and no smoothing
    /// that invents a position between two pictures: a truck drawn where
    /// nobody said it was is a truck this node cannot prove, and 0.9 is blunt
    /// that what a ghost shows is what its transcript says. Two pictures 200ms
    /// apart draw two poses.
    /// </summary>
    public class GhostField : MonoBehaviour
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int BlwpNextGhost(IntPtr ptr, int cap);
        public const bool Compiled = true;
#else
        private static int BlwpNextGhost(IntPtr ptr, int cap) => 0;
        public const bool Compiled = false;
#endif

        /// <summary>Words in one picture: eight of entry id, then x, z, heading, tick.</summary>
        public const int Words = 12;

        /// <summary>How many pictures are taken in one frame, so a backlog cannot stall drawing.</summary>
        public const int PerFrame = 24;

        /// <summary>
        /// Where pictures come from. The bridge in a player, and whatever a
        /// test hands it in an editor - injected for the same reason `sign`
        /// and `verify` are injected in the client: a rule nobody can drive
        /// from a test is a rule nobody has measured.
        /// </summary>
        public Func<GhostPicture?> Source;

        /// <summary>The body every ghost is drawn with. A test may leave it null.</summary>
        public GameObject Model;

        /// <summary>
        /// What the ground is under a drawn ghost, in metres.
        ///
        /// A picture carries x, z and a heading and says nothing about height,
        /// because height is not a protocol fact: the map is the fee histogram
        /// and it moves under everybody. The player hands the same surface the
        /// local truck stands on; a test hands whatever it wants to measure.
        /// Left null, a ghost keeps the y it had, which is what every ghost did
        /// before this existed - y = 0, metres under the road.
        /// </summary>
        /// <summary>
        /// How high a truck of this shape sits at a pose - x, z, heading in
        /// degrees. A picture carries no height and cannot: the map is the fee
        /// histogram and it moves under every player, so where the road is at
        /// that x and z is a fact of THIS page's world. The HEADING is here
        /// because a truck stands on four wheels, and a body fitted across
        /// them is not a single sample under its middle: measured 0.58 m
        /// apart on this map at one pose, which is a ghost floating over the
        /// truck it is a picture of.
        /// </summary>
        public Func<float, float, float, float> Seat;

        public int Shown { get; private set; }
        public int Trucks => trucks.Count;

        private readonly Dictionary<string, GhostTruck> trucks = new Dictionary<string, GhostTruck>();
        private readonly int[] words = new int[Words];

        void Update() => Draw(PerFrame);

        /// <summary>Take up to `max` pictures and put each truck where its own says.</summary>
        public int Draw(int max)
        {
            var drawn = 0;
            for (var i = 0; i < max; i++)
            {
                var picture = Next();
                if (picture == null) break;
                Show(picture.Value);
                drawn++;
            }
            return drawn;
        }

        /// <summary>One picture, from the injected source or from the bridge.</summary>
        public GhostPicture? Next()
        {
            if (Source != null) return Source();
            return FromBridge();
        }

        private GhostPicture? FromBridge()
        {
            var handle = GCHandle.Alloc(words, GCHandleType.Pinned);
            try
            {
                if (BlwpNextGhost(handle.AddrOfPinnedObject(), Words) != Words) return null;
            }
            finally { handle.Free(); }

            var entry = new System.Text.StringBuilder(64);
            for (var i = 0; i < 8; i++) entry.Append(words[i].ToString("x8"));
            return new GhostPicture(entry.ToString(), words[8], words[9], words[10], words[11]);
        }

        /// <summary>
        /// One truck per entry, put where that entry's picture says.
        ///
        /// A truck is made on the first picture of an entry and moved by every
        /// one after it, so the field is as big as the interest set the node
        /// chose and not as big as the traffic.
        /// </summary>
        public void Show(GhostPicture picture)
        {
            if (string.IsNullOrEmpty(picture.Entry)) return;

            if (!trucks.TryGetValue(picture.Entry, out var ghost) || ghost == null)
            {
                var body = Model != null ? Instantiate(Model, transform) : new GameObject();
                body.name = "ghost:" + picture.Entry.Substring(0, 8);
                body.transform.SetParent(transform, false);
                ghost = body.GetComponent<GhostTruck>();
                if (ghost == null) ghost = body.AddComponent<GhostTruck>();
                trucks[picture.Entry] = ghost;

                // A TEMPLATE IS KEPT INACTIVE SO IT IS NOT ITSELF IN THE SCENE,
                // and a clone of it inherits that. A ghost nobody activates is
                // a ghost nobody sees, which is the same as no ghost at all.
                body.SetActive(true);
            }

            var seat = Seat != null
                ? Seat(picture.X / GhostTruck.ONE, picture.Z / GhostTruck.ONE,
                       BlwpCore.Degrees(picture.Heading))
                : (float?)null;
            ghost.Show(picture.X, picture.Z, picture.Heading, seat);
            Shown++;
        }
    }
}
