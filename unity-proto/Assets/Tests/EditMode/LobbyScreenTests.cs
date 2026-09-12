using NUnit.Framework;
using UnityEngine;
using Blwp;

/// <summary>
/// THE DAILY'S LOBBY IN UNITY, FULLY VISIBLE ON EVERY PHONE (M3.3-34, the owner
/// 2026-09-12 22:16: "lobby and all its elements must be fully visible in Unity
/// on iOS and Android").
///
/// OnGUI never runs in batch mode, so visible is measured the way the title
/// screen's own test measures it: the layout is arithmetic, asked for at the
/// screen shapes iPhones and Android phones actually have - portrait and
/// landscape, at 1x and at the 2x drawing buffer the page gives a phone - and
/// every element has to sit inside the panel, clear of every other, with room
/// for at least two rounds and buttons a finger can hit.
/// </summary>
public class LobbyScreenTests
{
    static readonly Vector2[] Css =
    {
        // iOS: SE, 12-15, Pro Max - portrait and landscape
        new Vector2(375, 667), new Vector2(667, 375), new Vector2(390, 844), new Vector2(844, 390),
        new Vector2(430, 932), new Vector2(932, 430),
        // Android: common small and large phones - portrait and landscape
        new Vector2(360, 800), new Vector2(800, 360), new Vector2(412, 915), new Vector2(915, 412),
        // tablets and desktops
        new Vector2(768, 1024), new Vector2(1024, 768), new Vector2(1366, 768), new Vector2(1920, 1080),
    };

    static void Inside(Rect inner, Rect outer, string what)
    {
        const float e = 0.5f;
        Assert.IsTrue(inner.xMin >= outer.xMin - e && inner.yMin >= outer.yMin - e
                      && inner.xMax <= outer.xMax + e && inner.yMax <= outer.yMax + e,
            $"{what}: {inner} is not inside {outer}");
    }

    [Test]
    public void EveryLobbyElementIsInsideThePanelAndClearOfEveryOtherOnEveryPhone()
    {
        foreach (var css in Css)
        // 1x, 2x, and the densities phones actually draw at - measured on the
        // live page, an iPhone's Unity screen is 3x (1170x2532); Android 2.625x.
        foreach (var dpr in new[] { 1f, 2f, 2.625f, 3f })
        {
            float w = css.x * dpr, h = css.y * dpr;
            float min = Mathf.Min(w, h);
            float sub = Mathf.Clamp(min * 0.028f, 14f, 24f);
            float btn = Mathf.Clamp(min * 0.040f, 18f, 34f);
            var f = SplashScreen.Measure(w, h, sub, btn);
            var l = DailyLobby.MeasureLobby(f.copy, Mathf.Round(sub));
            string at = $"at {css.x}x{css.y} css, {dpr}x";

            Inside(f.panel, new Rect(0, 0, w, h), $"the panel {at}");
            foreach (var (r, what) in new[] { (f.play, "PLAY"), (f.spectate, "SPECTATE"), (f.hint, "the hint") })
                Inside(r, f.panel, $"{what} {at}");

            var parts = new[] { (l.you, "who you are"), (l.name, "NAME"), (l.key, "KEY"), (l.head, "the rounds header"),
                                (l.more, "the page button"), (l.list, "the round list") };
            foreach (var (r, what) in parts) Inside(r, f.copy, $"{what} {at}");
            for (int i = 0; i < parts.Length; i++)
                for (int j = i + 1; j < parts.Length; j++)
                    Assert.IsFalse(parts[i].Item1.Overlaps(parts[j].Item1), $"{parts[i].Item2} and {parts[j].Item2} overlap {at}");
            foreach (var (r, what) in new[] { (f.play, "PLAY"), (f.spectate, "SPECTATE"), (f.hint, "the hint") })
                Assert.IsFalse(l.list.Overlaps(r) || l.you.Overlaps(r), $"the lobby and {what} overlap {at}");

            Assert.GreaterOrEqual(l.rows, 2, $"fewer than two rounds fit {at}: list {l.list.height:0} px, row {l.rowH:0} px");
            Assert.LessOrEqual(l.rows * l.rowH, l.list.height + 0.5f, $"the rows run out of the list {at}");
            foreach (var (r, what) in new[] { (l.name, "NAME"), (l.key, "KEY"), (l.more, "the page button") })
                Assert.GreaterOrEqual(r.height, 27f, $"{what} is too small to press {at}");
            Assert.GreaterOrEqual(l.name.height, 34f, $"NAME is under a finger's height {at}");
            Assert.GreaterOrEqual(l.rowH, 34f, $"a round row is under a finger's height {at}");
            Assert.GreaterOrEqual(f.play.height, 30f, $"PLAY is under a finger's height {at}");
        }
    }

    const string Sample = "{\"mode\":\"lobby\",\"from\":\"daily.json\",\"you\":{\"name\":\"azure-elk-1364\",\"custom\":false,"
        + "\"generated\":\"azure-elk-1364\",\"fingerprint\":\"1a2b3c4d\"},\"rows\":["
        + "{\"id\":\"aaaa1111\",\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":40,\"seated\":0},"
        + "{\"id\":\"bbbb2222\",\"free\":true,\"agree\":1,\"needed\":2,\"joinable\":false,\"leftS\":170,\"seated\":0},"
        + "{\"id\":\"cccc3333\",\"free\":true,\"agree\":2,\"needed\":2,\"joinable\":true,\"leftS\":150,\"seated\":1}],"
        + "\"refused\":[],\"nodes\":2}";

    [Test]
    public void TheLobbyIsReadFromThePageAndPlayPicksTheJoinableRoundWithTheMostTimeLeft()
    {
        var s = DailyLobby.Parse(Sample);
        Assert.IsNotNull(s);
        Assert.AreEqual("azure-elk-1364", s.you.name);
        Assert.AreEqual(3, s.rows.Length);
        // the 1-of-2 round has more time left and is still never picked: no Join without both seats
        Assert.AreEqual(2, DailyLobby.PickDefault(s.rows));
        Assert.AreEqual(0, DailyLobby.Keep(s.rows, "aaaa1111"), "a picked joinable round stays picked");
        Assert.AreEqual(2, DailyLobby.Keep(s.rows, "bbbb2222"), "a round that is not joinable cannot stay picked");
        Assert.AreEqual(2, DailyLobby.Keep(s.rows, "gone"), "a round no longer listed falls back to the default");

        Assert.IsNull(DailyLobby.Parse(""), "no page, no lobby");
        Assert.IsNull(DailyLobby.Parse("{\"mode\":\"round\"}"), "a round page is not a lobby");
        Assert.IsNull(DailyLobby.Parse("not json"), "garbage is not a lobby");
        Assert.AreEqual(-1, DailyLobby.PickDefault(new LobbyRow[0]), "nothing to join, nothing picked");
        Assert.IsFalse(DailyLobby.Join("aaaa1111"), "outside a WebGL page nothing is joined");
    }
}
