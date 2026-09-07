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
--
-- 구매 심의(reviews)
--   신청자는 본인 심의의 상태만 볼 수 있고(reviews_status 뷰), 내용은 열람 PIN 으로
--   open_review() 를 호출해야 보입니다. 관리자는 reviews 테이블을 직접 읽습니다.
--   승인된 심의의 approved_amount 는 "가할당"으로 과제 잔액에서 차감되며, 연결된
--   구매 요청(requests.review_id)이 처리되면 그만큼 실집행으로 바뀝니다.
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
-- reviews : 구매 심의 (승인 시 가할당)
--   status: pending(심의 중) | approved(승인) | rejected(반려)
-- ---------------------------------------------------------------------
create table if not exists public.reviews (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz not null default now(),
  requester_id       uuid not null references auth.users (id) on delete restrict,
  requester_name     text not null default '',
  title              text not null,
  purpose            text not null default '',
  vendor             text not null default '',
  category           text not null default 'material',
  items              jsonb not null default '[]'::jsonb,   -- [{"name": "...", "amount": 1000000}, ...]
  amount             bigint not null default 0 check (amount >= 0),
  note               text not null default '',
  pin_hash           text not null,                        -- sha256(hex) of the requester's viewing PIN
  status             text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  project_id         uuid references public.projects (id) on delete restrict,
  approved_amount    bigint check (approved_amount is null or approved_amount >= 0),
  admin_note         text not null default '',
  processed_at       timestamptz,
  processed_by_name  text,
  constraint approved_requires_project check (status <> 'approved' or project_id is not null)
);
create index if not exists reviews_status_idx    on public.reviews (status);
create index if not exists reviews_requester_idx on public.reviews (requester_id);
create index if not exists reviews_project_idx   on public.reviews (project_id, category);

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
  review_id          uuid references public.reviews (id) on delete restrict,
  admin_note         text not null default '',
  processed_at       timestamptz,
  processed_by       uuid references auth.users (id),
  processed_by_name  text,
  constraint done_requires_project check (status <> 'done' or project_id is not null)
);
alter table public.requests add column if not exists category text not null default 'material';
alter table public.requests add column if not exists review_id uuid references public.reviews (id) on delete restrict;

create index if not exists requests_status_idx   on public.requests (status);
create index if not exists requests_project_idx  on public.requests (project_id);
create index if not exists requests_category_idx on public.requests (project_id, category);
create index if not exists requests_review_idx   on public.requests (review_id);

-- ---------------------------------------------------------------------
-- 신청자용 심의 상태 뷰 (내용 없이 상태만, 본인 것만)
--   뷰는 소유자 권한으로 실행되므로 reviews 의 RLS(관리자만 select)를 우회하되
--   where 절로 본인 행만 노출합니다.
-- ---------------------------------------------------------------------
drop view if exists public.reviews_status;
create view public.reviews_status as
select id, created_at, requester_id, requester_name, title, status, processed_at
from public.reviews
where requester_id = auth.uid();
grant select on public.reviews_status to authenticated;

-- 열람 PIN 으로 심의 내용 열기 (본인 또는 관리자)
create or replace function public.open_review(review_id uuid, pin text)
returns setof public.reviews
language sql
stable
security definer set search_path = public
as $$
  select r.*
  from public.reviews r
  where r.id = review_id
    and (r.requester_id = auth.uid() or public.is_admin())
    and r.pin_hash = encode(digest(pin, 'sha256'), 'hex');
$$;
revoke all on function public.open_review(uuid, text) from public;
grant execute on function public.open_review(uuid, text) to authenticated;

-- ---------------------------------------------------------------------
-- 예산 집계 뷰: 실집행(처리된 구매건) + 가할당(승인 심의의 미집행분)
-- ---------------------------------------------------------------------
drop view if exists public.project_budget;
drop view if exists public.project_category_budget;

create view public.project_category_budget as
with cat as (
  select p.id as project_id, p.code, p.name, p.active, c.key as category, c.value::numeric as budget
  from public.projects p
  cross join lateral jsonb_each_text(p.budgets) c
),
actual as (
  select project_id, category, sum(amount) as actual
  from public.requests
  where status = 'done'
  group by project_id, category
),
prov as (
  select r.project_id, r.category,
         sum(greatest(0, coalesce(r.approved_amount, r.amount)
             - coalesce((select sum(q.amount) from public.requests q where q.review_id = r.id and q.status = 'done'), 0))) as provisional
  from public.reviews r
  where r.status = 'approved'
  group by r.project_id, r.category
)
select cat.project_id, cat.code, cat.name, cat.active, cat.category, cat.budget,
       coalesce(actual.actual, 0)     as actual,
       coalesce(prov.provisional, 0)  as provisional,
       cat.budget - coalesce(actual.actual, 0) - coalesce(prov.provisional, 0) as remaining
from cat
left join actual on actual.project_id = cat.project_id and actual.category = cat.category
left join prov   on prov.project_id   = cat.project_id and prov.category   = cat.category;

create view public.project_budget as
select project_id as id, code, name, active,
       sum(budget)      as budget,
       sum(actual)      as actual,
       sum(provisional) as provisional,
       sum(remaining)   as remaining
from public.project_category_budget
group by project_id, code, name, active;

-- 집계 뷰는 관리자만 (과제 총액은 구성원에게 비공개)
alter view public.project_budget          set (security_invoker = true);
alter view public.project_category_budget set (security_invoker = true);

-- ---------------------------------------------------------------------
-- Row Level Security
--   · 로그인한 구성원: 과제 목록(이름·코드) 열람, 요청 전체 열람, 본인 요청 생성/수정/취소(미처리),
--                      본인 심의 생성 (내용은 open_review 로만)
--   · 관리자        : 과제·요청·심의 전체 CRUD
--   ※ 과제 예산(budgets) 총액을 구성원에게 숨기려면 아래 "projects: read all" 정책을
--     열 단위 뷰로 바꾸세요. 기본 정책은 과제 이름 배정을 위해 행 전체를 노출합니다.
-- ---------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.requests enable row level security;
alter table public.reviews  enable row level security;

drop policy if exists "profiles: read all"      on public.profiles;
drop policy if exists "profiles: update self"   on public.profiles;
drop policy if exists "profiles: admin update"  on public.profiles;
create policy "profiles: read all"     on public.profiles for select to authenticated using (true);
create policy "profiles: update self"  on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and is_admin = (select is_admin from public.profiles where id = auth.uid()));
create policy "profiles: admin update" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- 과제 예산(budgets)은 관리자만. 구성원은 예산이 빠진 projects_public 뷰로 과제 이름·코드만 봅니다.
drop policy if exists "projects: read all"     on public.projects;
drop policy if exists "projects: admin read"   on public.projects;
drop policy if exists "projects: admin write"  on public.projects;
create policy "projects: admin read"  on public.projects for select to authenticated using (public.is_admin());
create policy "projects: admin write" on public.projects for all    to authenticated using (public.is_admin()) with check (public.is_admin());

drop view if exists public.projects_public;
create view public.projects_public as
select id, code, name, start_date, end_date, manager, active, created_at
from public.projects;
alter view public.projects_public set (security_invoker = false);
grant select on public.projects_public to authenticated;
alter view public.reviews_status set (security_invoker = false);

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

drop policy if exists "reviews: admin read"   on public.reviews;
drop policy if exists "reviews: insert own"   on public.reviews;
drop policy if exists "reviews: admin write"  on public.reviews;
create policy "reviews: admin read"  on public.reviews for select to authenticated using (public.is_admin());
create policy "reviews: insert own"  on public.reviews for insert to authenticated with check (requester_id = auth.uid() and status = 'pending' and project_id is null);
create policy "reviews: admin write" on public.reviews for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "reviews: admin delete" on public.reviews;
create policy "reviews: admin delete" on public.reviews for delete to authenticated using (public.is_admin());

-- 실시간 반영 (대시보드 자동 갱신)
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'requests') then
    alter publication supabase_realtime add table public.requests;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'projects') then
    alter publication supabase_realtime add table public.projects;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reviews') then
    alter publication supabase_realtime add table public.reviews;
  end if;
end $$;

-- (선택) 특정 도메인만 가입 허용하려면 Supabase Dashboard > Authentication > Settings 에서
-- "Restrict sign-ups to email domains" 에 kaist.ac.kr 을 추가하세요.
