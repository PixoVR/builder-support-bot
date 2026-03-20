# Deployment Guide

## What you need

- A GitHub account (to push this repo)
- A Vercel account — free at vercel.com (sign in with GitHub)
- Your Anthropic API key — console.anthropic.com → API Keys
- (Optional) A Google account for question logging

---

## Step 1 — Create a GitHub repo

1. Go to github.com → New repository
2. Name it `builder-support-bot`, set to **Private**
3. Don't initialize with a README

Then push this project:

```bash
cd /Users/greg_debeer/Documents/builder-support-bot
git init
git add .
git commit -m "Initial build"
git remote add origin https://github.com/YOUR_USERNAME/builder-support-bot.git
git push -u origin main
```

---

## Step 2 — Deploy to Vercel

1. Go to vercel.com → Add New Project
2. Import your `builder-support-bot` GitHub repo
3. Click **Deploy** — Vercel auto-detects the setup

Your bot will be live at `https://builder-support-bot-xxx.vercel.app`

---

## Step 3 — Add environment variables

In Vercel → Project Settings → Environment Variables, add:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Your key from console.anthropic.com |
| `SHEETS_WEBHOOK_URL` | (optional) Your Apps Script URL — see Step 4 |

After adding variables, go to Deployments → click the three dots on the latest deploy → **Redeploy**.

---

## Step 4 — Set up question logging (optional but recommended)

This logs every question + answer to a Google Sheet so you can track what users are asking.

1. Go to sheets.google.com → create a new sheet called **Builder Bot Logs**
2. Add these headers in row 1: `Timestamp`, `User`, `Question`, `Answer`
3. In that sheet: Extensions → Apps Script
4. Replace all code with:

```javascript
function doPost(e) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
  var data = JSON.parse(e.postData.contents);
  sheet.appendRow([
    data.timestamp,
    data.userName,
    data.question,
    data.answer
  ]);
  return ContentService.createTextOutput('OK');
}
```

5. Click **Deploy** → New deployment
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Click Authorize, then Deploy
7. Copy the Web App URL and add it as `SHEETS_WEBHOOK_URL` in Vercel

---

## Updating the docs

When you push updates to builder-docs and want the bot to reflect them:

```bash
cd /Users/greg_debeer/Documents/builder-support-bot
npm run bundle-docs
git add data/docs.json
git commit -m "Update docs bundle"
git push
```

Vercel redeploys automatically on push. Done.

---

## Sharing with users

Send them the Vercel URL. They'll be prompted for their name, then can ask questions.
The bot works on mobile too.

To set a custom domain later: Vercel → Project Settings → Domains.
