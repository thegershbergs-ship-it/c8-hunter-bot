# PROGRESS.md

_Last updated 2026-11-16. A new session should read PLAN.md, this file and DECISIONS.md first._

## Status by phase
| Phase | Status | Evidence / what's left |
|---|---|---|
| 1 Research & plan | ✅ Done | RESEARCH.md (limits, C8 codes/recalls/issues, site rules, Claude-in-Actions), PLAN.md, DECISIONS.md, SETUP.md |
| 2 Foundation | ✅ Done | 26 automated tests pass (`npm test`): VIN check digit on real VINs, filters, dedupe, distance, payment, scoring, red-flag → Reject, email parsing, SSRF guard, robots, AI-answer parsing |
| 3 Telegram | 🟡 Built, **waiting on you** (SETUP step 2) | Then: run `testalert` + `selftest`, press each button, try each command |
| 4 Email ingestion | 🟡 Built and tested on sample formats, **waiting on you** (steps 3–4) | Then: confirm real emails from ≥3 sites parse (`/status` shows email:<site> 🟢) |
| 5 Page extraction + direct sources | ✅ Done | 10 live C8 listings extracted from UsedCorvettesForSale.com (VIN, year, trim, body, miles, colors). Dealer pages tested: most stale links were sold; redirect-to-other-car detection added. Marketplaces are not auto-fetched (terms). |
| 6 Free history stack | ✅ Done | NHTSA vPIC decode + recalls run live on real VINs; truth labels on every fact |
| 7 Market value & negotiation | 🟡 Logic done + tested | Needs ≥5 in-budget comparables. The database fills from email alerts once step 4 is done. |
| 8 AI layer | 🟡 Built | Needs the Claude token (step 5) to test tier 1 + photo analysis. Tiers 2/3 need the Gemini key / are tested via DISABLE_* repo variables. |
| 9 Automation | ✅ Running | Workflow live: hourly/4-hourly/weekly/monthly schedules, concurrency, DB auto-save. First cloud sweep succeeded 2026-11-16. |
| 10 Dry run | ⏳ After setup | test_mode is ON. Run a sweep, review, then `/set test mode off` |
| 11 Docs | ✅ Done | README, SETUP, USER_GUIDE, TROUBLESHOOTING |
| 12 First-week check-in | ⏳ ~2026-11-23 | See "Next session" below |

## Blocked on you
SETUP.md steps 2–7, then step 9 (selftest) and tell Claude "done".

## Next session (first-week check-in)
Open a terminal in this folder, run `claude`, and say:
> Read PLAN.md, PROGRESS.md and DECISIONS.md. It's the first-week check-in for the C8 bot: review the last week of runs (`gh run list`), data/db.json (sources, alertsSent, failed parses in data/failed/), alert quality and extraction accuracy, and tune anything that's off.

## Known limitations (honest)
- Major marketplaces are covered by **their own email alerts**, not by scraping (their terms forbid it). Email-only cars get a "New match" ping. The full check needs your tap or a paste.
- Fair values are thin for the first 1–2 weeks, and the alerts say so.
- Claude's `setup-token` in headless mode has community reports of 401 errors. If that happens, the Gemini/rules fallback takes over and you're told once.
