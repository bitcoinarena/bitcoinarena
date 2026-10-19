// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
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
///
/// AND IT NO LONGER CARRIES THE SOCKET'S WORD AT ALL (2026-09-18 20:04). "connecting … (error)" was
/// photographed at 20:00 across the sky over the mempool: with no price the headline is dashes, and spectating there
/// is no box and no chrome around that line. A player is told what is broken in words they can act on - "Bitcoin
/// price feed is down. Chart may be stale." - in the corner of the HUD they are already reading, and this subline is
/// empty until there is a day's move to show. The English rule below still holds, now over the sentences too.
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
                // A price that has arrived says its day; one that has not says nothing here, because the sentence
                // that names the broken feed says it in the corner instead.
                if (price > 0) Assert.IsNotEmpty(line, $"price {price} status \"{status}\" says nothing at all");
                else Assert.IsEmpty(line, $"price {price} status \"{status}\" still carries the socket's own word");
            }
    }

    /// <summary>
    /// And it still says the two different things it is for - but the second of them moved. A price that has arrived
    /// shows the day's move and NOTHING about the connection, which was decided when the feed roll ran the width of
    /// an iPhone across the scene. A price that has NOT arrived shows nothing here at all: what is broken is said by
    /// name, in the corner, where `ConnectionTrouble` puts it.
    /// </summary>
    [Test]
    public void ItSaysTheMoveOnceThereIsAPriceAndNothingBefore()
    {
        Assert.AreEqual("+1.38% 24h", DriveHud.PriceSubline(78515.0, 1.38, "live"));
        Assert.AreEqual("-0.77% 24h", DriveHud.PriceSubline(78515.0, -0.77, "live"));
        Assert.AreEqual("", DriveHud.PriceSubline(0.0, 0.0, "connecting"));
        Assert.AreEqual("", DriveHud.PriceSubline(0.0, 0.0, "error"), "the photographed line is still drawn");

        // AND THE SENTENCE THAT REPLACED IT NAMES THE FEED AND WHAT IT COSTS, in English.
        var said = DriveHud.ConnectionTrouble(priceFeedOk: false, roundFeedOk: true, spectating: false);
        Assert.AreEqual("Bitcoin price feed is down. Chart may be stale.", said);
        foreach (var bad in new[] { "verbinde", "Fehler", "nicht", "ä", "ö", "ü" })
            Assert.IsFalse(said.Contains(bad), $"the price-feed sentence reads \"{said}\", which is German");
    }
}
