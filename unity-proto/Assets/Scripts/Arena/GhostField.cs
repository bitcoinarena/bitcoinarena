// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Arena
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
        [DllImport("__Internal")] private static extern int ArenaNextGhost(IntPtr ptr, int cap);
        [DllImport("__Internal")] private static extern int ArenaGhostLabels(IntPtr ptr, int cap);
        public const bool Compiled = true;
#else
        private static int ArenaNextGhost(IntPtr ptr, int cap) => 0;
        private static int ArenaGhostLabels(IntPtr ptr, int cap) => 0;
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
        public Func<float, float, float, float> Rest;

        /// <summary>
        /// HOW A TRUCK OF THIS SHAPE LIES AT A POSE - the pitch and roll of the ground under its four wheels.
        ///
        /// 2026-09-18 10:42: "Ghosts have NO physics. They must climb hills the same as his own truck." A
        /// ghost was given the ground's HEIGHT (`Rest`) and nothing else, so it stood dead level on a hillside while
        /// the local truck, drawn from the same four contact points, tilted. The local truck has no physics here
        /// either - `CoreDrivenTruck.Lie` is a drawing rule over the surface, not a rigidbody - so this is the same
        /// rule for the same reason, handed in the same way the resting height is.
        /// </summary>
        public Func<float, float, float, Quaternion> Lie;

        public int Shown { get; private set; }
        public int Trucks => trucks.Count;
        /// <summary>Trucks taken away because their entry was left.</summary>
        public int Retired { get; private set; }

        private readonly Dictionary<string, GhostTruck> trucks = new Dictionary<string, GhostTruck>();

        /// <summary>
        /// Each shown entry's newest picture, in the core's own words (Q16.16). The HUD chart (WAR_TACTICS.md §0.3)
        /// puts a ghost where its picture is, through the core's mapping - not where its drawn body has eased to.
        /// </summary>
        public IReadOnlyDictionary<string, GhostPicture> Pictures => pictures;
        private readonly Dictionary<string, GhostPicture> pictures = new Dictionary<string, GhostPicture>();
        private readonly int[] words = new int[Words];

        void Update() => Draw(PerFrame);

        /// <summary>
        /// THE DEBUG LABEL OVER EACH GHOST (2026-09-17 19:15): the player's name, then how old the truck's newest
        /// picture is in ms and how it moved - an up arrow forward, a down arrow back, a left or right arrow for a turn,
        /// both when it did both. The page writes it (`ghostLabels` in @blwp/client) from what came through the nodes;
        /// a "~" before the age means this browser holds no stamp of the driver's clock and it is the time since the
        /// picture arrived. Read ten times a second, drawn every frame.
        /// </summary>
        public Func<string> LabelSource;
        public IReadOnlyDictionary<string, string[]> Labels => labels;
        private Dictionary<string, string[]> labels = new Dictionary<string, string[]>();
        private readonly byte[] labelBytes = new byte[8192];
        private float labelsReadAt = -1f;
        private GUIStyle labelStyle, labelShadow;

        /// <summary>`entry TAB name TAB line-two`, one a line, into entry -> { name, line two }.</summary>
        public static Dictionary<string, string[]> ParseLabels(string text)
        {
            var parsed = new Dictionary<string, string[]>();
            if (string.IsNullOrEmpty(text)) return parsed;
            foreach (var line in text.Split('\n'))
            {
                var parts = line.Split('\t');
                if (parts.Length < 3 || parts[0].Length == 0) continue;
                parsed[parts[0]] = new[] { parts[1], parts[2] };
            }
            return parsed;
        }

        private string ReadLabels()
        {
            if (LabelSource != null) return LabelSource();
            var handle = GCHandle.Alloc(labelBytes, GCHandleType.Pinned);
            try
            {
                var n = ArenaGhostLabels(handle.AddrOfPinnedObject(), labelBytes.Length);
                return n > 0 ? System.Text.Encoding.UTF8.GetString(labelBytes, 0, n) : "";
            }
            finally { handle.Free(); }
        }

        void LateUpdate()
        {
            // THE LABEL IS READ EVERY FRAME'S WORTH, NOT EVERY TENTH OF A SECOND. Read at 10 Hz it added up to another
            // 100 ms to an age that is already the picture's own, and the age over a truck is the one number a player
            // has for the lag (2026-09-17 19:15). The read is a bridge call and a split of a short string.
            if (Time.unscaledTime - labelsReadAt < 0.016f) return;
            labelsReadAt = Time.unscaledTime;
            labels = ParseLabels(ReadLabels());
        }

        /// <summary>
        /// THE CAMERA THE PICTURE ACTUALLY CAME OUT OF, WHICH IS NOT `Camera.main`.
        ///
        /// `Camera.main` is the first camera tagged MainCamera, and nothing in this build tags one: `Bootstrap` makes
        /// the chase camera in code and the tag is never set. `StrikeTheatre` found this twice and wrote it down both
        /// times - "it returned null in the player, because the camera that renders this build is not tagged
        /// MainCamera" - and it made the drone's distance and the crater's ring wrong before it was fixed there.
        ///
        /// Here it was worse than wrong: `OnGUI` returned on a null camera, so the debug label over each truck - the
        /// one number a player has for the lag (2026-09-17 19:15) - was never drawn in a player at all, only in
        /// the Editor tests that make their own tagged camera. Measured in a PlayMode world built by `Bootstrap`: two
        /// cameras, neither of them `Camera.main`.
        /// </summary>
        public static Camera LabelEye() => LabelEye(0);

        /// <summary>
        /// The same, for a truck on `layer` - and it must be a camera that can SEE that layer.
        ///
        /// The player's world has two cameras, and the second one is not a view of the world: `PackageYard` builds a
        /// `YardCamera` 2000 m under the map, culling everything but the yard layer, and turns it on whenever the
        /// loadout panel is open. `Camera.allCameras` is an enumeration, not a promise about which camera draws the
        /// ground, so "the first enabled camera" could be that one - and then every label and every rim marker would
        /// be placed from under the map while the panel was open.
        ///
        /// A camera that culls the truck's layer cannot draw the truck, so it cannot be the eye the truck is labelled
        /// through. That is the whole rule, and it does not depend on depth, order or a tag.
        /// </summary>
        public static Camera LabelEye(int layer)
        {
            var mask = 1 << layer;
            var main = Camera.main;
            if (main != null && (main.cullingMask & mask) != 0) return main;
            foreach (var c in Camera.allCameras)
                if (c != null && c.isActiveAndEnabled && (c.cullingMask & mask) != 0) return c;
            return null;
        }

        /// <summary>Where one truck's two lines go, and whether they are a marker at the screen's edge.</summary>
        public readonly struct LabelSpot
        {
            /// <summary>Screen point, y up from the bottom, the way `Camera.WorldToScreenPoint` gives it.</summary>
            public readonly Vector2 At;
            /// <summary>True when the hull is not on screen and this is the marker that says where it is.</summary>
            public readonly bool AtEdge;
            public LabelSpot(Vector2 at, bool atEdge) { At = at; AtEdge = atEdge; }
        }

        /// <summary>
        /// THE OTHER TRUCK IS MARKED AT THE EDGE WHEN IT IS OFF SCREEN (2026-09-18 06:45).
        ///
        /// The map parks one player per loading-bay door: 24 doors at a 6.8 m pitch, so two seats are a mean 54 m
        /// apart along the frontage. Measured from the camera a player drives with - `ChaseCamera` in Follow, 11 m
        /// behind the truck at fov 59 - that camera frames 3 of the 24 doors and puts a label on screen for 1. So two
        /// parked tabs usually cannot see each other at all, which is what the 19:15 photograph shows, and it is not
        /// lag. The doors are the map and stay; what was missing is a cue.
        ///
        /// A hull on screen keeps its label over the truck and gets nothing at the edge - one truck is one label. A
        /// hull off screen, or behind the camera, is pinned to the rim of the screen in the direction it lies in,
        /// with the same two lines and the same clock: nothing here invents a second age or a second pose.
        ///
        /// BEHIND THE CAMERA THE POINT IS MIRRORED. `WorldToScreenPoint` with a negative z gives a point reflected
        /// through the centre, so a truck behind the player would be marked on the wrong side. It is reflected back
        /// before the direction is taken.
        /// </summary>
        public static LabelSpot SpotFor(Camera cam, Vector3 world, float width, float height, float marginX, float marginY)
        {
            var p = cam.WorldToScreenPoint(world);
            var behind = p.z <= 0f;
            var at = new Vector2(p.x, p.y);
            if (behind) at = new Vector2(width - at.x, height - at.y);
            var inside = !behind
                && at.x >= marginX && at.x <= width - marginX
                && at.y >= marginY && at.y <= height - marginY;
            if (inside) return new LabelSpot(at, false);

            var centre = new Vector2(width * 0.5f, height * 0.5f);
            var d = at - centre;
            if (d.sqrMagnitude < 1e-4f) d = new Vector2(0f, 1f);
            var halfX = Mathf.Max(1f, width * 0.5f - marginX);
            var halfY = Mathf.Max(1f, height * 0.5f - marginY);
            var k = Mathf.Min(halfX / Mathf.Max(Mathf.Abs(d.x), 1e-4f), halfY / Mathf.Max(Mathf.Abs(d.y), 1e-4f));
            return new LabelSpot(centre + d * k, true);
        }

        void OnGUI()
        {
            if (labels.Count == 0 || CleanHud.On) return;
            if (labelStyle == null)
            {
                labelStyle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.LowerCenter, fontStyle = FontStyle.Bold };
                labelShadow = new GUIStyle(labelStyle);
                labelStyle.normal.textColor = Color.white;
                labelShadow.normal.textColor = new Color(0f, 0f, 0f, 0.85f);
            }
            var size = Mathf.Max(13, Screen.height / 48);
            labelStyle.fontSize = size; labelShadow.fontSize = size;
            foreach (var kv in trucks)
            {
                if (kv.Value == null || !labels.TryGetValue(kv.Key, out var label)) continue;
                var cam = LabelEye(kv.Value.gameObject.layer);
                if (cam == null) continue;
                var spot = SpotFor(cam, kv.Value.transform.position + Vector3.up * 3.8f,
                                   Screen.width, Screen.height, 160f, size * 3f);
                var rect = new Rect(spot.At.x - 160f, Screen.height - spot.At.y - size * 3f, 320f, size * 3f);
                var text = label[0] + "\n" + label[1];
                GUI.Label(new Rect(rect.x + 1.5f, rect.y + 1.5f, rect.width, rect.height), text, labelShadow);
                GUI.Label(rect, text, labelStyle);
            }
        }

        /// <summary>The page's record for "a new round is watched: take every truck away".</summary>
        public const int ClearTick = -2;
        public int Cleared { get; private set; }

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
                if (ArenaNextGhost(handle.AddrOfPinnedObject(), Words) != Words) return null;
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

            // CLEAR ALL (tick -2): the page started watching a new round, so no truck of the last one stands on
            // (2026-09-17 17:12: "after the next round suddenly 3 ghosts").
            if (picture.Tick == ClearTick)
            {
                foreach (var t in trucks.Values) if (t != null) { Destroy(t.gameObject); Retired++; }
                trucks.Clear();
                pictures.Clear();
                Cleared++;
                return;
            }

            // A RETIRE, NOT A PICTURE. The page sends tick -1 for an entry its
            // player has left - a reload keeps the key and draws a new entry - so
            // the truck stops standing where that abandoned run stopped.
            // Measured 2026-09-10 on the Daily: a reload handed this field 9 and
            // 11 entries, 8 and 10 of them abandoned and frozen, and a watched
            // player's reload left its 105-picture entry frozen beside the new
            // one. Which entry is left is the page's rule (`ghost-field.js`);
            // this only takes the truck away.
            if (picture.Tick < 0)
            {
                if (trucks.TryGetValue(picture.Entry, out var gone))
                {
                    trucks.Remove(picture.Entry);
                    pictures.Remove(picture.Entry);
                    if (gone != null) Destroy(gone.gameObject);
                    Retired++;
                }
                return;
            }

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

            var x = picture.X / GhostTruck.ONE;
            var z = picture.Z / GhostTruck.ONE;
            var heading = ArenaCore.Degrees(picture.Heading);
            var resting = Rest != null ? Rest(x, z, heading) : (float?)null;
            var lying = Lie != null ? Lie(x, z, heading) : (Quaternion?)null;
            ghost.Show(picture.X, picture.Z, picture.Heading, resting, lying);
            pictures[picture.Entry] = picture;
            Shown++;
        }
    }
}
