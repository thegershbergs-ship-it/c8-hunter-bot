# DECISIONS.md: one line of reasoning per decision

| # | Decision | Why |
|---|---|---|
| 1 | **Node.js 22**, 4 small dependencies (imapflow, mailparser, cheerio, yaml) | Node was already on your PC and is preinstalled on GitHub runners. A small, well-maintained set of libraries. |
| 2 | **One JSON file** as the database (`data/db.json`) | Free, diffable in GitHub, no external service. Size stays small (≈2 KB/car). Old cars are archived to gzip after 180 days. |
| 3 | **One workflow** with modes (quick / sweep / digest / keepalive / selftest / testalert) and a job-level concurrency group | Runs never overlap. Easy to trigger manually from the GitHub website or app. |
| 4 | Save DB with `git pull --rebase -X theirs` and 4 push retries | Handles the rare case where two commits race. The bot's newest data wins. |
| 5 | **Claude via `claude -p` CLI + `CLAUDE_CODE_OAUTH_TOKEN`**, not `claude-code-action` | The official subscription-token flow. The action would also require installing the Claude GitHub App, which this bot doesn't need. |
| 6 | Claude model `sonnet`, cap 15/day, ≤16 photos, single structured JSON answer | Keeps usage small on a subscription shared with your everyday Claude use. |
| 7 | Gemini model list `[3.5-flash-lite, 3.8-flash, 2.5-flash-lite]`, tried in order | Google renames and retires models often. A 404 falls through to the next model, and a 429 queues the work for the next run. |
| 8 | **No automatic scraping of Autotrader, Cars.com, CarGurus, CarMax, Carvana, TrueCar, Edmunds, BaT or C&B** | Their terms or robots forbid it, or it is unclear (see RESEARCH.md §2), and the master prompt says "if unclear, don't automate". Email alerts cover them instead. |
| 9 | Listing pages on those marketplaces are fetched **only when you ask** (Full check, a pasted link, or ⭐ Watch = one re-check per day), robots-checked, ≥3 s apart, honest user-agent | A single user-requested page view is not bulk scraping. BaT, TrueCar and Edmunds listing pages are never fetched. |
| 10 | Email-only cars get a short "🆕 New match" ping (pre-score ≥ 50) with a **Full check** button, and are capped below Strong until checked | Alert emails rarely include the VIN or photos, so a full Strong/Exceptional verdict would be dishonest without them. |
| 11 | **UsedCorvettesForSale.com** as an automatic direct source | Its robots.txt has no rules for general bots and its terms have no anti-automation clause (checked 2026-11-16). It is Corvette-only and lists VINs. |
| 12 | Distance = Census ZCTA centroid haversine × 1.2. State centroid is the fallback when only the state is known. | Free and offline. The state fallback is rough, but better than unknown for the 750-mile filter. |
| 13 | **Never store distance, payment or chat ID in the public DB** | Many distances to known dealer locations could reveal your home area. They are computed at message time from secrets. |
| 14 | Chat ID captured by the **first private `/start`** and stored AES-256-GCM-encrypted (`data/private.enc`), with the key derived from the bot token. A `TELEGRAM_CHAT_ID` secret overrides it. | Matches your "send the bot one message" step with no extra secret to copy. Messages from any other chat are ignored. |
| 15 | `/set` for private values (rate, down payment, term, ZIP) writes the same encrypted file | Lets you change private values from your phone without exposing them in the public repo. |
| 16 | Fair value = median of ≥5 closest comparables (±1 model year, same body, ±10k miles, ≤120 days old), each adjusted to the target car. The range is the IQR, at least ±3%. | Simple and explainable. $/mile and $/model-year are learned from the data once there are enough pairs; until then the defaults are $0.15/mile and $3,000/year. Trim/Z51/MagRide/front-lift deltas are defaults (2LT +$4k, 3LT +$7k, Z51 +$3k, MagRide +$1k, lift +$1k) and are listed in `src/market.js`. |
| 17 | Unknown facts get **half credit** and count toward a Confidence rating (≤2 key unknowns = High, ≤5 = Medium) | As specified. Mostly-unknown cars can't reach Exceptional. |
| 18 | No VIN → capped at Watchlist. A non-Stingray C8 under budget is alerted only if it passes **every** check, labeled "Unusual". | Spec. |
| 19 | NICB VINCheck: link only, never automated | It is consumer-only and limited to a few lookups per day. |
| 20 | Window sticker: not auto-fetched. Options come from photo analysis (glovebox label) and listing claims. | Public GM sticker lookups for Corvettes are unreliable. The bot never claims a sticker it didn't read. |
| 21 | Email-only cars become `stale` after 45 days unseen. Only re-checkable cars (watched or direct-source) become `likely_sold` after 3 days missing. | Alert emails don't re-announce cars that are still for sale, so "missing" doesn't mean "sold" for those. |
| 22 | Seller message, inspection checklist and negotiation numbers are **deterministic templates**, enriched by the AI answer when available | They cost $0, always work, and never invent leverage. The AI adds photo-based points and a polished seller message. |
| 23 | Dealer page that now shows a different VIN or a non-Corvette → treated as **sold/redirected** | Found in testing: many dealer sites redirect sold cars to other inventory. |
| 24 | Test mode (`alerts.test_mode: true`) prefixes every alert with [TEST] until the dry run is approved | Phase 10 requirement. Turn it off with `/set test mode off`. |
