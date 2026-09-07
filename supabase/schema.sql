-- =====================================================================
-- DSIL Lab Portal – 과제별 예산 관리 스키마 (Supabase / PostgreSQL)
-- ---------------------------------------------------------------------
-- 사용법
--   1. https://supabase.com 에서 새 프로젝트 생성 (Free tier 충분)
--   2. SQL Editor 에 이 파일 전체를 붙여 넣고 Run (여러 번 실행해도 안전)
--   3. Authentication > Providers > Email 에서 "Enable email OTP / magic link" 확인
--   4. Project Settings > API 의 URL 과 anon key 를 assets/js/config.js 에 입력,
--      backend: 'supabase' 로 변경
--   5. 관리자 지정:  update public.profiles set is_admin = true where email = 'admin@kaist.ac.kr';
--
-- 비목(category)
--   projects.budgets 는 {"material": 25000000, "activity": 10000000, ...} 형태의 JSON 이며
--   키는 assets/js/config.js 의 budgetCategories[].id 와 같아야 합니다.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- profiles : auth.users 와 1:1, 관리자 플래그
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  name        text,
  is_admin    boolean not null default false,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false);
$$;

-- ---------------------------------------------------------------------
-- projects : 과제 (비목별 예산은 budgets JSON)
-- ---------------------------------------------------------------------
create table if not exists public.projects (
  id          uuid primary key default gen_random_uuid(),
  code        text not null default '',
  name        text not null,
  budgets     jsonb not null default '{}'::jsonb,
  start_date  date,
  end_date    date,
  manager     text not null default '',
  note        text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.projects add column if not exists budgets jsonb not null default '{}'::jsonb;
alter table public.projects drop column if exists budget;

-- ---------------------------------------------------------------------
-- requests : 구매 요청
--   status: pending(미처리) | done(처리, 과제 배정됨) | rejected(반려)
-- ---------------------------------------------------------------------
create table if not exists public.requests (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  requester_id       uuid not null references auth.users (id) on delete restrict,
  requester_name     text not null default '',
  item               text not null,
  category           text not null default 'material',
  link               text not null default '',
  qty                integer not null default 1 check (qty >= 1),
  unit_price         bigint not null default 0 check (unit_price >= 0),
  amount             bigint not null default 0 check (amount >= 0),
  note               text not null default '',
  status             text not null default 'pending' check (status in ('pending', 'done', 'rejected')),
  project_id         uuid references public.projects (id) on delete restrict,
  admin_note         text not null default '',
  processed_at       timestamptz,
  processed_by       uuid references auth.users (id),
  processed_by_name  text,
  constraint done_requires_project check (status <> 'done' or project_id is not null)
);
alter table public.requests add column if not exists category text not null default 'material';

create index if not exists requests_status_idx   on public.requests (status);
create index if not exists requests_project_idx  on public.requests (project_id);
create index if not exists requests_category_idx on public.requests (project_id, category);

-- 과제별 총액 뷰 (처리된 건만 차감)
drop view if exists public.project_budget;
create view public.project_budget as
select
  p.id,
  p.code,
  p.name,
  p.active,
  (select coalesce(sum(v.value::numeric), 0) from jsonb_each_text(p.budgets) v)        as budget,
  coalesce(sum(r.amount) filter (where r.status = 'done'), 0)                           as used,
  (select coalesce(sum(v.value::numeric), 0) from jsonb_each_text(p.budgets) v)
    - coalesce(sum(r.amount) filter (where r.status = 'done'), 0)                       as remaining,
  count(r.id) filter (where r.status = 'done')                                          as done_count
from public.projects p
left join public.requests r on r.project_id = p.id
group by p.id;

-- 과제·비목별 뷰
drop view if exists public.project_category_budget;
create view public.project_category_budget as
select
  p.id                                   as project_id,
  p.code,
  p.name,
  c.key                                  as category,
  c.value::numeric                       as budget,
  coalesce((select sum(r.amount) from public.requests r
            where r.project_id = p.id and r.status = 'done' and r.category = c.key), 0) as used,
  c.value::numeric
    - coalesce((select sum(r.amount) from public.requests r
                where r.project_id = p.id and r.status = 'done' and r.category = c.key), 0) as remaining
from public.projects p
cross join lateral jsonb_each_text(p.budgets) c;

-- ---------------------------------------------------------------------
-- Row Level Security
--   · 로그인한 구성원: 과제·요청 전체 열람, 본인 요청 생성, 본인 미처리 요청 수정/삭제
--   · 관리자        : 과제 CRUD, 모든 요청 수정/삭제(배정·반려·되돌리기)
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.requests enable row level security;

drop policy if exists "profiles: read all"      on public.profiles;
drop policy if exists "profiles: update self"   on public.profiles;
drop policy if exists "profiles: admin update"  on public.profiles;
create policy "profiles: read all"     on public.profiles for select to authenticated using (true);
create policy "profiles: update self"  on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and is_admin = (select is_admin from public.profiles where id = auth.uid()));
create policy "profiles: admin update" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "projects: read all"     on public.projects;
drop policy if exists "projects: admin write"  on public.projects;
create policy "projects: read all"    on public.projects for select to authenticated using (true);
create policy "projects: admin write" on public.projects for all    to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "requests: read all"           on public.requests;
drop policy if exists "requests: insert own"         on public.requests;
drop policy if exists "requests: update own pending" on public.requests;
drop policy if exists "requests: delete own pending" on public.requests;
drop policy if exists "requests: admin all"          on public.requests;
create policy "requests: read all"           on public.requests for select to authenticated using (true);
create policy "requests: insert own"         on public.requests for insert to authenticated with check (requester_id = auth.uid() and status = 'pending' and project_id is null);
create policy "requests: update own pending" on public.requests for update to authenticated using (requester_id = auth.uid() and status = 'pending') with check (requester_id = auth.uid() and status = 'pending' and project_id is null);
create policy "requests: delete own pending" on public.requests for delete to authenticated using (requester_id = auth.uid() and status = 'pending');
create policy "requests: admin all"          on public.requests for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- 실시간 반영 (대시보드 자동 갱신)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'requests') then
    alter publication supabase_realtime add table public.requests;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'projects') then
    alter publication supabase_realtime add table public.projects;
  end if;
end $$;

-- (선택) 특정 도메인만 가입 허용하려면 Supabase Dashboard > Authentication > Settings 에서
-- "Restrict sign-ups to email domains" 에 kaist.ac.kr 을 추가하세요.
