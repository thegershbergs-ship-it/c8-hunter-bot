# USER_GUIDE: using the C8 Hunter day to day

## What you'll receive on Telegram
| Message | When | What to do |
|---|---|---|
| 🏆 **EXCEPTIONAL** (85+, High confidence) | Right away, even overnight (you can turn that off) | Act fast: tap **Draft seller message**, get the VIN-specific records, book an inspection |
| 🔥 **STRONG** (75–84) | Right away, or at 7 am if it arrived during quiet hours | Worth pursuing. Clear up the ❔ unknowns. |
| 🆕 **New match** (from an alert email) | Right away | Email data only. Tap **🔎 Full check** and the bot opens that one listing on its next run (or asks you to paste it). |
| 👀 Watchlist-class cars | One summary at 7 pm | /car N if curious |
| ⭐ Watched-car updates | When the price drops, the miles change, or it disappears | |
| 📅 Weekly digest | Sunday morning | Market, top 5, sources, usage, reminders |
| 🔴/🟡/✅ system notices | Once when something breaks and once when it recovers | See TROUBLESHOOTING.md |

**[TEST]** at the start means the bot is still in dry-run mode. Send `/set test mode off` to go live.

### Reading an alert
- Headline: class · score/100 · confidence, then year/trim/body/price.
- ✅ **Verified** = the bot read it from an official or third-party source (NHTSA, an actual CARFAX page, a legible photo). 🗣 **Seller claim** = only the listing says so. ❔ **Unknown** = no data (becomes a question for the seller).
- 💵 The monthly payment is an **estimate** using your loan settings ("PLACEHOLDER" until you set them).
- 📊 Fair-value range comes from the bot's own database of C8 listings. When it says "Not enough data", treat it loosely (early weeks).
- 🛡 Scam risk Low/Medium/High. High always blocks an alert.
- 🤝 Opening / target / walk-away offers, based only on real evidence.

## Buttons
- **⭐ Watch**: tracks the car, re-checking its page once a day (one page view, robots-respecting).
- **🚫 Reject**: hides it for good. The optional reason helps the bot learn your taste (after 20 ratings the digest suggests weight tweaks; nothing changes without you).
- **🔍 Deep-dive**: on the next run, a full report with the photo analysis, every comparable, the full negotiation brief, the checklist and seller questions.
- **✉️ Draft seller message**: a polite first message to copy and send **yourself**. The bot never contacts anyone.
- **🧰 Inspection list**: a C8 checklist tailored to this car's year, body and miles.
- **🔎 Full check**: for email-only matches.

## Commands
`/status` · `/top` · `/watchlist` · `/car 12` · `/market` · `/settings` · `/set <name> <value>` · `/pause` · `/resume` · `/search` · `/help`

The bot isn't a live chat. It reads your messages at each hourly run, so **replies can take up to about an hour** (GitHub sometimes starts runs late). To force a run right away, go to GitHub → Actions → C8 Hunter Bot → **Run workflow** (works from the GitHub mobile app too).

### Changing settings
- From Telegram: `/set max price 56000`, `/set miles 40000`, `/set radius 600`, `/set quiet start 22:30`, `/set interest rate 6.9`, `/set down payment 15000`, `/set loan length 60`, `/set ai cap 10`, `/set test mode off`, or any path in settings.yaml such as `/set weights.price_vs_market 22`.
- On GitHub: open `settings.yaml` → pencil icon → edit → **Commit changes**. Every number, color, option, weight and threshold is there with comments.
- Private values (ZIP, loan numbers) are never written in plain text. They come from GitHub Secrets, or from encrypted storage if you set them with /set.

## Pasting listings (Facebook Marketplace and everything else)
1. Share or paste the link into your bot chat. Optionally add a note.
2. If the bot can open the page, you get a full evaluation on the next run.
3. If it can't (Facebook almost never can), it asks you to **paste the listing text and send the photos** in the same chat. Send them within 24 hours; you can send more later and it re-checks.

## Manual routine (about 10 min, twice a week)
- **Facebook Marketplace**, Tue & Fri evenings: https://www.facebook.com/marketplace/search/?query=corvette%20stingray&minPrice=30000&maxPrice=58500 (set your location and a 500 mi radius once).
- **Corvette Forum C8 classifieds**: https://www.corvetteforum.com/forums/c8-corvettes-for-sale-17/
- **Bring a Trailer results**: https://bringatrailer.com/chevrolet/corvette/ (paste C8 results you see; real sold prices sharpen the fair-value estimates).
- Ready-made searches (add your ZIP at the end of the link, or set it on the page):
  - Autotrader: https://www.autotrader.com/cars-for-sale/used-cars/chevrolet/corvette?startYear=2020&maxPrice=58500&mileage=50000&searchRadius=500
  - Cars.com: https://www.cars.com/shopping/results/?makes[]=chevrolet&models[]=chevrolet-corvette&stock_type=used&year_min=2020&list_price_max=58500&mileage_max=50000&maximum_distance=500
  - CarGurus: https://www.cargurus.com/ → Used → Chevrolet Corvette → set Year 2020+, price, miles, 500 mi
  - UsedCorvettesForSale (already automatic): https://usedcorvettesforsale.com/c8-corvettes/

## Free-tier safety
- Claude: at most 15 evaluations per day (`ai.claude_daily_cap`), plus `/car` deep-dives and your questions (10/day). It uses your normal plan limits, so lower the cap if you notice it in your own Claude use.
- Gemini: backup only, 40 requests/day max. No billing is ever attached.
- GitHub Actions: free on public repos. `/status` shows today's usage.

## Changing defaults I picked for you
| Default | Change with |
|---|---|
| Financing 7.5% / $10k / 72 mo (placeholders) | secrets `LOAN_APR`, `LOAN_DOWN`, `LOAN_MONTHS`, or `/set interest rate …` |
| Quiet hours 23:00–07:00 ET | `/set quiet start 22:00`, `/set quiet end 06:30` |
| Exceptional cars ignore quiet hours | `alerts.exceptional_ignores_quiet` in settings.yaml |
| Claude model `sonnet`, 16 photos | `ai.claude_model`, `ai.claude_max_photos` |
| "New match" pings at pre-score ≥ 50 | `alerts.email_match_min_prescore` |
| Daily summary at 7 pm | `alerts.daily_summary_hour` |
| Test mode ON | `/set test mode off` |
