using NUnit.Framework;

/// <summary>
/// THE LINE UNDER THE PRICE IS ENGLISH.
///
/// Every other word on this HUD was checked and this one was not. The German
/// on the streamed model list was found by a photograph rather than by the one
/// German check this project had - that check reads the model LABELS, which
/// have been English all along, so nothing looked at the words beside them -
/// and `StreamingWordsTests` was written for exactly that. This line slipped
/// past both: it only appears while the spot price has not arrived yet, which
/// is the first seconds of a session and never a photographed frame.
///
/// It said "verbinde … (connecting)". It is drawn under the price, in the
/// place a player reads for the market.
/// </summary>
public class PriceSublineTests
{
    [Test]
    public void NoGermanUnderThePrice()
    {
        string[] german = { "verbinde", "wird", "werden", "laedt", "Fehler",
                            "kein", "nicht", "ä", "ö", "ü" };

        foreach (var status in new[] { "connecting", "live", "reopening", "" })
            foreach (double price in new[] { 0.0, -1.0, 79413.10 })
            {
                string line = DriveHud.PriceSubline(price, -0.77, status);
                foreach (var bad in german)
                    Assert.IsFalse(line.Contains(bad),
                        $"price {price} status \"{status}\" reads \"{line}\", which is German");
                Assert.IsNotEmpty(line, $"price {price} status \"{status}\" says nothing at all");
            }
    }

    /// <summary>
    /// And it still says the two different things it is for. A price that has
    /// arrived shows the day's move and NOTHING about the connection - that
    /// was a decision, taken when the feed roll ran the width of an iPhone
    /// across the scene - and a price that has not shows the connection.
    /// </summary>
    [Test]
    public void ItSaysTheMoveOnceThereIsAPriceAndTheStateBefore()
    {
        Assert.AreEqual("-0.77% 24h", DriveHud.PriceSubline(79413.10, -0.77, "live"));
        Assert.AreEqual("+1.20% 24h", DriveHud.PriceSubline(79413.10, 1.2, "live"));
        Assert.AreEqual("0.00% 24h", DriveHud.PriceSubline(79413.10, 0.0, "live"));

        Assert.AreEqual("connecting … (connecting)", DriveHud.PriceSubline(0, -0.77, "connecting"));
        Assert.AreEqual("connecting … (silent)", DriveHud.PriceSubline(0, -0.77, "silent"));
    }

    /// <summary>
    /// A price of zero is "no price yet", not "bitcoin is worthless", and a
    /// negative one cannot happen but must not draw a per-cent line either.
    /// </summary>
    [Test]
    public void NoPriceMeansTheConnectionLine()
    {
        Assert.IsTrue(DriveHud.PriceSubline(0, 5f, "live").StartsWith("connecting"));
        Assert.IsTrue(DriveHud.PriceSubline(-1, 5f, "live").StartsWith("connecting"));
        Assert.IsFalse(DriveHud.PriceSubline(0.01, 5f, "live").StartsWith("connecting"),
            "a real price, however small, is a price");
    }
}


/// <summary>
/// AND EVERY ROW OF THE DEBUG PANEL, which is on the driving HUD behind the
/// DEBUG icon and so is something a player can open.
///
/// Every row of it was German - "Tempo", "Gas", "Lenk", "Raeder", "Fluss",
/// "Panzer gruen/rot", "Soldaten", "Luft", "Bombe(n)" - and the sweep that
/// found the connecting word walked straight past all of them, because it
/// searched for a list of German words that happened not to include any of
/// these. None of them carries an umlaut, which is what a lazy check looks
/// for. This one names the words that were actually there.
/// </summary>
public class DebugPanelWordsTests
{
    static readonly string[] German =
    {
        "Tempo", "Gas ", "Lenk", "Raeder", "Fluss", "Panzer", "Soldaten",
        "gruen", "Luft", "Bombe", "verbinde", "lade ",
        "ä", "ö", "ü", "ß",
    };

    static void NoGerman(string row)
    {
        Assert.IsNotEmpty(row, "a debug row says nothing at all");
        foreach (var bad in German)
            Assert.IsFalse(row.Contains(bad), $"the row reads \"{row}\", which is German");
    }

    [Test]
    public void EveryRowIsEnglish()
    {
        NoGerman(DriveHud.SpeedRow(68.2f));
        NoGerman(DriveHud.InputRow(0.8f, -0.3f, true));
        NoGerman(DriveHud.InputRow(0f, 0f, false));
        NoGerman(DriveHud.DriftRow(2.645f, 4));
        NoGerman(DriveHud.FlowRow(-0.42f));
        NoGerman(DriveHud.ArmourRow(3, 4));
        NoGerman(DriveHud.InfantryRow(11, 9));
        NoGerman(DriveHud.AirRow(2, 1));
    }

    /// <summary>
    /// And they still say the numbers they are read for. These are the values
    /// measured in the player build when the panel was found reading zeroes
    /// off a kinematic body: 68.16 km/h and 2.645 m/s of slip.
    /// </summary>
    [Test]
    public void TheRowsStillCarryTheirNumbers()
    {
        Assert.AreEqual("Speed   68 km/h", DriveHud.SpeedRow(68.16f));
        Assert.AreEqual("Drift   2.6 m/s   Wheels 4/4", DriveHud.DriftRow(2.645f, 4));
        Assert.AreEqual("Armour   green 3  red 4", DriveHud.ArmourRow(3, 4));
        Assert.AreEqual("Infantry green 11  red 9", DriveHud.InfantryRow(11, 9));
        Assert.AreEqual("Air      2 heli  1 bomb(s)", DriveHud.AirRow(2, 1));
        Assert.AreEqual("Flow    -0.42", DriveHud.FlowRow(-0.42f));
        StringAssert.Contains("HB", DriveHud.InputRow(1f, 0f, true));
        StringAssert.DoesNotContain("HB", DriveHud.InputRow(1f, 0f, false));
    }
}
