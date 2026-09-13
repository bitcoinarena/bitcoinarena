using System;
using UnityEngine;
#if UNITY_WEBGL && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace Blwp
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
        public int seated;
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

    /// <summary>The seat PLAY asked for, as the page took it: "" before any press, then joining, joined or refused - and why, and the step it is on.</summary>
    [Serializable]
    public class LobbyJoin
    {
        public string state = "";
        public string why = "";
        public string stage = "";
    }

    /// <summary>What the page hands Unity to draw: the lobby, or nothing.</summary>
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
    }

    /// <summary>
    /// THE DAILY'S LOBBY, DRAWN BY UNITY (M3.3-34, the owner 2026-09-12 22:11-22:16).
    ///
    /// The lobby is the title screen: the rounds, who you are, PLAY and
    /// SPECTATE. What it shows is decided in the page and nowhere else - every
    /// round is fetched from the seats and checked against its own contract and
    /// both seats' signed listings before it is a row, and Join exists only when
    /// both seats of a 2-of-2 round say open and seated. Unity draws that and
    /// hands the player's press back; it decides nothing and holds no key.
    ///
    /// Outside a WebGL player there is no page, so every call answers nothing
    /// and the title screen is the offline one, exactly as before.
    /// </summary>
    public static class DailyLobby
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern string BlwpLobbyState();
        [DllImport("__Internal")] static extern int BlwpLobbyJoin(string id);
        [DllImport("__Internal")] static extern string BlwpLobbyEditName();
        [DllImport("__Internal")] static extern void BlwpLobbyKeyBackup();
        [DllImport("__Internal")] static extern void BlwpLobbyShown(string json);
        [DllImport("__Internal")] static extern int BlwpQueryParam(IntPtr name, IntPtr outp, int cap);
        [DllImport("__Internal")] static extern float BlwpUiScale();
        public const bool Compiled = true;
#else
        static float BlwpUiScale() => 1f;
        static string BlwpLobbyState() => "";
        static int BlwpLobbyJoin(string id) => 0;
        static string BlwpLobbyEditName() => "";
        static void BlwpLobbyKeyBackup() { }
        static void BlwpLobbyShown(string json) { }
        static int BlwpQueryParam(IntPtr name, IntPtr outp, int cap) => 0;
        public const bool Compiled = false;
#endif

        /// <summary>The lobby the page holds now, or null when this page is not a lobby.</summary>
        public static LobbyState Poll()
        {
            if (!Compiled) return null;
            try { return Parse(BlwpLobbyState()); } catch (Exception e) { Debug.LogWarning($"[lobby] {e.Message}"); return null; }
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
            return s;
        }

        /// <summary>How long a joined seat waits for its session before the round starts anyway.</summary>
        public const float SessionPatienceS = 5f;

        /// <summary>
        /// WHAT PLAY DOES ONCE THE PAGE HAS THE SEAT (M3.3-34, the owner 2026-09-13
        /// 07:11: "after PLAY the loading screen must not come again. PLAY starts
        /// the round"). The seat is taken in THIS page - PLAY used to navigate to
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
        /// The round PLAY joins when the player has picked none: the joinable one
        /// with the most entry time left, so a press never lands on a round that
        /// is about to close. -1 when no round can be joined.
        /// </summary>
        public static int PickDefault(LobbyRow[] rows)
        {
            int best = -1;
            for (int i = 0; rows != null && i < rows.Length; i++)
            {
                if (rows[i] == null || !rows[i].joinable) continue;
                if (best < 0 || rows[i].leftS > rows[best].leftS) best = i;
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

        /// <summary>Asks the page to join that round - the round's own link, so the seat is taken as a shared link takes it.</summary>
        public static bool Join(string id) => Compiled && !string.IsNullOrEmpty(id) && BlwpLobbyJoin(id) == 1;

        /// <summary>The page asks for the name (the browser's own prompt, which a phone keyboard can type into); answers why it was refused, or "".</summary>
        public static string EditName() => Compiled ? (BlwpLobbyEditName() ?? "") : "";

        /// <summary>The page shows this tab's private-key backup, where it can be copied.</summary>
        public static void KeyBackup() { if (Compiled) BlwpLobbyKeyBackup(); }

        /// <summary>What Unity drew, told back to the page - so what a player sees can be measured, not assumed.</summary>
        public static void Shown(string json) { if (Compiled) BlwpLobbyShown(json); }

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
            try { s = BlwpUiScale(); } catch { return 1f; }
            return float.IsNaN(s) ? 1f : Mathf.Clamp(s, 1f, 4f);
        }

        /// <summary>True when the page was sent here by PLAY in the lobby: the round starts without a second PLAY.</summary>
        public static bool AutoPlay() => Query("play") == "1";

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
                int n = BlwpQueryParam(nh.AddrOfPinnedObject(), oh.AddrOfPinnedObject(), outBytes.Length);
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
        public static Frame MeasureLobby(Rect copy, float font)
        {
            float line = font * 1.45f;
            float btnH = Mathf.Max(font * 2.1f, 34f);
            float gap = Mathf.Max(4f, font * 0.4f);
            float btnW = Mathf.Max(font * 5.2f, 72f);

            // THE HOW-TO ART (the owner 2026-09-13 08:58): ONE picture, small and
            // whole - load, cross the front, deliver, stake and win. A copy area
            // taller than it is wide-ish (a phone upright, a tablet, a desktop)
            // gets it as a strip across the top; a wide, short one (a phone held
            // sideways) as a column beside the rounds, where a strip would take
            // the height the rounds need.
            bool beside = copy.width >= copy.height * 2.2f;
            Rect howTo = default;
            if (!beside)
            {
                float hh = Mathf.Min(copy.width / HowToAspect, copy.height * 0.24f);
                float hw = hh * HowToAspect;
                howTo = new Rect(copy.x + (copy.width - hw) * 0.5f, copy.y, hw, hh);
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
            if (beside)
            {
                // the column: as tall as the list allows, no wider than 38% of it
                float ah = Mathf.Min(list.height, list.width * 0.38f / HowToAspect);
                float aw = ah * HowToAspect;
                howTo = new Rect(list.xMax - aw, list.y, aw, ah);
                list = new Rect(list.x, list.y, Mathf.Max(0f, list.width - aw - gap), list.height);
            }
            int rows = Mathf.Max(0, Mathf.FloorToInt((list.height + 0.01f) / rowH));
            return new Frame { you = you, name = name, key = key, head = head, more = more, list = list,
                               howTo = howTo, rowH = rowH, rows = rows, narrow = narrow };
        }

        /// <summary>The how-to art, loaded from Resources (Assets/Art/Resources).</summary>
        public const string HowToResource = "lobby-how-to-1-2-3-4";

        /// <summary>
        /// The part of the 1280x720 file that is drawn, as UVs (origin bottom-left):
        /// the four cards, x 40-1240 and y 118-570 from the top - the empty margins
        /// around them are not drawn, so the picture is as big as its room allows.
        /// </summary>
        public static readonly Rect HowToUv = new Rect(40f / 1280f, 150f / 720f, 1200f / 1280f, 452f / 720f);

        /// <summary>Width over height of the part drawn.</summary>
        public const float HowToAspect = 1200f / 452f;

        /// <summary>One row's words, shortest first to go: the round id, then the seated count.</summary>
        public static string[] RowWords(LobbyRow r)
        {
            string left = r.leftS >= 0 ? $"closes {r.leftS / 60}:{r.leftS % 60:00}" : "entry open";
            string seats = r.joinable ? $"{r.agree} of {r.needed} seats" : $"{r.agree} of {r.needed} seats - waiting";
            string id = string.IsNullOrEmpty(r.id) ? "" : (r.id.Length > 8 ? r.id.Substring(0, 8) : r.id);
            return new[]
            {
                $"{(r.free ? "FREE" : "PAID")} · {left} · {seats} · {r.seated} seated · {id}",
                $"{(r.free ? "FREE" : "PAID")} · {left} · {seats} · {r.seated} seated",
                $"{(r.free ? "FREE" : "PAID")} · {left} · {seats}",
            };
        }
    }
}
