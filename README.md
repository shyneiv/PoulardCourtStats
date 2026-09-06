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
2. Tap ⚙ (or **Settings**) and save a **Gemini API key** (+ optional model; default `gemini-2.0-flash`).
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
3. Tap **AI Capture**. Merges returned JSON into both rosters by player name.

### YouTube iframe limitation (screenshots)

Browsers (and YouTube) do **not** allow the page to read pixels from an embedded YouTube iframe. Screenshot/photo AI Capture still needs an uploaded image; use **Watch with AI** when you want Gemini to analyze the public URL instead.

## Open on a computer first

Double-click `index.html` works for scoring. For YouTube embeds, hosting on HTTPS is more reliable than `file://`.

## What this version does not include

- Native App Store install
- On-device Vision OCR without an API key
- Xcode project / backend server
