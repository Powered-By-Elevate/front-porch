// Real deletes, all the way down (PRD law 9, App Review 5.1.1(v)). The
// client's purge_me RPC scrubs every app table but cannot touch
// auth.users, so this function finishes the job: purge as the caller,
// then remove the auth user itself with the service role. Same pattern
// Sunday's Supper shipped.
//
// Deploy: supabase functions deploy delete-account
// (JWT verification stays ON, the default: Supabase refuses anonymous
// calls before this code runs. No extra secrets needed.)

import { createClient } from 'npm:@supabase/supabase-js@2';

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) return json({ error: 'unauthorized' }, 401);

  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const asCaller = createClient(url, Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userErr } = await asCaller.auth.getUser();
  const uid = userData?.user?.id;
  if (userErr || !uid) return json({ error: 'unauthorized' }, 401);

  // Purge with the caller's own identity so auth.uid() resolves and the
  // scrub runs exactly as the in-app door does (connections expire and
  // trigger the free/busy scrub, lights pointing AT the user die too,
  // which a bare cascade could never do: target_hash is a hash, not a
  // foreign key).
  const { error: purgeErr } = await asCaller.rpc('purge_me');
  if (purgeErr) return json({ error: purgeErr.message }, 500);

  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
  const { error: delErr } = await admin.auth.admin.deleteUser(uid);
  if (delErr) return json({ error: delErr.message }, 500);

  return json({ deleted: true });
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
