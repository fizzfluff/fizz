-- FIZZ MAP CHAT schema. Run once in the Supabase SQL editor (or psql).
-- Anonymous writes are allowed; the client id header keeps edits to your own row.

create table if not exists public.contributions (
  id bigint generated always as identity primary key,
  lat integer not null check (lat between -90 and 89),
  lon integer not null check (lon between -180 and 179),
  user_id text not null check (char_length(user_id) between 1 and 64),
  username text not null check (char_length(username) between 1 and 32),
  color text not null check (char_length(color) between 1 and 32),
  message text not null check (char_length(message) between 1 and 280),
  created_at timestamptz not null default now(),
  unique (lat, lon, user_id)
);

create index if not exists contributions_cell_idx on public.contributions (lat, lon);
create index if not exists contributions_recent_idx on public.contributions (created_at desc);

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

create or replace view public.cell_summary with (security_invoker = true) as
select
  lat,
  lon,
  count(distinct user_id)::int as contributor_count,
  count(*)::int as contribution_count,
  max(created_at) as last_activity,
  (array_agg(color order by created_at desc))[1] as color
from public.contributions
group by lat, lon;

create or replace view public.stats with (security_invoker = true) as
select
  count(*)::int as total_contributions,
  count(distinct user_id)::int as unique_contributors,
  count(distinct (lat, lon))::int as active_cells
from public.contributions;

create or replace view public.leaderboard with (security_invoker = true) as
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
