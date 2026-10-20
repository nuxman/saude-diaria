-- Saúde diária — cole tudo no Supabase: SQL Editor → New query → Run.
-- Pode rodar de novo sem estragar nada (idempotente).

create table if not exists public.meds (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  instr text not null default '',      -- instruções ("Após o almoço.")
  period text not null default 'livre', -- manha | almoco | livre | noite
  sort int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  synced_at timestamptz not null default clock_timestamp()
);

create table if not exists public.doses (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  med_id uuid not null references public.meds(id),
  day date not null,      -- data local do aparelho
  taken_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  synced_at timestamptz not null default clock_timestamp(),
  unique (user_id, med_id, day)
);

create table if not exists public.glucose (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  value int not null,     -- mg/dL
  moment text not null default '', -- Jejum, Antes do almoço...
  measured_at timestamptz not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  synced_at timestamptz not null default clock_timestamp()
);

create table if not exists public.bp (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  systolic int not null,
  diastolic int not null,
  pulse int,
  measured_at timestamptz not null,
  note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  synced_at timestamptz not null default clock_timestamp()
);

-- Vence o updated_at mais recente; synced_at é sempre o relógio do servidor
-- (o app busca novidades por synced_at, então edições offline enviadas tarde não se perdem).
create or replace function public.lww_guard() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.updated_at < old.updated_at then
    return null;  -- versão mais antiga: ignora
  end if;
  new.synced_at := clock_timestamp();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['meds','doses','glucose','bp'] loop
    execute format('drop trigger if exists lww on public.%I', t);
    execute format('create trigger lww before insert or update on public.%I for each row execute function public.lww_guard()', t);
    execute format('create index if not exists %I on public.%I (user_id, synced_at)', t || '_sync_idx', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists own_rows on public.%I', t);
    execute format('create policy own_rows on public.%I for all to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()))', t);
  end loop;
end $$;
