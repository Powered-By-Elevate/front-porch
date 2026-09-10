-- Front Porch engine, v1. The whole product is this file plus RLS.
-- Laws it implements come from os-vault/wiki/projects/front-porch.md §3 + §4:
--   a light is a row (existence = on), real 10s after flip, invisible to
--   everyone but its owner, the lock is irreversible, reveal is delayed
--   2-30 min and simultaneous, connections live 48h then force both
--   lights off, lights never expire on their own.

create extension if not exists pgcrypto;
create extension if not exists pg_cron;

-- Publishable pepper for phone hashing. It ships in the client bundle too
-- (client hashes the address book with the same value), so it defeats
-- precomputed tables, not a determined attacker. PRD law 7 says this out loud.
create table if not exists app_config (
  key text primary key,
  value text not null
);
insert into app_config (key, value)
  values ('phone_pepper', 'front-porch-v1-pepper')
  on conflict (key) do nothing;

create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  phone_hash text not null unique,
  dob date not null,
  hide_me boolean not null default false,
  created_at timestamptz not null default now()
);

-- Row existence = light on. Unflip = delete. No TTL anywhere (§4.8).
create table if not exists lights (
  owner_id uuid not null references profiles (id) on delete cascade,
  target_hash text not null,
  flipped_at timestamptz not null default now(),
  real_at timestamptz not null default now() + interval '10 seconds',
  primary key (owner_id, target_hash)
);

create table if not exists blocks (
  blocker_id uuid not null references profiles (id) on delete cascade,
  blocked_hash text not null,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_hash)
);

-- a_id < b_id always, enforced, so the pair has one canonical row.
create table if not exists connections (
  id uuid primary key default gen_random_uuid(),
  a_id uuid not null references profiles (id) on delete cascade,
  b_id uuid not null references profiles (id) on delete cascade,
  locked_at timestamptz not null default now(),
  reveal_at timestamptz not null,
  ends_at timestamptz not null,
  state text not null default 'locked' check (state in ('locked', 'open', 'expired')),
  check (a_id < b_id)
);
create unique index if not exists connections_one_live_per_pair
  on connections (a_id, b_id) where state <> 'expired';

-- Server-side outbox; a scheduled edge function drains it to APNs.
create table if not exists push_queue (
  id bigint generated always as identity primary key,
  user_id uuid not null references profiles (id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

alter table profiles enable row level security;
alter table lights enable row level security;
alter table blocks enable row level security;
alter table connections enable row level security;
alter table push_queue enable row level security;
alter table app_config enable row level security;

create policy profiles_own on profiles
  for all using (id = auth.uid()) with check (id = auth.uid());

-- The invisibility law at the database layer: nobody can ever select
-- another person's lights, and clients cannot write lights directly at
-- all (the RPCs below are the only door, so the cap and the 10-second
-- semantics cannot be bypassed).
create policy lights_own_read on lights
  for select using (owner_id = auth.uid());

create policy blocks_own on blocks
  for all using (blocker_id = auth.uid()) with check (blocker_id = auth.uid());

-- Participants see a connection only once it is OPEN. A locked,
-- unrevealed connection is invisible even to the two people in it,
-- which is what makes the 2-30 minute delay real (§4.3).
create policy connections_open_visible on connections
  for select using (state = 'open' and (a_id = auth.uid() or b_id = auth.uid()));

-- push_queue and app_config: no client policies. Service role only.

create or replace function _pepper() returns text
language sql stable security definer set search_path = public as
$$ select value from app_config where key = 'phone_pepper' $$;

create or replace function _hash_phone(p text) returns text
language sql stable security definer set search_path = public as
$$ select encode(digest(_pepper() || p, 'sha256'), 'hex') $$;

-- First-login profile creation. DOB is enforced server-side: v1 is 18+
-- (front-porch.md §6). The client gate is UX, this is the wall.
create or replace function ensure_profile(p_dob date) returns void
language plpgsql security definer set search_path = public as $$
declare v_phone text;
begin
  select phone into v_phone from auth.users where id = auth.uid();
  if v_phone is null or v_phone = '' then
    raise exception 'no_phone_identity';
  end if;
  if p_dob > (current_date - interval '18 years') then
    raise exception 'underage';
  end if;
  insert into profiles (id, phone_hash, dob)
    values (auth.uid(), _hash_phone(v_phone), p_dob)
    on conflict (id) do nothing;
end $$;

-- The only way a light turns on. Enforces: profile exists, cap of 10,
-- no self-light, not a hash the owner has blocked. real_at lands 10
-- seconds out by column default: an unset within 10 seconds deletes the
-- row before it was ever eligible, so it never existed (§4.1).
create or replace function set_light(p_target_hash text) returns void
language plpgsql security definer set search_path = public as $$
declare v_own_hash text;
begin
  select phone_hash into v_own_hash from profiles where id = auth.uid();
  if v_own_hash is null then raise exception 'no_profile'; end if;
  if p_target_hash = v_own_hash then raise exception 'self_light'; end if;
  if exists (select 1 from blocks where blocker_id = auth.uid() and blocked_hash = p_target_hash) then
    raise exception 'blocked_target';
  end if;
  if (select count(*) from lights where owner_id = auth.uid()) >= 10 then
    raise exception 'light_cap';
  end if;
  insert into lights (owner_id, target_hash)
    values (auth.uid(), p_target_hash)
    on conflict (owner_id, target_hash) do nothing;
end $$;

-- Unflip: hard delete, no trace (§3 law 2). A lock that already
-- happened lives in connections and is untouched by this (§4.2).
create or replace function unset_light(p_target_hash text) returns void
language sql security definer set search_path = public as
$$ delete from lights where owner_id = auth.uid() and target_hash = $1 $$;

-- Which of my contacts are on Front Porch (hide_me respected). Input is
-- hashes computed on device: names and raw numbers never arrive here.
create or replace function sync_contacts(p_hashes text[]) returns table (on_hash text)
language sql stable security definer set search_path = public as $$
  select p.phone_hash from profiles p
  where p.phone_hash = any (p_hashes) and p.hide_me = false
$$;

-- My open connections, shaped for the client: it knows contacts by phone
-- hash (names never leave the device), so the other party arrives as a
-- hash the address book resolves locally. Only 'open' rows exist here,
-- which keeps the pre-reveal invisibility (§4.3) even for direct callers.
create or replace function my_connections()
returns table (id uuid, other_hash text, ends_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.id,
         p.phone_hash,
         c.ends_at
  from connections c
  join profiles p on p.id = case when c.a_id = auth.uid() then c.b_id else c.a_id end
  where c.state = 'open' and (c.a_id = auth.uid() or c.b_id = auth.uid())
$$;

create or replace function set_hide_me(p_hide boolean) returns void
language sql security definer set search_path = public as
$$ update profiles set hide_me = $1 where id = auth.uid() $$;

-- Block: absolute (§3 law 8). Dissolves any live connection with that
-- person quietly and puts both pair lights out.
create or replace function block_hash(p_hash text) returns void
language plpgsql security definer set search_path = public as $$
declare v_other uuid; v_me uuid := auth.uid(); v_my_hash text;
begin
  insert into blocks (blocker_id, blocked_hash) values (v_me, p_hash)
    on conflict do nothing;
  delete from lights where owner_id = v_me and target_hash = p_hash;
  select id into v_other from profiles where phone_hash = p_hash;
  if v_other is not null then
    select phone_hash into v_my_hash from profiles where id = v_me;
    delete from lights where owner_id = v_other and target_hash = v_my_hash;
    update connections set state = 'expired'
      where state <> 'expired'
        and ((a_id = least(v_me, v_other) and b_id = greatest(v_me, v_other)));
  end if;
end $$;

-- Real deletes (§3 law 9). App-table purge; the auth.users row itself is
-- removed by the delete-account edge function (same pattern Sunday's
-- Supper shipped for App Review 5.1.1(v)).
create or replace function purge_me() returns void
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_my_hash text;
begin
  select phone_hash into v_my_hash from profiles where id = v_me;
  update connections set state = 'expired'
    where state <> 'expired' and (a_id = v_me or b_id = v_me);
  delete from lights where owner_id = v_me;
  delete from lights where target_hash = v_my_hash;
  delete from profiles where id = v_me;
end $$;

-- THE TICK. pg_cron runs this every minute. Three passes: lock, reveal,
-- expire. A minute of lag on real_at is invisible behind the randomized
-- reveal delay, and the 10-second rule is enforced by timestamp
-- comparison, not by scheduling precision.
create or replace function engine_tick() returns void
language plpgsql security definer set search_path = public as $$
begin
  -- LOCK: both lights on and real, both adults with profiles, neither
  -- blocks the other, no live connection. reveal_at = now + 2..30 min.
  insert into connections (a_id, b_id, reveal_at, ends_at)
  select pa.id, pb.id,
         now() + make_interval(secs => d.secs),
         now() + make_interval(secs => d.secs) + interval '48 hours'
  from lights la
  join profiles pa on pa.id = la.owner_id
  join profiles pb on pb.phone_hash = la.target_hash
  join lights lb on lb.owner_id = pb.id and lb.target_hash = pa.phone_hash
  cross join lateral (select 120 + floor(random() * 1680) as secs) d
  where la.real_at <= now() and lb.real_at <= now()
    and not exists (select 1 from blocks x where x.blocker_id = pa.id and x.blocked_hash = pb.phone_hash)
    and not exists (select 1 from blocks x where x.blocker_id = pb.id and x.blocked_hash = pa.phone_hash)
    and pa.id < pb.id
  on conflict (a_id, b_id) where state <> 'expired' do nothing;

  -- REVEAL: simultaneous, nameless push (the server never knows names,
  -- so the blessed name copy renders in-app where the address book is).
  with due as (
    update connections set state = 'open'
    where state = 'locked' and reveal_at <= now()
    returning a_id, b_id
  )
  insert into push_queue (user_id, payload)
  select u, jsonb_build_object(
    'title', 'Both lights are on.',
    'body', 'Someone you left the light on for left theirs on for you. You have 48 hours.')
  from due cross join lateral (values (due.a_id), (due.b_id)) t(u);

  -- EXPIRE: force both lights off, fully neutral, no pushes (§4.6).
  with done as (
    update connections set state = 'expired'
    where state = 'open' and ends_at <= now()
    returning a_id, b_id
  )
  delete from lights l using done d,
    profiles pa, profiles pb
  where pa.id = d.a_id and pb.id = d.b_id
    and ((l.owner_id = d.a_id and l.target_hash = pb.phone_hash)
      or (l.owner_id = d.b_id and l.target_hash = pa.phone_hash));
end $$;

select cron.schedule('front-porch-engine-tick', '* * * * *', $$select engine_tick()$$);
