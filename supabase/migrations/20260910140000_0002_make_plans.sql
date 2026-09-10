-- Make Plans, the third door. PRD §5 (front-porch.md), laws it implements:
--   free and busy only. Each person's raw windows land here but are never
--   readable by the other person, in any form. Only the computed overlap
--   crosses, so the other person just sees "you're both free."
--   Consent is the act of sharing. Nothing crosses until both have.
--   No rejection states (PRD law 10). A proposal is replaced by a
--   counter-proposal, never declined. Confirmed is terminal.
--   The door closes with the connection. Free/busy is scrubbed the moment
--   a connection expires, by trigger, on every path (tick, block, purge).
--   Pushes stay nameless (PRD §4.4). Names never left the device.

-- Windows are a tstzmultirange: range_agg normalizes overlapping and
-- adjacent windows on the way in, and intersection is one operator.
create table if not exists plan_availability (
  connection_id uuid not null references connections (id) on delete cascade,
  user_id uuid not null references profiles (id) on delete cascade,
  windows tstzmultirange not null,
  submitted_at timestamptz not null default now(),
  primary key (connection_id, user_id)
);

-- One plan per connection, ever. proposed -> confirmed, nothing else.
-- Either participant can replace a 'proposed' row with a different slot
-- (that is the counter-proposal), and proposed_by flips with it.
create table if not exists plans (
  connection_id uuid primary key references connections (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  proposed_by uuid not null references profiles (id) on delete cascade,
  state text not null default 'proposed' check (state in ('proposed', 'confirmed')),
  created_at timestamptz not null default now(),
  confirmed_at timestamptz
);

-- No client policies on either table. The RPCs below are the only door,
-- same doctrine as lights: the consent gate and the overlap-only rule
-- cannot be bypassed by a direct select.
alter table plan_availability enable row level security;
alter table plans enable row level security;

-- Hardening while we are here: the direct-select policy on connections
-- was unused (the client reads through my_connections()) and exposed raw
-- locked_at and reveal_at to participants, which is more of the engine's
-- clock than anyone needs (PRD law 4 wants order and timing unknowable).
-- RPC-only, like everything else.
drop policy if exists connections_open_visible on connections;

-- Parse client windows: jsonb [{"s": iso, "e": iso}, ...] -> multirange.
create or replace function _windows_from_jsonb(p jsonb) returns tstzmultirange
language plpgsql stable as $$
declare v tstzmultirange;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 100 then
    raise exception 'bad_windows';
  end if;
  begin
    select coalesce(range_agg(tstzrange(x.s, x.e)), '{}'::tstzmultirange) into v
    from (
      select (w ->> 's')::timestamptz as s, (w ->> 'e')::timestamptz as e
      from jsonb_array_elements(p) w
    ) x
    where x.s is not null and x.e is not null and x.e > x.s;
  exception when others then
    raise exception 'bad_windows';
  end;
  return v;
end $$;

-- Guard used by every plans RPC: the caller must be a participant and the
-- connection must be open. Everything else is 'no_connection', including
-- expired doors, so the client learns nothing it should not.
create or replace function _open_connection(p_connection uuid) returns connections
language plpgsql stable security definer set search_path = public as $$
declare c connections;
begin
  select * into c from connections
  where id = p_connection and state = 'open'
    and (a_id = auth.uid() or b_id = auth.uid());
  if c.id is null then raise exception 'no_connection'; end if;
  return c;
end $$;

-- Share (or reshare) my free windows for this connection. Clipped to the
-- next 14 days server-side. Exactly one gentle push exists in this step:
-- at the moment the two sets first line up, to the person who was
-- waiting. Resubmits stay quiet unless they create that moment, and
-- nothing fires once a proposal is already carrying the flow.
create or replace function submit_availability(p_connection uuid, p_windows jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  c connections;
  v_me uuid := auth.uid();
  v_other uuid;
  v_new tstzmultirange;
  v_mine_old tstzmultirange;
  v_theirs tstzmultirange;
  v_was_live boolean;
  v_now_live boolean;
begin
  c := _open_connection(p_connection);
  if exists (select 1 from plans where connection_id = c.id and state = 'confirmed') then
    raise exception 'plan_confirmed';
  end if;
  v_other := case when c.a_id = v_me then c.b_id else c.a_id end;
  v_new := _windows_from_jsonb(p_windows)
           * tstzmultirange(tstzrange(now(), now() + interval '14 days'));

  select windows into v_mine_old from plan_availability
    where connection_id = c.id and user_id = v_me;
  select windows into v_theirs from plan_availability
    where connection_id = c.id and user_id = v_other;
  v_was_live := v_theirs is not null and v_mine_old is not null
                and not isempty(v_theirs * v_mine_old);

  insert into plan_availability (connection_id, user_id, windows)
    values (c.id, v_me, v_new)
  on conflict (connection_id, user_id)
    do update set windows = excluded.windows, submitted_at = now();

  v_now_live := v_theirs is not null and not isempty(v_theirs * v_new);
  if v_now_live and not v_was_live
     and not exists (select 1 from plans where connection_id = c.id) then
    insert into push_queue (user_id, payload)
    values (v_other, jsonb_build_object(
      'title', 'Make Plans',
      'body', 'Your free times line up. Open Front Porch to pick one.'));
  end if;
end $$;

-- Everything the client needs to draw the door, and nothing more:
--   mine / theirs: who has shared (booleans only)
--   my_windows: my own windows back, for the edit grid
--   overlaps: null until BOTH have shared, then the intersection only,
--     clipped to proposable time and floored at 45 minutes
--   plan: the current proposal or confirmed plan, with by_me
-- The other person's raw windows never appear in any shape.
create or replace function plan_state(p_connection uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  c connections;
  v_me uuid := auth.uid();
  v_other uuid;
  v_mine tstzmultirange;
  v_theirs tstzmultirange;
  v_my_windows jsonb;
  v_overlaps jsonb;
  v_plan jsonb;
begin
  c := _open_connection(p_connection);
  v_other := case when c.a_id = v_me then c.b_id else c.a_id end;
  select windows into v_mine from plan_availability
    where connection_id = c.id and user_id = v_me;
  select windows into v_theirs from plan_availability
    where connection_id = c.id and user_id = v_other;

  if v_mine is not null then
    select coalesce(jsonb_agg(jsonb_build_object('s', lower(r), 'e', upper(r)) order by lower(r)),
                    '[]'::jsonb)
      into v_my_windows
    from unnest(v_mine) r;
  end if;

  if v_mine is not null and v_theirs is not null then
    select coalesce(jsonb_agg(jsonb_build_object('s', y.s, 'e', y.e)), '[]'::jsonb)
      into v_overlaps
    from (
      select lower(x.rr) as s, upper(x.rr) as e
      from (
        select r * tstzrange(now() + interval '30 minutes', now() + interval '14 days') as rr
        from unnest(v_mine * v_theirs) r
      ) x
      where not isempty(x.rr) and upper(x.rr) - lower(x.rr) >= interval '45 minutes'
      order by 1
      limit 60
    ) y;
  end if;

  select jsonb_build_object(
      'starts_at', p.starts_at, 'ends_at', p.ends_at,
      'by_me', p.proposed_by = v_me, 'state', p.state)
    into v_plan
  from plans p where p.connection_id = c.id;

  return jsonb_build_object(
    'mine', v_mine is not null,
    'theirs', v_theirs is not null,
    'my_windows', v_my_windows,
    'overlaps', v_overlaps,
    'plan', v_plan);
end $$;

-- Put a time on the table, or replace the one that is there. The server
-- re-checks the slot against the CURRENT intersection, so a client can
-- never propose a time the other person did not offer.
create or replace function propose_plan(p_connection uuid, p_starts timestamptz, p_ends timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare
  c connections;
  v_me uuid := auth.uid();
  v_other uuid;
  v_mine tstzmultirange;
  v_theirs tstzmultirange;
  v_state text;
begin
  c := _open_connection(p_connection);
  v_other := case when c.a_id = v_me then c.b_id else c.a_id end;

  select state into v_state from plans where connection_id = c.id;
  if v_state = 'confirmed' then raise exception 'plan_confirmed'; end if;

  select windows into v_mine from plan_availability
    where connection_id = c.id and user_id = v_me;
  select windows into v_theirs from plan_availability
    where connection_id = c.id and user_id = v_other;
  if v_mine is null or v_theirs is null then raise exception 'no_availability'; end if;

  if p_starts is null or p_ends is null
     or p_ends - p_starts < interval '30 minutes'
     or p_ends - p_starts > interval '4 hours'
     or p_starts < now() + interval '15 minutes' then
    raise exception 'bad_slot';
  end if;
  if not tstzrange(p_starts, p_ends) <@ (v_mine * v_theirs) then
    raise exception 'slot_outside_overlap';
  end if;

  insert into plans (connection_id, starts_at, ends_at, proposed_by)
    values (c.id, p_starts, p_ends, v_me)
  on conflict (connection_id) do update
    set starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        proposed_by = excluded.proposed_by,
        created_at = now();

  insert into push_queue (user_id, payload)
  values (v_other, jsonb_build_object(
    'title', 'Make Plans',
    'body', 'A time is on the table. Open Front Porch to take a look.'));
end $$;

-- The other person says yes. Only the non-proposer can confirm, so a
-- plan is always two yeses, same shape as the lights.
create or replace function confirm_plan(p_connection uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  c connections;
  v_me uuid := auth.uid();
  p plans;
begin
  c := _open_connection(p_connection);
  select * into p from plans where connection_id = c.id;
  if p.connection_id is null then raise exception 'no_proposal'; end if;
  if p.state = 'confirmed' then raise exception 'plan_confirmed'; end if;
  if p.proposed_by = v_me then raise exception 'own_proposal'; end if;

  update plans set state = 'confirmed', confirmed_at = now()
    where connection_id = c.id;

  insert into push_queue (user_id, payload)
  values (p.proposed_by, jsonb_build_object(
    'title', 'It''s a plan.',
    'body', 'Open Front Porch to put it on your calendar.'));
end $$;

-- The scrub. Free/busy is the sensitive half and it dies with the door,
-- on every path that expires a connection (the tick, a block, a purge).
-- The plans row deliberately survives soft expiry: a confirmed time is
-- the only record until both calendars carry it, it is unreachable
-- through any RPC once the door closes, and it hard-deletes with the
-- connection when an account is purged (law 9 holds).
create or replace function _scrub_plan_freebusy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from plan_availability where connection_id = new.id;
  return new;
end $$;

drop trigger if exists connections_scrub_freebusy on connections;
create trigger connections_scrub_freebusy
  after update of state on connections
  for each row
  when (new.state = 'expired' and old.state is distinct from 'expired')
  execute function _scrub_plan_freebusy();
