using NUnit.Framework;
using Blwp;

/// <summary>
/// THE WAR DOES NOT RACE TO CATCH UP (the owner 2026-09-16 12:26: tanks "suddenly become very fast and race
/// to another place - not instant", immediately on login). The core is stepped in whole ticks, at most
/// eight a frame. Slow frames used to leave the rest owed with no end to it, and fast frames then paid
/// it back at eight ticks a frame. This drives the stepping rule with the frames a page has while it
/// loads - a third of a second each, the longest frame Unity reports - and then with 60 fps frames.
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

        Assert.AreEqual(60 * CoreDrivenTruck.MostTicksPerFrame, slowTicks, "a slow frame should still step its most");
        Assert.LessOrEqual(most, 2, $"a 60 fps frame stepped {most} ticks: the world is racing to catch up");
        Assert.AreEqual(120f, fastTicks, 2f, $"2 s at 60 fps should be about 120 ticks, it was {fastTicks}");
        Assert.Less(acc, Step, "what is kept is under one step, for drawing between ticks");
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
