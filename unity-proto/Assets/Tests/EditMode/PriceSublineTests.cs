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
