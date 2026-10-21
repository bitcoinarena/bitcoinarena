// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Arena
{
    /// <summary>
    /// THE GAME'S WHOLE REACH INTO THE NETWORK.
    ///
    /// Four calls: start a session, read a status line, count the marks that
    /// have been receipted, and stop. That is deliberately all of it.
    ///
    /// Unity never builds a message, never signs one, and never learns an
    /// outcome from one. The client in the page does that, and the client
    /// computes nothing either - it carries a hash the core produced. So this
    /// class holds no key, no contract and no wire format: putting an encoder
    /// here would be a second implementation of a format that pins money, and
    /// a signing key in C# would be a key in the renderer.
    ///
    /// THE INPUTS ARE NOT PUBLISHED FROM HERE EITHER. They are taken inside
    /// `ArenaStep`, where the core is stepped, so what crosses the wire is the
    /// five words the core actually consumed rather than a copy Unity kept.
    /// Two records of one thing is how they start to differ.
    ///
    /// Outside a WebGL player every one of these is a stub that answers
    /// nothing, exactly as `ArenaCore` is: there is no core in an editor, so
    /// there is nothing to commit to and nobody to tell.
    /// </summary>
    public static class ArenaNet
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int ArenaNetStart(IntPtr url, int batchEvery, int markEvery);
        [DllImport("__Internal")] private static extern int ArenaNetStatus(IntPtr ptr, int cap);
        [DllImport("__Internal")] private static extern int ArenaNetEnded();
        [DllImport("__Internal")] private static extern int ArenaNetEnding(IntPtr ptr, int cap);
        [DllImport("__Internal")] private static extern int ArenaNetMarks();
        [DllImport("__Internal")] private static extern int ArenaRoundSeed();
        [DllImport("__Internal")] private static extern int ArenaNetNodeUrl(IntPtr ptr, int cap);
        public const bool Compiled = true;
#else
        private static int ArenaNetStart(IntPtr url, int batchEvery, int markEvery) => 0;
        private static int ArenaNetStatus(IntPtr ptr, int cap) => 0;
        private static int ArenaNetEnded() => 0;
        private static int ArenaNetEnding(IntPtr ptr, int cap) => 0;
        private static int ArenaNetMarks() => 0;
        private static int ArenaRoundSeed() => 0;
        private static int ArenaNetNodeUrl(IntPtr ptr, int cap) => 0;
        public const bool Compiled = false;
#endif

        /// <summary>
        /// How often the two things are published, in core ticks.
        ///
        /// `IMPLEMENTATION.md` gives the rates beside the messages:
        /// INPUT_BATCH at 10 Hz and CHECKPOINT at 1 Hz. The core runs at 60
        /// ticks a second, so those are every 6 ticks and every 60 - and they
        /// are written as that arithmetic rather than as two numbers, because
        /// the tick rate is the thing that could change.
        /// </summary>
        public const int TicksPerSecond = 60;
        public const int BatchEvery = TicksPerSecond / 10;   // 10 Hz
        public const int MarkEvery = TicksPerSecond;         // 1 Hz

        /// <summary>
        /// The node this page was told to play against, or empty.
        ///
        /// Named by the PAGE, not compiled in and not typed into a scene: a
        /// lobby will name it one day, together with the round, and until then
        /// whoever runs the page does. Empty is the shipping default and means
        /// no session at all.
        /// </summary>
        public static string NodeUrl()
        {
            if (!Compiled) return "";
            var bytes = new byte[256];
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                int n = ArenaNetNodeUrl(handle.AddrOfPinnedObject(), bytes.Length);
                return n > 0 ? System.Text.Encoding.UTF8.GetString(bytes, 0, n) : "";
            }
            finally { handle.Free(); }
        }

        /// <summary>True once a session has been asked for and the page took it.</summary>
        public static bool Running { get; private set; }

        /// <summary>
        /// Asks the page to open a session against one node.
        ///
        /// Answers whether the request was TAKEN, not whether it succeeded: the
        /// client's work is asynchronous and a jslib call is not, so what comes
        /// back is "the page has begun" and the rest is read from `Status`.
        /// Pretending otherwise would make this return a lie once in every
        /// slow handshake.
        /// </summary>
        public static bool Start(string nodeUrl)
        {
            if (!MayStart(Running, Ended) || string.IsNullOrEmpty(nodeUrl)) return false;
            var bytes = System.Text.Encoding.UTF8.GetBytes(nodeUrl + "\0");
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                // Only a session the page TOOK changes this: a start the page declined while the
                // last run's final publish is still going out leaves the old state as it was.
                bool took = ArenaNetStart(handle.AddrOfPinnedObject(), BatchEvery, MarkEvery) == 1;
                if (took) { Running = true; Debug.Log($"[arena] session opening against {nodeUrl}"); }
                return took;
            }
            finally { handle.Free(); }
        }

        /// <summary>
        /// WHETHER A SESSION MAY BE ASKED FOR: none has been, or the last one's run is over (the owner
        /// 2026-09-15 16:14, hole 1 - a second PLAY in the same tab starts a new round without a
        /// reload). Measured before: `Running` never went false, so the second round in a tab could
        /// never open a session.
        /// </summary>
        public static bool MayStart(bool running, bool over) => !running || over;

        /// <summary>A session is open and its run is not over.</summary>
        public static bool Live => Running && !Ended;

        /// <summary>
        /// One line for the debug panel: the state, the counts and the tick.
        ///
        /// A status nobody can read is a status nobody checks - the same reason
        /// the feed names its sockets on the HUD rather than only when broken.
        /// </summary>
        public static string Status()
        {
            if (!Compiled) return "off";
            var bytes = new byte[192];
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                int n = ArenaNetStatus(handle.AddrOfPinnedObject(), bytes.Length);
                return n > 0 ? System.Text.Encoding.UTF8.GetString(bytes, 0, n) : "off";
            }
            finally { handle.Free(); }
        }

        /// <summary>
        /// THE RUN'S ENDING, or an empty string while it is still alive.
        ///
        /// `<WORD> <reason>` - today always VOID and why - and it is the
        /// CLIENT'S word, read out of the session, not a judgement made here.
        /// Unity does not decide an outcome; the deterministic core and the
        /// protocol do, and this is the game being told.
        ///
        /// It is a signal and not a panel line. `Status()` is text nobody
        /// consumed, which is how a player went on steering a round that could
        /// not be settled: the hold had filled, the client had stopped
        /// publishing, and nothing in the game had been told.
        /// </summary>
        public static string Ending()
        {
            if (!Compiled) return "";
            var bytes = new byte[256];
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                int n = ArenaNetEnding(handle.AddrOfPinnedObject(), bytes.Length);
                return n > 0 ? System.Text.Encoding.UTF8.GetString(bytes, 0, n) : "";
            }
            finally { handle.Free(); }
        }

        /// <summary>
        /// Whether this run is over. False when there is no session at all, so
        /// a player who was given no node plays exactly the game that shipped
        /// before any of this existed.
        /// </summary>
        /// Asked every tick and on every input read, so it is an int across
        /// the boundary: pinning a buffer per frame to be told "no" is a cost
        /// every player would pay for the case that has not happened.
        public static bool Ended => Running && ArenaNetEnded() != 0;

        /// <summary>
        /// WHETHER THE ROUND'S OWN LINE IS DOWN (2026-09-18 20:04, so the HUD can say what is broken).
        ///
        /// The page's status begins with the client's own word - opening, ready, ended - and a LIVE session whose
        /// word is not `ready` is a player whose other trucks have stopped arriving. A run that has ended is not a
        /// broken connection: that player finished, and the HUD says nothing.
        /// </summary>
        public static bool FeedDown()
        {
            if (!Live) return false;
            var said = Status();
            if (string.IsNullOrEmpty(said)) return true;
            int space = said.IndexOf(' ');
            var word = space < 0 ? said : said.Substring(0, space);
            return word != "ready";
        }

        /// <summary>
        /// How many of this run's marks a node has receipted.
        ///
        /// The one number that says the round is being WITNESSED rather than
        /// merely sent: a mark with no receipt is a commitment nobody has
        /// promised to hold.
        /// </summary>
        public static int Marks => ArenaNetMarks();

        /// <summary>
        /// The seed the ROUND puts this player's world at, or 0 for no round.
        ///
        /// `init(seedWord)` decides which of the 24 loading bays this player
        /// parks at and the rng stream after it, and the committee replays this
        /// entry with the same word - `seedWordForEntry(entry, randomness)`. The
        /// page derives it once, when it joins, from the randomness every node
        /// it was given agrees on. Zero is the daily: no round, no entry, and
        /// the harness constant that holds the solo apron on bay 13.
        /// </summary>
        public static int RoundSeed => ArenaRoundSeed();
    }
}
