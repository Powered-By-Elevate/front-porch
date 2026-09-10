-- Engine smoke test. Run against a scratch Postgres (not production):
--   grep -v -e pg_cron -e cron.schedule ../migrations/20260909210000_0001_engine.sql > /tmp/fp_migration_no_cron.sql
--   createdb fp_test && psql -d fp_test -f engine_smoke.sql
-- Passed in full 2026-09-09 (PG16): ALL ENGINE CHECKS PASSED.

\set ON_ERROR_STOP on
create schema auth;
create table auth.users (id uuid primary key, phone text);
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('test.uid', true), '')::uuid $$;

\i /tmp/fp_migration_no_cron.sql

insert into auth.users values
  ('00000000-0000-0000-0000-000000000001', '+14045550101'),
  ('00000000-0000-0000-0000-000000000002', '+14045550102');

set test.uid = '00000000-0000-0000-0000-000000000001';
select ensure_profile('1990-01-01');
set test.uid = '00000000-0000-0000-0000-000000000002';
select ensure_profile('1992-02-02');

\echo === underage is refused ===
insert into auth.users values ('00000000-0000-0000-0000-000000000003', '+14045550103');
set test.uid = '00000000-0000-0000-0000-000000000003';
do $$ begin
  perform ensure_profile((current_date - interval '15 years')::date);
  raise exception 'FAIL: underage accepted';
exception when others then
  if sqlerrm not like '%underage%' then raise; end if;
end $$;

\echo === both flip, still inside 10 seconds: tick must NOT lock ===
set test.uid = '00000000-0000-0000-0000-000000000001';
select set_light(_hash_phone('+14045550102'));
set test.uid = '00000000-0000-0000-0000-000000000002';
select set_light(_hash_phone('+14045550101'));
select engine_tick();
do $$ begin
  if (select count(*) from connections) <> 0 then
    raise exception 'FAIL: locked before the lights were real';
  end if;
end $$;

\echo === both real: tick locks exactly once, 2-30 min reveal, 48h window ===
update lights set real_at = now() - interval '1 second';
select engine_tick();
select engine_tick();
do $$
declare c record;
begin
  if (select count(*) from connections) <> 1 then
    raise exception 'FAIL: expected exactly one connection';
  end if;
  select * into c from connections;
  if c.state <> 'locked' then raise exception 'FAIL: not locked'; end if;
  if c.reveal_at < now() + interval '1 minute' or c.reveal_at > now() + interval '31 minutes' then
    raise exception 'FAIL: reveal_at outside 2-30 min';
  end if;
  if c.ends_at <> c.reveal_at + interval '48 hours' then
    raise exception 'FAIL: ends_at is not reveal + 48h';
  end if;
end $$;

\echo === unflip after lock changes nothing about the connection ===
set test.uid = '00000000-0000-0000-0000-000000000002';
select unset_light(_hash_phone('+14045550101'));
select engine_tick();
do $$ begin
  if (select state from connections) <> 'locked' then
    raise exception 'FAIL: unflip disturbed the lock';
  end if;
end $$;

\echo === reveal: state open, two nameless pushes, my_connections shows it ===
update connections set reveal_at = now() - interval '1 second',
                       ends_at = now() - interval '1 second' + interval '48 hours';
select engine_tick();
do $$ begin
  if (select state from connections) <> 'open' then raise exception 'FAIL: not open'; end if;
  if (select count(*) from push_queue) <> 2 then raise exception 'FAIL: expected 2 pushes'; end if;
end $$;
set test.uid = '00000000-0000-0000-0000-000000000001';
do $$ begin
  if (select count(*) from my_connections()) <> 1 then
    raise exception 'FAIL: my_connections empty for participant';
  end if;
  if (select other_hash from my_connections()) <> _hash_phone('+14045550102') then
    raise exception 'FAIL: other_hash wrong';
  end if;
end $$;

\echo === expiry: both lights forced off, state expired, porch neutral ===
update connections set ends_at = now() - interval '1 second';
select engine_tick();
do $$ begin
  if (select state from connections) <> 'expired' then raise exception 'FAIL: not expired'; end if;
  if (select count(*) from lights) <> 0 then raise exception 'FAIL: lights survived expiry'; end if;
end $$;

\echo === the cap: light 11 is refused ===
set test.uid = '00000000-0000-0000-0000-000000000001';
do $$
declare i int;
begin
  for i in 1..10 loop
    perform set_light('fakehash' || i::text);
  end loop;
  begin
    perform set_light('fakehash11');
    raise exception 'FAIL: cap did not hold';
  exception when others then
    if sqlerrm not like '%light_cap%' then raise; end if;
  end;
end $$;

\echo ALL ENGINE CHECKS PASSED
