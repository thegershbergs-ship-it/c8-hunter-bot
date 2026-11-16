# C8 Hunter Bot

A personal, **$0/month** bot that hunts for a used **C8 Corvette Stingray** within budget, protects against bad cars, scams and overpaying, and messages you on **Telegram** when a good one shows up.

**How it works**
1. **Finds cars** from marketplace **alert emails** (Autotrader, CarGurus, Cars.com, CarMax, Carvana, TrueCar, Edmunds, Chevy CPO, BaT, Cars & Bids) sent to a dedicated Gmail, from **UsedCorvettesForSale.com** (which allows bots), and from **any link you paste** into Telegram (Facebook Marketplace, Craigslist, dealer sites).
2. **Checks each car**: hard filters (price, miles, distance, clean title, no engine mods), VIN check digit, the official **NHTSA** VIN decode and recalls, any free CARFAX/AutoCheck link, odometer consistency, and remaining warranty. Every fact is labeled ✅ Verified / 🗣 Seller claim / ❔ Unknown.
3. **Judges it**: a 100-point score, fair value from its own price database, scam-risk rating, and an AI review of photos and description (Claude on your subscription → Gemini free tier → rules only).
4. **Tells you**: Exceptional/Strong alerts with buttons (Watch, Reject, Deep-dive, Draft seller message, Inspection checklist), a daily Watchlist summary and a Sunday digest.

**It never** contacts sellers, makes offers, pays for anything, or claims something is verified when it isn't. Always get a pre-purchase inspection.

Runs on GitHub Actions (public repo, free). Hourly quick check, 4-hourly full sweep, weekly digest, monthly keepalive.

| Doc | What |
|---|---|
| [SETUP.md](SETUP.md) | The few steps only you can do |
| [USER_GUIDE.md](USER_GUIDE.md) | Day-to-day use: commands, buttons, settings, what alerts mean |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | The 10 most likely problems and fixes |
| [settings.yaml](settings.yaml) | All your criteria, weights and thresholds |
| [RESEARCH.md](RESEARCH.md) · [DECISIONS.md](DECISIONS.md) · [PLAN.md](PLAN.md) · [PROGRESS.md](PROGRESS.md) | Background |
