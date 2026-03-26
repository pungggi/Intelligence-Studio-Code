# PRD Review: CoreCode

**Reviewer:** Claude (AI-assisted Review)
**Datum:** 26. März 2026
**Status:** Initiales Review

---

## Gesamteindruck

Das PRD beschreibt eine ambitionierte und architektonisch fundierte Vision. Die "Frankenstein"-Architektur (natives UI + VS Code Extension Host) ist der richtige Ansatz, um beide Welten zu vereinen. Projekte wie **Zed**, **Lapce** und **Cursor** validieren Teile dieser Strategie bereits. Dennoch gibt es einige kritische Lücken und Risiken, die vor der Umsetzung adressiert werden sollten.

---

## Stärken

1. **Klare Problemdefinition** — Electron-Overhead vs. fehlendes Extension-Ökosystem bei nativen Editoren ist ein reales, gut verstandenes Problem.
2. **Saubere 3-Komponenten-Architektur** — Die Trennung in Frontend, Extension Host und IPC-Brücke ist der richtige architektonische Schnitt.
3. **Pragmatisches MVP-Scoping** — WebViews, Terminal, Debugger und Settings Sync auszuschließen ist die richtige Entscheidung für einen ersten Meilenstein.
4. **Risikobewusstsein** — IPC-Bottleneck, API Drift und Speicherlecks sind korrekt als Top-Risiken identifiziert.

---

## Kritische Lücken & Empfehlungen

### 1. KI-Agenten-Pipeline ist unterbestimmt (Abschnitt 3)

**Problem:** Die Strategie, die ~1.500+ APIs aus `vscode.d.ts` durch KI-Agenten zu mappen, ist der riskanteste Teil des gesamten PRDs — und gleichzeitig der am wenigsten spezifizierte.

**Fehlende Details:**
- Wie wird die Korrektheit des generierten Codes validiert? LLMs halluzinieren — besonders bei Edge Cases von APIs.
- Welche Test-Strategie sichert die generierten Bindings ab? (Conformance Test Suite?)
- Wie sieht der Human-in-the-Loop-Prozess aus? Vollautomatisch ist unrealistisch.
- Was passiert bei APIs, die die KI nicht korrekt mappen kann?

**Empfehlung:** Einen gestuften Ansatz definieren:
1. **Tier 1 (manuell):** Die ~20 kritischsten APIs handschriftlich implementieren und als Referenz nutzen.
2. **Tier 2 (KI-assistiert):** KI generiert Code, Entwickler reviewen.
3. **Tier 3 (KI-automatisiert):** Nur für triviale API-Weiterleitungen.

Dazu eine Conformance Test Suite gegen den echten VS Code Extension Host als Validierung.

### 2. Fehlende Technologie-Entscheidung beim Frontend

**Problem:** "Rust (GPUI, wgpu, Slint) oder Tauri" ist eine fundamentale Architekturentscheidung, die offen gelassen wird. GPUI (Zed-intern, nicht als stabiles Framework verfügbar), wgpu (Low-Level), Slint (deklarativ) und Tauri (Web-basiert) haben jeweils völlig unterschiedliche Implikationen für:
- Entwicklerproduktivität
- Text-Rendering-Qualität (Schriftarten, Ligatures, BiDi)
- Barrierefreiheit (Accessibility)
- Plattformunterstützung

**Empfehlung:** Vor der Implementierung eine Spike/Proof-of-Concept-Phase mit den 2 vielversprechendsten Kandidaten (z.B. Tauri + wgpu-basiertes Custom-Rendering) durchführen und anhand konkreter Kriterien bewerten.

### 3. Fehlender Abschnitt: Text-Editing-Kern

**Problem:** Das PRD erwähnt "Text-Rendering", aber der eigentliche Text-Editing-Kern fehlt komplett:
- Welche Datenstruktur für den Text-Buffer? (Rope, Piece Table, Gap Buffer?)
- Syntax Highlighting Engine? (Tree-sitter?)
- Undo/Redo-Strategie?
- Multi-Cursor / Selektion?
- Encoding-Handling (UTF-8, UTF-16 für LSP-Kompatibilität)?

**Empfehlung:** Einen eigenen Abschnitt "2.4 Text-Editing Engine" hinzufügen. Dies ist der Kern eines Code-Editors und verdient eigene Architekturentscheidungen. Tree-sitter für Syntax Highlighting und eine Rope-Datenstruktur (wie bei Zed/Lapce) wären der Stand der Technik.

### 4. LSP-Integration fehlt im Architektur-Diagramm

**Problem:** Das Language Server Protocol (LSP) wird nur beiläufig in Abschnitt 5 erwähnt ("Nur Basis-LSP-Support"). Aber LSP ist kein optionales Feature — es ist der zentrale Mechanismus für Autovervollständigung, Go-to-Definition, Fehleranzeige etc.

**Frage:** Laufen die LSP-Server als Kindprozesse des Extension Hosts (wie in VS Code)? Oder direkt vom nativen Frontend gesteuert? Dies beeinflusst die gesamte IPC-Architektur.

**Empfehlung:** LSP-Architektur explizit in Abschnitt 2 aufnehmen. Entscheidung: LSP-Nachrichten durch den Extension Host routen (kompatibel mit VS Code Extensions) oder direkt vom Frontend handlen (performanter, aber inkompatibel mit Extension-basiertem LSP-Management).

### 5. Fehlende nicht-funktionale Anforderungen

Das PRD definiert Ziel-Performance (< 16ms Frame-Zeit), aber es fehlen:
- **Startup-Zeit-Ziel** (z.B. < 500ms bis erstes sichtbares Frame)
- **RAM-Ziel** (z.B. < 200MB Baseline ohne Extensions)
- **Extension-Kompatibilitätsziel** (z.B. "Top 50 VS Code Extensions müssen funktionieren")
- **Plattform-Support** (Windows, macOS, Linux — alle ab MVP?)
- **Accessibility-Anforderungen** (Screen Reader, Keyboard-Only-Navigation)

### 6. Fehlende Aussage zur Lizenzierung

**Problem:** Der VS Code Extension Host (`extHost`) steht unter der MIT-Lizenz als Teil von VS Code OSS. Ein "modifizierter Fork" ist erlaubt, aber:
- Die VS Code Marketplace ToS verbieten die Nutzung durch Nicht-VS-Code-Produkte.
- Alternative: Open VSX Registry (Eclipse Foundation).

**Empfehlung:** Rechtliche Klärung der Marketplace-Nutzung und explizite Entscheidung für Open VSX oder einen eigenen Marketplace.

---

## Risikotabelle — Ergänzungsvorschläge

| Risiko | Beschreibung | Mitigierung |
|:---|:---|:---|
| **VS Code Marketplace ToS** | Extensions dürfen nur in VS Code-kompatiblen Produkten genutzt werden. | Open VSX Registry nutzen; rechtliche Prüfung. |
| **Text-Rendering-Qualität** | Eigenes Rendering erreicht nicht die Qualität von Chromium/CoreText. | Plattform-native Schrift-APIs nutzen (DirectWrite, CoreText, FreeType). |
| **Extension-Kompatibilität** | Viele Extensions nutzen undokumentierte VS Code-Interna. | Kompatibilitätsmatrix der Top-50-Extensions erstellen und testen. |
| **KI-generierter Code-Qualität** | Halluzinationen/Fehler in generierten API-Bindings. | Conformance Tests, manuelles Review für kritische APIs. |

---

## Empfohlene nächste Schritte

1. **Technologie-Spike:** Frontend-Framework evaluieren (2 Wochen)
2. **Proof of Concept:** Minimaler Rust-Editor + Node.js Extension Host + IPC mit einer einzigen Extension (z.B. ESLint) — validiert die Gesamtarchitektur
3. **PRD ergänzen:** Text-Engine, LSP-Architektur, nicht-funktionale Anforderungen, Lizenzierung
4. **KI-Pipeline konkretisieren:** Tier-basierter Ansatz statt "KI löst alles"
5. **Kompatibilitätsmatrix:** Top-50 VS Code Extensions analysieren und nach API-Abdeckung priorisieren
