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
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text,
  name         text,
  is_admin     boolean not null default false,
  status       text not null default 'pending' check (status in ('pending', 'active', 'disabled', 'rejected')),
  approved_at  timestamptz,
  approved_by  text,
  created_at   timestamptz not null default now()
);
alter table public.profiles add column if not exists status text not null default 'pending';
alter table public.profiles add column if not exists approved_at timestamptz;
alter table public.profiles add column if not exists approved_by text;
update public.profiles set status = 'active' where is_admin and status <> 'active';

-- 승인된(active) 계정인지: 구성원 쓰기 경로에서 확인
create or replace function public.is_active()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select coalesce((select status = 'active' from public.profiles where id = auth.uid()), false);
$$;

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
alter table public.requests add column if not exists kind text not null default 'purchase';   -- purchase(구매) | meeting(회의비)
alter table public.requests add column if not exists meta jsonb not null default '{}'::jsonb;  -- 회의비: 회의명·일시·참석자 등
alter table public.requests add column if not exists report jsonb;                             -- 구매 보고서 (status, 카드실사용자, 검수일자, 사진 키 등)
alter table public.projects add column if not exists account_manager text not null default '';  -- 계정책임자
alter table public.projects add column if not exists card_users jsonb not null default '[]'::jsonb; -- 카드 실사용자(참여연구원) 이름 목록
alter table public.profiles add column if not exists signature_key text;                        -- 서명 이미지 (Storage 키)
alter table public.projects add column if not exists alias text not null default '';            -- 참여과제 시트의 과제 약칭 (우수신진, 차지반 …)
alter table public.projects add column if not exists participants jsonb not null default '[]'::jsonb; -- [{ name, months:{ '2026-09': true } }] 회의비 참석자 후보
-- 참여과제 시트 원본 행과 가져오기 정보 (관리자만 쓰고, 로그인한 누구나 읽음)
create table if not exists public.app_settings (key text primary key, value jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now());
alter table public.app_settings enable row level security;
drop policy if exists "settings: read all" on public.app_settings;
drop policy if exists "settings: admin write" on public.app_settings;
create policy "settings: read all"    on public.app_settings for select to authenticated using (true);
create policy "settings: admin write" on public.app_settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());
-- 회의비 처리 로그: 누구나 자기 행을 추가할 수 있고 읽기만 가능 (수정·삭제 정책 없음 = 불가)
create table if not exists public.meeting_logs (
  id uuid primary key default gen_random_uuid(), at timestamptz not null default now(),
  by_id uuid references public.profiles(id), by_name text not null default '', type text not null,
  request_id uuid, requester_id uuid, requester_name text not null default '', project text not null default '', code text not null default '',
  title text not null default '', amount numeric not null default 0, count int not null default 0, per_head numeric not null default 0,
  attendees text not null default '', detail text not null default ''
);
alter table public.meeting_logs enable row level security;
drop policy if exists "meeting_logs: read all"   on public.meeting_logs;
drop policy if exists "meeting_logs: insert own" on public.meeting_logs;
create policy "meeting_logs: read all"   on public.meeting_logs for select to authenticated using (true);
create policy "meeting_logs: insert own" on public.meeting_logs for insert to authenticated with check (public.is_active() and by_id = auth.uid());
-- 회의비는 청구자가 참여과제 시트에 있는 과제를 골라 내면 관리자 승인 없이 바로 처리(status done)됩니다.
drop policy if exists "requests: insert meeting auto" on public.requests;
create policy "requests: insert meeting auto" on public.requests for insert to authenticated
  with check (public.is_active() and requester_id = auth.uid() and kind = 'meeting' and status = 'done' and project_id is not null
              and exists (select 1 from public.projects p, public.profiles me where p.id = project_id and me.id = auth.uid()
                          and p.participants @> jsonb_build_array(jsonb_build_object('name', me.name))));
-- 사진 저장: Storage 에 public 버킷 'report-photos' 를 만들고 authenticated 에게 insert/select/delete 를 허용하세요.
-- 보고서 작성자는 requests 를 update 할 수 있어야 하므로 아래 정책을 추가합니다 (본인 요청의 report 열만 바꾸는 용도).
drop policy if exists "requests: update own report" on public.requests;
create policy "requests: update own report" on public.requests for update to authenticated
  using (requester_id = auth.uid() and status = 'done') with check (requester_id = auth.uid() and status = 'done');

create index if not exists requests_status_idx   on public.requests (status);
create index if not exists requests_project_idx  on public.requests (project_id);
create index if not exists requests_category_idx on public.requests (project_id, category);
create index if not exists requests_review_idx   on public.requests (review_id);

-- ---------------------------------------------------------------------
-- export_logs : 보고서 내보내기 이력 (관리자 전용 아카이브, 추가만 가능)
--   rows 에 내보낸 시점의 스냅샷을 그대로 저장하므로 나중에 같은 보고서를 다시 받을 수 있습니다.
-- ---------------------------------------------------------------------
create table if not exists public.export_logs (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  exported_by       uuid references auth.users (id),
  exported_by_name  text not null default '',
  purpose           text not null default '',
  format            text not null default 'csv' check (format in ('csv', 'print')),
  count             integer not null default 0,
  total_amount      bigint not null default 0,
  filter            jsonb not null default '{}'::jsonb,
  rows              jsonb not null default '[]'::jsonb
);
create index if not exists export_logs_created_idx on public.export_logs (created_at desc);

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
create policy "profiles: update self"  on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid() and is_admin = (select is_admin from public.profiles where id = auth.uid()) and status = (select status from public.profiles where id = auth.uid()));
create policy "profiles: admin update" on public.profiles for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- 과제 예산(budgets)은 관리자만. 구성원은 예산이 빠진 projects_public 뷰로 과제 이름·코드만 봅니다.
drop policy if exists "projects: read all"     on public.projects;
drop policy if exists "projects: admin read"   on public.projects;
drop policy if exists "projects: admin write"  on public.projects;
create policy "projects: admin read"  on public.projects for select to authenticated using (public.is_admin());
create policy "projects: admin write" on public.projects for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- 과제 담당자(owners): 관리자가 아니어도 자기 담당 과제의 예산은 볼 수 있습니다.
alter table public.projects add column if not exists owners jsonb not null default '[]'::jsonb;

create or replace function public.is_project_owner(p_owners jsonb)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from jsonb_array_elements_text(coalesce(p_owners, '[]'::jsonb)) o
    join public.profiles me on me.id = auth.uid()
    where public.name_key(o) = public.name_key(me.name)
  );
$$;

drop view if exists public.projects_public;
create view public.projects_public as
select id, code, name, start_date, end_date, manager, active, created_at, alias, participants, owners,
       account_manager, card_users,
       case when public.is_admin() or public.is_project_owner(owners) then budgets else '{}'::jsonb end as budgets
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
create policy "requests: insert own"         on public.requests for insert to authenticated with check (public.is_active() and requester_id = auth.uid() and status = 'pending' and project_id is null);
create policy "requests: update own pending" on public.requests for update to authenticated using (requester_id = auth.uid() and status = 'pending') with check (requester_id = auth.uid() and status = 'pending' and project_id is null);
create policy "requests: delete own pending" on public.requests for delete to authenticated using (requester_id = auth.uid() and status = 'pending');
create policy "requests: admin all"          on public.requests for all    to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "reviews: admin read"   on public.reviews;
drop policy if exists "reviews: insert own"   on public.reviews;
drop policy if exists "reviews: admin write"  on public.reviews;
create policy "reviews: admin read"  on public.reviews for select to authenticated using (public.is_admin());
create policy "reviews: insert own"  on public.reviews for insert to authenticated with check (public.is_active() and requester_id = auth.uid() and status = 'pending' and project_id is null);
create policy "reviews: admin write" on public.reviews for update to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "reviews: admin delete" on public.reviews;
create policy "reviews: admin delete" on public.reviews for delete to authenticated using (public.is_admin());

-- 내보내기 이력: 관리자만 읽고 추가. update/delete 정책이 없으므로 API 로는 지울 수 없습니다.
alter table public.export_logs enable row level security;
drop policy if exists "export_logs: admin read"   on public.export_logs;
drop policy if exists "export_logs: admin insert" on public.export_logs;
create policy "export_logs: admin read"   on public.export_logs for select to authenticated using (public.is_admin());
create policy "export_logs: admin insert" on public.export_logs for insert to authenticated with check (public.is_admin() and exported_by = auth.uid());

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

-- =====================================================================
-- 장비 예약
--   equipment(관리자 관리) · equipment_users(담당자가 PIN 과 함께 등록) · reservations · usage_logs
--   구성원은 예산·PIN 이 빠진 뷰만 읽고, 쓰기는 모두 검증 함수(RPC)를 통합니다.
-- =====================================================================
create or replace function public.name_key(t text)
returns text language sql immutable as $$ select lower(regexp_replace(coalesce(t, ''), '\s', '', 'g')); $$;

create or replace function public.log_due_interval()
returns interval language sql immutable as $$ select interval '7 days'; $$;   -- config.js equipment.logDueDays 와 맞추세요

create table if not exists public.equipment (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  name              text not null,
  location          text not null default '',
  manager_name      text not null default '',
  manager_pin_hash  text not null default '',
  description       text not null default '',
  rules             text not null default '',
  color             text not null default '#004191',
  active            boolean not null default true
);

create table if not exists public.equipment_users (
  id            uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references public.equipment (id) on delete cascade,
  name          text not null,
  name_key      text not null,
  grade         text not null default 'training' check (grade in ('training', 'test', 'user', 'super')),   -- 유저/슈퍼유저만 예약 가능
  granted_at    timestamptz not null default now(),
  granted_by    text not null default '',
  unique (equipment_id, name_key)
);
alter table public.equipment_users add column if not exists grade text not null default 'training';
alter table public.equipment_users drop column if exists pin_hash;

create table if not exists public.reservations (
  id            uuid primary key default gen_random_uuid(),
  created_at    timestamptz not null default now(),
  equipment_id  uuid not null references public.equipment (id) on delete restrict,
  user_id       uuid references auth.users (id),
  user_name     text not null default '',
  user_key      text not null default '',
  start_at      timestamptz not null,
  end_at        timestamptz not null,
  purpose       text not null default '',
  status        text not null default 'booked' check (status in ('booked', 'cancelled')),
  log_id        uuid,
  cancelled_at  timestamptz,
  cancelled_by  text,
  check (end_at > start_at)
);
create index if not exists reservations_equipment_time_idx on public.reservations (equipment_id, start_at);
create index if not exists reservations_user_idx on public.reservations (user_id, user_key);

create table if not exists public.usage_logs (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  reservation_id  uuid not null references public.reservations (id) on delete cascade,
  equipment_id    uuid not null references public.equipment (id) on delete cascade,
  user_id         uuid references auth.users (id),
  user_name       text not null default '',
  used_start      timestamptz,
  used_end        timestamptz,
  condition       text not null default 'normal' check (condition in ('normal', 'issue')),
  content         text not null default '',
  issues          text not null default '',
  waived          boolean not null default false,
  waived_by       text
);

drop view if exists public.equipment_public;
create view public.equipment_public as
select id, created_at, name, location, manager_name, description, rules, color, active from public.equipment;
alter view public.equipment_public set (security_invoker = false);
grant select on public.equipment_public to authenticated;

drop view if exists public.equipment_users_public;
create view public.equipment_users_public as
select id, equipment_id, name, grade, granted_at, granted_by from public.equipment_users;
alter view public.equipment_users_public set (security_invoker = false);
grant select on public.equipment_users_public to authenticated;

-- 담당자 확인: PIN 이 맞고, 로그인한 사람이 그 장비의 담당자로 지정돼 있어야 함 (포털 관리자는 예외)
create or replace function public.verify_equipment_manager(p_equipment_id uuid, p_pin text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.equipment e join public.profiles me on me.id = auth.uid()
    where e.id = p_equipment_id
      and e.manager_pin_hash <> '' and e.manager_pin_hash = encode(digest(coalesce(p_pin, ''), 'sha256'), 'hex')
      and (me.is_admin or public.name_key(e.manager_name) = public.name_key(me.name))
  );
$$;

drop function if exists public.grant_equipment_user(uuid, text, text, text);
create or replace function public.grant_equipment_user(p_equipment_id uuid, p_manager_pin text, p_name text, p_grade text)
returns setof public.equipment_users_public language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_by text; v_grade text;
begin
  if not public.verify_equipment_manager(p_equipment_id, p_manager_pin) then raise exception '장비 담당자 PIN이 올바르지 않습니다.'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception '이름을 입력하세요.'; end if;
  v_grade := case when p_grade in ('training', 'test', 'user', 'super') then p_grade else 'training' end;
  select name into v_by from public.profiles where id = auth.uid();
  insert into public.equipment_users (equipment_id, name, name_key, grade, granted_by)
  values (p_equipment_id, trim(p_name), public.name_key(p_name), v_grade, coalesce(v_by, ''))
  on conflict (equipment_id, name_key) do update
    set name = excluded.name, grade = excluded.grade, granted_at = now(), granted_by = excluded.granted_by
  returning id into v_id;
  return query select * from public.equipment_users_public where id = v_id;
end;
$$;

create or replace function public.set_equipment_user_grade(p_equipment_id uuid, p_manager_pin text, p_user_id uuid, p_grade text)
returns setof public.equipment_users_public language plpgsql security definer set search_path = public as $$
declare v_by text;
begin
  if not public.verify_equipment_manager(p_equipment_id, p_manager_pin) then raise exception '장비 담당자 PIN이 올바르지 않습니다.'; end if;
  if p_grade not in ('training', 'test', 'user', 'super') then raise exception '등급을 확인하세요.'; end if;
  select name into v_by from public.profiles where id = auth.uid();
  update public.equipment_users set grade = p_grade, granted_at = now(), granted_by = coalesce(v_by, '') where id = p_user_id and equipment_id = p_equipment_id;
  return query select * from public.equipment_users_public where id = p_user_id;
end;
$$;

create or replace function public.revoke_equipment_user(p_equipment_id uuid, p_manager_pin text, p_user_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.verify_equipment_manager(p_equipment_id, p_manager_pin) then raise exception '장비 담당자 PIN이 올바르지 않습니다.'; end if;
  delete from public.equipment_users where id = p_user_id and equipment_id = p_equipment_id;
end;
$$;

drop function if exists public.create_reservation(uuid, text, timestamptz, timestamptz, text);
create or replace function public.create_reservation(p_equipment_id uuid, p_start timestamptz, p_end timestamptz, p_purpose text)
returns setof public.reservations language plpgsql security definer set search_path = public as $$
declare v_name text; v_key text; v_eq public.equipment%rowtype; v_clash public.reservations%rowtype; v_id uuid; v_grade text;
begin
  if not public.is_active() then raise exception '승인된 계정만 예약할 수 있습니다.'; end if;
  select name into v_name from public.profiles where id = auth.uid();
  v_key := public.name_key(v_name);
  select * into v_eq from public.equipment where id = p_equipment_id and active;
  if not found then raise exception '예약할 수 없는 장비입니다.'; end if;
  select grade into v_grade from public.equipment_users u where u.equipment_id = p_equipment_id and u.name_key = v_key;
  if not public.is_admin() then  -- 포털 관리자는 담당자 등록 없이 예약 가능
    if v_grade is null then raise exception '이 장비의 사용자로 등록되어 있지 않습니다. 담당자(%)에게 등록을 요청하세요.', v_eq.manager_name; end if;
    if v_grade not in ('user', 'super') then raise exception '현재 등급(%)으로는 예약할 수 없습니다. 담당자에게 유저 승급을 요청하세요.', v_grade; end if;
  end if;
  if p_end <= p_start then raise exception '시작·종료 시각을 확인하세요.'; end if;
  if p_end <= now() then raise exception '이미 지난 시간은 예약할 수 없습니다.'; end if;
  if p_end - p_start > interval '8 hours' then raise exception '1회 예약은 최대 8시간입니다.'; end if;
  if exists (select 1 from public.reservations r where r.status = 'booked' and r.log_id is null
             and (r.user_id = auth.uid() or r.user_key = v_key) and r.end_at < now() - public.log_due_interval()) then
    raise exception '사용 로그를 기한 내 작성하지 않은 예약이 있어 새 예약을 할 수 없습니다. 로그를 먼저 작성하세요.';
  end if;
  select * into v_clash from public.reservations r where r.equipment_id = p_equipment_id and r.status = 'booked' and r.start_at < p_end and r.end_at > p_start limit 1;
  if found then raise exception '같은 시간에 %님의 예약이 있습니다.', v_clash.user_name; end if;
  insert into public.reservations (equipment_id, user_id, user_name, user_key, start_at, end_at, purpose)
  values (p_equipment_id, auth.uid(), coalesce(v_name, ''), v_key, p_start, p_end, coalesce(p_purpose, ''))
  returning id into v_id;
  return query select * from public.reservations where id = v_id;
end;
$$;

create or replace function public.update_reservation(p_reservation_id uuid, p_start timestamptz, p_end timestamptz, p_purpose text default null, p_manager_pin text default null)
returns setof public.reservations language plpgsql security definer set search_path = public as $$
declare v_r public.reservations%rowtype; v_name text; v_key text; v_start timestamptz; v_end timestamptz; v_clash public.reservations%rowtype;
begin
  select * into v_r from public.reservations where id = p_reservation_id;
  if not found then raise exception '예약을 찾을 수 없습니다.'; end if;
  if v_r.status <> 'booked' then raise exception '취소된 예약은 변경할 수 없습니다.'; end if;
  select name into v_name from public.profiles where id = auth.uid();
  v_key := public.name_key(v_name);
  if not (((v_r.user_id = auth.uid() or v_r.user_key = v_key) and v_r.start_at > now())
          or (p_manager_pin is not null and public.verify_equipment_manager(v_r.equipment_id, p_manager_pin))) then
    raise exception '본인의 예정된 예약만 변경할 수 있습니다. 시작된 예약은 장비 담당자가 처리합니다.';
  end if;
  v_start := coalesce(p_start, v_r.start_at); v_end := coalesce(p_end, v_r.end_at);
  if v_end <= v_start then raise exception '시작·종료 시각을 확인하세요.'; end if;
  if v_end <= now() then raise exception '이미 지난 시간으로는 바꿀 수 없습니다.'; end if;
  if v_end - v_start > interval '8 hours' then raise exception '1회 예약은 최대 8시간입니다.'; end if;
  select * into v_clash from public.reservations r where r.id <> p_reservation_id and r.equipment_id = v_r.equipment_id and r.status = 'booked' and r.start_at < v_end and r.end_at > v_start limit 1;
  if found then raise exception '같은 시간에 %님의 예약이 있습니다.', v_clash.user_name; end if;
  update public.reservations set start_at = v_start, end_at = v_end, purpose = coalesce(p_purpose, purpose) where id = p_reservation_id;
  return query select * from public.reservations where id = p_reservation_id;
end;
$$;

create or replace function public.cancel_reservation(p_reservation_id uuid, p_manager_pin text default null)
returns setof public.reservations language plpgsql security definer set search_path = public as $$
declare v_r public.reservations%rowtype; v_name text; v_key text;
begin
  select * into v_r from public.reservations where id = p_reservation_id;
  if not found then raise exception '예약을 찾을 수 없습니다.'; end if;
  if v_r.status <> 'booked' then raise exception '이미 취소된 예약입니다.'; end if;
  select name into v_name from public.profiles where id = auth.uid();
  v_key := public.name_key(v_name);
  if ((v_r.user_id = auth.uid() or v_r.user_key = v_key) and v_r.start_at > now())
     or (p_manager_pin is not null and public.verify_equipment_manager(v_r.equipment_id, p_manager_pin)) then
    update public.reservations set status = 'cancelled', cancelled_at = now(), cancelled_by = coalesce(v_name, '') where id = p_reservation_id;
  else
    raise exception '본인의 예정된 예약만 취소할 수 있습니다. 지난 예약은 장비 담당자가 처리합니다.';
  end if;
  return query select * from public.reservations where id = p_reservation_id;
end;
$$;

create or replace function public.create_usage_log(p_reservation_id uuid, p_used_start timestamptz, p_used_end timestamptz, p_condition text, p_content text, p_issues text)
returns setof public.usage_logs language plpgsql security definer set search_path = public as $$
declare v_r public.reservations%rowtype; v_name text; v_id uuid;
begin
  select * into v_r from public.reservations where id = p_reservation_id;
  if not found or v_r.status <> 'booked' then raise exception '로그를 쓸 예약을 찾을 수 없습니다.'; end if;
  if v_r.log_id is not null then raise exception '이미 로그가 작성된 예약입니다.'; end if;
  select name into v_name from public.profiles where id = auth.uid();
  if not (v_r.user_id = auth.uid() or v_r.user_key = public.name_key(v_name)) then raise exception '본인 예약의 로그만 작성할 수 있습니다.'; end if;
  insert into public.usage_logs (reservation_id, equipment_id, user_id, user_name, used_start, used_end, condition, content, issues)
  values (p_reservation_id, v_r.equipment_id, auth.uid(), coalesce(v_name, ''), coalesce(p_used_start, v_r.start_at), coalesce(p_used_end, v_r.end_at),
          case when p_condition = 'issue' then 'issue' else 'normal' end, coalesce(p_content, ''), coalesce(p_issues, ''))
  returning id into v_id;
  update public.reservations set log_id = v_id where id = p_reservation_id;
  return query select * from public.usage_logs where id = v_id;
end;
$$;

create or replace function public.waive_usage_log(p_reservation_id uuid, p_manager_pin text, p_note text)
returns setof public.usage_logs language plpgsql security definer set search_path = public as $$
declare v_r public.reservations%rowtype; v_name text; v_id uuid;
begin
  select * into v_r from public.reservations where id = p_reservation_id;
  if not found or v_r.status <> 'booked' then raise exception '예약을 찾을 수 없습니다.'; end if;
  if v_r.log_id is not null then raise exception '이미 로그가 있는 예약입니다.'; end if;
  if not public.verify_equipment_manager(v_r.equipment_id, p_manager_pin) then raise exception '장비 담당자 PIN이 올바르지 않습니다.'; end if;
  select name into v_name from public.profiles where id = auth.uid();
  insert into public.usage_logs (reservation_id, equipment_id, user_id, user_name, used_start, used_end, condition, content, waived, waived_by)
  values (p_reservation_id, v_r.equipment_id, v_r.user_id, v_r.user_name, v_r.start_at, v_r.end_at, 'normal', coalesce(p_note, ''), true, coalesce(v_name, ''))
  returning id into v_id;
  update public.reservations set log_id = v_id where id = p_reservation_id;
  return query select * from public.usage_logs where id = v_id;
end;
$$;

revoke all on function public.verify_equipment_manager(uuid, text) from public;
revoke all on function public.grant_equipment_user(uuid, text, text, text) from public;
revoke all on function public.set_equipment_user_grade(uuid, text, uuid, text) from public;
revoke all on function public.revoke_equipment_user(uuid, text, uuid) from public;
revoke all on function public.create_reservation(uuid, timestamptz, timestamptz, text) from public;
revoke all on function public.update_reservation(uuid, timestamptz, timestamptz, text, text) from public;
revoke all on function public.cancel_reservation(uuid, text) from public;
revoke all on function public.create_usage_log(uuid, timestamptz, timestamptz, text, text, text) from public;
revoke all on function public.waive_usage_log(uuid, text, text) from public;
grant execute on function public.verify_equipment_manager(uuid, text) to authenticated;
grant execute on function public.grant_equipment_user(uuid, text, text, text) to authenticated;
grant execute on function public.set_equipment_user_grade(uuid, text, uuid, text) to authenticated;
grant execute on function public.revoke_equipment_user(uuid, text, uuid) to authenticated;
grant execute on function public.create_reservation(uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.update_reservation(uuid, timestamptz, timestamptz, text, text) to authenticated;
grant execute on function public.cancel_reservation(uuid, text) to authenticated;
grant execute on function public.create_usage_log(uuid, timestamptz, timestamptz, text, text, text) to authenticated;
grant execute on function public.waive_usage_log(uuid, text, text) to authenticated;

alter table public.equipment       enable row level security;
alter table public.equipment_users enable row level security;
alter table public.reservations    enable row level security;
alter table public.usage_logs      enable row level security;

drop policy if exists "equipment: admin all"        on public.equipment;
drop policy if exists "equipment_users: admin all"  on public.equipment_users;
drop policy if exists "reservations: read all"      on public.reservations;
drop policy if exists "reservations: admin all"     on public.reservations;
drop policy if exists "usage_logs: read all"        on public.usage_logs;
drop policy if exists "usage_logs: admin all"       on public.usage_logs;
create policy "equipment: admin all"       on public.equipment       for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "equipment_users: admin all" on public.equipment_users for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "reservations: read all"     on public.reservations    for select to authenticated using (true);
create policy "reservations: admin all"    on public.reservations    for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "usage_logs: read all"       on public.usage_logs      for select to authenticated using (true);
create policy "usage_logs: admin all"      on public.usage_logs      for all    to authenticated using (public.is_admin()) with check (public.is_admin());

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reservations') then
    alter publication supabase_realtime add table public.reservations;
  end if;
end $$;

-- =====================================================================
-- 출석 시트
--   구성원은 auth 계정 + 출석 PIN(해시)으로 확인. 출석 체크·휴가 신청은 서버 함수가 규칙을 강제합니다.
--   시간 판정은 Asia/Seoul 기준. 규칙 값은 attendance_settings 에서 바꿉니다.
-- =====================================================================
create table if not exists public.attendance_settings (key text primary key, value text not null);
insert into public.attendance_settings (key, value) values ('open_after', '06:00'), ('late_after', '09:00'), ('close_after', '11:00'), ('vacation_per_half', '2'), ('self_register', 'true')
on conflict (key) do nothing;
create or replace function public.att_setting(p_key text) returns text language sql stable security definer set search_path = public as $$
  select value from public.attendance_settings where key = p_key;
$$;

create table if not exists public.attendance_members (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users (id),
  name        text not null,
  name_key    text not null unique,
  pin_hash    text not null,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create table if not exists public.attendance_records (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.attendance_members (id) on delete cascade,
  name         text not null default '',
  date         date not null,
  status       text not null check (status in ('present', 'late', 'excused')),
  check_in_at  timestamptz not null default now(),
  reason       text not null default '',
  created_at   timestamptz not null default now(),
  edited_by    text,
  unique (member_id, date)
);
create table if not exists public.attendance_leaves (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references public.attendance_members (id) on delete cascade,
  name        text not null default '',
  type        text not null check (type in ('vacation', 'trip')),
  start_date  date not null,
  end_date    date not null,
  days        integer not null default 0,
  reason      text not null default '',
  created_at  timestamptz not null default now(),
  check (end_date >= start_date)
);
create table if not exists public.attendance_holidays (date date primary key, label text not null default '');

drop view if exists public.attendance_members_public;
create view public.attendance_members_public as select id, name, active, created_at from public.attendance_members;
alter view public.attendance_members_public set (security_invoker = false);
grant select on public.attendance_members_public to authenticated;

create or replace function public.att_is_workday(p_date date) returns boolean language sql stable security definer set search_path = public as $$
  select extract(isodow from p_date) < 6 and not exists (select 1 from public.attendance_holidays h where h.date = p_date);
$$;

-- 이전 버전(출석 전용 PIN) 함수 정리
drop function if exists public.att_login(text, text);
drop function if exists public.att_change_pin(text, text);
drop function if exists public.att_check_in(text, text);
drop function if exists public.att_request_leave(text, text, date, date, text);
drop function if exists public.att_delete_leave(text, uuid);
drop function if exists public.att_member_for(text);

-- 포털(auth) 계정으로 출석 구성원 자동 연결: 승인된 계정만, 이름 기준으로 찾고 없으면 생성
create or replace function public.att_login_portal()
returns setof public.attendance_members_public language plpgsql security definer set search_path = public as $$
declare v_name text; v_key text; v_m public.attendance_members%rowtype;
begin
  if not public.is_active() then raise exception '승인된 계정만 출석을 사용할 수 있습니다.'; end if;
  select coalesce(name, split_part(email, '@', 1)) into v_name from public.profiles where id = auth.uid();
  v_key := public.name_key(v_name);
  select * into v_m from public.attendance_members where user_id = auth.uid();
  if not found then select * into v_m from public.attendance_members where name_key = v_key; end if;
  if not found then
    insert into public.attendance_members (user_id, name, name_key, pin_hash) values (auth.uid(), v_name, v_key, '') returning * into v_m;
  elsif v_m.user_id is null then
    update public.attendance_members set user_id = auth.uid() where id = v_m.id;
  end if;
  if not v_m.active then raise exception '출석 사용이 중지된 구성원입니다.'; end if;
  return query select * from public.attendance_members_public where id = v_m.id;
end;
$$;

create or replace function public.att_member_for() returns public.attendance_members language plpgsql stable security definer set search_path = public as $$
declare v_m public.attendance_members%rowtype;
begin
  if not public.is_active() then raise exception '승인된 계정만 출석을 사용할 수 있습니다.'; end if;
  select * into v_m from public.attendance_members where user_id = auth.uid() and active;
  if not found then raise exception '출석 구성원 연결이 필요합니다. 페이지를 새로고침하세요.'; end if;
  return v_m;
end;
$$;

create or replace function public.att_check_in(p_reason text)
returns setof public.attendance_records language plpgsql security definer set search_path = public as $$
declare v_m public.attendance_members%rowtype; v_now timestamptz := now(); v_local timestamp; v_today date; v_hm text; v_status text; v_id uuid; v_leave record;
begin
  v_m := public.att_member_for();
  v_local := timezone('Asia/Seoul', v_now); v_today := v_local::date; v_hm := to_char(v_local, 'HH24:MI');
  if extract(isodow from v_today) >= 6 then raise exception '주말에는 출석 체크가 없습니다.'; end if;
  if exists (select 1 from public.attendance_holidays h where h.date = v_today) then raise exception '공휴일에는 출석 체크가 없습니다.'; end if;
  select * into v_leave from public.attendance_leaves l where l.member_id = v_m.id and l.start_date <= v_today and v_today <= l.end_date limit 1;
  if found then raise exception '오늘은 %으로 등록되어 있어 출석 체크를 하지 않습니다.', case when v_leave.type = 'trip' then '출장' else '휴가' end; end if;
  if exists (select 1 from public.attendance_records r where r.member_id = v_m.id and r.date = v_today) then raise exception '오늘은 이미 출석 체크를 했습니다.'; end if;
  if v_hm < coalesce(public.att_setting('open_after'), '06:00') then raise exception '출석 가능 시간은 % ~ % 입니다.', coalesce(public.att_setting('open_after'), '06:00'), public.att_setting('close_after'); end if;
  if v_hm >= public.att_setting('close_after') then raise exception '% 이후에는 출석 체크를 할 수 없습니다. 오늘은 미기입(결근)으로 처리됩니다.', public.att_setting('close_after'); end if;
  v_status := case when v_hm < public.att_setting('late_after') then 'present' when coalesce(trim(p_reason), '') <> '' then 'excused' else 'late' end;
  insert into public.attendance_records (member_id, name, date, status, check_in_at, reason)
  values (v_m.id, v_m.name, v_today, v_status, v_now, case when v_status = 'present' then '' else coalesce(trim(p_reason), '') end) returning id into v_id;
  return query select * from public.attendance_records where id = v_id;
end;
$$;

create or replace function public.att_workdays(p_from date, p_to date) returns integer language sql stable security definer set search_path = public as $$
  select count(*)::int from generate_series(p_from, p_to, interval '1 day') d where public.att_is_workday(d::date);
$$;

create or replace function public.att_request_leave(p_type text, p_start date, p_end date, p_reason text)
returns setof public.attendance_leaves language plpgsql security definer set search_path = public as $$
declare v_m public.attendance_members%rowtype; v_days int; v_id uuid; v_half record; v_limit int; v_used int;
begin
  v_m := public.att_member_for();
  if p_type not in ('vacation', 'trip') then raise exception '종류를 확인하세요.'; end if;
  if p_end < p_start then raise exception '날짜를 확인하세요.'; end if;
  if p_type = 'trip' and coalesce(trim(p_reason), '') = '' then raise exception '출장 사유를 입력하세요.'; end if;
  v_days := public.att_workdays(p_start, p_end);
  if v_days <= 0 then raise exception '선택한 기간에 근무일이 없습니다.'; end if;
  if exists (select 1 from public.attendance_leaves l where l.member_id = v_m.id and l.start_date <= p_end and p_start <= l.end_date) then raise exception '이미 같은 기간에 휴가·출장이 등록되어 있습니다.'; end if;
  if exists (select 1 from public.attendance_records r where r.member_id = v_m.id and r.date between p_start and p_end) then raise exception '해당 기간에 이미 출석 기록이 있습니다.'; end if;
  if p_type = 'vacation' then
    v_limit := coalesce(public.att_setting('vacation_per_half')::int, 2);
    for v_half in
      select extract(year from d)::int as y, case when extract(month from d) <= 6 then 1 else 2 end as h, count(*)::int as n
      from generate_series(p_start, p_end, interval '1 day') d where public.att_is_workday(d::date) group by 1, 2
    loop
      select coalesce(sum(public.att_workdays(greatest(l.start_date, make_date(v_half.y, case when v_half.h = 1 then 1 else 7 end, 1)),
                                              least(l.end_date, make_date(v_half.y, case when v_half.h = 1 then 6 else 12 end, case when v_half.h = 1 then 30 else 31 end)))), 0)
      into v_used from public.attendance_leaves l
      where l.member_id = v_m.id and l.type = 'vacation'
        and l.end_date >= make_date(v_half.y, case when v_half.h = 1 then 1 else 7 end, 1)
        and l.start_date <= make_date(v_half.y, case when v_half.h = 1 then 6 else 12 end, case when v_half.h = 1 then 30 else 31 end);
      if v_used + v_half.n > v_limit then raise exception '%년 % 휴가는 %일까지입니다. (사용 %일, 신청 %일)', v_half.y, case when v_half.h = 1 then '상반기' else '하반기' end, v_limit, v_used, v_half.n; end if;
    end loop;
  end if;
  insert into public.attendance_leaves (member_id, name, type, start_date, end_date, days, reason)
  values (v_m.id, v_m.name, p_type, p_start, p_end, v_days, coalesce(trim(p_reason), '')) returning id into v_id;
  return query select * from public.attendance_leaves where id = v_id;
end;
$$;

create or replace function public.att_delete_leave(p_id uuid) returns void language plpgsql security definer set search_path = public as $$
declare v_m public.attendance_members%rowtype;
begin
  v_m := public.att_member_for();
  delete from public.attendance_leaves where id = p_id and member_id = v_m.id and start_date >= (timezone('Asia/Seoul', now()))::date;
  if not found then raise exception '본인의 시작 전 신청만 취소할 수 있습니다.'; end if;
end;
$$;

create or replace function public.att_set_holidays(p_holidays jsonb) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception '관리자만 공휴일을 바꿀 수 있습니다.'; end if;
  delete from public.attendance_holidays;
  insert into public.attendance_holidays (date, label) select (x->>'date')::date, coalesce(x->>'label', '') from jsonb_array_elements(coalesce(p_holidays, '[]'::jsonb)) x;
end;
$$;

revoke all on function public.att_login_portal() from public;
revoke all on function public.att_check_in(text) from public;
revoke all on function public.att_request_leave(text, date, date, text) from public;
revoke all on function public.att_delete_leave(uuid) from public;
revoke all on function public.att_set_holidays(jsonb) from public;
grant execute on function public.att_login_portal() to authenticated;
grant execute on function public.att_check_in(text) to authenticated;
grant execute on function public.att_request_leave(text, date, date, text) to authenticated;
grant execute on function public.att_delete_leave(uuid) to authenticated;
grant execute on function public.att_set_holidays(jsonb) to authenticated;

alter table public.attendance_settings enable row level security;
alter table public.attendance_members  enable row level security;
alter table public.attendance_records  enable row level security;
alter table public.attendance_leaves   enable row level security;
alter table public.attendance_holidays enable row level security;
drop policy if exists "att_settings: admin all" on public.attendance_settings;
drop policy if exists "att_members: admin all"  on public.attendance_members;
drop policy if exists "att_records: read all"   on public.attendance_records;
drop policy if exists "att_records: admin all"  on public.attendance_records;
drop policy if exists "att_leaves: read all"    on public.attendance_leaves;
drop policy if exists "att_leaves: admin all"   on public.attendance_leaves;
drop policy if exists "att_holidays: read all"  on public.attendance_holidays;
create policy "att_settings: admin all" on public.attendance_settings for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "att_members: admin all"  on public.attendance_members  for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "att_records: read all"   on public.attendance_records  for select to authenticated using (true);
create policy "att_records: admin all"  on public.attendance_records  for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "att_leaves: read all"    on public.attendance_leaves   for select to authenticated using (true);
create policy "att_leaves: admin all"   on public.attendance_leaves   for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "att_holidays: read all"  on public.attendance_holidays for select to authenticated using (true);

-- =====================================================================
-- 소모품 재고
--   관리자가 중간 관리자(PIN)를 두고, 중간 관리자가 품목·보유량·단가를 등록/입고/조정.
--   구성원은 소모 처리(재고 차감)만 하며 모든 변동은 inventory_moves 에 남습니다.
-- =====================================================================
create table if not exists public.inventory_managers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  area        text not null default '',
  pin_hash    text not null,
  created_at  timestamptz not null default now()
);
create table if not exists public.inventory_items (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  category    text not null default '',
  unit        text not null default '개',
  location    text not null default '',
  qty         numeric not null default 0 check (qty >= 0),
  unit_price  bigint not null default 0,
  min_qty     numeric not null default 0,
  note        text not null default '',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists public.inventory_moves (
  id           uuid primary key default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  item_id      uuid not null references public.inventory_items (id) on delete cascade,
  item_name    text not null default '',
  location     text not null default '',
  type         text not null check (type in ('init', 'in', 'out', 'adjust')),
  qty          numeric not null,
  unit_price   bigint not null default 0,
  user_name    text not null default '',
  note         text not null default '',
  stock_after  numeric not null default 0
);
create index if not exists inventory_moves_item_idx on public.inventory_moves (item_id, created_at desc);

drop view if exists public.inventory_managers_public;
create view public.inventory_managers_public as select id, name, area, created_at from public.inventory_managers;
alter view public.inventory_managers_public set (security_invoker = false);
grant select on public.inventory_managers_public to authenticated;

create or replace function public.inv_verify_manager(p_manager_id uuid, p_pin text) returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.inventory_managers m where m.id = p_manager_id and m.pin_hash = encode(digest(coalesce(p_pin, ''), 'sha256'), 'hex'));
$$;

create or replace function public.inv_save_item(p_manager_id uuid, p_pin text, p_item jsonb)
returns setof public.inventory_items language plpgsql security definer set search_path = public as $$
declare v_mgr text; v_id uuid; v_cur public.inventory_items%rowtype; v_qty numeric; v_price bigint;
begin
  if not public.inv_verify_manager(p_manager_id, p_pin) then raise exception '담당자 PIN이 올바르지 않습니다.'; end if;
  select name into v_mgr from public.inventory_managers where id = p_manager_id;
  if coalesce(trim(p_item->>'name'), '') = '' then raise exception '품목명을 입력하세요.'; end if;
  v_qty := greatest(0, coalesce((p_item->>'qty')::numeric, 0));
  v_price := greatest(0, coalesce((p_item->>'unit_price')::bigint, 0));
  if p_item->>'id' is null or p_item->>'id' = '' then
    insert into public.inventory_items (name, category, unit, location, qty, unit_price, min_qty, note, active)
    values (trim(p_item->>'name'), coalesce(p_item->>'category', ''), coalesce(nullif(p_item->>'unit', ''), '개'), coalesce(p_item->>'location', ''), v_qty, v_price,
            coalesce((p_item->>'min_qty')::numeric, 0), coalesce(p_item->>'note', ''), coalesce((p_item->>'active')::boolean, true))
    returning id into v_id;
    insert into public.inventory_moves (item_id, item_name, location, type, qty, unit_price, user_name, note, stock_after)
    values (v_id, trim(p_item->>'name'), coalesce(p_item->>'location', ''), 'init', v_qty, v_price, coalesce(v_mgr, ''), '초기 보유량', v_qty);
  else
    v_id := (p_item->>'id')::uuid;
    select * into v_cur from public.inventory_items where id = v_id;
    if not found then raise exception '품목을 찾을 수 없습니다.'; end if;
    update public.inventory_items set name = trim(p_item->>'name'), category = coalesce(p_item->>'category', ''), unit = coalesce(nullif(p_item->>'unit', ''), unit),
      location = coalesce(p_item->>'location', ''), qty = v_qty, unit_price = v_price, min_qty = coalesce((p_item->>'min_qty')::numeric, 0),
      note = coalesce(p_item->>'note', ''), active = coalesce((p_item->>'active')::boolean, true), updated_at = now() where id = v_id;
    if v_qty <> v_cur.qty then
      insert into public.inventory_moves (item_id, item_name, location, type, qty, unit_price, user_name, note, stock_after)
      values (v_id, trim(p_item->>'name'), coalesce(p_item->>'location', ''), 'adjust', v_qty - v_cur.qty, v_price, coalesce(v_mgr, ''), coalesce(nullif(p_item->>'adjust_note', ''), '재고 조정'), v_qty);
    end if;
  end if;
  return query select * from public.inventory_items where id = v_id;
end;
$$;

create or replace function public.inv_delete_item(p_manager_id uuid, p_pin text, p_item_id uuid) returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.inv_verify_manager(p_manager_id, p_pin) then raise exception '담당자 PIN이 올바르지 않습니다.'; end if;
  if exists (select 1 from public.inventory_moves where item_id = p_item_id and type = 'out') then raise exception '소모 기록이 있는 품목은 삭제할 수 없습니다. 사용 중지로 바꾸세요.'; end if;
  delete from public.inventory_items where id = p_item_id;
end;
$$;

create or replace function public.inv_restock(p_manager_id uuid, p_pin text, p_item_id uuid, p_qty numeric, p_unit_price bigint, p_note text)
returns setof public.inventory_items language plpgsql security definer set search_path = public as $$
declare v_mgr text; v_it public.inventory_items%rowtype; v_price bigint;
begin
  if not public.inv_verify_manager(p_manager_id, p_pin) then raise exception '담당자 PIN이 올바르지 않습니다.'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception '입고 수량은 0보다 커야 합니다.'; end if;
  select name into v_mgr from public.inventory_managers where id = p_manager_id;
  select * into v_it from public.inventory_items where id = p_item_id for update;
  if not found then raise exception '품목을 찾을 수 없습니다.'; end if;
  v_price := case when coalesce(p_unit_price, 0) > 0 then p_unit_price else v_it.unit_price end;
  update public.inventory_items set qty = qty + p_qty, unit_price = v_price, updated_at = now() where id = p_item_id;
  insert into public.inventory_moves (item_id, item_name, location, type, qty, unit_price, user_name, note, stock_after)
  values (p_item_id, v_it.name, v_it.location, 'in', p_qty, v_price, coalesce(v_mgr, ''), coalesce(p_note, ''), v_it.qty + p_qty);
  return query select * from public.inventory_items where id = p_item_id;
end;
$$;

create or replace function public.inv_consume(p_item_id uuid, p_qty numeric, p_note text)
returns setof public.inventory_moves language plpgsql security definer set search_path = public as $$
declare v_it public.inventory_items%rowtype; v_name text; v_id uuid;
begin
  if not public.is_active() then raise exception '승인된 계정만 소모 처리할 수 있습니다.'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception '수량은 0보다 커야 합니다.'; end if;
  select * into v_it from public.inventory_items where id = p_item_id and active for update;
  if not found then raise exception '소모 처리할 수 없는 품목입니다.'; end if;
  if p_qty > v_it.qty then raise exception '재고(%)보다 많습니다. 담당자에게 알려주세요.', v_it.qty; end if;
  select name into v_name from public.profiles where id = auth.uid();
  update public.inventory_items set qty = qty - p_qty, updated_at = now() where id = p_item_id;
  insert into public.inventory_moves (item_id, item_name, location, type, qty, unit_price, user_name, note, stock_after)
  values (p_item_id, v_it.name, v_it.location, 'out', p_qty, v_it.unit_price, coalesce(v_name, ''), coalesce(p_note, ''), v_it.qty - p_qty) returning id into v_id;
  return query select * from public.inventory_moves where id = v_id;
end;
$$;

revoke all on function public.inv_verify_manager(uuid, text) from public;
revoke all on function public.inv_save_item(uuid, text, jsonb) from public;
revoke all on function public.inv_delete_item(uuid, text, uuid) from public;
revoke all on function public.inv_restock(uuid, text, uuid, numeric, bigint, text) from public;
revoke all on function public.inv_consume(uuid, numeric, text) from public;
grant execute on function public.inv_verify_manager(uuid, text) to authenticated;
grant execute on function public.inv_save_item(uuid, text, jsonb) to authenticated;
grant execute on function public.inv_delete_item(uuid, text, uuid) to authenticated;
grant execute on function public.inv_restock(uuid, text, uuid, numeric, bigint, text) to authenticated;
grant execute on function public.inv_consume(uuid, numeric, text) to authenticated;

alter table public.inventory_managers enable row level security;
alter table public.inventory_items    enable row level security;
alter table public.inventory_moves    enable row level security;
drop policy if exists "inv_managers: admin all" on public.inventory_managers;
drop policy if exists "inv_items: read all"     on public.inventory_items;
drop policy if exists "inv_items: admin all"    on public.inventory_items;
drop policy if exists "inv_moves: read all"     on public.inventory_moves;
drop policy if exists "inv_moves: admin all"    on public.inventory_moves;
create policy "inv_managers: admin all" on public.inventory_managers for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "inv_items: read all"     on public.inventory_items    for select to authenticated using (true);
create policy "inv_items: admin all"    on public.inventory_items    for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "inv_moves: read all"     on public.inventory_moves    for select to authenticated using (true);
create policy "inv_moves: admin all"    on public.inventory_moves    for all    to authenticated using (public.is_admin()) with check (public.is_admin());

-- =====================================================================
-- 보안 이벤트 (로그인 실패·잠금·매크로 의심). 관리자만 열람, 기록은 누구나(로그인 전 포함) 남길 수 있음
-- =====================================================================
create table if not exists public.security_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  type        text not null,
  severity    text not null default 'low' check (severity in ('low', 'high')),
  name        text not null default '',
  detail      text not null default '',
  page        text not null default '',
  user_agent  text not null default '',
  user_id     uuid
);
create index if not exists security_events_created_idx on public.security_events (created_at desc);

create or replace function public.log_security_event(p_type text, p_severity text, p_name text, p_detail text, p_page text, p_user_agent text)
returns void language sql security definer set search_path = public as $$
  insert into public.security_events (type, severity, name, detail, page, user_agent, user_id)
  values (left(coalesce(p_type, 'other'), 40), case when p_severity = 'high' then 'high' else 'low' end, left(coalesce(p_name, ''), 80), left(coalesce(p_detail, ''), 400), left(coalesce(p_page, ''), 80), left(coalesce(p_user_agent, ''), 160), auth.uid());
$$;
revoke all on function public.log_security_event(text, text, text, text, text, text) from public;
grant execute on function public.log_security_event(text, text, text, text, text, text) to anon, authenticated;

alter table public.security_events enable row level security;
drop policy if exists "security: admin read" on public.security_events;
create policy "security: admin read" on public.security_events for select to authenticated using (public.is_admin());

-- 실시간 알림을 이메일/웹훅으로 보내려면 Database Webhooks(Dashboard > Database > Webhooks)에서
-- security_events INSERT 를 Slack/Discord/이메일 서비스로 연결하세요. 웹훅 주소가 코드에 노출되지 않습니다.

-- (선택) 특정 도메인만 가입 허용하려면 Supabase Dashboard > Authentication > Settings 에서
-- "Restrict sign-ups to email domains" 에 kaist.ac.kr 을 추가하세요.
