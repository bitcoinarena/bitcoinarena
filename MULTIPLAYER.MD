# BTC Logistics War — Multiplayer- & Echtgeld-Konzept

Stand: 2026-08-30. Dieses Dokument beschreibt, wie aus dem Einzelspieler-Prototyp
ein anonymes Multiplayer-Spiel mit echten Sats wird: Lightning rein, Fracht als
Einsatz, Auszahlung nur bei Ankunft, 10 % Host-Fee — und eine Architektur, in
der der Client **nichts** entscheidet.

---

## 0. Leitprinzip

> **Der Client ist ein Eingabegerät und ein Fernseher.**

Sobald Geld auf dem Spiel steht, darf keine einzige spielentscheidende Größe im
Browser berechnet werden. Der Client sendet ausschließlich Eingaben (Lenken,
Gas, Bremse) und rendert, was der Server ihm sagt. Ob der Truck getroffen
wurde, ob er lebt, ob er das Tor erreicht hat — das simuliert der Server.

Die Konsequenz ist die wichtigste Sicherheitseigenschaft des ganzen Konzepts:
**Es gibt keinen API-Aufruf „ich bin angekommen“.** Ankunft ist ein Ereignis,
das der Server in seiner eigenen Simulation feststellt. Die Angriffsklasse
„gefälschtes Spielergebnis“ existiert damit strukturell nicht — sie muss nicht
abgewehrt werden, weil es den Endpunkt nicht gibt.

Ein manipulierter Client kann deshalb genau eines erreichen: perfekt fahren.
Das ist kein Sicherheits-, sondern ein Ökonomieproblem, und wird in §4.4
(Kalibrierung) behandelt.

---

## 1. Konten & Anonymität

**Kein E-Mail, kein Passwort, keine PII.** Ein Konto ist ein Schlüsselpaar.

- Beim ersten Besuch erzeugt der Browser (WebCrypto) ein ed25519-Schlüsselpaar.
  Der Public Key **ist** die Konto-ID.
- Login = Challenge-Response: Server schickt Nonce, Client signiert, fertig.
  Es gibt keine Passwortdatenbank, die geleakt werden könnte.
- Der Anzeigename wird deterministisch aus dem Pubkey abgeleitet
  (`brave-otter-4711`) — zufällig wirkend, kollisionfrei, nicht wählbar.
  Nicht wählbar heißt: keine Impersonation, keine Beleidigungsnamen, keine
  Moderation nötig.
- Schlüsselverlust = Guthabenverlust. Der Client bietet einmalig eine
  Seed-Phrase zum Sichern an. Das ist die ehrliche Konsequenz aus
  Anonymität ohne Identitätsanker, und sie wird dem Nutzer genau so gesagt.
- Kontoerstellung ist gratis, aber gedrosselt (Rate-Limit pro IP + kleines
  Client-Proof-of-Work), damit Konten-Fluten teuer sind.

---

## 2. Geldfluss

```
                    ┌──────────────────────── Spieler ───────────────────────┐
                    │  ed25519-Konto          Browser-Client (Unity WebGL)   │
                    └───────┬──────────────────────────┬─────────────────────┘
                            │ REST (Wallet)            │ WebSocket (Spiel: nur Inputs)
                    ┌───────▼──────────┐       ┌───────▼─────────┐
                    │  API-Gateway     │       │  Shard-Server   │  autoritative
                    │  (stateless)     │       │  (Spielsim)     │  Simulation
                    └───────┬──────────┘       └───────┬─────────┘
                            │                          │ signierte Ergebnisse
                    ┌───────▼──────────────────────────▼─────────┐
                    │        Ledger (Postgres, double-entry,     │
                    │        append-only Hash-Kette)             │
                    └───────┬────────────────────────────────────┘
                            │ signierte Auszahlungs-Freigaben
                    ┌───────▼──────────┐
                    │  Wallet-Daemon   │── Lightning-Node (Hot-Wallet, kleiner Float)
                    │  (eigener Host,  │── Cold-Sweep ab Schwellwert
                    │  kein Internet-  │
                    │  Inbound)        │
                    └──────────────────┘
```

### 2.1 Einzahlung
- `POST /deposit {amount}` → Server erzeugt Lightning-Invoice (Label = Konto).
- Settlement-Callback schreibt **idempotent** (Invoice-ID als Schlüssel) auf
  das Konto gut. Lightning settelt atomar — das 0-Conf-Problem von On-Chain
  existiert hier nicht.
- Min. 1 000 sat, konfigurierbares Maximum pro Konto (Exposure-Cap, §8.4).

### 2.2 Ledger
- **Double-Entry**: jede Bewegung ist eine Buchung zwischen zwei Konten
  (Spieler ↔ Escrow ↔ Haus). Es gibt keinen Code-Pfad, der „einen Saldo setzt“.
- Invariante, laufend geprüft:
  `Σ Spielerguthaben + Escrow + Hauskonto = Σ Einzahlungen − Σ Auszahlungen`
- Jede Buchung enthält den Hash ihres Vorgängers → **append-only Hash-Kette**.
  Nachträgliches Ändern einer Buchung bricht die Kette sichtbar. Der aktuelle
  Kettenkopf ist öffentlich abrufbar (`GET /audit/head`); Spieler bekommen zu
  jeder eigenen Buchung eine signierte Quittung.
- Saldo-Operationen laufen unter `SELECT … FOR UPDATE` / serialisierbaren
  Transaktionen — Race-Conditions (doppeltes Ausgeben desselben Guthabens
  durch parallele Requests) sind damit auf DB-Ebene ausgeschlossen, nicht nur
  im Anwendungscode.

### 2.3 Auszahlung
- `POST /withdraw {bolt11}` → Prüfungen: Betrag ≤ Saldo, ≥ Minimum,
  Rate-Limits, Tages-Cap.
- Ablauf: erst **debit als pending**, dann zahlen, bei Fehlschlag re-credit.
  Idempotency-Key pro Anfrage — ein doppelt gesendeter Request zahlt nie
  doppelt.
- Beträge über Schwellwert (z. B. 250 000 sat) werden verzögert ausgezahlt
  (Review-Fenster). Das begrenzt den Schaden **jedes** noch unbekannten Fehlers
  auf den Schwellwert × Rate — Sicherheitsnetz unter allem anderen.
- Routing-Gebühren trägt der Empfänger (transparent angezeigt); die Host-Fee
  steckt im Spiel (§4), nicht in der Auszahlung.

### 2.4 Schlüsseltrennung (warum ein gehackter Spielserver die Node nicht leert)
Der Wallet-Daemon läuft auf eigenem Host, nimmt **keine** Verbindungen aus dem
Internet an und zahlt nur gegen eine gültige ed25519-Signatur des
Settlement-Keys **plus** passende Ledger-Buchung **plus** Rate-Caps. Der
Settlement-Key liegt nicht auf dem Web/Spiel-Tier. Wer das Gateway oder einen
Shard kompromittiert, kann damit keine Auszahlung erzeugen — er kann höchstens
Runden manipulieren, was die Kalibrierung (§4.4) und die Caps (§8.4) begrenzen.
Die Hot-Wallet hält nur einen kleinen Float (z. B. 2–5 M sat), Rest wird
automatisch cold geswept.

---

## 3. Eine Fahrt (Ablauf)

1. **Runde**: Der Server betreibt die Blockuhr (heute `BlockClock`, dann
   serverseitig). Pro Runde ein Seed → identisches Terrain, identische Armeen
   für alle (§7).
2. **Beladen**: Spieler wählt Pakete. Jedes Paket hat einen **Preis in sats**
   (§4.1). Bei „LOSFAHREN“ wird die Summe vom Guthaben in ein Escrow-Konto
   gebucht. Kein Guthaben, keine Fracht.
3. **Fahren**: Client schickt Eingaben, Server simuliert, Client rendert mit
   Prediction und wird korrigiert (§6).
4. **Ausgang**:
   - **Tor erreicht** → Server stellt das Ankunftsereignis fest, bucht
     `Einsatz × Multiplikator` (§4.2) vom Haus/Pool an den Spieler.
   - **Zerstört / Rundenende ohne Ankunft** → Einsatz geht vollständig ans
     Haus. Keine Teilauszahlung (Anforderung 4: nur Ankunft zahlt).
5. **Reparatur/Neukauf** nach der Fahrt aus dem Guthaben (§5).

---

## 4. Einsatz, Auszahlung, 10 % Host-Fee

### 4.1 Pakete als Einsatz
Die Pakete kommen weiter aus dem echten Mempool (Optik, Größe, Heat), aber ihr
**Einsatzpreis** ist eine Serverseite Größe in Stufen, abgeleitet aus dem
Fee-Band der Transaktion: z. B. 100 / 500 / 1 000 / 5 000 sat. Der
Gesamteinsatz ist die Summe der geladenen Pakete, begrenzt durch Ladefläche
**und** Einsatz-Cap des Trucks (§5). „Ein 5 000-sat-Truck“ heißt: 5 000 sat
Einsatz sind an Bord, und bei Ankunft auf der Normalroute kommen ~5 000 sat
Gewinn heraus (M ≈ 2,0 nach Fee, siehe Beispiel).

### 4.2 Auszahlungsformel
```
Auszahlung bei Ankunft = Einsatz × M_angezeigt
M_angezeigt            = 0,90 × M_fair(Route, Heat, Truckklasse)
```
Die **10 % Host-Fee ist im angezeigten Multiplikator eingebacken** — der
Spieler sieht immer die Zahl, die er tatsächlich bekommt. `M_fair` ist der
Multiplikator, bei dem die erwartete Auszahlung dem Einsatz entspricht
(faire Quote): schafft es statistisch jeder zweite Truck durch den
Frontkorridor, ist dort `M_fair = 2,0` und angezeigt wird ×1,8.

**Beispiel:** Einsatz 5 000 sat, Frontkorridor, `M_fair = 2,22` →
angezeigt ×2,0 → Ankunft zahlt 10 000 sat (Netto +5 000). Von den fairen
11 111 hat das Haus 1 111 einbehalten ≙ 10 % — über alle Spieler gerechnet.

### 4.3 Routen-Multiplikator & Gefechtsnähe (Anforderung 5)
Der Server kennt den gefahrenen Pfad (er simuliert ihn) und berechnet ein
**Expositions-Integral**: wie lange und wie tief der Truck im
Gefechtskorridor war, gewichtet mit der aktuellen Heat.

- Frontkorridor (Mitte, hohe Heat): bis ×2,4 fair.
- Normalroute: ~×1,6 fair.
- Randweg / Kartenkante: fällt gegen ×1,0 fair — **nach Fee also ×0,9**.

Das ist die elegante Form der „Strafpunkte“: Wer sich vom Schlachtfeld
fernhält, verliert nicht durch eine Regel, sondern durch Arithmetik.
Risikofrei fahren hat EV −10 %. Der Exploit aus dem Einzelspieler („nur
billige, sichere Fracht, ewig Gewinn“) ist damit doppelt zu: die Blockuhr
begrenzt Fahrten pro Zeit, und sichere Fahrten sind strukturell verlustig.

### 4.4 Kalibrierung — die ökonomische Verteidigung
`M_fair` ist keine Konstante, sondern wird laufend aus den **globalen,
tatsächlichen Ankunftsquoten** je (Routenband × Heatband × Truckklasse)
nachgeführt, Ziel: Auszahlungsquote 90 % über alles.

Das ist die Antwort auf perfekte Fahr-Bots und auf Multi-Accounts: Ein Bot,
der überdurchschnittlich oft ankommt, hebt die gemessene Ankunftsquote seines
Bandes → der Multiplikator sinkt für alle → sein eigener Vorteil schrumpft
mit. Bots schlagen nicht das Haus, sie verschlechtern die Quote — ihre eigene
eingeschlossen. Multi-Accounts helfen nicht, weil es keine Boni gibt und die
Kalibrierung global ist.

Ehrlicher Trade-off: Auch gute menschliche Fahrer teilen sich diese Anpassung.
Die Granularität (pro Band, nicht global) hält den Effekt lokal; einzelne
geübte Spieler **können** zeitweise +EV sein — das ist wie Poker-Rake
akzeptiert, solange das Aggregat stimmt. Schutzgeländer: Einsatz-Cap pro Fahrt
und pro Konto/Runde, Rekalibrierung täglich, Alarm bei Band-Quoten > 95 %.

---

## 5. Trucks: Kauf & Reparatur (Anforderung 6)

- **Starter-Truck**: gratis, kleine Ladefläche (niedriger Einsatz-Cap), wenig
  Panzerung.
- Bessere Trucks kosten Sats vom Guthaben: mehr Ladefläche (höherer
  Einsatz-Cap), mehr Panzerung (höhere Überlebensquote), mehr Tempo.
- Schaden bleibt nach der Fahrt bestehen; Reparatur kostet anteilig.
  Totalschaden = Truck weg, neu kaufen.
- **Grundsatz: Geld kauft Kapazität und Varianzreduktion, nie Erwartungswert.**
  Jede Truckklasse hat ihre eigene Kalibrierungsspalte (§4.4). Ein gepanzerter
  Truck kommt öfter an — und hat dafür entsprechend niedrigere Multiplikatoren.
  Sonst wäre „Panzerung kaufen“ eine Gelddruckmaschine, und genau solche
  stillen +EV-Pfade sind die Sicherheitslücken von Spielökonomien.

---

## 6. Autoritative Simulation & Netzprotokoll (Anforderungen 8, 9)

### 6.1 Geteilter deterministischer Kern
Die Spiellogik (Armeen, Beschuss, Truck-Bewegung als vereinfachtes
Fahrmodell, Treffer, Tor) wird aus `Army.cs` & Co. in einen **gemeinsamen
deterministischen Kern** extrahiert (Rust → nativ für den Server, WASM für den
Client; Festkomma-Arithmetik, damit beide bitidentisch rechnen).

- Der **Server** führt den Kern autoritativ aus: ~20–30 Hz, pro Fahrt eine
  private Weltinstanz (§6.3). Der Kern ist klein (≈200 Einheiten, 2D-Logik) —
  konservativ geschätzt laufen **mehrere hundert parallele Fahrten pro
  CPU-Kern**.
- Der **Client** führt denselben Kern lokal als Prediction aus. Die Armeen
  sind aus dem Runden-Seed vollständig deterministisch → der Server muss sie
  **nicht** streamen, nur einen Checksum-Heartbeat; bei Drift schickt er einen
  Korrektur-Snapshot (selten).
- Unity behält WheelCollider & Federung **rein kosmetisch** — das Fahrgefühl
  bleibt, aber Position/Tod/Ankunft kommen vom Server. (Das ist die eine
  spürbare Migrationsänderung: das Ergebnis-Fahrmodell wird einfacher als
  PhysX.)

### 6.2 Traffic-Budget
| Nachricht | Richtung | Rate | Größe |
|---|---|---|---|
| InputBatch (Tick-Nr + 10× quantisiert Lenk/Gas/Bremse) | C→S | 10/s | ~30 B |
| TruckCorrection (Pos, V, Heading, HP, quantisiert) | S→C | 10/s | ~40 B |
| GhostUpdate (≤ 8 nächste Spieler, delta-codiert) | S→C | 5/s | ~10 B/Ghost |
| ArmyChecksum | S→C | 1/s | 8 B |
| Events (Treffer, Tod, Lieferung, Blockschluss) | S→C | selten | ~20 B |

**Summe < 2 KB/s pro Spieler.** Zusätzlicher Plattform-Gewinn: heute pollt
jeder Client selbst mempool.space; künftig holt **ein** Server-Fetcher die
Daten und verteilt sie im Runden-Seed — ein externer Abruf für alle statt
einem pro Spieler.

### 6.3 Andere Spieler: Geister, bewusst
Andere Trucks sind sichtbare **Geister ohne Kollision**, und die Armeen jeder
Fahrt reagieren **nur auf den eigenen Truck** (private Weltinstanz).

Begründung, keine Bequemlichkeit: In einem Geldspiel darf kein fremder Spieler
meine Gewinnchance verändern können. Geteilte Armeen wären reicher, aber
sofort ausbeutbar (im Windschatten eines Whale-Fahrers fahren, der alle Panzer
auf sich zieht; gezieltes Rammen; Absprachen). Geister geben das
Multiplayer-Gefühl — man sieht die Konkurrenz fahren, sterben, ankommen — ohne
einen einzigen Kopplungs-Exploit. Ein „Konvoi-Modus“ mit echter Interaktion
bleibt als spätere Nicht-Geld-Variante denkbar.

Das globale **Leaderboard pro Block** (heute lokal in `BlockClock.Board`) wird
serverseitig und für alle sichtbar: wer hat in diesem Block wie viel sat
verdient, wie viel BTC bewegt.

---

## 7. Provably Fair (Runden-Seeds)

Damit niemand argwöhnen muss, das Terrain oder die Armeen seien gegen ihn
gewürfelt:

1. Der Server committet im Voraus eine Kette von Tagesgeheimnissen
   (`H(secret_d)` wird am Vortag veröffentlicht).
2. Runden-Seed: `seed = HMAC(secret_d, btc_blockhash ‖ runden_nr)` — der
   Bitcoin-Blockhash ist öffentliche, vom Haus nicht wählbare Entropie.
3. Bei Rundenstart wird `H(seed)` veröffentlicht, bei Rundenende `seed`.
4. Jeder kann mit dem offenen WASM-Kern nachrechnen, dass Terrain und
   Armee-Spawns exakt aus dem Seed folgen — und dass der Server sie nicht
   nachträglich auf einen bestimmten Spieler zugeschnitten hat.

---

## 8. Bedrohungsmodell

| Angriff | Verteidigung |
|---|---|
| Gefälschte Ankunft per API | **Endpunkt existiert nicht.** Ankunft ist ein Server-Simulationsereignis (§0). |
| Manipulierter Client / Speedhack / Teleport | Client sendet nur Inputs; Server-Takt und Server-Physik gelten. Inputs jenseits des Tick-Fensters werden verworfen. |
| Replay alter Eingaben/Ergebnisse | Tick-Nummern + Session-HMAC pro Nachricht; Fahrten sind an Runden-ID + Seed gebunden. |
| Doppelauszahlung / Race auf Saldo | Double-Entry-Ledger, serialisierbare Transaktionen, Idempotency-Keys (§2.2, 2.3). |
| Kompromittierter Spielserver leert die Node | Schlüsseltrennung: Wallet-Daemon zahlt nur signierte, ledger-gedeckte, rate-begrenzte Freigaben (§2.4). Hot-Float klein. |
| Perfekter Fahr-Bot | Ökonomisch: globale Kalibrierung senkt sein Band (§4.4); Einsatz-Caps begrenzen Durchsatz. |
| Multi-Accounting | Keine Boni; Kalibrierung global; Kontoerstellung gedrosselt (PoW + IP-Limits). |
| Spieler-gegen-Spieler-Griefing | Strukturell unmöglich: private Weltinstanzen, Geister ohne Kollision (§6.3). |
| Rigged Terrain/Spawns („das Haus würfelt gegen mich“) | Commit-Reveal-Seeds mit Bitcoin-Blockhash-Entropie, nachrechenbar (§7). |
| Ledger-Manipulation durch Insider | Append-only Hash-Kette, öffentlicher Kettenkopf, signierte Spielerquittungen (§2.2). |
| DoS / Flooding | CDN/WS-Gateway mit Rate-Limits, Nachrichtenquoten pro Session, stateless Gateways horizontal skaliert. |
| Invoice-/Withdraw-Probing | Min/Max, Rate-Caps, Pending-Zustände, Review-Schwelle (§2.3). |

**Ehrliche Grenze:** „Es gibt keine Sicherheitslücken“ kann kein seriöses
Konzept versprechen. Was dieses Design leistet: die gefährlichsten
Angriffsklassen sind **strukturell unmöglich** (gefälschtes Ergebnis,
Client-Autorität, PvP-Kopplung), die übrigen sind **im Schaden begrenzt**
(Exposure-Caps, kleiner Hot-Float, Review-Schwellen, Schlüsseltrennung) und
**sichtbar** (Hash-Kette, Invarianten-Monitoring, Quoten-Alarme). Das ist der
Zustand, den auch eine Börse oder ein Casino realistisch erreicht.

---

## 9. Skalierung & Betrieb

- **Gateway**: stateless, hinter CDN (WebSocket-Terminierung, Rate-Limits).
- **Shards**: ein Prozess simuliert n Fahrten; Zuweisung per Konsistent-Hash;
  horizontale Skalierung trivial, weil Fahrten unabhängig sind (§6.3).
- **Ledger**: ein Postgres-Primary (Geld ist klein und transaktional, das
  skaliert weit); Read-Replicas für Leaderboards/Audit.
- **Sessions**: Redis.
- **Ein** Mempool-Fetcher für die ganze Plattform (§6.2).
- Monitoring: Ledger-Invariante, Auszahlungsquote je Band, Hot-Wallet-Float,
  Checksum-Driftrate.

---

## 10. Rechtlicher Hinweis (außerhalb des Scopes, nicht ignorierbar)

Echtgeld-Einsatz mit Zufallsanteil ist in den meisten Jurisdiktionen
lizenzpflichtiges Glücks- oder Geschicklichkeitsspiel; volle Anonymität ohne
KYC kollidiert je nach Standort mit Geldwäsche-Regeln. Das Konzept ist so
geschnitten, dass Limits (Einsatz-Caps, Verlust-Limits pro Zeitraum,
Selbstsperre) technisch vorhanden sind — die Rechtsfrage selbst braucht vor
einem Echtgeld-Launch eine eigene Klärung. Bis dahin läuft alles identisch mit
Spielgeld (Phase 1–2).

---

## 11. Umsetzungsplan

| Phase | Inhalt | Baut auf |
|---|---|---|
| **0** | Deterministischen Kern extrahieren (Rust: Armeen, Truck-Fahrmodell, Treffer, Tor; Festkomma; WASM-Build). Golden-Tests: Kern-Replays gegen aufgezeichnete Unity-Läufe. | `Army.cs` ist bereits reine Logik — genau dafür portierbar. |
| **1** | Konten (ed25519), Ledger, Spielgeld-Einzahlung/-Auszahlung, Audit-Kette. Noch Einzelspieler. | `BlockClock`, `DeliveryGate` |
| **2** | Server-autoritative Fahrten: Input-Protokoll, Prediction/Correction im Client, Geister, globales Block-Leaderboard, ein zentraler Mempool-Fetcher. | §6 |
| **3** | Lightning echt (LND/CLN + Wallet-Daemon, Schlüsseltrennung), kleine Caps, Commit-Reveal-Seeds, Kalibrierungs-Pipeline. | §2, §4.4, §7 |
| **4** | Skalierung (Shards, CDN), Truck-Shop & Reparatur, Review-Prozesse, Limits/Selbstsperre, Lasttests, externes Security-Audit vor Cap-Erhöhung. | §5, §9 |

---

## 12. API-Oberfläche (vollständig — Kürze ist hier das Sicherheitsargument)

```
REST  POST /account            {pubkey}                → Name
      POST /login              {pubkey}→Challenge→Sig  → Session-Token
      POST /deposit            {amount}                → bolt11-Invoice
      POST /withdraw           {bolt11, idempotency}   → pending/paid
      GET  /balance
      GET  /rounds/current                             → Seed-Commit, Uhr, Board
      GET  /audit/head                                 → Ledger-Kettenkopf
      GET  /receipts/{entry}                           → signierte Quittung

WS    join_run   {truck, cargo[]}   → Server prüft & escrowt Einsatz
      inputs     {tick, [steer,throttle,brake]×10, hmac}
      ← state    {correction | ghost | checksum | event}
```

Mehr gibt es nicht. Insbesondere gibt es keinen Endpunkt, über den ein Client
eine Position, einen Treffer, eine Ankunft oder einen Kontostand *behaupten*
kann — und was es nicht gibt, kann niemand missbrauchen.
