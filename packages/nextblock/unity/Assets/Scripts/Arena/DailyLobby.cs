// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using System;
using System.Collections.Generic;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace Arena
{
    /// <summary>One round as the lobby lists it - every field the page's own, checked there.</summary>
    [Serializable]
    public class LobbyRow
    {
        public string id = "";
        public string line = "";
        public bool free;
        public int agree;
        public int needed;
        public bool joinable;
        public int leftS = -1;
        /// <summary>Whole seconds until the round starts, 0 once it has started; -1 when the page did not say (an older page) -.</summary>
        public int startS = -1;
        /// <summary>The round's committee size - its signer nodes, from its verified contract (7 paid, 2 free); -1 when the page did not say (follow-up).</summary>
        public int total = -1;
        public int joined;
        /// <summary>What a paying round costs to enter, in whole sats; 0 for a free round.</summary>
        public long stakeSats;
    }

    /// <summary>Who this tab is: the name and the identity key's fingerprint.</summary>
    [Serializable]
    public class LobbyYou
    {
        public string name = "";
        public bool custom;
        public string generated = "";
        public string fingerprint = "";
    }

    /// <summary>The signer node PLAY asked for, as the page took it: "" before any press, then joining, joined or refused - and why, and the step it is on.</summary>
    [Serializable]
    public class LobbyJoin
    {
        public string state = "";
        public string why = "";
        public string stage = "";
        /// <summary>The round the join was for (64 hex), "" when the page did not say; and its kind when the lobby listed it.</summary>
        public string round = "";
        public bool kindKnown;
        public bool free;
        public long stakeSats;
        /// <summary>The page entered this round itself, as the next one after a run (continuing is the default, 2026-09-28).</summary>
        public bool next;
    }

    /// <summary>What the page hands Unity to draw: the lobby, or nothing.</summary>
    /// <summary>What a kept round still owes this browser's player (2026-09-14): looked at by the page, never collected by looking.</summary>
    [Serializable]
    public class LobbyWithdraw
    {
        public bool available;
        public string msat = "";
        public bool elsewhere;
    }

    /// <summary>
    /// ONE COLLECT LINE THE PAGE WROTE (2026-10-07): the page owns the words - another kept seed's record,
    /// a failed collect, an uncollectable record - and their kind (other, failed, uncollectable); Unity only draws them.
    /// </summary>
    [Serializable]
    public class LobbyCollectLine
    {
        public string text = "";
        public string kind = "";
    }

    [Serializable]
    public class LobbyState
    {
        public string mode = "";
        public string from = "";
        public LobbyYou you = new LobbyYou();
        public LobbyRow[] rows = new LobbyRow[0];
        public string[] refused = new string[0];
        public int nodes;
        public LobbyJoin join = new LobbyJoin();
        public LobbyWithdraw withdraw = new LobbyWithdraw();
        /// <summary>The signer nodes, by address, that did not answer the page's last lobby read within `answerS` seconds.</summary>
        public string[] unanswered = new string[0];
        public int answerS = 10;
        /// <summary>The seats the lobby read asked, and those whose read failed outright: all failed is "none reached".</summary>
        public int asked;
        public int failed;
        /// <summary>The page is taking the player to the next round (SPECTATE-2158): no lobby until exit game or its start.</summary>
        public bool continuing;
        /// <summary>
        /// The top of the page's "joining next round · exit game" box while it is up, a fraction of the game canvas from its
        /// top, else 0: the result card, its fold control and a wreck's summary end above it.
        /// </summary>
        public float nextBoxTop;
        /// <summary>The collect's own lines: at most three, drawn under the round rows; none when empty.</summary>
        public LobbyCollectLine[] collect = new LobbyCollectLine[0];
    }

    /// <summary>
    /// THE DAILY'S LOBBY, DRAWN BY UNITY (M3.3-34, 2026-09-12 22:11-22:16).
    ///
    /// The lobby is the title screen: the rounds, who you are, PLAY and
    /// SPECTATE. What it shows is decided in the page and nowhere else - every
    /// round is fetched from the signer nodes and checked against its own contract and
    /// both signer nodes' signed listings before it is a row, and Join exists only when
    /// both signer nodes of a 2-of-2 round say open and joined. Unity draws that and
    /// hands the player's press back; it decides nothing and holds no key.
    ///
    /// Outside a WebGL player there is no page, so every call answers nothing
    /// and the title screen is the offline one, exactly as before.
    /// </summary>
    public static class DailyLobby
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern string ArenaLobbyState();
        [DllImport("__Internal")] static extern int ArenaLobbyJoin(string id);
        [DllImport("__Internal")] static extern string ArenaLobbyEditName();
        [DllImport("__Internal")] static extern void ArenaLobbyKeyBackup();
        [DllImport("__Internal")] static extern void ArenaLobbyShown(string json);
        [DllImport("__Internal")] static extern void ArenaAssaultShown(string json);
        [DllImport("__Internal")] static extern void ArenaHudClean(int on);
        [DllImport("__Internal")] static extern int ArenaQueryParam(IntPtr name, IntPtr outp, int cap);
        [DllImport("__Internal")] static extern float ArenaUiScale();
        [DllImport("__Internal")] static extern int ArenaLinkAutoPlay();
        public const bool Compiled = true;
#else
        static float ArenaUiScale() => 1f;
        static string ArenaLobbyState() => "";
        static int ArenaLobbyJoin(string id) => 0;
        static string ArenaLobbyEditName() => "";
        static void ArenaLobbyKeyBackup() { }
        static void ArenaLobbyShown(string json) { }
        static void ArenaAssaultShown(string json) { }
        static void ArenaHudClean(int on) { }
        static int ArenaQueryParam(IntPtr name, IntPtr outp, int cap) => 0;
        static int ArenaLinkAutoPlay() => 2;
        public const bool Compiled = false;
#endif

        /// <summary>The lobby the page holds now, or null when this page is not a lobby.</summary>
        public static LobbyState Poll()
        {
            if (!Compiled) return null;
            try { return Parse(ArenaLobbyState()); } catch (Exception e) { Debug.LogWarning($"[lobby] {e.Message}"); return null; }
        }

        /// <summary>The page's JSON as a lobby, or null: nothing, not a lobby, or not JSON.</summary>
        public static LobbyState Parse(string json)
        {
            if (string.IsNullOrEmpty(json)) return null;
            LobbyState s;
            try { s = JsonUtility.FromJson<LobbyState>(json); } catch { return null; }
            if (s == null || s.mode != "lobby") return null;
            if (s.rows == null) s.rows = new LobbyRow[0];
            if (s.refused == null) s.refused = new string[0];
            if (s.you == null) s.you = new LobbyYou();
            if (s.join == null) s.join = new LobbyJoin();
            if (s.withdraw == null) s.withdraw = new LobbyWithdraw();
            if (s.unanswered == null) s.unanswered = new string[0];
            return s;
        }

        /// <summary>
        /// A WITHDRAWAL AVAILABLE (2026-09-14): after start the page looks at every kept
        /// round, and while one still owes the player money the lobby says so, with the amount,
        /// until it is withdrawn. Nothing is collected by looking; the Withdraw is the page's.
        /// "" when there is none.
        /// </summary>
        /// <summary>
        /// THE COLLECT LINES TO DRAW: the page's strings as it wrote them, empty ones dropped, at most three.
        /// </summary>
        public static LobbyCollectLine[] CollectLines(LobbyState s)
        {
            if (s == null || s.collect == null) return new LobbyCollectLine[0];
            var keep = new List<LobbyCollectLine>();
            foreach (var c in s.collect)
                if (c != null && !string.IsNullOrEmpty(c.text) && keep.Count < 3) keep.Add(c);
            return keep.ToArray();
        }

        /// <summary>A collect line's colour by its kind: grey-blue for another kept seed, red for a failed collect, orange for uncollectable.</summary>
        public static Color CollectColour(string kind) =>
            kind == "failed" ? new Color(1f, 0.50f, 0.46f)
            : kind == "uncollectable" ? new Color(1f, 0.62f, 0.20f)
            : new Color(0.62f, 0.70f, 0.78f);

        public static string WithdrawNotice(LobbyState s)
        {
            if (s == null || s.withdraw == null || !s.withdraw.available) return "";
            if (s.withdraw.elsewhere) return "Withdrawal available - open in another tab of this browser";
            return long.TryParse(s.withdraw.msat, out var msat) && msat > 0
                ? $"Withdrawal available: {msat / 1000} sat - press Withdraw in the wallet panel"
                : "";
        }

        /// <summary>
        /// A SIGNER NODE THAT DID NOT ANSWER, SAID ON THE LOBBY ITSELF (2026-09-17: "never hang forever"). Measured before on the
        /// Daily with its tunnels silent: a round past its close with PLAY enabled for 237 s, then an empty list and a grey PLAY
        /// with no message for as long as it was watched; the only error text anywhere was the small grey hint after a refused
        /// join. The page now gives each signer node `answerS` seconds; this is what the player reads when one did not.
        /// "" when every signer node answered.
        /// </summary>
        /// <summary>
        /// THE EMPTY LIST'S LINE (MF 18: with every seat unreachable the lobby said "No round is open for entry right now"):
        /// when every seat the lobby asked failed, that it reached none; else that no round is open.
        /// </summary>
        public static string EmptyListLine(LobbyState s)
        {
            if (s != null && s.asked > 0 && s.failed >= s.asked)
                return $"No signer node answered ({s.asked} asked) - the rounds cannot be read. Asked again every 5 seconds.";
            return "No round is open for entry right now. The signer nodes are asked again every 5 seconds."
                + (s != null && s.refused != null && s.refused.Length > 0 ? $"\nNot listed: {s.refused.Length}" : "");
        }

        public static string UnansweredLine(LobbyState s)
        {
            if (s == null || s.unanswered == null || s.unanswered.Length == 0) return "";
            var names = new string[s.unanswered.Length];
            for (int i = 0; i < names.Length; i++) names[i] = Host(s.unanswered[i]);
            string who = names.Length == 1 ? $"Signer node {names[0]} did not" : $"Signer nodes {string.Join(" and ", names)} did not";
            return $"{who} answer in {Math.Max(1, s.answerS)} s. PLAY waits until every signer node of the round answers - asked again every second.";
        }

        /// <summary>
        /// The red box on the lobby's list: a refused join first (its reason, which names the signer nodes that did not answer
        /// a join), then the signer nodes that did not answer the last lobby read. "" when there is nothing to say.
        /// </summary>
        public static string LobbyError(LobbyState s, string joinWhy)
        {
            string silent = UnansweredLine(s);
            if (string.IsNullOrEmpty(joinWhy)) return silent;
            return RefusedLine(s != null ? s.join : null, joinWhy) + (string.IsNullOrEmpty(silent) ? "" : "\n" + silent);
        }

        /// <summary>
        /// A REFUSED JOIN NAMES ITS ROUND (2026-09-26 16:56, phone: "Not joined: the node refused the entry: the round is
        /// closed" lay on the next paid round's row, which read exactly as the closed one had - "Say which round is closed, by the
        /// name the lobby already has for it, not 'the round'"). The name is the one a row and the PLAY line give a round: its kind
        /// and "round" and the first 8 of its id.
        /// </summary>
        public static string RefusedLine(LobbyJoin join, string why)
        {
            string id = join != null ? join.round : "";
            if (string.IsNullOrEmpty(id)) return $"Not joined: {why}.";
            string name = (join.kindKnown ? Kind(join.free, join.stakeSats) + " " : "") + $"round {ShortId(id)}";
            if (Closed(why)) return $"Not joined: {name} is closed - the node refused its entry.";
            // A ROUND WHOSE ENTRY IS NOT OPEN YET says when it opens, as the page words it - the round is named in it
            if (why != null && why.StartsWith("Round ") && why.Contains("opens for entry")) return why;
            return $"Not joined {name}: {why}.";
        }

        /// <summary>The node's word for a round that is over.</summary>
        public static bool Closed(string why) => !string.IsNullOrEmpty(why) && why.Contains("the round is closed");

        /// <summary>A round's name in the lobby: the first 8 of its id.</summary>
        /// <summary>
        /// THE HEADER ABOVE THE ROUNDS (follow-up, 2026-10-06, plan comment 430): one shared line naming each
        /// kind listed with that kind's OWN signer numbers, from its rows - the same source as the row. Paid and free together:
        /// "ROUNDS · PAID: 5 OF 7 SIGNER NODES · FREE: 2 OF 2"; one kind: "ROUNDS · JOIN NEEDS 5 OF 7 SIGNER NODES". A kind whose
        /// rows differ says "PER ROUND" (each row keeps its "(N needed)"); a row without the committee size (an older page)
        /// says "N NEEDED" with no "OF"; nothing listed: "ROUNDS". No fixed number: every count is a row's.
        /// </summary>
        /// <summary>
        /// THE HEADER, LONGEST FIRST, FOR THE NARROW SCREEN (measured on UI 133 at 390 px: "ROUNDS · JOIN NEEDS 5 OF 7
        /// SIGNER NC" - the line was cut, even at the smallest font): the full line, then the same numbers in fewer words, then
        /// "ROUNDS". The drawer takes the longest that fits (SplashScreen FitWords).
        /// </summary>
        public static string[] HeaderWordings(LobbyRow[] rows)
        {
            string full = HeaderWords(rows);
            if (rows == null || rows.Length == 0) return new[] { full };
            string paid = KindNumbers(rows, false), free = KindNumbers(rows, true);
            string one = paid ?? free;
            var list = new System.Collections.Generic.List<string> { full };
            if (paid != null && free != null) list.Add($"ROUNDS · PAID {paid} · FREE {free}");
            else if (one != null && one.Contains(" OF ")) { list.Add($"ROUNDS · {one} SIGNER NODES"); list.Add($"ROUNDS · {one} NODES"); }
            list.Add("ROUNDS");
            return list.ToArray();
        }

        public static string HeaderWords(LobbyRow[] rows)
        {
            if (rows == null || rows.Length == 0) return "ROUNDS";
            string paid = KindNumbers(rows, false), free = KindNumbers(rows, true);
            // "SIGNER NODES" follows the paid numbers only when they read "N OF M" (plan 430: "PAID: PER ROUND", "PAID: 5 NEEDED")
            if (paid != null && free != null)
                return paid.Contains(" OF ") ? $"ROUNDS · PAID: {paid} SIGNER NODES · FREE: {free}" : $"ROUNDS · PAID: {paid} · FREE: {free}";
            string one = paid ?? free;
            if (one == "PER ROUND") return "ROUNDS · SIGNER NODES PER ROUND";
            if (one.EndsWith(" NEEDED")) return $"ROUNDS · JOIN NEEDS {one.Substring(0, one.Length - " NEEDED".Length)} SIGNER NODES";
            return $"ROUNDS · JOIN NEEDS {one} SIGNER NODES";
        }

        /// <summary>One kind's numbers over its rows: "5 OF 7", "5 NEEDED" (no committee size), "PER ROUND" (rows differ), or null (none of that kind).</summary>
        static string KindNumbers(LobbyRow[] rows, bool free)
        {
            string seen = null;
            foreach (var r in rows)
            {
                if (r == null || r.free != free) continue;
                string n = r.total > 0 ? $"{r.needed} OF {r.total}" : $"{r.needed} NEEDED";
                if (seen == null) seen = n;
                else if (seen != n) return "PER ROUND";
            }
            return seen;
        }

        /// <summary>
        /// THE LINE UNDER THE ROUNDS (follow-up): only the round PLAY joins, in its row's words - "PLAY joins round c71ee776 -
        /// 7 signer nodes agree (5 needed)". Without a round to join: "PLAY waits for a round whose signer nodes agree" (never
        /// "both"), or "PLAY waits for an open round" when nothing is listed.
        /// </summary>
        public static string HintWords(LobbyRow r, int listed) => r != null
            ? $"PLAY joins round {ShortId(r.id)} - {r.agree} signer {(r.agree == 1 ? "node agrees" : "nodes agree")} ({r.needed} needed)"
            : listed > 0 ? "PLAY waits for a round whose signer nodes agree" : "PLAY waits for an open round";

        /// <summary>
        /// THE SAME LINE, LONGEST FIRST, FOR A PHONE (measured on UI 134 at 360 px: "ʼLAY joins round 9efb418b - 6 signer
        /// nodes agree (5 needed" - cut at both ends): the full line, then the numbers in fewer words, then the round alone.
        /// </summary>
        public static string[] HintWordings(LobbyRow r, int listed) => r != null
            ? new[] { HintWords(r, listed), $"PLAY joins {ShortId(r.id)} - {r.agree} agree ({r.needed} needed)", $"PLAY joins round {ShortId(r.id)}" }
            : new[] { HintWords(r, listed), listed > 0 ? "PLAY waits for agreement" : "PLAY waits for a round" };

        public static string ShortId(string id) => string.IsNullOrEmpty(id) ? "" : (id.Length > 8 ? id.Substring(0, 8) : id);

        /// <summary>What a round is: FREE, or PAID and what it costs (2026-09-15 16:08: "PAID · 100 sats").</summary>
        public static string Kind(bool free, long stakeSats) => free ? "FREE" : $"PAID · {stakeSats} {(stakeSats == 1 ? "sat" : "sats")}";

        /// <summary>An address as the player reads it: no scheme, no trailing slash.</summary>
        public static string Host(string url)
        {
            string h = url ?? "";
            int k = h.IndexOf("://", StringComparison.Ordinal);
            if (k >= 0) h = h.Substring(k + 3);
            return h.TrimEnd('/');
        }

        /// <summary>How long a joined signer node waits for its session before the round starts anyway.</summary>
        public const float SessionPatienceS = 5f;

        /// <summary>
        /// WHAT PLAY DOES ONCE THE PAGE HAS JOINED (M3.3-34, 2026-09-13
        /// 07:11: "after PLAY the loading screen must not come again. PLAY starts
        /// the round"). The round is joined in THIS page - PLAY used to navigate to
        /// the round's link, the page reloaded and Unity loaded a second time. The
        /// round starts when the page says joined and the session has opened, or
        /// `SessionPatienceS` after joined without one. "refused" hands the page's
        /// reason back to the title screen; anything else waits.
        /// </summary>
        public static string AfterJoin(LobbyState s, bool sessionRunning, float joinedForS)
        {
            if (s == null || s.join == null) return "wait";
            if (s.join.state == "refused") return "refused";
            if (s.join.state != "joined") return "wait";
            return sessionRunning || joinedForS >= SessionPatienceS ? "play" : "wait";
        }

        /// <summary>
        /// The round PLAY joins when the player has picked none: a joinable FREE
        /// round first (2026-09-15: a player with no sats who presses PLAY
        /// must not land on a paying round while a free one is listed - measured
        /// on the Daily, the paying round had the most entry left after every
        /// rollover and was PLAY's pick), and within the same kind the one with
        /// the most entry time left, so a press never lands on a round that is
        /// about to close. A paying round is PLAY's only when no free round can be
        /// joined; the player can still tap its row. -1 when no round can be joined.
        /// </summary>
        public static int PickDefault(LobbyRow[] rows)
        {
            int best = -1;
            for (int i = 0; rows != null && i < rows.Length; i++)
            {
                if (rows[i] == null || !rows[i].joinable) continue;
                if (best < 0 || (rows[i].free && !rows[best].free)
                    || (rows[i].free == rows[best].free && rows[i].leftS > rows[best].leftS)) best = i;
            }
            return best;
        }

        /// <summary>The picked round if it is still listed and joinable, else the default.</summary>
        public static int Keep(LobbyRow[] rows, string pickedId)
        {
            for (int i = 0; rows != null && i < rows.Length; i++)
                if (rows[i] != null && rows[i].joinable && rows[i].id == pickedId) return i;
            return PickDefault(rows);
        }

        /// <summary>Asks the page to join that round - the round's own link, so the round is joined as a shared link takes it.</summary>
        public static bool Join(string id) => Compiled && !string.IsNullOrEmpty(id) && ArenaLobbyJoin(id) == 1;

        /// <summary>The page asks for the name (the browser's own prompt, which a phone keyboard can type into); answers why it was refused, or "".</summary>
        public static string EditName() => Compiled ? (ArenaLobbyEditName() ?? "") : "";

        /// <summary>The page shows this tab's private-key backup, where it can be copied.</summary>
        public static void KeyBackup() { if (Compiled) ArenaLobbyKeyBackup(); }

        /// <summary>What Unity drew, told back to the page - so what a player sees can be measured, not assumed.</summary>
        public static void Shown(string json) { if (Compiled) ArenaLobbyShown(json); }

        /// <summary>The same for the assault banner and the desktop log, so a browser run can be asked what the war said.</summary>
        public static void AssaultShown(string json) { if (Compiled) ArenaAssaultShown(json); }

        /// <summary>CleanHud's half in the page: hides the HTML overlays that sit over the canvas.</summary>
        public static void HudClean(bool on) { if (Compiled) ArenaHudClean(on ? 1 : 0); }

        /// <summary>
        /// The screen's pixels per CSS pixel, 1 outside a page. The title screen
        /// is laid out in CSS pixels and drawn at this scale, so a phone at 3x
        /// shows it at the size a player reads - measured on an iPhone before:
        /// every element on screen, and the text about 8 points high.
        /// </summary>
        public static float UiScale()
        {
            if (!Compiled) return 1f;
            float s;
            try { s = ArenaUiScale(); } catch { return 1f; }
            return float.IsNaN(s) ? 1f : Mathf.Clamp(s, 1f, 4f);
        }

        /// <summary>True when the page was sent here by PLAY in the lobby: the round starts without a second PLAY.</summary>
        public static bool AutoPlay() => Query("play") == "1";

        /// <summary>The page's word on the address's play=1: -1 not decided, 0 held to the round's start, 1 drive, 2 none.</summary>
        public static int LinkAutoPlay() => ArenaLinkAutoPlay();

        /// <summary>
        /// WHAT THE ADDRESS'S play=1 DOES NOW (measured on preview UI 137: a reload during a join held to its start drove
        /// 29 s before the start with no stake): "wait" while the page has not decided (at most LinkWaitS), "no" when it holds the join
        /// to the round's start (the lobby shows it, the start begins the run), "play" otherwise - an older page that says nothing too.
        /// </summary>
        public const float LinkWaitS = 30f;
        public static string LinkAutoPlayStep(int word, float waitedS) => word == 0 ? "no" : word == -1 && waitedS < LinkWaitS ? "wait" : "play";

        static string Query(string name)
        {
            if (!Compiled) return "";
#if UNITY_WEBGL && !UNITY_EDITOR
            var nameBytes = System.Text.Encoding.UTF8.GetBytes(name + "\0");
            var outBytes = new byte[64];
            var nh = GCHandle.Alloc(nameBytes, GCHandleType.Pinned);
            var oh = GCHandle.Alloc(outBytes, GCHandleType.Pinned);
            try
            {
                int n = ArenaQueryParam(nh.AddrOfPinnedObject(), oh.AddrOfPinnedObject(), outBytes.Length);
                return n > 0 ? System.Text.Encoding.UTF8.GetString(outBytes, 0, n) : "";
            }
            finally { nh.Free(); oh.Free(); }
#else
            return "";
#endif
        }

        /// <summary>Every rectangle of the lobby inside the title screen's copy area.</summary>
        public struct Frame
        {
            public Rect you, name, key, head, more, list, howTo;
            public Rect[] howToCells;
            public bool howToGrid;
            /// <summary>A phone upright (2026-09-15 11:57, option B): four pages in one box - panel
            /// 1, 2, 3, 4, one each (howToCells[i] is page i) - and the arrows beside them that turn them.</summary>
            public bool howToCarousel;
            public Rect howToPrev, howToNext;
            public float rowH;
            public int rows;
            public bool narrow;
        }

        /// <summary>
        /// THE LOBBY'S LAYOUT, as arithmetic - because OnGUI never runs in batch
        /// mode, and "fully visible on iOS and Android" is only true if it can be
        /// measured on every phone shape without drawing it (the owner 22:16).
        ///
        /// Top down inside the copy area: who you are, with NAME and KEY beside
        /// it - or under it, on a screen too narrow for both on one line; the
        /// ROUNDS header with its page button; then as many round rows as fit.
        /// Every button is at least 34 px high, a finger's width on a phone.
        /// </summary>
        public static Frame MeasureLobby(Rect copy, float font, bool portrait = false, bool carousel = true)
        {
            float line = font * 1.45f;
            float btnH = Mathf.Max(font * 2.1f, 34f);
            float gap = Mathf.Max(4f, font * 0.4f);
            float btnW = Mathf.Max(font * 5.2f, 72f);

            // THE OWNER'S HOW-TO, FOUR PANELS (2026-09-14 07:55): load, cross
            // the front, deliver, stake and win - each panel whole, never
            // stretched. A desktop or any landscape copy area gets them as one
            // row, 1-2-3-4; a portrait one (a phone upright, a tablet) as two
            // rows, 1-2 over 3-4; a wide, short one (a phone held sideways) as the
            // same two rows in a column beside the rounds, where a strip would
            // take the height the rounds need. Shrunk to fit, never below
            // HowToMinCell high. WHICH OF THE TWO is whichever draws each panel
            // bigger in the room it has (a row on a tie): measured, a portrait
            // phone's copy area is wider than tall inside the title panel, and a
            // row there drew 64 px panels where two rows of two draw 127. Not by
            // pixels: a phone's canvas is 1170 px wide at 3x.
            // AND A PHONE HELD UPRIGHT IS ALWAYS 1-2 OVER 3-4 (the owner 07:55): its
            // copy area is wider than tall inside the title panel, so the shape of
            // the SCREEN is handed in - measured at 375x667, the bigger-panel rule
            // alone chose a row (101 px panels) over a grid capped at 42% (82 px).
            bool beside = copy.width >= copy.height * 2.2f;
            float cellGap = Mathf.Max(2f, gap * 0.5f);
            float gridCap = portrait ? 0.48f : 0.42f;
            // THE ROUNDS COME FIRST (the owner 22:16, "fully visible"): the panels take
            // only what leaves who-you-are, NAME and KEY, the header and two round
            // rows on screen. Measured at 375x667 2x: at 48% of the height the list
            // kept 75 px - one round.
            bool narrowHere = copy.width < btnW * 2f + gap + font * 16f;
            float reserved = (narrowHere ? line * 2f + gap + btnH + gap : Mathf.Max(btnH, line * 2f) + gap)
                           + Mathf.Max(line, btnH * 0.8f) + gap * 0.5f + 2f * Mathf.Max(font * 2.0f, 34f) + gap + 1f;
            float room = Mathf.Max(0f, copy.height - reserved);
            bool grid = beside || portrait || SmallestIn(true, copy.width, Mathf.Min(copy.height * gridCap, room), cellGap)
                                              > SmallestIn(false, copy.width, Mathf.Min(copy.height * 0.34f, room), cellGap) + 0.5f;
            // The box from one side, so every cell is exactly its panel's shape whatever the gaps.
            float WidthFor(float h) => BoxWidthFor(grid, h, cellGap);
            float HeightFor(float w) => BoxHeightFor(grid, w, cellGap);
            Rect howTo = default;
            Rect prev = default, next = default;
            Rect[] pages = null;
            // A PHONE ON ITS SIDE: 1-2 over 3-4 in a column at the right. Where the
            // rest can stay one line wide beside it, the column takes the FULL height
            // of the copy area (bigger panels); where it cannot - stacked, who-you-are,
            // NAME and KEY took the rounds' height: measured at 667x375 1x, a 58 px
            // list, one round - it sits beside the round list only, as before.
            // (1 px spare: measured, the left side landed a float hair under the
            // one-line width and stacked - 667x375 1x, a 58 px list.)
            float keepWide = copy.width - (btnW * 2f + gap + font * 16f) - gap - 1f;
            bool besideAll = beside && keepWide >= WidthFor(MinBoxHeight(grid, cellGap));
            if (besideAll)
            {
                float aw = Mathf.Min(copy.width * 0.45f, WidthFor(copy.height), keepWide);
                float ah = HeightFor(aw);
                howTo = new Rect(copy.xMax - aw, copy.y, aw, ah);
                copy = new Rect(copy.x, copy.y, Mathf.Max(0f, copy.width - aw - gap), copy.height);
            }
            else if (!beside)
            {
                float hh = Mathf.Min(HeightFor(copy.width), Mathf.Min(copy.height * (grid ? gridCap : 0.34f), room));
                hh = Mathf.Max(hh, Mathf.Min(room, MinBoxHeight(grid, cellGap)));
                float hw = WidthFor(hh);
                if (hw > copy.width) { hw = copy.width; hh = HeightFor(hw); }
                howTo = new Rect(copy.x + (copy.width - hw) * 0.5f, copy.y, hw, hh);
                // A PHONE UPRIGHT TURNS PAGES (2026-09-15 11:57, option B): the four panels as
                // 1-2 over 3-4 were hard to read and took too much of a phone. One panel per page, the
                // arrows beside it; its room is the grid's, so the rounds still come first.
                // `carousel: false` is that grid, kept as the measure.
                if (portrait && carousel)
                    (howTo, prev, next, pages) = CarouselOf(copy, room, btnH, gap);
                copy = new Rect(copy.x, howTo.yMax + gap, copy.width, Mathf.Max(0f, copy.yMax - howTo.yMax - gap));
            }

            bool narrow = copy.width < btnW * 2f + gap + font * 16f;

            Rect you, name, key;
            float y = copy.y;
            if (narrow)
            {
                you = new Rect(copy.x, y, copy.width, line * 2f);
                y = you.yMax + gap;
                float half = (copy.width - gap) * 0.5f;
                name = new Rect(copy.x, y, half, btnH);
                key = new Rect(name.xMax + gap, y, copy.width - half - gap, btnH);
                y = name.yMax + gap;
            }
            else
            {
                float right = btnW * 2f + gap;
                you = new Rect(copy.x, y, copy.width - right - gap, Mathf.Max(btnH, line * 2f));
                name = new Rect(you.xMax + gap, y + (you.height - btnH) * 0.5f, btnW, btnH);
                key = new Rect(name.xMax + gap, name.y, btnW, btnH);
                y = you.yMax + gap;
            }

            float moreW = Mathf.Max(font * 4f, 56f);
            float headH = Mathf.Max(line, btnH * 0.8f);
            var head = new Rect(copy.x, y, copy.width - moreW - gap, headH);
            var more = new Rect(head.xMax + gap, y, moreW, headH);
            y = head.yMax + gap * 0.5f;

            float rowH = Mathf.Max(font * 2.0f, 34f);
            var list = new Rect(copy.x, y, copy.width, Mathf.Max(0f, copy.yMax - y));
            if (beside && !besideAll)
            {
                // the column beside the rounds: 1-2 over 3-4, from the rounds header
                // down, no wider than 45% of the list; the header, its page button and
                // the list give up its width. Measured beside the list only, with the
                // panels at their own shapes: panel 3 drew 37 px at 667x375 1x.
                float aw = Mathf.Min(list.width * 0.45f, WidthFor(copy.yMax - head.y));
                float ah = HeightFor(aw);
                howTo = new Rect(copy.xMax - aw, head.y, aw, ah);
                float cut = aw + gap;
                head = new Rect(head.x, head.y, Mathf.Max(0f, head.width - cut), head.height);
                more = new Rect(more.x - cut, more.y, more.width, more.height);
                list = new Rect(list.x, list.y, Mathf.Max(0f, list.width - cut), list.height);
            }
            int rows = Mathf.Max(0, Mathf.FloorToInt((list.height + 0.01f) / rowH));
            return new Frame { you = you, name = name, key = key, head = head, more = more, list = list,
                               howTo = howTo, howToCells = pages ?? HowToCells(howTo, grid, cellGap), howToGrid = grid,
                               howToCarousel = pages != null, howToPrev = prev, howToNext = next,
                               rowH = rowH, rows = rows, narrow = narrow };
        }

        /// <summary>How much taller panels 1 and 2 are on their pages than the grid's top row, at least (the letter's number).</summary>
        public const float CarouselTaller = 1.15f;

        /// <summary>The page panel `i` is on: one panel per page, 1 to 4 (2026-09-15, option B).</summary>
        public static int HowToPageOf(int panel) => panel;

        /// <summary>How many pages the how-to has on a phone upright.</summary>
        public const int HowToPages = 4;

        /// <summary>
        /// ONE PANEL PER PAGE, FOUR PAGES (2026-09-15, option B): 1, then 2, then 3, then 4,
        /// the arrows beside them. In CSS pixels, as the page lays the title screen out (UiScale):
        /// a phone upright's copy area is 266-318 px wide, and 1 and 2 side by side cannot be
        /// taller there than the grid drew them (measured: 375x667, a 277 px copy area, the grid's
        /// top row 111.4 px); one panel across the width can. The box is panel 1's height at the
        /// width beside the arrows - its shape is the tallest - never more than the room the
        /// rounds leave, and one size on every page, so turning a page moves nothing else. Every
        /// other panel as big as fits in it, centred, each its own shape.
        /// </summary>
        static (Rect box, Rect prev, Rect next, Rect[] cells) CarouselOf(Rect copy, float room, float arrow, float gap)
        {
            float avail = Mathf.Max(0f, copy.width - 2f * (arrow + gap));
            float h = Mathf.Max(0f, Mathf.Min(avail / PanelAspectOf(0), room));
            var box = new Rect(copy.x, copy.y, copy.width, h);
            var prev = new Rect(box.x, box.y, arrow, h);
            var next = new Rect(box.xMax - arrow, box.y, arrow, h);
            float x0 = prev.xMax + gap;
            var cells = new Rect[HowToPages];
            for (int i = 0; i < HowToPages; i++)
            {
                float a = PanelAspectOf(i), ch = Mathf.Min(h, avail / a), cw = ch * a;
                cells[i] = new Rect(x0 + (avail - cw) * 0.5f, box.y + (h - ch) * 0.5f, cw, ch);
            }
            return (box, prev, next, cells);
        }

        /// <summary>
        /// the owner's how-to, whole (2026-09-14 07:55), in Resources
        /// (Assets/Art/Resources/lobby-howto.png, 1448x1086), white knocked out for
        /// the dark UI: 1 load, 2 cross the front, 3 deliver, 4 stake and win.
        /// EVERY PANEL IS DRAWN FROM IT BY ITS OWN BOX: the four tiles that came with
        /// it were cut at half height (y 543), and the picture's rows really part at
        /// y 625-649 - tile 3 carried the bottom of panel 1 (the players, the truck),
        /// which showed as a sliver above 3 and 4 in one row (measured, 1280x800).
        /// </summary>
        public const string HowToWhole = "lobby-howto";
        const float WholeW = 1448f, WholeH = 1086f;

        /// <summary>Each panel's opaque box in the whole, x y w h from the top-left (tools/cut-howto.py).</summary>
        public static readonly Rect[] PanelBoxes =
        {
            new Rect(32f, 80f, 667f, 545f), new Rect(726f, 82f, 714f, 543f),
            new Rect(23f, 650f, 688f, 369f), new Rect(752f, 653f, 677f, 367f),
        };

        /// <summary>Width over height of panel `i` - they are not one shape: 1.22, 1.31, 1.86, 1.84.</summary>
        public static float PanelAspectOf(int i) => PanelBoxes[i].width / PanelBoxes[i].height;

        /// <summary>Panel `i`'s box as UVs in the whole (origin bottom-left).</summary>
        public static Rect PanelUv(int i)
        {
            var b = PanelBoxes[i];
            return new Rect(b.x / WholeW, 1f - (b.y + b.height) / WholeH, b.width / WholeW, b.height / WholeH);
        }

        static float SumAspect => PanelAspectOf(0) + PanelAspectOf(1) + PanelAspectOf(2) + PanelAspectOf(3);
        static float MaxAspect => Mathf.Max(Mathf.Max(PanelAspectOf(0), PanelAspectOf(1)), Mathf.Max(PanelAspectOf(2), PanelAspectOf(3)));
        // two columns of width c: the top row as tall as its taller panel, the bottom row too
        static float GridK => 1f / Mathf.Min(PanelAspectOf(0), PanelAspectOf(1)) + 1f / Mathf.Min(PanelAspectOf(2), PanelAspectOf(3));

        /// <summary>How tall the how-to box is at `w` wide: one row at one height, or 1-2 over 3-4 in two equal columns.</summary>
        public static float BoxHeightFor(bool grid, float w, float g)
            => grid ? Mathf.Max(0f, (w - g) * 0.5f) * GridK + g : Mathf.Max(0f, w - 3f * g) / SumAspect;

        /// <summary>How wide the how-to box is at `h` tall.</summary>
        public static float BoxWidthFor(bool grid, float h, float g)
            => grid ? 2f * Mathf.Max(0f, h - g) / GridK + g : h * SumAspect + 3f * g;

        /// <summary>The box height at which the smallest panel is HowToMinCell high.</summary>
        public static float MinBoxHeight(bool grid, float g) => grid ? HowToMinCell * MaxAspect * GridK + g : HowToMinCell;

        /// <summary>How high the smallest panel is drawn in the biggest box of that kind inside `w` x `capH`.</summary>
        public static float SmallestIn(bool grid, float w, float capH, float g)
        {
            float h = Mathf.Min(BoxHeightFor(grid, w, g), capH);
            float bw = BoxWidthFor(grid, h, g);
            return grid ? Mathf.Max(0f, (bw - g) * 0.5f) / MaxAspect : h;
        }

        /// <summary>
        /// The four panels inside the how-to box, each exactly its own shape: 1-2-3-4
        /// in a row at one height, or 1-2 over 3-4 in two equal columns, top-aligned.
        /// </summary>
        public static Rect[] HowToCells(Rect box, bool grid, float g)
        {
            var cells = new Rect[4];
            if (grid)
            {
                float c = Mathf.Max(0f, (box.width - g) * 0.5f);
                float top = c / Mathf.Min(PanelAspectOf(0), PanelAspectOf(1));
                for (int i = 0; i < 4; i++)
                    cells[i] = new Rect(box.x + (i % 2) * (c + g), box.y + (i < 2 ? 0f : top + g), c, c / PanelAspectOf(i));
            }
            else
            {
                float x = box.x;
                for (int i = 0; i < 4; i++)
                {
                    float w = box.height * PanelAspectOf(i);
                    cells[i] = new Rect(x, box.y, w, box.height);
                    x += w + g;
                }
            }
            return cells;
        }

        /// <summary>
        /// The smallest a panel is drawn, in layout px: the floor the 1-2-3-4 strip
        /// before it was held to (40). A phone draws at 2-3x, so that is 80-120
        /// device px; 60 could not be kept beside two rounds on a 667x375 screen
        /// at 1x - measured - and no phone draws at 1x.
        /// </summary>
        public const float HowToMinCell = 40f;

        /// <summary>
        /// One row's words, shortest first to go: the round id, then the joined count. A paying
        /// row says what it costs in every form (2026-09-15 16:08: "Paid must read like
        /// 'PAID · 100 sats'") - measured before, it said PAID and never how much.
        /// </summary>
        public static string[] RowWords(LobbyRow r) => RowWords(r, false);

        /// <summary>
        /// And with `named`, while a refusal names a round, every row says its own name right after its kind, so the round
        /// the lobby still offers is told apart from the one that was refused (2026-09-26 16:56); the joined count and
        /// then the signer nodes go first to fit.
        /// </summary>
        public static string[] RowWords(LobbyRow r, bool named)
        {
            string kind = Kind(r.free, r.stakeSats);
            // NEVER A ROUND LENGTH (2026-10-04 11:25Z: "closes 1:57" on a 90 s round). The countdown is the ENTRY's,
            // so the row says when the round starts and until when it can be joined, from the page's startS and leftS; an older
            // page sends no startS (-1) and the row then says only "join until".
            string join = r.leftS >= 0 ? $"join until {r.leftS / 60}:{r.leftS % 60:00}" : "entry open";
            string left = r.startS > 0 ? $"starts in {r.startS / 60}:{r.startS % 60:00} · {join}"
                : r.startS == 0 ? $"started · {join}"
                : join;
            // THE PLAYER IS NEVER TOLD "SIGNER NODE" (2026-09-15 16:22): the nodes that sign the
            // round are signer nodes, and the players in it have joined. "7 signer nodes (5 needed)", not "7 of 5".
            // A ROUND WHOSE ENTRY HAS CLOSED SAYS SO rather than "waiting" (the page no longer offers it: measured, "closes 0:00"
            // with PLAY enabled for 237 s behind a silent signer node).
            string nodes = $"{r.agree} signer {(r.agree == 1 ? "node" : "nodes")} ({r.needed} needed)";
            string signers = r.joinable ? nodes
                : r.leftS == 0 ? $"{nodes} - entry closed"
                : $"{nodes} - waiting";
            string id = ShortId(r.id);
            if (named && id.Length > 0)
                return new[]
                {
                    $"{kind} · round {id} · {left} · {signers} · {r.joined} joined",
                    $"{kind} · round {id} · {left} · {signers}",
                    $"{kind} · round {id} · {left}",
                };
            // AND SHORTER, FOR A PHONE (measured on UI 133 at 390 px: "PAID · 100 sats · starts in 0:28 · join until
            // 1:00 · 7 signer node" - the last wording still too wide, cut): the nodes as a count, then the times alone
            string few = r.joinable ? $"{r.agree} {(r.agree == 1 ? "node" : "nodes")}" : r.leftS == 0 ? "entry closed" : "waiting";
            return new[]
            {
                $"{kind} · {left} · {signers} · {r.joined} joined · {id}",
                $"{kind} · {left} · {signers} · {r.joined} joined",
                $"{kind} · {left} · {signers}",
                $"{kind} · {left} · {few}",
                $"{kind} · {left}",
            };
        }
    }
}
