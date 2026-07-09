// supabase/functions/create-payment-order/index.ts
//
// Called by the customer app when they hit "Pay Now" at checkout.
// - Verifies the customer's session token
// - Recalculates the cart total from the DB (never trusts client price)
// - Creates a Razorpay order and a matching payment_intents row
// - Returns just enough info for the browser to open Razorpay Checkout
//
// Deploy: supabase functions deploy create-payment-order
// Secrets needed (set once, see bottom of this file for the command):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ▼▼▼ PASTE NOTHING HERE — these come from Supabase secrets, not code ▼▼▼
const RAZORPAY_KEY_ID = Deno.env.get('RAZORPAY_KEY_ID')!
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET')!
// ▲▲▲ Set these with: supabase secrets set RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... ▲▲▲

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')! // auto-provided by Supabase, no need to set

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { token, items, address, lat, lng } = await req.json()

    if (!token || !Array.isArray(items) || !items.length || !address) {
      return new Response(JSON.stringify({ error: 'MISSING_FIELDS' }), { status: 400, headers: cors })
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    // 1. Validate session -> get real customer_id (never trust a client-supplied id)
    const { data: customerId, error: sessErr } = await sb.rpc('check_session', { p_token: token, p_role: 'customer' })
    if (sessErr || !customerId) {
      return new Response(JSON.stringify({ error: 'INVALID_SESSION' }), { status: 401, headers: cors })
    }

    // 2. Rate limit — stop a script from spamming Razorpay orders
    //    (max 8 payment attempts per customer per 5 minutes)
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { count } = await sb
      .from('payment_intents')
      .select('id', { count: 'exact', head: true })
      .eq('customer_id', customerId)
      .gte('created_at', fiveMinAgo)
    if ((count ?? 0) >= 8) {
      return new Response(JSON.stringify({ error: 'TOO_MANY_ATTEMPTS' }), { status: 429, headers: cors })
    }

    // 3. Recompute price from the DB — item ids/qty only, price is looked up fresh
    let subtotal = 0
    for (const line of items) {
      const { data: item } = await sb.from('menu_items').select('*').eq('id', line.id).eq('active', true).maybeSingle()
      if (!item) return new Response(JSON.stringify({ error: `ITEM_NOT_FOUND:${line.id}` }), { status: 400, headers: cors })
      if (item.oos) return new Response(JSON.stringify({ error: `OUT_OF_STOCK:${item.name}` }), { status: 400, headers: cors })
      subtotal += item.price * line.qty
    }
    if (subtotal <= 0) return new Response(JSON.stringify({ error: 'EMPTY_CART' }), { status: 400, headers: cors })
    const tax = Math.round(subtotal * 0.05)
    const totalPaise = (subtotal + tax) * 100

    // 4. Create the Razorpay order
    const rpRes = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Basic ' + btoa(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`),
      },
      body: JSON.stringify({ amount: totalPaise, currency: 'INR', receipt: crypto.randomUUID() }),
    })
    const rpOrder = await rpRes.json()
    if (!rpRes.ok) {
      return new Response(JSON.stringify({ error: 'RAZORPAY_ERROR', detail: rpOrder }), { status: 500, headers: cors })
    }

    // 5. Remember what this order was for, so we can create it for real once payment succeeds
    const { error: insErr } = await sb.from('payment_intents').insert({
      customer_id: customerId,
      items,
      address,
      lat: lat ?? null,
      lng: lng ?? null,
      amount: totalPaise,
      razorpay_order_id: rpOrder.id,
    })
    if (insErr) {
      return new Response(JSON.stringify({ error: 'DB_ERROR', detail: insErr.message }), { status: 500, headers: cors })
    }

    return new Response(JSON.stringify({
      razorpay_order_id: rpOrder.id,
      amount: totalPaise,
      currency: 'INR',
      key_id: RAZORPAY_KEY_ID, // this one is PUBLIC by design — Razorpay's own checkout.js needs it client-side
    }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (e) {
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', detail: String(e) }), { status: 500, headers: cors })
  }
})
