/**
 * Cloudflare Pages Function — POST /api/coaching-signup
 *
 * Receives coaching form submissions, forwards to Google Sheets,
 * sends notification email to coach, and (for beginners) sends
 * the training plan PDF to the user via Resend.
 *
 * Environment variables (set in Cloudflare Pages dashboard):
 *   GOOGLE_SCRIPT_URL   — Google Apps Script web app URL for Sheets
 *   RESEND_API_KEY      — Resend API key
 *   FROM_EMAIL          — Verified sender email on Resend
 *   COACH_EMAIL         — Coach notification email (default: letustalkrunning@gmail.com)
 */

export async function onRequestPost(context) {
  const COACH_EMAIL  = context.env.COACH_EMAIL  || 'letustalkrunning@gmail.com';
  const RESEND_KEY   = context.env.RESEND_API_KEY;
  const FROM_EMAIL   = context.env.FROM_EMAIL || 'onboarding@resend.dev';
  const SHEETS_URL   = context.env.GOOGLE_SCRIPT_URL;

  try {
    const data = await context.request.json();

    // Validate required fields
    if (!data.name || !data.email || !data.phone || !data.plan_tier) {
      return jsonResponse({ error: 'Missing required fields: name, email, phone, plan_tier' }, 400);
    }

    if (!data.submitted_at) data.submitted_at = new Date().toISOString();

    // ── 1. Forward to Google Sheets via Apps Script ────────────────────
    if (SHEETS_URL) {
      context.waitUntil(
        fetch(SHEETS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        }).catch(err => console.warn('Sheets error:', err.message))
      );
    }

    // ── 2. Send coach notification email ──────────────────────────────
    if (RESEND_KEY) {
      context.waitUntil(
        sendCoachNotification(RESEND_KEY, FROM_EMAIL, COACH_EMAIL, data)
          .catch(err => console.warn('Coach email error:', err.message))
      );
    }

    // ── 3. For beginner plans, email the PDF to the user ──────────────
    if (RESEND_KEY && data.plan_tier === 'beginner' && data.plan_distance) {
      context.waitUntil(
        sendBeginnerPlanEmail(RESEND_KEY, FROM_EMAIL, data)
          .catch(err => console.warn('User email error:', err.message))
      );
    }

    return jsonResponse({
      success: true,
      message: data.plan_tier === 'beginner'
        ? 'Your training plan is on its way!'
        : 'We will be in touch soon to schedule your consultation.',
    });

  } catch (err) {
    return jsonResponse({ error: 'Failed to process sign-up. Please try again.' }, 500);
  }
}

// ── CORS preflight ──────────────────────────────────────────────────────────
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function sendCoachNotification(apiKey, from, to, data) {
  const rows = Object.entries(data)
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;font-weight:bold;vertical-align:top;">${esc(k)}</td><td style="padding:4px 0;">${esc(String(v))}</td></tr>`)
    .join('');

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `New ${data.plan_tier.toUpperCase()} coaching signup: ${data.name}`,
      html: `<h2>New Coaching Sign-Up</h2><table style="border-collapse:collapse;">${rows}</table>`,
    }),
  });
}

async function sendBeginnerPlanEmail(apiKey, from, data) {
  const firstName = data.name.split(' ')[0];
  const dist = data.plan_distance;

  // Try to fetch the PDF from /plans/ on the same origin
  let attachments = [];
  const pdfFilename = `LTR-${dist}-Training-Plan.pdf`;
  try {
    const pdfUrl = new URL(`/plans/${pdfFilename}`, 'https://letstalkrunning.com').href;
    const pdfRes = await fetch(pdfUrl);
    if (pdfRes.ok) {
      const buf = await pdfRes.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      attachments = [{ filename: pdfFilename, content: base64 }];
    }
  } catch {}

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [data.email],
      subject: `Your ${dist} Training Plan from Let's Talk Running`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
          <h2 style="color:#0F172A;">Hey ${esc(firstName)}! 🏃</h2>
          <p>Thanks for signing up! ${attachments.length > 0
            ? `Your <strong>${esc(dist)} training plan</strong> is attached to this email.`
            : `Your <strong>${esc(dist)} training plan</strong> is being prepared — we'll send it to you shortly.`
          }</p>
          <p>A few tips to get started:</p>
          <ul>
            <li>Start slow — the first two weeks are about building the habit</li>
            <li>Don't skip rest days — they're where the magic happens</li>
            <li>Hydrate well and fuel your runs properly</li>
          </ul>
          <p>Happy running!<br><strong>Team Let's Talk Running</strong></p>
          <hr style="border:none;border-top:1px solid #e2e8f0;margin:1.5rem 0;">
          <p style="font-size:12px;color:#94a3b8;">
            <a href="https://letstalkrunning.com" style="color:#E85D04;">letstalkrunning.com</a>
          </p>
        </div>
      `,
      attachments,
    }),
  });
}

function esc(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
