using UnityEngine;

namespace Blwp
{
    /// <summary>
    /// THE CALL SITE: a session that opens when a round rolls out, and a status
    /// the debug panel can read.
    ///
    /// It publishes nothing itself. The inputs go to the network from inside
    /// `BlwpStep`, where the core is stepped, so the transcript is the words
    /// the core consumed; the checkpoints go on the same tick counter. What
    /// this component does is decide WHEN a session should exist, which is a
    /// question about the game, and it is the only part of that question Unity
    /// is allowed to answer.
    ///
    /// Off by default. A player who has not been given a node to play against
    /// gets exactly the game they had before this existed, and one line in the
    /// debug panel saying so.
    /// </summary>
    public class NetSession : MonoBehaviour
    {
        [Tooltip("The node to publish to. Empty means no session at all, which "
                 + "is the default: the single-player game is unchanged.")]
        public string nodeUrl = "";

        [Tooltip("Wait this many core ticks after the core starts driving before "
                 + "opening a session, so the handshake does not land in the "
                 + "same frame as the world being built.")]
        public int settleTicks = 30;

        /// <summary>What the last poll said. For the debug panel, and for tests.</summary>
        public string Status { get; private set; } = "off";

        /// <summary>Marks a node has receipted for this run.</summary>
        public int Marks { get; private set; }

        /// <summary>
        /// The run's ending, or empty while it is alive: `&lt;WORD&gt; &lt;reason&gt;`.
        ///
        /// Polled like the rest, and it is what the HUD draws from. Unity does
        /// not decide it - the client holds the word and the reason, and this
        /// carries them.
        /// </summary>
        public string Ending { get; private set; } = "";

        float _nextPoll;

        /// <summary>
        /// Whether a session should be asked for on this tick.
        ///
        /// Its own function because it is a RULE and rules here are measured:
        /// a session is wanted once, only when a node has been named, only
        /// while the core is actually driving, and only after the world has
        /// settled. `Update` reads it; a test reads it too, which is the only
        /// way any of this can be checked in an editor - `BlwpNet` is a stub
        /// there and will never open anything.
        /// </summary>
        public static bool ShouldOpen(string url, bool coreDriving, bool alreadyRunning,
                                      int tick, int settleTicks)
            => !string.IsNullOrEmpty(url) && coreDriving && !alreadyRunning
               && tick >= settleTicks;

        void Start()
        {
            // The page names the node, so a build carries no address of its own
            // and a player who was given none plays exactly the game that
            // shipped before any of this existed.
            if (string.IsNullOrEmpty(nodeUrl)) nodeUrl = BlwpNet.NodeUrl();
        }

        void Update()
        {
            if (ShouldOpen(nodeUrl, BlwpCore.Available, BlwpNet.Running,
                           BlwpCore.Tick, settleTicks))
                BlwpNet.Start(nodeUrl);

            // Polled rather than pushed, and not every frame: the status is a
            // string built in the page, and building it sixty times a second to
            // show it four times would be the kind of cost nobody notices until
            // it is everywhere.
            if (Time.unscaledTime < _nextPoll) return;
            _nextPoll = Time.unscaledTime + 0.5f;
            Status = BlwpNet.Running ? BlwpNet.Status() : "off";
            Marks = BlwpNet.Marks;
            Ending = BlwpNet.Ending();
        }
    }
}
