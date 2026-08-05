'use strict';

const crypto = require('crypto');

/**
 * GitHub webhook receiver.
 *
 * Polling every 30 minutes means a critical alert can sit unseen for 29 of
 * them. GitHub will push `dependabot_alert` and `pull_request` events the
 * moment they happen, which is both faster and cheaper than polling harder.
 *
 * Requires the box to be reachable from GitHub (a tunnel or port forward) and
 * a shared secret — unsigned requests are rejected outright.
 */

const HANDLED_EVENTS = new Set([
  'dependabot_alert',
  'pull_request',
  'code_scanning_alert',
  'secret_scanning_alert',
  'repository'
]);

/**
 * Constant-time check of the `x-hub-signature-256` header against the body.
 * Returns false rather than throwing for every failure mode, so a malformed
 * signature is indistinguishable from a wrong one.
 */
function verifySignature(rawBody, signature, secret) {
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

/** The repository a payload refers to, or null if it names none. */
function repoFromPayload(payload) {
  return payload?.repository?.full_name || null;
}

/**
 * Decide what a delivery means for our cached state.
 *
 * Rather than hand-merging each payload shape into the posture object — which
 * would need a parallel implementation of everything the collector does — a
 * relevant event re-collects that single repo. One repo costs a handful of
 * requests and keeps exactly one code path building postures.
 */
function planForEvent(event, payload) {
  if (event === 'ping') return { action: 'ack', reason: 'ping' };
  if (!HANDLED_EVENTS.has(event)) return { action: 'ignore', reason: `unhandled event: ${event}` };

  const repo = repoFromPayload(payload);
  if (!repo) return { action: 'ignore', reason: 'no repository in payload' };

  // A deleted repo can't be re-collected; drop it instead.
  if (event === 'repository' && payload.action === 'deleted') {
    return { action: 'drop', repo, reason: 'repository deleted' };
  }
  return { action: 'recollect', repo, reason: `${event}.${payload.action || 'event'}` };
}

/** Express handler factory. Expects the route to be mounted with a raw body parser. */
function createWebhookHandler(collector, config) {
  return async function handleWebhook(req, res) {
    if (!config.webhookSecret) {
      return res.status(503).json({
        error: 'Webhook not configured',
        hint: 'Set GH_WEBHOOK_SECRET to the secret you configured on the GitHub webhook.'
      });
    }
    if (!verifySignature(req.body, req.get('x-hub-signature-256'), config.webhookSecret)) {
      return res.status(401).json({ error: 'Bad signature' });
    }

    let payload;
    try {
      payload = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const event = req.get('x-github-event') || 'unknown';
    const plan = planForEvent(event, payload);

    // Answer GitHub immediately; a slow re-collect must not time out the hook.
    res.json({ ok: true, event, ...plan });

    try {
      if (plan.action === 'recollect') await collector.recollectRepo(plan.repo);
      else if (plan.action === 'drop') collector.dropRepo(plan.repo);
    } catch (e) {
      console.warn(`[webhook] ${event} for ${plan.repo} failed:`, e.message);
    }
  };
}

module.exports = { verifySignature, planForEvent, createWebhookHandler, HANDLED_EVENTS };
