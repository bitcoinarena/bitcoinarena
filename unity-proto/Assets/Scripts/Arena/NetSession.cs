// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

namespace Arena
{
    /// <summary>
    /// THE CALL SITE: a session that opens when a round rolls out, and a status
    /// the debug panel can read.
    ///
    /// It publishes nothing itself. The inputs go to the network from inside
    /// `ArenaStep`, where the core is stepped, so the transcript is the words
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
        /// WHY A TAB IS NOT IN A ROUND, IN ITS OWN WORDS (2026-09-18 09:00, the two-tab gate).
        ///
        /// Two headless players on this host drove for nine minutes with the page's line reading "play - not started"
        /// and no session, and nothing on the screen or in the console said which of the three conditions was unmet.
        /// The page could be asked whether it had named a node; it could not be asked what UNITY thought. So the rule
        /// says so itself, once per reason rather than once per frame - a log line is the one thing a headless client
        /// can already read.
        /// </summary>
        void SayWhyNotYet()
        {
            var why = string.IsNullOrEmpty(nodeUrl) ? "the page has named no node"
                : !ArenaCore.Available ? "the core is not driving here"
                : ArenaCore.Tick < settleTicks ? $"the world is still settling ({ArenaCore.Tick} of {settleTicks} ticks)"
                : "nothing is left to wait for, and no session was asked for";
            if (why == _saidWhy) return;
            _saidWhy = why;
            Debug.Log($"[arena] no session yet: {why}");
        }
        string _saidWhy = "";

        /// <summary>
        /// Whether a session should be asked for on this tick.
        ///
        /// Its own function because it is a RULE and rules here are measured:
        /// a session is wanted once, only when a node has been named, only
        /// while the core is actually driving, and only after the world has
        /// settled. `Update` reads it; a test reads it too, which is the only
        /// way any of this can be checked in an editor - `ArenaNet` is a stub
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
            if (string.IsNullOrEmpty(nodeUrl)) nodeUrl = ArenaNet.NodeUrl();
        }

        float _nextAsk;

        void Update()
        {
            // AND ASKED AGAIN WHILE THERE IS NONE (M3.3-34, 2026-09-13 07:11):
            // PLAY in the lobby joins in this page, after Start - the page
            // is no longer reloaded, so a round named later has to be seen here.
            // AND ONCE A RUN IS OVER THE ROUND IS NOT ASKED FOR AGAIN (hole 1): the page lets go of the
            // finished round, so the address is asked afresh and answers only for the next join.
            if (ArenaNet.Ended) nodeUrl = "";
            if (string.IsNullOrEmpty(nodeUrl) && Time.unscaledTime >= _nextAsk)
            {
                _nextAsk = Time.unscaledTime + 0.5f;
                nodeUrl = ArenaNet.NodeUrl();
            }
            if (ShouldOpen(nodeUrl, ArenaCore.Available, ArenaNet.Live,
                           ArenaCore.Tick, settleTicks))
                ArenaNet.Start(nodeUrl);
            else if (!ArenaNet.Live) SayWhyNotYet();

            // Polled rather than pushed, and not every frame: the status is a
            // string built in the page, and building it sixty times a second to
            // show it four times would be the kind of cost nobody notices until
            // it is everywhere.
            // THE REASON IS NOT POLL-RATE NEWS (2026-09-20, measured twice in the BAY). Between a VOID and the
            // lobby taking the screen there are about 0.6 s, and this poll refreshes every 0.5 s - so whether the
            // player is told why depends on which lands first. Photographed both ways on one build: bay-04.png has
            // the line, bayok-27.png and bayfull-29.png are the same state with nothing on screen.
            // (The HUD no longer prints it - NO-STOPPED-LINE-2103 - but the ending's reason is still the session's.)
            // Fetched once, the moment the run ends; the poll below carries on as before.
            if (ArenaNet.Ended && string.IsNullOrEmpty(Ending)) Ending = ArenaNet.Ending();
            if (Time.unscaledTime < _nextPoll) return;
            _nextPoll = Time.unscaledTime + 0.5f;
            Status = ArenaNet.Running ? ArenaNet.Status() : "off";
            Marks = ArenaNet.Marks;
            Ending = ArenaNet.Ending();
        }
    }
}
