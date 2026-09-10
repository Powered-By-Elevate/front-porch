-- Make Plans smoke test. Run against a scratch Postgres (not production):
--   grep -v -e pg_cron -e cron.schedule ../migrations/20260909210000_0001_engine.sql > /tmp/fp_m1.sql
--   cp ../migrations/20260910140000_0002_make_plans.sql /tmp/fp_m2.sql
--   createdb fp_plans_test && psql -d fp_plans_test -f plans_smoke.sql

\set ON_ERROR_STOP on
set timezone = 'UTC';
create schema auth;
create table auth.users (id uuid primary key, phone text);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('test.uid', true), '')::uuid $$;

\i /tmp/fp_m1.sql
\i /tmp/fp_m2.sql

insert into auth.users values
  ('00000000-0000-0000-0000-000000000001', '+14045550101'),
  ('00000000-0000-0000-0000-000000000002', '+14045550102'),
  ('00000000-0000-0000-0000-000000000003', '+14045550103');

set test.uid = '00000000-0000-0000-0000-000000000001';
select ensure_profile('1990-01-01');
set test.uid = '00000000-0000-0000-0000-000000000002';
select ensure_profile('1992-02-02');
set test.uid = '00000000-0000-0000-0000-000000000003';
select ensure_profile('1994-03-03');

-- An open connection between 1 and 2, directly. The lock dance itself is
-- engine_smoke.sql's job.
insert into connections (a_id, b_id, reveal_at, ends_at, state) values
  ('00000000-0000-0000-0000-000000000001',
   '00000000-0000-0000-0000-000000000002',
   now() - interval '1 hour', now() + interval '47 hours', 'open');

\echo === a non-participant is refused every door ===
set test.uid = '00000000-0000-0000-0000-000000000003';
do $$
declare v_conn uuid;
begin
  select id into v_conn from connections limit 1;
  begin
    perform submit_availability(v_conn, '[]'::jsonb);
    raise exception 'FAIL: non-participant submitted';
  exception when others then
    if sqlerrm not like '%no_connection%' then raise; end if;
  end;
  begin
    perform plan_state(v_conn);
    raise exception 'FAIL: non-participant read state';
  exception when others then
    if sqlerrm not like '%no_connection%' then raise; end if;
  end;
end $$;

\echo === bad windows are refused ===
set test.uid = '00000000-0000-0000-0000-000000000001';
do $$
declare v_conn uuid;
begin
  select id into v_conn from connections limit 1;
  begin
    perform submit_availability(v_conn, '{"not":"an array"}'::jsonb);
    raise exception 'FAIL: non-array accepted';
  exception when others then
    if sqlerrm not like '%bad_windows%' then raise; end if;
  end;
end $$;

\echo === user 1 shares. nothing crosses, nothing fires ===
do $$
declare v_conn uuid; v jsonb; d1 timestamptz := date_trunc('day', now()) + interval '1 day';
        d2 timestamptz := date_trunc('day', now()) + interval '2 days';
begin
  select id into v_conn from connections limit 1;
  perform submit_availability(v_conn, jsonb_build_array(
    jsonb_build_object('s', (d1 + interval '18 hours')::text, 'e', (d1 + interval '21 hours')::text),
    jsonb_build_object('s', (d2 + interval '9 hours')::text,  'e', (d2 + interval '11 hours')::text)));
  if (select count(*) from push_queue) <> 0 then
    raise exception 'FAIL: a lone submission pushed';
  end if;
  v := plan_state(v_conn);
  if (v ->> 'mine') <> 'true' or (v ->> 'theirs') <> 'false' then
    raise exception 'FAIL: state after first submission wrong: %', v;
  end if;
  if (v -> 'overlaps') <> 'null'::jsonb then
    raise exception 'FAIL: overlaps visible before both shared';
  end if;
  if jsonb_array_length(v -> 'my_windows') <> 2 then
    raise exception 'FAIL: my_windows not returned';
  end if;
end $$;

\echo === user 2 sees only that, never the windows ===
set test.uid = '00000000-0000-0000-0000-000000000002';
do $$
declare v_conn uuid; v jsonb;
begin
  select id into v_conn from connections limit 1;
  v := plan_state(v_conn);
  if (v ->> 'mine') <> 'false' or (v ->> 'theirs') <> 'true' then
    raise exception 'FAIL: state for the second person wrong: %', v;
  end if;
  if (v -> 'overlaps') <> 'null'::jsonb or (v -> 'my_windows') <> 'null'::jsonb then
    raise exception 'FAIL: something crossed before consent';
  end if;
end $$;

\echo === disjoint share: both in, empty overlap, still no push ===
do $$
declare v_conn uuid; v jsonb; d3 timestamptz := date_trunc('day', now()) + interval '3 days';
begin
  select id into v_conn from connections limit 1;
  perform submit_availability(v_conn, jsonb_build_array(
    jsonb_build_object('s', (d3 + interval '6 hours')::text, 'e', (d3 + interval '7 hours')::text)));
  if (select count(*) from push_queue) <> 0 then
    raise exception 'FAIL: empty overlap pushed';
  end if;
  v := plan_state(v_conn);
  if (v -> 'overlaps') <> '[]'::jsonb then
    raise exception 'FAIL: expected empty overlaps, got %', v -> 'overlaps';
  end if;
end $$;

\echo === reshare that lines up: exact overlap, one push to the waiter ===
do $$
declare v_conn uuid; v jsonb; d1 timestamptz := date_trunc('day', now()) + interval '1 day';
        d3 timestamptz := date_trunc('day', now()) + interval '3 days';
begin
  select id into v_conn from connections limit 1;
  perform submit_availability(v_conn, jsonb_build_array(
    jsonb_build_object('s', (d1 + interval '19 hours 30 minutes')::text, 'e', (d1 + interval '22 hours')::text),
    jsonb_build_object('s', (d3 + interval '6 hours')::text, 'e', (d3 + interval '7 hours')::text)));
  if (select count(*) from push_queue) <> 1 then
    raise exception 'FAIL: expected exactly one lineup push';
  end if;
  if (select user_id from push_queue) <> '00000000-0000-0000-0000-000000000001' then
    raise exception 'FAIL: lineup push went to the wrong person';
  end if;
  if (select payload ->> 'body' from push_queue) not like '%line up%' then
    raise exception 'FAIL: lineup push copy wrong';
  end if;
  v := plan_state(v_conn);
  if jsonb_array_length(v -> 'overlaps') <> 1 then
    raise exception 'FAIL: expected one overlap, got %', v -> 'overlaps';
  end if;
  if (v -> 'overlaps' -> 0 ->> 's')::timestamptz <> d1 + interval '19 hours 30 minutes'
     or (v -> 'overlaps' -> 0 ->> 'e')::timestamptz <> d1 + interval '21 hours' then
    raise exception 'FAIL: overlap bounds wrong: %', v -> 'overlaps';
  end if;
end $$;

\echo === a slot outside the overlap is refused, inside is accepted ===
do $$
declare v_conn uuid; d1 timestamptz := date_trunc('day', now()) + interval '1 day';
begin
  select id into v_conn from connections limit 1;
  begin
    perform propose_plan(v_conn, d1 + interval '19 hours', d1 + interval '20 hours 30 minutes');
    raise exception 'FAIL: slot outside overlap accepted';
  exception when others then
    if sqlerrm not like '%slot_outside_overlap%' then raise; end if;
  end;
  perform propose_plan(v_conn, d1 + interval '19 hours 30 minutes', d1 + interval '21 hours');
  if (select count(*) from plans where state = 'proposed') <> 1 then
    raise exception 'FAIL: proposal missing';
  end if;
  if (select count(*) from push_queue where payload ->> 'body' like '%on the table%'
        and user_id = '00000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FAIL: proposal push missing or misaddressed';
  end if;
end $$;

\echo === the other side counter-proposes, and the proposal flips ===
set test.uid = '00000000-0000-0000-0000-000000000001';
do $$
declare v_conn uuid; v jsonb; d1 timestamptz := date_trunc('day', now()) + interval '1 day';
begin
  select id into v_conn from connections limit 1;
  v := plan_state(v_conn);
  if (v -> 'plan' ->> 'by_me') <> 'false' then
    raise exception 'FAIL: proposal should read by_me false for user 1';
  end if;
  perform propose_plan(v_conn, d1 + interval '20 hours', d1 + interval '21 hours');
  v := plan_state(v_conn);
  if (v -> 'plan' ->> 'by_me') <> 'true'
     or (v -> 'plan' ->> 'starts_at')::timestamptz <> d1 + interval '20 hours' then
    raise exception 'FAIL: counter-proposal did not replace: %', v -> 'plan';
  end if;
  if (select count(*) from plans) <> 1 then
    raise exception 'FAIL: more than one plan per connection';
  end if;
end $$;

\echo === you cannot confirm your own proposal ===
do $$
declare v_conn uuid;
begin
  select id into v_conn from connections limit 1;
  begin
    perform confirm_plan(v_conn);
    raise exception 'FAIL: proposer confirmed their own plan';
  exception when others then
    if sqlerrm not like '%own_proposal%' then raise; end if;
  end;
end $$;

\echo === the other side confirms: terminal, pushed, further moves refused ===
set test.uid = '00000000-0000-0000-0000-000000000002';
do $$
declare v_conn uuid; v jsonb; d1 timestamptz := date_trunc('day', now()) + interval '1 day';
begin
  select id into v_conn from connections limit 1;
  perform confirm_plan(v_conn);
  v := plan_state(v_conn);
  if (v -> 'plan' ->> 'state') <> 'confirmed' then
    raise exception 'FAIL: not confirmed';
  end if;
  if (select count(*) from push_queue where payload ->> 'title' = 'It''s a plan.'
        and user_id = '00000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FAIL: confirm push missing or misaddressed';
  end if;
  begin
    perform propose_plan(v_conn, d1 + interval '20 hours', d1 + interval '21 hours');
    raise exception 'FAIL: proposed over a confirmed plan';
  exception when others then
    if sqlerrm not like '%plan_confirmed%' then raise; end if;
  end;
  begin
    perform submit_availability(v_conn, '[]'::jsonb);
    raise exception 'FAIL: reshared over a confirmed plan';
  exception when others then
    if sqlerrm not like '%plan_confirmed%' then raise; end if;
  end;
end $$;

\echo === expiry scrubs free/busy on the trigger, door refuses, plan row survives ===
update connections set ends_at = now() - interval '1 second';
select engine_tick();
do $$
declare v_conn uuid;
begin
  select id into v_conn from connections limit 1;
  if (select state from connections) <> 'expired' then raise exception 'FAIL: not expired'; end if;
  if (select count(*) from plan_availability) <> 0 then
    raise exception 'FAIL: free/busy survived expiry';
  end if;
  if (select count(*) from plans) <> 1 then
    raise exception 'FAIL: plan row should survive soft expiry';
  end if;
  begin
    perform plan_state(v_conn);
    raise exception 'FAIL: expired door still answers';
  exception when others then
    if sqlerrm not like '%no_connection%' then raise; end if;
  end;
end $$;

\echo === purge: the connection and its plan hard-delete with the account ===
set test.uid = '00000000-0000-0000-0000-000000000001';
select purge_me();
do $$ begin
  if (select count(*) from connections) <> 0 then
    raise exception 'FAIL: connection survived purge';
  end if;
  if (select count(*) from plans) <> 0 then
    raise exception 'FAIL: plan survived purge';
  end if;
end $$;

\echo ALL PLANS CHECKS PASSED
