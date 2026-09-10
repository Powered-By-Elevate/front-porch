-- Push delivery smoke test. Run against a scratch Postgres (not production):
--   grep -v -e pg_cron -e cron.schedule ../migrations/20260909210000_0001_engine.sql > /tmp/fp_m1.sql
--   cp ../migrations/20260910140000_0002_make_plans.sql /tmp/fp_m2.sql
--   grep -v -e pg_net -e cron.schedule ../migrations/20260910160000_0003_push_delivery.sql > /tmp/fp_m3.sql
--   createdb fp_push_test && psql -d fp_push_test -f push_smoke.sql

\set ON_ERROR_STOP on
set timezone = 'UTC';
create schema auth;
create table auth.users (id uuid primary key, phone text);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('test.uid', true), '')::uuid $$;
-- Supabase ships these roles; the 0003 revokes reference them.
create role anon nologin;
create role authenticated nologin;

\i /tmp/fp_m1.sql
\i /tmp/fp_m2.sql
\i /tmp/fp_m3.sql

insert into auth.users values
  ('00000000-0000-0000-0000-000000000001', '+14045550101'),
  ('00000000-0000-0000-0000-000000000002', '+14045550102'),
  ('00000000-0000-0000-0000-000000000009', '+14045550109');

set test.uid = '00000000-0000-0000-0000-000000000001';
select ensure_profile('1990-01-01');
set test.uid = '00000000-0000-0000-0000-000000000002';
select ensure_profile('1992-02-02');

\echo === registering without a profile is refused ===
set test.uid = '00000000-0000-0000-0000-000000000009';
do $$ begin
  perform register_push_token('t-orphan');
  raise exception 'FAIL: profileless registration accepted';
exception when others then
  if sqlerrm not like '%no_profile%' then raise; end if;
end $$;

\echo === an empty token is refused ===
set test.uid = '00000000-0000-0000-0000-000000000001';
do $$ begin
  perform register_push_token('');
  raise exception 'FAIL: empty token accepted';
exception when others then
  if sqlerrm not like '%bad_token%' then raise; end if;
end $$;

\echo === register lands one row, re-register refreshes it ===
select register_push_token('token-A');
select register_push_token('token-A');
do $$ begin
  if (select count(*) from device_tokens where token = 'token-A') <> 1 then
    raise exception 'FAIL: expected exactly one row for token-A';
  end if;
  if (select user_id from device_tokens where token = 'token-A')
     <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: token-A not owned by u1';
  end if;
end $$;

\echo === a token changes hands: the new owner takes the row ===
set test.uid = '00000000-0000-0000-0000-000000000002';
select register_push_token('token-A');
do $$ begin
  if (select user_id from device_tokens where token = 'token-A')
     <> '00000000-0000-0000-0000-000000000002' then
    raise exception 'FAIL: token-A did not change hands';
  end if;
  if (select count(*) from device_tokens) <> 1 then
    raise exception 'FAIL: handover duplicated the token row';
  end if;
end $$;

\echo === unregister only removes your own claim ===
set test.uid = '00000000-0000-0000-0000-000000000001';
select unregister_push_token('token-A');
do $$ begin
  if not exists (select 1 from device_tokens where token = 'token-A') then
    raise exception 'FAIL: u1 removed u2''s token';
  end if;
end $$;
set test.uid = '00000000-0000-0000-0000-000000000002';
select unregister_push_token('token-A');
do $$ begin
  if exists (select 1 from device_tokens where token = 'token-A') then
    raise exception 'FAIL: owner unregister did not remove the token';
  end if;
end $$;

\echo === claim takes unclaimed rows once and marks them claimed ===
insert into push_queue (user_id, payload)
select '00000000-0000-0000-0000-000000000001', jsonb_build_object('title', 't', 'body', 'b')
from generate_series(1, 3);
do $$ begin
  if (select count(*) from claim_push_batch(10)) <> 3 then
    raise exception 'FAIL: first claim did not return the 3 rows';
  end if;
  if (select count(*) from push_queue where claimed_at is null) <> 0 then
    raise exception 'FAIL: claim left rows unmarked';
  end if;
  if (select count(*) from claim_push_batch(10)) <> 0 then
    raise exception 'FAIL: fresh claims were claimable again';
  end if;
end $$;

\echo === a stale claim (crashed run) is claimable again ===
update push_queue set claimed_at = now() - interval '6 minutes';
do $$ begin
  if (select count(*) from claim_push_batch(10)) <> 3 then
    raise exception 'FAIL: stale claims were not re-claimable';
  end if;
end $$;

\echo === sent and dead are terminal ===
do $$
declare v_ids bigint[]; v_dead bigint;
begin
  select array_agg(id order by id) into v_ids from push_queue;
  v_dead := v_ids[3];
  perform mark_push_sent(v_ids[1:2]);
  perform mark_push_dead(v_dead, 'no_device');
  update push_queue set claimed_at = now() - interval '6 minutes';
  if (select count(*) from claim_push_batch(10)) <> 0 then
    raise exception 'FAIL: terminal rows were claimed again';
  end if;
  if (select error from push_queue where id = v_dead) <> 'no_device' then
    raise exception 'FAIL: dead row lost its reason';
  end if;
  if (select count(*) from push_queue where sent_at is not null) <> 3 then
    raise exception 'FAIL: terminal marks missing';
  end if;
end $$;

\echo === claim prunes delivered rows older than seven days ===
update push_queue set sent_at = now() - interval '8 days';
do $$ begin
  perform claim_push_batch(10);
  if (select count(*) from push_queue) <> 0 then
    raise exception 'FAIL: old delivered rows survived the prune';
  end if;
end $$;

\echo === the drain token-drop door works ===
set test.uid = '00000000-0000-0000-0000-000000000001';
select register_push_token('token-B');
select register_push_token('token-C');
select drop_push_tokens(array['token-B', 'token-C']);
do $$ begin
  if (select count(*) from device_tokens) <> 0 then
    raise exception 'FAIL: drop_push_tokens left rows behind';
  end if;
end $$;

\echo === tokens die with the profile (law 9) ===
select register_push_token('token-D');
select purge_me();
do $$ begin
  if exists (select 1 from device_tokens where token = 'token-D') then
    raise exception 'FAIL: purge left a device token behind';
  end if;
end $$;

\echo === the drain trigger no-ops with no config (safe pre-deploy) ===
select _fire_push_drain();

\echo ALL PUSH CHECKS PASSED
