// ============================================================
// createCheckoutSession.ts
// StrikeMind Signals™ — Stripe Checkout Function
// Deploy this inside your Base44 app backend
// ============================================================

import { createClientFromRequest } from 'npm:@base44/sdk@0.8.25';

// ── TIER → STRIPE PRICE ID MAP ──────────────────────────────
// Replace these with your live Stripe Price IDs
const PRICE_IDS: Record<string, string> = {
  brief:     'price_REPLACE_BRIEF',      // $29/mo
  fullstack: 'price_REPLACE_FULLSTACK',  // $49/mo
  fire:      'price_REPLACE_FIRE',       // $99/mo
};

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      }
    });
  }

  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  // ── PARSE BODY ───────────────────────────────────────────
  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid or empty request body' }, { status: 400 });
  }

  const { email, tier, telegramUsername, fullName } = body;

  if (!email || !tier) {
    return Response.json({ error: 'Missing required fields: email and tier' }, { status: 400 });
  }

  const priceId = PRICE_IDS[tier];
  if (!priceId || priceId.startsWith('price_REPLACE')) {
    return Response.json({ error: `Invalid tier or price ID not configured: ${tier}` }, { status: 400 });
  }

  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) {
    return Response.json({ error: 'Stripe not configured' }, { status: 500 });
  }

  try {
    // ── CREATE/FIND STRIPE CUSTOMER ─────────────────────
    const customerSearch = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'&limit=1`,
      {
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        }
      }
    );
    const searchData = await customerSearch.json();
    let customerId: string;

    if (searchData.data && searchData.data.length > 0) {
      customerId = searchData.data[0].id;
    } else {
      // Create new customer
      const createRes = await fetch('https://api.stripe.com/v1/customers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          email,
          name: fullName || '',
          'metadata[telegram_username]': telegramUsername || '',
          'metadata[tier]': tier,
        })
      });
      const newCustomer = await createRes.json();
      customerId = newCustomer.id;
    }

    // ── BASE URL ────────────────────────────────────────
    const origin = req.headers.get('origin') || 'https://vmhgcreative.com';

    // ── CREATE CHECKOUT SESSION ─────────────────────────
    const sessionBody = new URLSearchParams({
      mode: 'subscription',
      customer: customerId,
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      'subscription_data[trial_period_days]': '7',
      'subscription_data[metadata][tier]': tier,
      'subscription_data[metadata][telegram_username]': telegramUsername || '',
      'subscription_data[metadata][full_name]': fullName || '',
      success_url: `${origin}?subscribed=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}?cancelled=true`,
      'metadata[tier]': tier,
      'metadata[telegram_username]': telegramUsername || '',
      'metadata[full_name]': fullName || '',
    });

    const sessionRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: sessionBody
    });

    const session = await sessionRes.json();

    if (!session.url) {
      console.error('Stripe session error:', JSON.stringify(session));
      return Response.json({ error: session.error?.message || 'Failed to create checkout session' }, { status: 500 });
    }

    // ── PRE-CREATE SUBSCRIBER RECORD ────────────────────
    try {
      const base44 = createClientFromRequest(req);
      await base44.asServiceRole.entities.Subscriber.create({
        email,
        full_name: fullName || '',
        telegram_username: telegramUsername || '',
        tier,
        stripe_customer_id: customerId,
        stripe_session_id: session.id,
        status: 'pending',
        access_active: false,
      });
    } catch (dbErr) {
      console.warn('DB pre-create warning (non-blocking):', dbErr);
    }

    return Response.json({ url: session.url }, {
      headers: { 'Access-Control-Allow-Origin': '*' }
    });

  } catch (err) {
    console.error('createCheckoutSession error:', err);
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
});
