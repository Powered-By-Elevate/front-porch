-- Push delivery, v1. The outbox from 0001 gains claim semantics, devices
-- gain a token registry, and pg_cron gains a minute trigger that fires
-- the push-drain edge function through pg_net. Laws that bind this file:
-- pushes are nameless by architecture (PRD §4.4, the server never knows
-- names), and delivery must survive a crashed drain run without ever
-- sending the reveal twice on a healthy one.

create extension if not exists pg_net;

-- Claim semantics on the outbox. claimed_at marks a row some drain run
-- picked up; sent_at stays the terminal marker (delivered, or dead with
-- the reason in error). A claim older than five minutes is presumed
-- crashed and the row is claimable again, so a retryable APNs failure
-- needs no bookkeeping at all: leave the claim, it re-runs itself.
alter table push_queue add column if not exists claimed_at timestamptz;
alter table push_queue add column if not exists error text;

-- One row per device token. A token must be able to change hands (sign
-- out, a handed-down phone), and RLS cannot let the new owner delete the
-- old owner's claim, so the RPCs below are the only doors, same as
-- lights. Tokens die with the profile (real deletes, law 9) and on
-- APNs 410, which the drain function handles service-side.
create table if not exists device_tokens (
  token text primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  platform text not null default 'ios' check (platform in ('ios')),
  updated_at timestamptz not null default now()
);
create index if not exists device_tokens_user on device_tokens (user_id);
alter table device_tokens enable row level security;
-- No client policies. RPC doors only; the drain reads with service role.

create or replace function register_push_token(p_token text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from profiles where id = auth.uid()) then
    raise exception 'no_profile';
  end if;
  if p_token is null or length(p_token) = 0 or length(p_token) > 512 then
    raise exception 'bad_token';
  end if;
  insert into device_tokens (token, user_id)
    values (p_token, auth.uid())
    on conflict (token) do update
      set user_id = excluded.user_id, updated_at = now();
end $$;

create or replace function unregister_push_token(p_token text) returns void
language sql security definer set search_path = public as
$$ delete from device_tokens where token = $1 and user_id = auth.uid() $$;

-- The drain's half, service role only (execute is revoked from clients
-- below). Atomically claims a batch of undelivered, unclaimed (or
-- stale-claimed) rows, prunes delivered rows older than seven days while
-- it is here, and hands back everything the function needs in one trip.
create or replace function claim_push_batch(p_limit int default 100)
returns table (id bigint, user_id uuid, payload jsonb)
language plpgsql security definer set search_path = public as $$
begin
  delete from push_queue q where q.sent_at < now() - interval '7 days';
  return query
  update push_queue q set claimed_at = now()
  where q.id in (
    select b.id from push_queue b
    where b.sent_at is null
      and (b.claimed_at is null or b.claimed_at < now() - interval '5 minutes')
    order by b.id
    limit p_limit
    for update skip locked)
  returning q.id, q.user_id, q.payload;
end $$;

-- Terminal markers. Delivered and dead look the same to the claimer
-- (sent_at set); dead rows carry why, for the operator's eyes only.
create or replace function mark_push_sent(p_ids bigint[]) returns void
language sql security definer set search_path = public as
$$ update push_queue set sent_at = now() where id = any ($1) $$;

create or replace function mark_push_dead(p_id bigint, p_error text) returns void
language sql security definer set search_path = public as
$$ update push_queue set sent_at = now(), error = left($2, 200) where id = $1 $$;

-- The drain function deletes 410/BadDeviceToken tokens itself via this
-- door rather than raw table access, so every write path stays named.
create or replace function drop_push_tokens(p_tokens text[]) returns void
language sql security definer set search_path = public as
$$ delete from device_tokens where token = any ($1) $$;

revoke execute on function claim_push_batch(int) from public, anon, authenticated;
revoke execute on function mark_push_sent(bigint[]) from public, anon, authenticated;
revoke execute on function mark_push_dead(bigint, text) from public, anon, authenticated;
revoke execute on function drop_push_tokens(text[]) from public, anon, authenticated;

-- The minute trigger. Reads the deployed function's URL and shared
-- secret from app_config (service-role-only table from 0001) and no-ops
-- until BOTH rows exist, so this migration is safe to run before the
-- function is deployed. Runbook: after `supabase functions deploy
-- push-drain --no-verify-jwt`, insert app_config keys 'push_drain_url'
-- (the function's invoke URL) and 'push_drain_secret' (same value set as
-- the function's DRAIN_SECRET). A minute of drain lag hides entirely
-- inside the randomized 2-30 minute reveal delay.
create or replace function _fire_push_drain() returns void
language plpgsql security definer set search_path = public as $$
declare v_url text; v_secret text;
begin
  select value into v_url from app_config where key = 'push_drain_url';
  select value into v_secret from app_config where key = 'push_drain_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(
    url := v_url,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_secret,
      'Content-Type', 'application/json'),
    body := '{}'::jsonb);
end $$;

select cron.schedule('front-porch-push-drain', '* * * * *', $$select _fire_push_drain()$$);
