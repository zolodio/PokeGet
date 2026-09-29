-- Run this once in Supabase: SQL Editor -> New query -> paste -> Run

create table if not exists products (
  url               text primary key,
  name              text,
  in_stock          boolean not null default false,
  first_seen        timestamptz not null default now(),
  last_seen         timestamptz not null default now(),
  last_in_stock_at  timestamptz
);

create table if not exists check_runs (
  id          bigint generated always as identity primary key,
  ran_at      timestamptz not null default now(),
  status      text not null,            -- 'ok' | 'blocked' | 'error'
  product_count int,
  in_stock_count int,
  note        text
);

-- Only the service-role key (used by GitHub Actions) should touch these tables.
alter table products   enable row level security;
alter table check_runs enable row level security;
