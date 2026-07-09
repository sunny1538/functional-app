// supabase/functions/verify-payment/index.ts
//
// Called by the customer app right after Razorpay Checkout succeeds
// (in the "handler" callback). Verifies the payment signature
// server-side, then creates the real order via finalize_paid_order().
//
// Deploy: supabase functions deploy verify-payment
// Secrets needed: RAZORPAY_KEY_SECRET (same one as create-payment-order)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ▼▼▼ Set with: supabase secrets set RAZORPAY_KEY_SECRET=... (same value as before) ▼▼▼
const RAZORPAY_KEY_SECRET = Deno.env.get('RAZORPAY_KEY_SECRET')!
// ▲▲▲

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = await req.json()
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return new Response(JSON.stringify({ error: 'MISSING_FIELDS' }), { status: 400, headers: cors })
    }

    // Razorpay's documented signature check: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
    const expected = await hmacHex(RAZORPAY_KEY_SECRET, `${razorpay_order_id}|${razorpay_payment_id}`)
    if (expected !== razorpay_signature) {
      return new Response(JSON.stringify({ error: 'SIGNATURE_MISMATCH' }), { status: 400, headers: cors })
    }

    const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

    const { data: intent } = await sb.from('payment_intents').select('id').eq('razorpay_order_id', razorpay_order_id).maybeSingle()
    if (!intent) return new Response(JSON.stringify({ error: 'INTENT_NOT_FOUND' }), { status: 404, headers: cors })

    const { data: order, error } = await sb.rpc('finalize_paid_order', {
      p_intent_id: intent.id,
      p_razorpay_payment_id: razorpay_payment_id,
    })
    if (error) {
      return new Response(JSON.stringify({ error: 'FINALIZE_FAILED', detail: error.message }), { status: 500, headers: cors })
    }

    return new Response(JSON.stringify({ success: true, order }), { headers: { ...cors, 'Content-Type': 'application/json' } })

  } catch (e) {
    return new Response(JSON.stringify({ error: 'SERVER_ERROR', detail: String(e) }), { status: 500, headers: cors })
  }
})
