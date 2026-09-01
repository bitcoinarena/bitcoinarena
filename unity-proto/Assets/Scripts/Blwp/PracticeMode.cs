using UnityEngine;

namespace Blwp
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
        public static int Input => On ? BlwpCore.ONE : 0;

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

            string q = BlwpCore.QueryParam("practice");
            if (string.IsNullOrEmpty(q)) return;

            q = q.Trim().ToLowerInvariant();
            if (q == "0" || q == "off" || q == "false" || q == "no") { On = false; Source = "url"; }
            else if (q == "1" || q == "on" || q == "true" || q == "yes") { On = true; Source = "url"; }
            else Debug.LogWarning("[blwp] ?practice=" + q + " not understood, keeping the scene default");
        }
    }
}
