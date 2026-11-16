# RESEARCH.md: what I looked up, with sources

Researched 2026-11-16. Anything here can change, so re-check the sources before relying on a number.

## 1. Free-tier limits (every service the bot uses)

| Service | Free limit that matters | How the bot stays under it | Source |
|---|---|---|---|
| GitHub Actions (public repo, standard runners) | Free with no monthly minute cap. Max job 6 h. Scheduled workflows on a public repo are **disabled after 60 days without repo activity**. The scheduler can start jobs late. | Jobs take a few minutes. A monthly keepalive commit runs. The bot always shows the actual last-run time. | https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-actions/about-billing-for-github-actions , https://code.claude.com/docs/en/github-actions ("disables the schedule after 60 days without repository activity") |
| Claude (your subscription) via `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN` | Uses your plan's normal usage limits, which are shared with your everyday Claude use. Officially supported for GitHub Actions on Pro/Max/Team/Enterprise. Some users report `401 Invalid bearer token` with `claude -p`, so the bot detects this. | Hard cap of 15 evaluations/day (settings). The rule engine filters first. Each evaluation is a single turn with limited photos. | https://code.claude.com/docs/en/github-actions , https://claudeissues.com/issue/65320-setup-token-oauth-token-returns-401-invalid-bearer-token-with-claude-p-on-max-su |
| Gemini API free tier (Google AI Studio key, **no billing**) | Limits are per project, shown in AI Studio, and change often (they were cut in Dec 2025). Daily quotas reset at midnight Pacific. Free-tier prompts **may be used by Google to improve products**, so the bot sends listing data only. Stable models as of today: `gemini-3.8-flash`, `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`. `gemini-2.5-flash` is deprecated and reroutes on 2026-12-01. | Used only as a backup. Capped at 40 requests/day (settings). On HTTP 429 the work is queued for the next run. The model list in settings is tried in order. | https://aistudio.google.com/docs/rate-limits , https://aistudio.google.com/docs/models |
| Telegram Bot API | Free. Message limit 4,096 chars, photo caption 1,024. About 30 msgs/sec overall and 1 msg/sec per chat. `getUpdates` keeps unread updates for 24 h. | Messages are split under 4,000 chars and sent with a pause between them. The bot polls every hour (inside the 24 h window). | https://core.telegram.org/bots/api , https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this |
| Gmail (IMAP + app password) | Free. IMAP download about 2,500 MB/day. App passwords require 2-Step Verification. | Alert emails are small. The bot reads only unread mail and moves processed mail to a label. | https://support.google.com/mail/answer/7126229 , https://support.google.com/accounts/answer/185833 |
| NHTSA vPIC VIN decoder | Free, no key. NHTSA asks for reasonable use. | Each VIN is cached forever. Requests are spaced 1 s apart. | https://vpic.nhtsa.dot.gov/api/ |
| NHTSA Recalls API | Free, no key. | Cached per model year for 7 days. | https://api.nhtsa.gov/recalls/recallsByVehicle?make=CHEVROLET&model=CORVETTE&modelYear=2021 |
| US ZIP centroids | US Census 2024 ZCTA Gazetteer (public domain), bundled as `data/zip_centroids.csv.gz` (33,791 ZIPs). | Offline. No API calls. | https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/ |
| NICB VINCheck | Free, a few lookups per day per person, consumer use only. | **Not automated.** The bot only adds a one-tap link to each alert. | https://www.nicb.org/vincheck |

## 2. Car sites: what automation is allowed

| Site | robots.txt (checked today) | Terms of use | Bot's policy |
|---|---|---|---|
| Autotrader (Cox) | `/cars-for-sale/vehicle/...` not disallowed. The site served an Akamai **block page** to an honest bot user-agent. | Cox sites forbid automated extraction "except in strict conformance with the Robots Exclusion Protocol" (KBB/Cox visitor terms). | Email alerts. A listing page is fetched only when you ask (Full check or paste-a-link), and only when robots.txt allows it. |
| Cars.com | robots.txt itself returns 403 to bots. Search returned 403. | Not retrievable. Third-party scrapers say their terms restrict scraping. | Email alerts. Fetched only on request, and it will usually be blocked, in which case the bot asks you to paste the text. |
| CarGurus | `/Cars/inventorylisting/` disallowed. Some listing paths are allowed. | Bans "scrape, data mine". Automated collection only "in strict conformance with the Robots Exclusion Protocol". | Email alerts. Fetched on request, only on robots-allowed paths. |
| CarMax | robots.txt returns 403 to bots. | Not checked. | Email alerts plus fetch on request. |
| Carvana | `Disallow: /inventory/`. `/vehicle/` allowed. | Not checked. | Email alerts plus fetch on request. |
| TrueCar | `Disallow: /used-cars-for-sale/listing/*` | n/a | Email alerts only. **Listing pages are never fetched** (robots disallows them). |
| Edmunds | `Disallow: */vin/*` (listing pages) | n/a | Email alerts only. Never fetched. |
| Bring a Trailer | Crawl-delay 1. Listing pages allowed. | **Explicitly bans robots/spiders/scrapers "whether automated or manual"** to access, monitor or scrape. | **Never fetched.** Use BaT's own email alerts. You paste interesting results. |
| Cars & Bids | Only `/sell-car/` disallowed. The site is a JavaScript app (no static data). | Terms page is JavaScript-only, so it couldn't be read. | Email alerts only (unclear means not automated). |
| Chevrolet CPO / franchise dealer sites | Varies by dealer | Varies | Fetched on request, only when robots.txt allows. |

**Conclusion.** No major marketplace clearly allows unattended scraping. Bring a Trailer and CarGurus clearly forbid it. So the bot relies on **email alerts as the main engine**, which gets close to real time. It fetches a single listing page **only when you ask for it** (Full check button or a pasted link), honestly identified, robots-checked, and at most 1 request every 3 s per site. Under the master prompt's rule ("if it's not allowed or unclear, don't automate it"), no marketplace gets automatic fetching by default. Individual sites can be switched on in `settings.yaml` (`sites.<name>.fetch: auto`) if you decide that's acceptable.

## 3. C8 Corvette knowledge

### VIN structure (verified against the NHTSA decoder today)
Example: `1G1Y B 2 D 4 x M 5 ######`
- Positions 1–4 `1G1Y` = Chevrolet Corvette.
- **Position 5 = series/trim:** `A` = Stingray 1LT, `B` = 2LT, `C` = 3LT, `D` = Z06 1LZ (Z06 2LZ/3LZ and E-Ray/ZR1 use other letters: anything that decodes as Z06/E-Ray/ZR1 is treated as "other variant").
- **Position 6 = body:** `2` = coupe, `3` = convertible.
- **Position 8 = engine:** `4` = LT2 6.2 L (Stingray), `3` = LT6 5.5 L (Z06).
- Position 9 = check digit. Position 10 = model year (`L`=2020, `M`=2021, `N`=2022, `P`=2023, `R`=2024, `S`=2025, `T`=2026). Position 11 `5` = Bowling Green, KY.
- vPIC returns `Trim` like "Preferred 2LT", `BodyClass` "Coupe" / "Convertible/Cabriolet", `EngineModel` "LT2 - ENGINE", 8-speed automatic.

### Option (RPO) codes the bot cares about
Printed on the window sticker and on the Service Parts ID label (glovebox. Some 2020 reports say it is a QR label on the driver's door).
| RPO | Meaning | How to spot it in photos |
|---|---|---|
| **Z51** | Z51 Performance Package (bigger brakes, eLSD, extra cooling, aero, includes performance exhaust NPP and Z51 suspension FE3) | "Z51" badge/rear spoiler/front splitter, larger brakes. **Rear quarter "Z51" script is not always present.** Window sticker line "Z51 Performance Package". |
| **FE4** | Z51 suspension **with Magnetic Selective Ride Control** | "Magnetic Ride" on sticker. Drive-mode menu shows "MRC". Cannot be seen from outside. |
| **FE2** | Magnetic Ride on non-Z51 cars (later years) | Same |
| **E60** | Front lift, adjustable height **with memory** | Button with car-nose-up icon on the center console switch bank |
| **NPP** | Performance exhaust (4 round tips standard on all C8. NPP is the dual-mode valved system included with Z51) | Sticker, or "Exhaust" mode settings. Tips alone are not proof. |
| **AQ9 / AH2 / AE4** | GT1 seats (base) / GT2 seats / Competition Sport seats | GT1 = rounded backs with no carbon. GT2 = more bolster, carbon/painted trim on the back. Competition = big fixed bolsters with harness pass-throughs. |
| **1YC07 / 1YC67** | Coupe / Convertible model codes | Removable roof panel vs. folding hardtop |
| 1LT / 2LT / 3LT | Trim | 2LT adds HUD, 14-speaker Bose, heated/vented seats, wireless charging, front-curb camera. 3LT adds a leather-wrapped interior and GT2 seats as standard. |

Sources: https://corvsport.com/?p=81454 (2020 RPO list), https://corvetteactioncenter.com/specs/c8-corvette/2021-corvette/2021-corvette-rpo-codes.html , https://www.corvetteactioncenter.com/wp-content/uploads/2021/06/2022-corvette-rpo-codes.pdf

### Model-year changes (Stingray)
- **2020:** Launch year. Early-build DCT and electrical complaints are the most common in forums. Four recalls (see below).
- **2021:** New colors Silver Flare and Red Mist, Sky Cool Gray / Strike Yellow interior, Magnetic Ride available more widely, and a wireless-phone/tech update. Price stayed under $60k.
- **2022:** Minor changes. The half-shaft recall covers some 2021–22 cars.
- **2023:** 70th Anniversary package. Z06 returns.
- **2024:** E-Ray launches. Mid-cycle tech updates.
- **2025:** New colors (Hysteria Purple, Sebring Orange returns), new optional spoiler, updated interior screen layout.
- **Budget reality:** with a $57.5k ceiling, expect mostly **2020–2022** cars, often 1LT/2LT. The bot measures the real spread and reports it weekly instead of guessing.
Sources: https://www.motorauthority.com/news/1128783_2021-chevrolet-corvette-still-under-60-000-with-new-tech-new-colors-new-stripes , https://hagerty.com/media/?p=393794 , https://www.corvsport.com/2025-corvette-lineup-whats-new-with-every-model , https://gmauthority.com/blog/2024/07/2025-corvette-pricing-uncovered/

### Colors (used for scoring)
- Preferred exterior: **black** (Black), **dark red** (Red Mist, Long Beach Red, Radiant Red), **red** (Torch Red), **blue** (Elkhart Lake Blue, Rapid Blue, Riptide Blue), **yellow** (Accelerate Yellow), **silver** (Blade Silver, Silver Flare).
- Other C8 colors (small penalty): Arctic White, Ceramic Matrix Gray, Shadow Gray, Hypersonic Gray, Sea Wolf Gray, Zeus Bronze, Sebring Orange, Amplify Orange, Caffeine, Cacti Green, Hysteria Purple, White Pearl.
- Preferred interior: Jet Black, Natural / Natural Dipped (tan/caramel), Artemis (brown/tan), and white-ish interiors (Sky Cool Gray counts as gray, so not preferred). Others: Adrenaline Red, Morello Red, Tension/Twilight Blue, Strike Yellow two-tone, Santorini Blue.

### NHTSA recalls (pulled live from the NHTSA API today; the bot re-pulls weekly)
| Campaign | Years | Summary |
|---|---|---|
| 20V461000 | 2020 | Frunk interior release button may not work after car is off 10 min (entrapment risk) |
| 20V489000 | 2020 | Car can be driven with the frunk lid unlatched despite warnings (software) |
| 20V581000 | 2020 | Driver seat-belt retractor may not lock in a crash |
| 20V588000 | 2020 | Electronic brake boost sensor connection contamination |
| 21V421000 | 2021 | Communications gateway module: airbag warning lamp issue |
| 22V091000 | 2021–2022 | **Rear half-shafts may be missing ball bearings → loss of drive power** |
| 24V418000 | 2024–2025 | Seat-belt retractors may lock stowed |
| 25V536000 | 2023–2026 | Fuel can spill into filler pocket during refueling (left-side radiator/fan cars) |
| 26V213000 | 2025–2026 | Turn-signal lighting (various C8 variants) |
A **TCM emissions recall** (voluntary, 2020–2022, the TCM clears DTCs incorrectly) is reported by GM Authority and forums. Confirm it by VIN. Completion check: Chevrolet's free VIN recall lookup at https://www.chevrolet.com/ownercenter/recalls (shows **open** recalls only, so "none open" means done or not applicable), or ask any Chevrolet dealer for a GM Global Warranty/recall printout by VIN.
Source: https://api.nhtsa.gov/recalls/recallsByVehicle?make=CHEVROLET&model=CORVETTE&modelYear=2020 (and per year)

### Factory warranty (for remaining-coverage estimates)
- Bumper-to-bumper **3 yr / 36,000 mi**. Powertrain **5 yr / 60,000 mi** (whichever first), counted from the original in-service date. https://www.chevrolet.com/owners/warranty
- GM Certified Pre-Owned: 12 mo / 12,000 mi limited warranty plus a 6 yr / 100,000 mi powertrain (from original in-service). Dealers cite eligibility of ≤6 years old and <75k miles. Verify per car. Sources: dealer CPO listings, https://www.cioccacorvette.com/blog/2024/january/4/enjoy-added-assurance-with-a-certified-pre-owned-corvette-in-atlantic-city-nj.htm
- Extended GM protection plans must generally be bought before factory coverage expires. https://www.consumeraffairs.com/automotive/chevrolet-corvette-extended-warranty.html

### Common C8 issues → inspection checklist (frequency labels are mine, from forum/complaint volume)
| Issue | Frequency | What to check / ask |
|---|---|---|
| Tremec TR-9080 DCT problems: leaks (pan gasket, input-shaft seal), sensor faults → "Service Transmission"/limp mode, rare failures and cracked housings (mostly early 2020–21) | **Widely reported** | Ask for DCT fluid/filter service records (GM interval cited as ~22,500 mi / 3 yr for the first service). Look for fluid under the car or wet transmission. Do a cold-start and low-speed test drive. PPI scan for stored TCM codes. Check whether the TCM recall was done. |
| Frunk latch/release recalls (2020), water in frunk | Widely reported (recalls) / occasionally reported (water) | Recall completion. Frunk dry with no mold. |
| Front splitter / nose scrapes (low car) | **Widely reported** | Photos of the splitter underside. E60 front lift helps. |
| Half-shaft missing bearings (2021–22 recall) | Recall | Recall completion by VIN |
| Electrical/infotainment glitches, warning lights (early cars) | Occasionally reported | Dash photos with the engine running, and no warning lights |
| Wheel curb rash / tire wear (wide, soft tires; rears can last ~10–15k mi) | Widely reported | Tire date codes and tread. Budget about $1,500–2,000 for a set. |
| Interior rattles / targa-top creaks | Occasionally reported | Test drive |
Sources: https://www.motorbiscuit.com/investigation-launched-2020-2021-c8-corvette-transmission-issues , https://gmauthority.com/blog/gm/chevrolet/corvette/c8/ , https://corvsport.com/your-guide-to-common-c8-issues-recalls-and-technical-service-bulletins , https://www.pistonheads.com/features/ph-buying-guides/corvette-stingray-c8--ph-used-buying-guide/49470 , https://www.corvetteforum.com/forums/c8-stingray-general-discussion/4902047-common-problems-on-c8.html
**Rule:** these are general patterns. The bot never claims a specific car has one without evidence.

## 4. Running Claude inside GitHub Actions with your subscription
- Official path: run `claude setup-token` on your own computer (needs Claude Code installed: `npm install -g @anthropic-ai/claude-code`). It opens your browser to approve and prints a long-lived token. Store it as the repo secret **`CLAUDE_CODE_OAUTH_TOKEN`**. https://code.claude.com/docs/en/github-actions
- The `anthropics/claude-code-action@v1` action needs the Claude GitHub App installed. That's overkill here, so the bot installs the **Claude Code CLI** in the runner and calls `claude -p` (headless mode) with `CLAUDE_CODE_OAUTH_TOKEN` in the environment. This is the same engine the action uses (built on the Agent SDK).
- Known risk: some users get `401 Invalid bearer token` from setup-token tokens in `claude -p`. The bot detects 401/auth errors, falls back to Gemini, and tells you once how to regenerate the token.
- GitHub Models: retired July 2026. Not used.

## 5. Transport cost estimates (rough; brokers' own numbers)
- Open carrier, long distance: about **$0.55–0.95/mile** (shorter trips cost more per mile).
- Enclosed: **30–60% more**, roughly **$0.90–1.40/mile**. Most C8 buyers choose enclosed.
- The bot uses **$1.00/mile open and $1.50/mile enclosed below 500 mi, and $0.75 / $1.15 above that**, each with a $400 minimum, labeled "rough estimate" (settings).
Sources: https://www.freightwaves.com/checkpoint/cost-to-ship-car/ , https://www.kbb.com/car-advice/costs-shipping-vehicle

## 6. Saved-search filters to enter on each site
See SETUP.md step 4. The C8 filter is "Chevrolet → Corvette, years 2020 to newest" on every site. Corvette generations are not separate models on most sites, so the year filter does the C8 separation, and the bot drops C7s anyway.
