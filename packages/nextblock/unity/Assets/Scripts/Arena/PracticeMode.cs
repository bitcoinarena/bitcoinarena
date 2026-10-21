// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using UnityEngine;

namespace Arena
{
    /// <summary>
    /// Practice: the army fires, and nothing lands.
    ///
    /// ON by default in this build, because it exists to be driven and judged
    /// rather than survived. The flag is not a Unity secret - it is fed to the
    /// deterministic core as an input, rides in the transcript with the
    /// throttle and the steering, and is written into the hashed state. A node
    /// replaying a staked run therefore sees exactly which ticks were shielded
    /// and can refuse to settle it.
    ///
    /// That is the whole difference between a practice mode and a cheat, and it
    /// is why this was worth a protocol input rather than a line in TruckHealth
    /// that hides the damage after the fact.
    /// </summary>
    public static class PracticeMode
    {
        /// <summary>True while incoming fire is withheld.</summary>
        public static bool On = true;

        /// <summary>
        /// Where the starting value came from, for the log and for the HUD.
        ///
        /// Worth recording rather than inferring: "practice was on" and "the
        /// URL asked for practice" are different facts, and only the second
        /// survives a screenshot.
        /// </summary>
        public static string Source { get; private set; } = "default";

        /// <summary>What the core wants: Q16.16, so one or nothing.</summary>
        public static int Input => On ? ArenaCore.ONE : 0;

        /// <summary>
        /// THE INPUT A RUN SENDS (2026-10-04): never practice in a signed run. Practice was on by default and its
        /// switch sat under the cargo panel until ROLL OUT, so every staked run carried practice ticks - S_PRACTICE set, the
        /// damage withheld. Unity stops sending it; the core and its pinned hash are unchanged.
        /// </summary>
        public static int InputFor(bool signedRun) => signedRun ? 0 : Input;

        /// <summary>What the PRACTICE box says in a signed run, and outside one.</summary>
        public static string Words(bool on, bool signedRun) =>
            signedRun ? "live fire  ·  in a signed run" : on ? "no damage  ·  tap to arm" : "live fire  ·  tap for practice";

        public static void Toggle() { On = !On; Source = "player"; }

        /// <summary>
        /// Sets the starting state, in order of authority.
        ///
        /// The URL wins because that is what a shared link is for - handing
        /// somebody a build already in the mode you meant them to see. The
        /// scene's own setting is the fallback so the editor and a standalone
        /// build have an answer without one.
        ///
        /// Accepts ?practice=0/1, ?practice=off/on, ?practice=false/true.
        /// </summary>
        public static void Configure(bool sceneDefault)
        {
            On = sceneDefault;
            Source = "scene";

            string q = ArenaCore.QueryParam("practice");
            if (string.IsNullOrEmpty(q)) return;

            q = q.Trim().ToLowerInvariant();
            if (q == "0" || q == "off" || q == "false" || q == "no") { On = false; Source = "url"; }
            else if (q == "1" || q == "on" || q == "true" || q == "yes") { On = true; Source = "url"; }
            else Debug.LogWarning("[arena] ?practice=" + q + " not understood, keeping the scene default");
        }
    }
}
