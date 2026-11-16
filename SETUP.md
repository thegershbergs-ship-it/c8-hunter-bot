# SETUP: the steps only you can do (≈20–30 minutes, one sitting)

Your repo: **https://github.com/thegershbergs-ship-it/c8-hunter-bot** (public; secrets are encrypted and never visible).

**Golden rule:** never paste a token or password into a chat (including with Claude). Each one goes straight into GitHub Secrets, using one of the two methods below.

**Two ways to save a secret. Pick one:**
- **A. Website:** open https://github.com/thegershbergs-ship-it/c8-hunter-bot/settings/secrets/actions, click **New repository secret**, type the **Name** exactly as shown, paste the **Secret**, and click **Add secret**.
- **B. Terminal (faster):** in PowerShell run the command shown (for example `gh secret set TELEGRAM_BOT_TOKEN --repo thegershbergs-ship-it/c8-hunter-bot`), paste the value when it asks (it stays hidden), and press Enter.

Steps are in priority order. If you run out of time, stop after step 4. The bot works with whatever is done.

---

## 1. GitHub ✅ (already done)
Claude created the public repository with your logged-in `gh` account. Nothing to do.

## 2. Telegram bot (5 min). This is how the bot messages you.
1. On your phone, open Telegram and search for **@BotFather** (blue check mark).
2. Tap **Start**, then send: `/newbot`
3. When it asks for a name, send: `C8 Hunter`
4. When it asks for a username, send something unique ending in `bot`, for example `c8hunter_yourinitials_bot`
5. BotFather replies with a **token** like `123456789:AAH...`. Tap it to copy.
6. Save it as secret **`TELEGRAM_BOT_TOKEN`** (method A or B).
7. Back in Telegram, tap the link BotFather gave you (t.me/yourbotname), then tap **Start**. That sends `/start`.
   - **Success:** within about an hour (or right away if you trigger a run, see step 9) the bot replies "✅ Linked to you". It links to the **first** chat that sends /start and ignores everyone else, so do this right after creating the bot.

## 3. Alert inbox (8 min). A new Gmail used only for car alerts.
1. Open a private/incognito browser window and go to https://accounts.google.com/signup
2. Create a new account (for example `yourname.c8alerts@gmail.com`). Use a strong new password and keep it in your password manager.
3. Turn on 2-Step Verification: https://myaccount.google.com/signinoptions/twosv → **Get started**, then follow the prompts (your phone number is fine).
4. Create an app password: https://myaccount.google.com/apppasswords → App name: `C8 Hunter` → **Create**. Copy the 16-letter password (spaces don't matter).
5. Save secret **`GMAIL_ADDRESS`** = the new Gmail address.
6. Save secret **`GMAIL_APP_PASSWORD`** = the 16-letter app password.
   - **Success:** the self-test (step 9) shows "✅ Alert inbox connected".

## 4. Saved searches with email alerts (10–15 min). The main car-finding engine.
On each site: sign up with the **alert Gmail** from step 3, apply these filters, then **Save search** and turn email alerts **on** with the **most frequent** option ("instant" or "daily").
Filters everywhere: **Chevrolet → Corvette · Used · Year 2020 to newest · Max price $58,500 · Max mileage 50,000 · All trims · Coupe and convertible · ZIP = your home ZIP · Radius = 750 mi, or the largest option under that (usually 500).**
(Menu labels shift a little over time. If a filter doesn't exist on a site, skip it; the bot filters again itself.)

| # | Site | Where | Notes |
|---|---|---|---|
| 1 | **Autotrader** | autotrader.com → Used → Chevrolet Corvette | Year "2020–Any", Price "Max $58,500", Mileage "Under 50,000", Radius "500 miles". Click **Save Search** and set "Email me new matches" to daily or instant. |
| 2 | **CarGurus** | cargurus.com → Buy used → Chevrolet Corvette | Year min 2020, Price max 58,500, Mileage max 50,000, Distance 500. Click **Save search** and turn email notifications on. |
| 3 | **Cars.com** | cars.com → Used → Chevrolet Corvette | Min year 2020, Max price, Max mileage, Distance 500 mi. Click **Save search** and turn alerts on. |
| 4 | **CarMax** | carmax.com → Chevrolet Corvette | Nationwide, with transfer fees. Year 2020+, price, miles. Click **Save search** and turn alerts on. |
| 5 | **Carvana** | carvana.com → Corvette | Year 2020+, price, miles. Turn on **Save search** / notify (if offered). |
| 6 | **TrueCar** | truecar.com → Used Corvette | Year 2020+, price, miles, radius. **Save search** with alerts. |
| 7 | **Edmunds** | edmunds.com → Used Corvette | Same filters. **Save search** and turn on alerts. |
| 8 | **Chevrolet CPO** | chevrolet.com → Shop → Certified Pre-Owned → Corvette | Save the search if it offers alerts. Otherwise bookmark it (see USER_GUIDE). |
| 9 | **Bring a Trailer** | bringatrailer.com/chevrolet/corvette/ | Make an account. On the Corvette model page, **Follow**/save a search for "C8" so new listings and results reach the inbox. (Results give real sold prices.) |
| 10 | **Cars & Bids** | carsandbids.com | Make an account. Save a search for "Corvette C8" with notifications (if offered). |

- **Success:** within a day, alert emails arrive in the new Gmail, and `/status` in Telegram shows `email:autotrader`, `email:cargurus` and so on as 🟢.

## 5. Claude subscription token (3 min). AI evaluations on your existing plan, $0 extra.
1. Open **PowerShell** on your PC.
2. Install Claude Code (one time). Copy and paste:
   ```
   npm install -g @anthropic-ai/claude-code
   ```
3. Run:
   ```
   claude setup-token
   ```
4. A browser window opens. Log in with your Claude account and click **Authorize**.
5. PowerShell prints a long token. Copy it (select it, then right-click).
6. Save it as secret **`CLAUDE_CODE_OAUTH_TOKEN`**.
   - **Success:** the self-test shows "✅ Claude (your subscription) answered". The bot uses at most 15 evaluations per day (adjustable).

## 6. Gemini backup key (optional, 3 min). The bot works fine without it.
1. Go to https://aistudio.google.com/apikey (use any Google account, not your personal one if you prefer).
2. Click **Create API key**. If it asks for a project, choose **Create new project**. **Do not set up billing.** If anything asks for a card, stop and skip this step.
3. Copy the key and save it as secret **`GEMINI_API_KEY`**.
   - Note: Google may use free-tier prompts to improve its products. The bot sends **listing data only**, nothing about you.

## 7. Your private settings (2 min). These never appear in the public repo.
| Secret name | Value | If you skip it |
|---|---|---|
| **`HOME_ZIP`** | your 5-digit home ZIP | distances show as unknown |
| `LOAN_APR` | e.g. `6.9` | 7.5 placeholder |
| `LOAN_DOWN` | e.g. `15000` | 10000 placeholder |
| `LOAN_MONTHS` | e.g. `60` | 72 placeholder |
You can also change these later from Telegram (`/set interest rate 6.9`). Those are stored encrypted.

## 8. Facebook Marketplace (1 min)
1. On your phone, open this link, log in, set **Location → your town, radius 500 mi**, and bookmark the page: https://www.facebook.com/marketplace/search/?query=corvette%20stingray&minPrice=30000&maxPrice=58500&exact=false
2. Routine: check it **Tuesday and Friday evenings**. When something looks good, **share the link to your C8 Hunter Telegram bot**. If the bot can't open Facebook (it usually can't), it asks you to paste the text and send the photos.

## 9. Kick it off and verify (1 min)
1. Open https://github.com/thegershbergs-ship-it/c8-hunter-bot/actions/workflows/bot.yml
2. Click **Run workflow**, choose mode **selftest**, then click **Run workflow**.
3. After about 2 minutes, Telegram shows a ✅/❌ list. Then tell Claude "done". Claude re-checks each step and tells you exactly which one, if any, needs redoing.
