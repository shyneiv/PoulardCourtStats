# CourtStats (phone web app)

Track multiple basketball games from your iPhone Safari browser — live scoring, YouTube watch mode, dual-team box scores, and optional AI capture from broadcast graphics. No Xcode or backend required (static GitHub Pages).

## Fastest way on iPhone

1. Open the GitHub Pages HTTPS link in Safari.
2. Optional: Share → **Add to Home Screen** so it feels like an app.

Games and your API key are stored only in the phone’s browser (`localStorage`).

## Tabs

| Tab | What it does |
| --- | --- |
| **Dash** | All games, quick +1/+2/+3, rename teams |
| **Score** | Focused scoreboard for the selected game |
| **Box** | Home/Away rosters + live box score tables + tap-to-stat pad |
| **Watch** | YouTube embed + roster chips + stat pad + **AI Capture** |
| **Log** | Play-by-play / AI event history |

## Watch + AI Capture

1. Open **Watch**, paste a YouTube URL (or video ID), tap **Play**.
2. Edit Home/Away rosters (default: Player 1–5 each side). Tap a player, then use +PTS / +REB / … or FG make/miss buttons.
3. Tap ⚙ (or **Settings** on Watch/Box) and save:
   - **API key** (OpenAI-compatible)
   - **Base URL** (default `https://api.openai.com/v1`)
   - **Model** (default `gpt-4o-mini`, vision-capable)
4. **AI Capture**: take/upload a photo of the TV scorebug or box-score graphic, add an optional note, tap **AI Capture**. The app calls Chat Completions with the image and merges returned JSON into both rosters (match by player name, case-insensitive; unknown players are added). Team scores update when provided. Events log gets an “AI Capture” note. Rows filled by AI show **AI-assisted — verify**.

### YouTube iframe limitation

Browsers (and YouTube) do **not** allow the page to read pixels from an embedded YouTube iframe. The AI cannot “see” the playing video directly — you must **screenshot or photograph** the scorebug / graphic and upload that image.

Settings are saved under `localStorage` key `courtstats.ai.v1`. Games use `courtstats.games.v1`.

## Open on a computer first

Double-click `index.html` works for scoring. For YouTube embeds, hosting on HTTPS is more reliable than `file://`.

## What this version does not include

- Native App Store install
- On-device Vision OCR without an API key
- Xcode project / backend server
