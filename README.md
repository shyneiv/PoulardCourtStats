# CourtStats (phone web app)

Track multiple basketball games from your iPhone Safari browser — live scoring, YouTube watch mode, dual-team box scores, Gemini YouTube “Watch with AI”, and optional screenshot AI Capture. No Xcode or backend required (static GitHub Pages).

## Fastest way on iPhone

1. Open the GitHub Pages HTTPS link in Safari.
2. Optional: Share → **Add to Home Screen** so it feels like an app.

Games and your API keys are stored only in the phone’s browser (`localStorage`).

## Tabs

| Tab | What it does |
| --- | --- |
| **Dash** | All games, quick +1/+2/+3, rename teams |
| **Score** | Focused scoreboard for the selected game |
| **Box** | Home/Away rosters + live box score tables + tap-to-stat pad |
| **Watch** | YouTube embed + **Watch with AI** (Gemini) + roster chips + screenshot **AI Capture** |
| **Log** | Play-by-play / AI event history |

## Watch with AI (Gemini + YouTube URL)

Gemini can analyze a **public** YouTube game URL (video understanding) and fill the box score — **no screenshots required**.

1. Open **Watch**, paste a YouTube URL (or video ID), tap **Play**.
2. Tap ⚙ (or **Settings**) and save a **Gemini API key** (+ optional model; default `gemini-3.6-flash`).
   - Create a key at [Google AI Studio](https://aistudio.google.com/apikey).
3. Tap **✦ Watch YouTube with AI**. Status shows *Gemini is watching the game… this can take a minute* (often 30–120+ seconds).
4. On success, rosters merge (same JSON shape as screenshot AI), team scores update, players are marked **AI-assisted**, and the Log gets an `AI Watch` event (`ai: true`).

### Limitations

- Videos must be **public** (private/unlisted may fail).
- The app does **not** read iframe pixels — Gemini receives the canonical `https://www.youtube.com/watch?v=ID` via the Generative Language API.
- Best on **completed / VOD** games. Live or incomplete streams may fail or return partial box scores.
- Always verify AI-assisted rows.

Settings (`courtstats.ai.v1`) store: OpenAI `apiKey` / `baseUrl` / `model` (screenshot path) and `geminiKey` / `geminiModel` (YouTube watch). Games use `courtstats.games.v1`.

## Screenshot AI Capture (OpenAI-compatible)

1. Same Watch tab: upload/take a photo of the TV scorebug or box-score graphic.
2. Configure OpenAI-compatible **API key**, **Base URL** (`https://api.openai.com/v1`), and vision **Model** (default `gpt-4o-mini`).
3. Tap **AI Capture**. Merges returned JSON into both rosters by **jersey first, then name** (and may prompt to save a quarter snapshot).

### YouTube iframe limitation (screenshots)

Browsers (and YouTube) do **not** allow the page to read pixels from an embedded YouTube iframe. Screenshot/photo AI Capture still needs an uploaded image; use **Watch with AI** when you want Gemini to analyze the public URL instead.

## Open on a computer first

Double-click `index.html` works for scoring. For YouTube embeds, hosting on HTTPS is more reliable than `file://`.

## What this version does not include

- Native App Store install
- On-device Vision OCR without an API key
- Xcode project / backend server


If Gemini returns **503 / high demand**, the app automatically retries and tries fallback Flash models.


## Rosters, jerseys & Unassigned

- Each player can have an optional **jersey** number (`#23`). Edit name + jersey on **Box** or **Watch**.
- Use **Clear placeholders** to drop default Player 1–5 rows and start with empty starters, then enter real names/numbers.
- AI Capture / Gemini Watch prompts receive the roster as `Name (#jersey)` and are instructed to **match jersey first, then name**, prefer the known roster, and put leftover points on **Unassigned**.
- Tip: set your roster (with jerseys) *before* capturing a full box-score graphic — that cuts Unassigned vs tiny scorebugs.

## Roster from photo

On **Box** or **Watch**, use **Roster from photo** near the roster editor: pick Home / Away / Both, upload a lineup, starting-5 graphic, or written names (photo library OK — no forced camera), then tap **✦ Read roster**. Prefers your OpenAI-compatible vision key; falls back to Gemini with an inline image. Names + jersey numbers merge into the side roster (rebuilds placeholders; merges into an existing real roster without wiping stats).

## Quarter snapshots

- Each game stores `snapshots[]` (deep copies of scores + both rosters) with period, time, note, and source.
- On **Watch** and **Box**: period chips (Q1–Q4 / OT), **Save Q snapshot**, and **Restore** (with confirm).
- After a successful AI Capture or Gemini Watch, the app offers to save the result as a Q{n} snapshot.
