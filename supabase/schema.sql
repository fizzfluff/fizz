-- FIZZ MAP schema. Run once in the Supabase SQL editor (or psql).
-- Anonymous writes are allowed; the x-client-id header keeps edits to your own row.
--
-- This file RESETS the database: everything below is dropped and recreated, so
-- running it deletes every existing claim and message.

drop view if exists public.cell_summary;
drop view if exists public.stats;
drop view if exists public.leaderboard;
drop table if exists public.contributions;

create table public.contributions (
  id bigint generated always as identity primary key,
  lat integer not null check (lat between -90 and 89),
  lon integer not null check (lon between -180 and 179),
  user_id text not null check (char_length(user_id) between 1 and 64),
  username text not null check (char_length(username) between 1 and 32),
  color text not null check (char_length(color) between 1 and 32),
  message text not null check (char_length(message) between 1 and 280),
  is_claim boolean not null default false,
  created_at timestamptz not null default now(),
  unique (lat, lon, user_id)  -- one message per user per dot
);

create index contributions_cell_idx on public.contributions (lat, lon);
create index contributions_recent_idx on public.contributions (created_at desc);

-- A user owns at most one dot, and a dot is owned by at most one user.
create unique index contributions_one_claim_per_user
  on public.contributions (user_id) where is_claim;
create unique index contributions_one_claim_per_dot
  on public.contributions (lat, lon) where is_claim;

alter table public.contributions enable row level security;

drop policy if exists "public read" on public.contributions;
create policy "public read" on public.contributions
  for select using (true);

drop policy if exists "insert own" on public.contributions;
create policy "insert own" on public.contributions
  for insert with check (
    user_id = coalesce(current_setting('request.headers', true)::json->>'x-client-id', '')
  );

drop policy if exists "update own" on public.contributions;
create policy "update own" on public.contributions
  for update using (
    user_id = coalesce(current_setting('request.headers', true)::json->>'x-client-id', '')
  );

drop policy if exists "delete own" on public.contributions;
create policy "delete own" on public.contributions
  for delete using (
    user_id = coalesce(current_setting('request.headers', true)::json->>'x-client-id', '')
  );

-- A message may only land on a dot that is already claimed, so a fresh dot can
-- be claimed but not chatted on.
create or replace function public.contributions_require_claim()
returns trigger language plpgsql as $$
begin
  if not new.is_claim and not exists (
    select 1 from public.contributions
    where lat = new.lat and lon = new.lon and is_claim
  ) then
    raise exception 'dot is not claimed' using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists contributions_require_claim on public.contributions;
create trigger contributions_require_claim
  before insert on public.contributions
  for each row execute function public.contributions_require_claim();

-- A dot's colour is its owner's; unowned dots fall back to the newest message.
create view public.cell_summary with (security_invoker = true) as
select
  lat,
  lon,
  count(distinct user_id)::int as contributor_count,
  count(*)::int as contribution_count,
  max(created_at) as last_activity,
  (array_agg(color order by is_claim desc, created_at desc))[1] as color
from public.contributions
group by lat, lon;

create view public.stats with (security_invoker = true) as
select
  count(*)::int as total_contributions,
  count(distinct user_id)::int as unique_contributors,
  count(distinct (lat, lon))::int as active_cells
from public.contributions;

create view public.leaderboard with (security_invoker = true) as
select
  user_id,
  (array_agg(username order by created_at desc))[1] as username,
  (array_agg(color order by created_at desc))[1] as color,
  count(*)::int as count
from public.contributions
group by user_id
order by count desc
limit 10;

grant select on public.contributions, public.cell_summary, public.stats, public.leaderboard
  to anon, authenticated;
grant insert, update, delete on public.contributions to anon, authenticated;
grant usage, select on all sequences in schema public to anon, authenticated;
