// The drain. pg_cron fires this every minute through pg_net (migration
// 0003, _fire_push_drain), it claims a batch from push_queue, sends each
// row to every device token its user holds, and marks outcomes. Crash
// anywhere and the claim expires in five minutes, so nothing is lost and
// a healthy run never sends twice.
//
// Deploy: supabase functions deploy push-drain --no-verify-jwt
// Secrets: DRAIN_SECRET (same value as app_config push_drain_secret),
// APNS_TEAM_ID, APNS_KEY_ID, APNS_KEY_P8 (the .p8 file's PEM text),
// APNS_TOPIC (defaults to the bundle id), APNS_ENV (sandbox|production,
// defaults sandbox).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { alertBody, apnsHeaders, apnsHost, apnsJwt, classifyApns } from './apns.ts';

type QueueRow = { id: number; user_id: string; payload: { title?: string; body?: string } };

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('DRAIN_SECRET') ?? '';
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return new Response('forbidden', { status: 403 });
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  );

  const { data: batch, error: claimErr } = await sb.rpc('claim_push_batch', { p_limit: 100 });
  if (claimErr) return json({ error: claimErr.message }, 500);
  const rows = (batch ?? []) as QueueRow[];
  if (rows.length === 0) return json({ claimed: 0 });

  const userIds = [...new Set(rows.map((r) => r.user_id))];
  const { data: tokenRows, error: tokErr } = await sb
    .from('device_tokens')
    .select('user_id, token')
    .in('user_id', userIds);
  if (tokErr) return json({ error: tokErr.message }, 500);
  const tokensByUser = new Map<string, string[]>();
  for (const t of tokenRows ?? []) {
    const list = tokensByUser.get(t.user_id) ?? [];
    list.push(t.token);
    tokensByUser.set(t.user_id, list);
  }

  const jwt = await apnsJwt(
    Deno.env.get('APNS_KEY_P8') ?? '',
    Deno.env.get('APNS_KEY_ID') ?? '',
    Deno.env.get('APNS_TEAM_ID') ?? '',
  );
  const host = apnsHost(Deno.env.get('APNS_ENV') ?? 'sandbox');
  const headers = apnsHeaders(jwt, Deno.env.get('APNS_TOPIC') ?? 'com.poweredbyelevate.both');

  const sentIds: number[] = [];
  const goneTokens = new Set<string>();
  const deadRows: { id: number; reason: string }[] = [];
  let authBroken = false;
  let retrying = 0;

  for (const row of rows) {
    if (authBroken) break; // leave the rest claimed; next tick retries
    const tokens = tokensByUser.get(row.user_id) ?? [];
    if (tokens.length === 0) {
      deadRows.push({ id: row.id, reason: 'no_device' });
      continue;
    }
    let okAny = false;
    let retryAny = false;
    let lastReason = 'unregistered';
    for (const token of tokens) {
      const res = await fetch(`${host}/3/device/${token}`, {
        method: 'POST',
        headers,
        body: alertBody(row.payload ?? {}),
      }).catch(() => null);
      if (res === null) {
        retryAny = true; // network blip, claim expiry retries it
        continue;
      }
      let reason: string | undefined;
      if (res.status !== 200) {
        reason = (await res.json().catch(() => ({})) as { reason?: string }).reason;
      } else {
        await res.body?.cancel();
      }
      const outcome = classifyApns(res.status, reason);
      if (outcome === 'ok') okAny = true;
      else if (outcome === 'gone') goneTokens.add(token);
      else if (outcome === 'auth') {
        authBroken = true;
        retryAny = true;
        break;
      } else if (outcome === 'retry') retryAny = true;
      else lastReason = reason ?? `status_${res.status}`;
    }
    if (okAny) sentIds.push(row.id);
    else if (retryAny) retrying++;
    else deadRows.push({ id: row.id, reason: lastReason });
  }

  if (sentIds.length > 0) await sb.rpc('mark_push_sent', { p_ids: sentIds });
  if (goneTokens.size > 0)
    await sb.rpc('drop_push_tokens', { p_tokens: [...goneTokens] });
  for (const d of deadRows) {
    await sb.rpc('mark_push_dead', { p_id: d.id, p_error: d.reason });
  }

  return json({
    claimed: rows.length,
    sent: sentIds.length,
    dead: deadRows.length,
    retrying,
    dropped_tokens: goneTokens.size,
    auth_broken: authBroken,
  });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
