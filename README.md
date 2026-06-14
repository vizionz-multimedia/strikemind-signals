# StrikeMind Signals™ — Landing Page v2.0
### Trade Team Apex Edition

## Overview
Full landing page for StrikeMind Signals™ subscription service. Features the complete Trade Team Apex faction — StrikeMind, Project MIA, and Striker — with a three-tier Stripe paywall and Telegram invite-link delivery.

## Files
```
index.html          — Full landing page (self-contained, no dependencies)
README.md           — This file
```

## Setup

### 1. Configure the Checkout Endpoint
In `index.html`, find this line and replace with your deployed function URL:
```js
const CHECKOUT_ENDPOINT = 'REPLACE_WITH_YOUR_CHECKOUT_FUNCTION_URL';
```
Should point to:
```
https://base44.app/api/apps/YOUR_APP_ID/functions/createCheckoutSession
```

### 2. Required Environment Variables (in your Base44 app)
```
STRIPE_SECRET_KEY         — sk_live_...
STRIPE_WEBHOOK_SECRET     — whsec_...
TELEGRAM_BOT_TOKEN        — from @BotFather
TELEGRAM_CHANNEL_ID       — numeric ID e.g. -1001234567890
```

### 3. Required Backend Functions
- `createCheckoutSession` — creates Stripe checkout session, returns `{ url }`
- `stripeWebhook` — handles: checkout.session.completed, invoice.paid, invoice.payment_failed, customer.subscription.deleted, customer.subscription.updated

### 4. Stripe Price IDs
Update the `PRICE_IDS` object in `createCheckoutSession`:
```ts
const PRICE_IDS = {
  brief:     'price_XXXXX',   // $29/mo
  fullstack: 'price_XXXXX',   // $49/mo
  fire:      'price_XXXXX',   // $99/mo
};
```

### 5. Telegram Bot Setup
- Create bot via @BotFather
- Add bot as **admin** to your StrikeMind Signals channel
- Grant permissions: **Invite Users** + **Ban/Remove Members**

## Architecture

### Tier → Agent Access
| Tier       | Agents              | Price  |
|------------|---------------------|--------|
| Brief      | MIA + StrikeMind    | $29/mo |
| Full Stack | MIA + StrikeMind + Striker | $49/mo |
| FIRE       | All agents + Direct DMs | $99/mo |

### Signal Flow
1. Customer completes checkout → Stripe fires `checkout.session.completed`
2. Backend generates single-use Telegram invite link (15-min expiry, member_limit: 1)
3. Invite link emailed to subscriber
4. On cancellation/non-payment → bot removes user from channel

## Brand Assets
All faction logos are hosted on Base44 CDN. To self-host, replace the `src` URLs in `index.html` with your own CDN paths.

## Disclaimer
For informational purposes only. Not financial advice. All trading involves risk. Capital First.

---
© 2026 VMHGCreative · vmhgcreative.com
