// supabase/functions/razorpay-webhook/index.ts
//
// Server-to-server backup. Even if the customer closes the browser
// right after paying (before verify-payment runs), Razorpay still
// calls this URL directly, so the order still gets created.
// Safe to run twice — finalize_paid_order() is idempotent.
//
// Deploy: supabase functions deploy razorpay-webhook --no-verify-jwt
//   (--no-verify-jwt is required — Razorpay can't send a Supabase auth header)
//
// Then in Razorpay Dashboard → Settings → Webhooks:
//   URL: https://<your-project-ref>.supabase.co/functions/v1/razorpay-webhook
//   Active events: payment.captured
//   Secret: set your own string here, then also save it as RAZORPAY_WEBHOOK_SECRET below
//
// Secrets needed: RAZORPAY_WEBHOOK_SECRET

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ▼▼▼ Set with: supabase secrets set RAZORPAY_WEBHOOK_SECRET=... (the secret you typed into Razorpay's webhook settings) ▼▼▼
const RAZORPAY_WEBHOOK_SECRET = Deno.env.get('RAZORPAY_WEBHOOK_SECRET')!
// ▲▲▲

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

async function hmacHex(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  try {
    const rawBody = await req.text()
    const signature = req.headers.get('x-razorpay-signature') || ''

    const expected = await hmacHex(RAZORPAY_WEBHOOK_SECRET, rawBody)
    if (expected !== signature) {
      return new Response('Invalid signature', { status: 400 })
    }

    const event = JSON.parse(rawBody)

    if (event.event === 'payment.captured') {
      const payment = event.payload.payment.entity
      const razorpay_order_id = payment.order_id
      const razorpay_payment_id = payment.id

      const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
      const { data: intent } = await sb.from('payment_intents').select('id').eq('razorpay_order_id', razorpay_order_id).maybeSingle()
      if (intent) {
        await sb.rpc('finalize_paid_order', { p_intent_id: intent.id, p_razorpay_payment_id })
      }
    }

    return new Response('ok', { status: 200 })
  } catch (e) {
    return new Response('error: ' + String(e), { status: 500 })
  }
})
