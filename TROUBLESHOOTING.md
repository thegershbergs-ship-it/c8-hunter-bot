# TROUBLESHOOTING: the 10 most likely problems

First step for anything: in Telegram, send **/status**. On GitHub, open **Actions → C8 Hunter Bot**, click the latest run, and read the "Run bot" step. The last lines show a plain-English summary and any errors.

### 1. "Your Claude token stopped working" 🔑
The token expired or was revoked. Claude-based evaluations pause and Gemini or the rules take over.
1. On your PC, open PowerShell and run: `claude setup-token`, then approve in the browser.
2. Run `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo thegershbergs-ship-it/c8-hunter-bot` and paste the new token.
3. Send `/search` (or wait up to a day). The bot says "✅ Claude token works again".

### 2. Alert inbox: "Gmail rejected the app password" 🔴
This happens if the app password was revoked, the Google password changed (which revokes app passwords), or 2-Step Verification was turned off.
1. Sign in to the alert Gmail and go to https://myaccount.google.com/apppasswords
2. Create a new app password named `C8 Hunter`.
3. Run `gh secret set GMAIL_APP_PASSWORD --repo thegershbergs-ship-it/c8-hunter-bot` and paste it.
4. GitHub → Actions → Run workflow → **selftest**.

### 3. "I couldn't read a <site> alert email (format may have changed)" 🟡
The site redesigned its emails. Other sites keep working. A sample (with personal details removed) is saved in `data/failed/`.
Fix: open a Claude Code session in the repo folder and say: *"Read PLAN.md, PROGRESS.md and DECISIONS.md, then fix the <site> email parser using the sample in data/failed/."* Meanwhile, paste any interesting cars from that site into Telegram.

### 4. No messages at all for a long time
- Check that the workflow is enabled. GitHub disables schedules after 60 days with no repo activity. (The monthly keepalive prevents this, but if it happens: Actions → C8 Hunter Bot → **Enable workflow**.)
- Check `/status`: is it ⏸ PAUSED? Send `/resume`.
- Quiet hours: Strong alerts wait until 7 am.
- There may simply be no qualifying cars. The Sunday digest says how many C8s are under your max.

### 5. The bot doesn't answer my commands
- It only reads messages at each hourly run, and GitHub can start runs 10–30+ minutes late. To answer right away: Actions → Run workflow → quick.
- If it **never** answers: the chat link may be lost (for example, the bot token was changed). Fix: in Telegram, message **@userinfobot** to get your numeric ID, then run `gh secret set TELEGRAM_CHAT_ID --repo thegershbergs-ship-it/c8-hunter-bot` and paste that number.

### 6. A source is marked DOWN 🔴 (for example `usedcorvettesforsale`)
After 3 failures in a row the bot tests it once a day and tells you when it recovers. If it stays down for days, the site probably changed its layout or now blocks bots. See #3 for how to get it fixed. Don't try to get around a block: the bot only uses sources that allow it.

### 7. "Full check" says the site blocked the bot
This is normal for Cars.com, CarMax and some dealers. Open the listing yourself, copy the text, paste it into the bot chat, and send the photos. The bot evaluates from that.

### 8. Gemini errors / "AI review pending"
- Daily free quota reached: the work queues for the next run automatically.
- "API key not valid": create a new key at https://aistudio.google.com/apikey (**no billing**) and update `GEMINI_API_KEY`.
- Model retired: Google renames models often. Edit `ai.gemini_models` in settings.yaml (current names are in RESEARCH.md §1).

### 9. Wrong distances or "distance unknown"
`HOME_ZIP` is missing or wrong. Run `gh secret set HOME_ZIP --repo thegershbergs-ship-it/c8-hunter-bot` (5 digits), or send `/set zip 01234` in Telegram. Listings that show only a state use the state's center, which is rough.

### 10. Database save failed / run shows ❌
Usually two runs collided while saving. The next run retries and nothing is lost, because the bot only adds data. If every run fails: open the failed run, read the red step, and start a Claude Code session in the repo folder with *"the C8 bot's runs are failing, here's the error: …"*.

---
**Undo anything:** every change (including the bot's own saves) is a git commit. On GitHub: repo → **Commits** → open the commit → **Revert** (or ask Claude Code to revert it).
