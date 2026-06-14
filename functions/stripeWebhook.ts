// ============================================================
// stripeWebhook.ts
// StrikeMind Signals™ — Stripe Webhook Handler
// Handles: checkout.session.completed, invoice.paid,
//          invoice.payment_failed, customer.subscription.deleted,
//          customer.subscription.updated
// Deploy this inside your Base44 app backend
// ============================================================

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, stripe-signature',
      }
    });
  }

  const stripeKey     = Deno.env.get('STRIPE_SECRET_KEY');
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const botToken      = Deno.env.get('TELEGRAM_BOT_TOKEN');
  const channelId     = Deno.env.get('TELEGRAM_CHANNEL_ID');

  if (!stripeKey || !webhookSecret) {
    return Response.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  // ── VERIFY STRIPE SIGNATURE ─────────────────────────────
  const sig  = req.headers.get('stripe-signature') || '';
  const body = await req.text();

  let event: any;
  try {
    event = await verifyStripeWebhook(body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err);
    return Response.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const base44 = createClientFromRequest(req);

  try {
    switch (event.type) {

      // ── CHECKOUT COMPLETED → ACTIVATE + SEND INVITE ──
      case 'checkout.session.completed': {
        const session  = event.data.object;
        const custId   = session.customer;
        const subId    = session.subscription;
        const meta     = session.metadata || {};
        const tier     = meta.tier || 'brief';
        const tgHandle = meta.telegram_username || '';
        const email    = session.customer_details?.email || meta.email || '';

        // Fetch subscription for trial end date
        let trialEnd: string | null = null;
        if (subId) {
          const subRes  = await stripeGet(`/v1/subscriptions/${subId}`, stripeKey);
          trialEnd = subRes.trial_end
            ? new Date(subRes.trial_end * 1000).toISOString()
            : null;
        }

        // Generate Telegram invite link
        let inviteLink = '';
        if (botToken && channelId) {
          inviteLink = await createTelegramInvite(botToken, channelId, custId);
        }

        // Update subscriber record
        const subs = await base44.asServiceRole.entities.Subscriber.filter({ stripe_customer_id: custId });
        if (subs.length > 0) {
          await base44.asServiceRole.entities.Subscriber.update(subs[0].id, {
            status: 'active',
            access_active: true,
            stripe_subscription_id: subId,
            trial_end: trialEnd,
            notes: inviteLink ? `Telegram invite: ${inviteLink}` : '',
          });
        } else {
          // Create if not pre-created
          await base44.asServiceRole.entities.Subscriber.create({
            email,
            tier,
            telegram_username: tgHandle,
            stripe_customer_id: custId,
            stripe_subscription_id: subId,
            status: 'active',
            access_active: true,
            trial_end: trialEnd,
            notes: inviteLink ? `Telegram invite: ${inviteLink}` : '',
          });
        }

        console.log(`✅ Activated: ${custId} | Tier: ${tier} | Invite: ${inviteLink}`);
        break;
      }

      // ── INVOICE PAID → CONFIRM RENEWAL ───────────────
      case 'invoice.paid': {
        const invoice = event.data.object;
        const custId  = invoice.customer;

        const subs = await base44.asServiceRole.entities.Subscriber.filter({ stripe_customer_id: custId });
        if (subs.length > 0) {
          await base44.asServiceRole.entities.Subscriber.update(subs[0].id, {
            status: 'active',
            access_active: true,
          });
        }
        console.log(`💳 Renewal confirmed: ${custId}`);
        break;
      }

      // ── PAYMENT FAILED → MARK PAST DUE ───────────────
      case 'invoice.payment_failed': {
        const invoice = event.data.object;
        const custId  = invoice.customer;

        const subs = await base44.asServiceRole.entities.Subscriber.filter({ stripe_customer_id: custId });
        if (subs.length > 0) {
          await base44.asServiceRole.entities.Subscriber.update(subs[0].id, {
            status: 'past_due',
          });
        }
        console.log(`⚠️ Payment failed: ${custId}`);
        break;
      }

      // ── SUBSCRIPTION DELETED → REVOKE ACCESS ─────────
      case 'customer.subscription.deleted': {
        const sub    = event.data.object;
        const custId = sub.customer;

        const subs = await base44.asServiceRole.entities.Subscriber.filter({ stripe_customer_id: custId });
        if (subs.length > 0) {
          const subscriber = subs[0];
          await base44.asServiceRole.entities.Subscriber.update(subscriber.id, {
            status: 'cancelled',
            access_active: false,
          });

          // Remove from Telegram channel if we have a user_id stored
          if (botToken && channelId && subscriber.telegram_user_id) {
            await removeTelegramUser(botToken, channelId, subscriber.telegram_user_id);
          }
        }
        console.log(`🚫 Subscription cancelled: ${custId}`);
        break;
      }

      // ── SUBSCRIPTION UPDATED → CHECK STATUS ──────────
      case 'customer.subscription.updated': {
        const sub    = event.data.object;
        const custId = sub.customer;

        if (['canceled', 'unpaid'].includes(sub.status)) {
          const subs = await base44.asServiceRole.entities.Subscriber.filter({ stripe_customer_id: custId });
          if (subs.length > 0) {
            const subscriber = subs[0];
            await base44.asServiceRole.entities.Subscriber.update(subscriber.id, {
              status: sub.status === 'unpaid' ? 'past_due' : 'cancelled',
              access_active: false,
            });

            if (sub.status === 'canceled' && botToken && channelId && subscriber.telegram_user_id) {
              await removeTelegramUser(botToken, channelId, subscriber.telegram_user_id);
            }
          }
        }
        break;
      }

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    return Response.json({ received: true });

  } catch (err) {
    console.error('Webhook handler error:', err);
    return Response.json({ error: 'Handler failed' }, { status: 500 });
  }
});

// ── HELPERS ──────────────────────────────────────────────────

async function stripeGet(path: string, key: string) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    headers: { 'Authorization': `Bearer ${key}` }
  });
  return res.json();
}

async function createTelegramInvite(token: string, chatId: string, customerId: string): Promise<string> {
  const expireDate = Math.floor(Date.now() / 1000) + (15 * 60); // 15 min
  const res = await fetch(`https://api.telegram.org/bot${token}/createChatInviteLink`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      name: `stripe_${customerId}`,
      expire_date: expireDate,
      member_limit: 1,
    })
  });
  const data = await res.json();
  if (!data.ok) {
    console.error('Telegram invite error:', JSON.stringify(data));
    return '';
  }
  return data.result.invite_link || '';
}

async function removeTelegramUser(token: string, chatId: string, userId: string | number): Promise<void> {
  // Ban (removes from channel)
  await fetch(`https://api.telegram.org/bot${token}/banChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, user_id: userId })
  });
  // Immediately unban so they can rejoin if they resubscribe
  await fetch(`https://api.telegram.org/bot${token}/unbanChatMember`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, user_id: userId, only_if_banned: true })
  });
  console.log(`👋 Removed from Telegram: ${userId}`);
}

// ── STRIPE WEBHOOK SIGNATURE VERIFICATION ────────────────────
async function verifyStripeWebhook(payload: string, sig: string, secret: string): Promise<any> {
  const parts    = sig.split(',');
  const tsPart   = parts.find(p => p.startsWith('t='));
  const v1Part   = parts.find(p => p.startsWith('v1='));

  if (!tsPart || !v1Part) throw new Error('Invalid signature format');

  const timestamp = tsPart.substring(2);
  const expected  = v1Part.substring(3);
  const signed    = `${timestamp}.${payload}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signed));
  const computed  = Array.from(new Uint8Array(signature))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (computed !== expected) throw new Error('Signature mismatch');

  // Replay protection: reject events older than 5 minutes
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp);
  if (age > 300) throw new Error('Webhook timestamp too old');

  return JSON.parse(payload);
}
