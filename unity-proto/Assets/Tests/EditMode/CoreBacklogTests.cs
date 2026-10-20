// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
using NUnit.Framework;
using Arena;

/// <summary>
/// THE WAR DOES NOT RACE TO CATCH UP, AND IT DOES NOT LIVE IN THE PAST EITHER.
///
/// 2026-09-16 12:26: tanks "suddenly become very fast and race to another place - not instant",
/// immediately on login. That was fast frames paying off an unbounded debt at eight ticks a frame, and
/// the answer then was to throw the time away. 2026-09-18 10:42: "TANKS are in completely
/// different places in the two sessions, as if each tab has its own game" - which is what throwing it
/// away costs, because a browser throttles the tab it is not showing and that tab then stays behind.
///
/// So the rule is the second half of his own first sentence: not instant was what it lacked. A page
/// steps at most eight ticks a frame while it is nearly up to date, and a debt over a second is stepped
/// in ONE frame rather than walked off or dropped. This drives that rule with the frames a page has
/// while it loads - a third of a second each, the longest frame Unity reports - and then with 60 fps
/// frames, where the test that matters is that nothing is left to race off.
/// </summary>
public class CoreBacklogTests
{
    const float Step = 1f / 60f;

    [Test]
    public void FastFramesAfterSlowOnesStepTheWorldAtItsOwnSpeed()
    {
        float acc = 0f, droppedS = 0f;
        int slowTicks = 0;
        for (int f = 0; f < 60; f++)                       // 20 s of loading at 3 fps
        {
            acc += 1f / 3f;
            slowTicks += CoreDrivenTruck.TicksDue(ref acc, Step, CoreDrivenTruck.MostTicksPerFrame, out float d);
            droppedS += d;
        }

        int most = 0, fastTicks = 0;
        for (int f = 0; f < 120; f++)                      // then 2 s at 60 fps
        {
            acc += Step;
            int due = CoreDrivenTruck.TicksDue(ref acc, Step, CoreDrivenTruck.MostTicksPerFrame, out _);
            most = System.Math.Max(most, due);
            fastTicks += due;
        }

        UnityEngine.Debug.Log($"[backlog-test] 20 s at 3 fps stepped {slowTicks} ticks and let go {droppedS:F2} s; "
                              + $"then 2 s at 60 fps stepped {fastTicks} ticks, at most {most} in one frame");

        // THE WHOLE TWENTY SECONDS OF WORLD, not the 480 ticks eight a frame would have managed: a page that steps
        // less than the round does is a page whose tanks stand somewhere else than everybody else's.
        Assert.AreEqual(1200, slowTicks, 2, $"20 s at 3 fps stepped {slowTicks} ticks, so this page is in its own world");
        Assert.AreEqual(0f, droppedS, 1e-6f, $"a slow page threw away {droppedS:F2} s of the round");
        // AND NOTHING IS LEFT TO RACE OFF when the frames come back, which is the 12:26 report.
        Assert.LessOrEqual(most, 2, $"a 60 fps frame stepped {most} ticks: the world is racing to catch up");
        Assert.AreEqual(120f, fastTicks, 2f, $"2 s at 60 fps should be about 120 ticks, it was {fastTicks}");
        Assert.Less(acc, Step, "what is kept is under one step, for drawing between ticks");
    }

    /// <summary>
    /// A TAB THE BROWSER WAS NOT SHOWING REJOINS THE ROUND (2026-09-18 10:42: "TANKS are in completely
    /// different places in the two sessions, as if each tab has its own game").
    ///
    /// A hidden tab is throttled to nothing by the browser, and the time it missed used to be thrown away: his two
    /// tabs showed one block at 0:34 and 0:20 with their tanks in different places, each core at its own tick. The
    /// world is the round's, so the time is stepped when the page is shown again - in one frame, because the 12:26
    /// report asked for exactly that: not a race, and "not instant" was what it was missing.
    /// </summary>
    [Test]
    public void ATabThatWasHiddenStepsTheTimeItMissedInsteadOfLosingIt()
    {
        float acc = 0f;
        int ticks = CoreDrivenTruck.TicksDue(ref acc, Step, CoreDrivenTruck.MostTicksPerFrame, out float d, out int j);
        Assert.AreEqual(0, ticks, "an empty accumulator stepped something");

        acc += 8f;                                        // eight seconds with the tab in the background
        ticks = CoreDrivenTruck.TicksDue(ref acc, Step, CoreDrivenTruck.MostTicksPerFrame, out d, out j);
        UnityEngine.Debug.Log($"[backlog-test] 8 s hidden: stepped {ticks} ticks in one frame ({j} of them jumped), "
                              + $"let go {d:F3} s, kept {acc:F4} s");
        Assert.AreEqual(480, ticks, 1, $"8 s of world should be 480 ticks, it stepped {ticks}");
        Assert.AreEqual(0f, d, 1e-6f, $"a hidden tab threw away {d:F3} s and would stand in a different world");
        Assert.Less(acc, Step, "what is kept is under one step");

        // AND A TAB LEFT FOR TEN MINUTES IS NOT STEPPED FOR EVER: what is past the cap is given up, once.
        acc += 600f;
        ticks = CoreDrivenTruck.TicksDue(ref acc, Step, CoreDrivenTruck.MostTicksPerFrame, out d, out j);
        Assert.AreEqual(CoreDrivenTruck.MostTicksAtOnce + CoreDrivenTruck.MostTicksPerFrame, ticks,
            "a frame stepped more than the cap allows");
        Assert.Greater(d, 0f, "ten minutes away should give up what is past the cap");
    }

    [Test]
    public void AnOrdinaryFrameLosesNothing()
    {
        float acc = 0f, droppedS = 0f;
        int ticks = 0;
        for (int f = 0; f < 450; f++)                      // 10 s at 45 fps
        {
            acc += 1f / 45f;
            ticks += CoreDrivenTruck.TicksDue(ref acc, Step, CoreDrivenTruck.MostTicksPerFrame, out float d);
            droppedS += d;
        }
        Assert.AreEqual(0f, droppedS, 1e-6f, $"a 45 fps page let go {droppedS:F3} s");
        Assert.AreEqual(600, ticks, 1, $"10 s at 45 fps should step 600 ticks, it stepped {ticks}");
    }
}
