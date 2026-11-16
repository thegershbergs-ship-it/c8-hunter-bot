# PLAN.md: build plan

Goal: a $0/month bot that finds the best C8 Corvette Stingray within budget, protects against bad cars and scams, and alerts you on Telegram.

## Architecture (one line each)
- **Runtime:** Node.js 22 on GitHub Actions (public repo, free standard runners). One workflow, with modes chosen by schedule.
- **Storage:** `data/db.json` (single JSON file, committed after every run). Old listings go to `data/archive.jsonl.gz`.
- **Settings:** `settings.yaml` (public criteria, editable from Telegram). Private values live in GitHub Secrets, or in AES-encrypted `data/private.enc` when changed via `/set`.
- **Inputs:** (1) marketplace alert emails over Gmail IMAP; (2) direct sources allowed by robots + terms (currently UsedCorvettesForSale.com); (3) links you paste in Telegram (Facebook and everything else); (4) manual routine in USER_GUIDE.
- **Checks:** VIN check digit → NHTSA vPIC decode → NHTSA recalls → free report link → odometer consistency → warranty estimate. Every fact is labeled Verified / Seller claim / Unknown.
- **Judging:** hard filters → 100-point rule score (weights in settings) → AI review (Claude via subscription → Gemini free → rules) adjusts ±10 → class.
- **Output:** Telegram alerts with buttons, commands, daily Watchlist summary, weekly digest.

## Phases (status in PROGRESS.md)
1. Research & plan (RESEARCH.md, DECISIONS.md, SETUP.md checklist)
2. Foundation: settings, DB, core logic, unit tests
3. Telegram: alerts, buttons, commands (needs your bot token)
4. Email-alert ingestion (needs the alert inbox + saved searches)
5. Listing page extraction + direct sources
6. Free history stack
7. Market value + negotiation
8. AI layer (3 tiers)
9. Automation (Actions schedules, keepalive, secrets)
10. Dry run in [TEST] mode
11. Docs & handoff
12. First-week check-in

## Assumptions (defaults used; change in settings.yaml or with /set)
- Financing placeholders: 7.5% APR, $10,000 down, 72 months.
- Quiet hours 23:00–07:00 Eastern. Exceptional cars still alert during quiet hours.
- Claude model "sonnet" (lighter on your plan), with a cap of 15 evaluations/day and 16 photos per car.
- Email-only matches get a short "New match" ping at pre-score ≥ 50. Full checks happen when you tap the button.
