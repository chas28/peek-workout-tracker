-- PEEK Workout Tracker — Supabase schema
-- Run this once in the Supabase Dashboard: SQL Editor -> New query -> paste -> Run.
-- (The anon key the app uses can only read/write rows through these policies;
-- it cannot create tables, so this step has to be done here manually.)

-- 1. Workouts: one row per logged workout session.
create table if not exists public.workouts (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  time timestamptz,
  title text,
  type text not null check (type in ('strength', 'cardio')),
  exercises jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workouts_user_id_idx on public.workouts (user_id);

-- 2. Rest days: dates the user explicitly marked as a rest day.
create table if not exists public.rest_days (
  user_id uuid not null references auth.users (id) on delete cascade,
  date date not null,
  primary key (user_id, date)
);

-- 3. Settings: one row per user (theme / time format / weight unit).
create table if not exists public.user_settings (
  user_id uuid primary key references auth.users (id) on delete cascade,
  theme text not null default 'dark',
  time_format text not null default '12h',
  weight_unit text not null default 'lbs',
  updated_at timestamptz not null default now()
);

-- Row Level Security: every policy is scoped to auth.uid() = user_id, so a
-- visitor's anonymous session (see src/supabaseClient.js) can only ever
-- read/write its own rows — never another visitor's, even though the anon
-- key itself is public. Anonymous-auth users are Postgres role
-- "authenticated" with auth.uid() set to their real (per-session) user id.

alter table public.workouts enable row level security;
alter table public.rest_days enable row level security;
alter table public.user_settings enable row level security;

create policy "workouts: owner full access"
  on public.workouts for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "rest_days: owner full access"
  on public.rest_days for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "user_settings: owner full access"
  on public.user_settings for all
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
