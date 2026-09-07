using System;
using System.Runtime.InteropServices;
using UnityEngine;

namespace Blwp
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
    /// `BlwpStep`, where the core is stepped, so what crosses the wire is the
    /// five words the core actually consumed rather than a copy Unity kept.
    /// Two records of one thing is how they start to differ.
    ///
    /// Outside a WebGL player every one of these is a stub that answers
    /// nothing, exactly as `BlwpCore` is: there is no core in an editor, so
    /// there is nothing to commit to and nobody to tell.
    /// </summary>
    public static class BlwpNet
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern int BlwpNetStart(IntPtr url, int batchEvery, int markEvery);
        [DllImport("__Internal")] private static extern int BlwpNetStatus(IntPtr ptr, int cap);
        [DllImport("__Internal")] private static extern int BlwpNetMarks();
        [DllImport("__Internal")] private static extern int BlwpNetNodeUrl(IntPtr ptr, int cap);
        public const bool Compiled = true;
#else
        private static int BlwpNetStart(IntPtr url, int batchEvery, int markEvery) => 0;
        private static int BlwpNetStatus(IntPtr ptr, int cap) => 0;
        private static int BlwpNetMarks() => 0;
        private static int BlwpNetNodeUrl(IntPtr ptr, int cap) => 0;
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
                int n = BlwpNetNodeUrl(handle.AddrOfPinnedObject(), bytes.Length);
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
            if (Running || string.IsNullOrEmpty(nodeUrl)) return false;
            var bytes = System.Text.Encoding.UTF8.GetBytes(nodeUrl + "\0");
            var handle = GCHandle.Alloc(bytes, GCHandleType.Pinned);
            try
            {
                Running = BlwpNetStart(handle.AddrOfPinnedObject(), BatchEvery, MarkEvery) == 1;
                if (Running) Debug.Log($"[blwp] session opening against {nodeUrl}");
                return Running;
            }
            finally { handle.Free(); }
        }

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
                int n = BlwpNetStatus(handle.AddrOfPinnedObject(), bytes.Length);
                return n > 0 ? System.Text.Encoding.UTF8.GetString(bytes, 0, n) : "off";
            }
            finally { handle.Free(); }
        }

        /// <summary>
        /// How many of this run's marks a node has receipted.
        ///
        /// The one number that says the round is being WITNESSED rather than
        /// merely sent: a mark with no receipt is a commitment nobody has
        /// promised to hold.
        /// </summary>
        public static int Marks => BlwpNetMarks();
    }
}
