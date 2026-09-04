# CourtStats (phone web app)

Same core idea as the iOS project — multiple games, live dashboard, +1/+2/+3 scoring, YouTube player, event log — but it runs in **Safari on iPhone**. No Xcode.

## Fastest way on iPhone

1. Put this folder on any free static host:
   - [Netlify Drop](https://app.netlify.com/drop) — drag the folder onto the page
   - [Cloudflare Pages](https://pages.cloudflare.com)
   - GitHub Pages
2. Open the HTTPS link in Safari.
3. Optional: Share → **Add to Home Screen** so it feels like an app.

Games are stored in the phone’s browser (localStorage).

## Open on a computer first

Double-click `index.html` works for scoring. For YouTube embeds, hosting on HTTPS is more reliable than `file://`.

## What this version does not include

- Native App Store install
- On-device Vision OCR (use the Score / Dashboard buttons instead)
- Xcode project
