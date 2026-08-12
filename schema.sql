-- =====================================================================
--  가족 메신저 — 데이터베이스 스키마
--  Supabase 대시보드 > SQL Editor 에 통째로 붙여넣고 실행하세요.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------

-- 가족 구성원 프로필
create table if not exists public.profiles (
  id           uuid primary key references auth.users on delete cascade,
  display_name text not null,
  color        text not null default '#4A82C4',
  created_at   timestamptz not null default now()
);

-- 채팅방
create table if not exists public.rooms (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

-- 방 참여자. 여기서 마지막 한 명이 빠지면 방이 통째로 삭제됩니다.
create table if not exists public.room_members (
  room_id      uuid not null references public.rooms(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  joined_at    timestamptz not null default now(),
  last_read_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

-- 메시지 (첨부파일은 Storage 에 두고 경로만 저장)
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  room_id         uuid not null references public.rooms(id) on delete cascade,
  sender_id       uuid references public.profiles(id) on delete set null,
  body            text,
  attachment_path text,
  attachment_name text,
  attachment_type text,
  attachment_size bigint,
  created_at      timestamptz not null default now()
);

create index if not exists messages_room_time_idx
  on public.messages (room_id, created_at desc);

-- PostgreSQL 은 외래키에 인덱스를 자동 생성하지 않습니다.
-- 계정 삭제 시 연쇄 처리와, 알림 보낼 때 구독 조회에 쓰입니다.
create index if not exists messages_sender_idx   on public.messages (sender_id);
create index if not exists room_members_user_idx on public.room_members (user_id);
create index if not exists rooms_created_by_idx  on public.rooms (created_by);
create index if not exists profiles_color_idx    on public.profiles (color);

-- 웹 푸시 구독 정보 (기기 하나당 한 줄)
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);

create index if not exists push_subs_user_idx on public.push_subscriptions (user_id);


-- ---------------------------------------------------------------------
-- 2. 헬퍼 함수
--    RLS 정책 안에서 room_members 를 직접 조회하면 무한 재귀가 납니다.
--    security definer 함수로 우회합니다.
-- ---------------------------------------------------------------------

create or replace function public.is_member(p_room uuid, p_user uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.room_members
    where room_id = p_room and user_id = p_user
  );
$$;


-- Storage 경로의 첫 폴더명을 안전하게 uuid 로 바꿉니다.
-- 바로 ::uuid 캐스팅하면, UUID 가 아닌 폴더에 놓인 파일이 하나라도 있을 때
-- 그 버킷 조회 전체가 에러로 실패합니다.
create or replace function public.safe_uuid(t text)
returns uuid
language plpgsql
immutable
as $$
begin
  if t is null or t !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  then
    return null;
  end if;
  return t::uuid;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. 트리거
-- ---------------------------------------------------------------------

-- 3-1. 회원가입하면 프로필을 자동으로 만들고, 가족 색을 하나 배정합니다.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  palette text[] := array[
    '#E8913A',  -- 감귤
    '#3FA98A',  -- 청옥
    '#D9604F',  -- 홍시
    '#4A82C4',  -- 쪽빛
    '#8C6FD1',  -- 라일락
    '#B59A2E'   -- 황토
  ];
  chosen text;
begin
  -- 아직 아무도 안 쓰는 색을 앞에서부터 고릅니다.
  -- count(*) 로 순번을 매기면 탈퇴 후 재가입 때 색이 겹치고,
  -- random()/hashtext() 로 뽑으면 6색에 5명이 겹칠 확률이 90%가 넘습니다.
  perform pg_advisory_xact_lock(hashtext('profile_color'));

  select t.c into chosen
  from unnest(palette) with ordinality as t(c, ord)
  where not exists (select 1 from public.profiles p where p.color = t.c)
  order by t.ord
  limit 1;

  insert into public.profiles (id, display_name, color)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data->>'display_name', ''),
      split_part(new.email, '@', 1)
    ),
    -- 팔레트를 다 쓴 7번째 사람부터는 아무 색이나
    coalesce(chosen, palette[1 + floor(random() * array_length(palette, 1))::int])
  );

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- 3-2. 요구사항 3번: 마지막 참여자가 나가면 방과 메시지가 전부 사라집니다.
--      messages 의 FK 가 on delete cascade 라 방만 지우면 메시지도 함께 삭제됩니다.
create or replace function public.delete_room_if_empty()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.room_members where room_id = old.room_id
  ) then
    delete from public.rooms where id = old.room_id;
  end if;
  return old;
end;
$$;

drop trigger if exists trg_delete_room_if_empty on public.room_members;
create trigger trg_delete_room_if_empty
  after delete on public.room_members
  for each row execute function public.delete_room_if_empty();


-- ---------------------------------------------------------------------
-- 4. RLS (Row Level Security)
--    가족끼리 쓰는 앱이므로 서로의 프로필과 방 목록은 모두 공개,
--    대화 내용만 참여자에게 제한합니다.
-- ---------------------------------------------------------------------

alter table public.profiles           enable row level security;
alter table public.rooms              enable row level security;
alter table public.room_members       enable row level security;
alter table public.messages           enable row level security;
alter table public.push_subscriptions enable row level security;

-- 프로필
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- 방: 목록은 모두 볼 수 있고, 누구나 만들 수 있습니다.
drop policy if exists rooms_read   on public.rooms;
drop policy if exists rooms_insert on public.rooms;
create policy rooms_read   on public.rooms for select to authenticated using (true);
create policy rooms_insert on public.rooms for insert to authenticated
  with check (created_by = (select auth.uid()));

-- 참여자: 누가 어느 방에 있는지는 공개, 들어가고 나가는 건 본인만.
drop policy if exists members_read   on public.room_members;
drop policy if exists members_insert on public.room_members;
drop policy if exists members_update on public.room_members;
drop policy if exists members_delete on public.room_members;
create policy members_read   on public.room_members for select to authenticated using (true);
create policy members_insert on public.room_members for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy members_update on public.room_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy members_delete on public.room_members for delete to authenticated
  using (user_id = (select auth.uid()));

-- 메시지: 참여 중인 방만 읽고 쓸 수 있습니다.
drop policy if exists messages_read   on public.messages;
drop policy if exists messages_insert on public.messages;
drop policy if exists messages_delete on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (public.is_member(room_id, (select auth.uid())));
create policy messages_insert on public.messages for insert to authenticated
  with check (sender_id = (select auth.uid()) and public.is_member(room_id, (select auth.uid())));
create policy messages_delete on public.messages for delete to authenticated
  using (sender_id = (select auth.uid()));

-- 푸시 구독: 본인 것만.
drop policy if exists push_all on public.push_subscriptions;
create policy push_all on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 5. Realtime 활성화 (요구사항 6번: 실시간 반영)
-- ---------------------------------------------------------------------

do $$
begin
  begin execute 'alter publication supabase_realtime add table public.messages';     exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.rooms';        exception when duplicate_object then null; end;
  begin execute 'alter publication supabase_realtime add table public.room_members'; exception when duplicate_object then null; end;
end $$;


-- ---------------------------------------------------------------------
-- 6. Storage (요구사항 4번: 사진 / 동영상 / 음성 / 파일)
--    비공개 버킷을 만들고, 방 참여자만 읽고 쓰게 합니다.
--    파일 경로 규칙: {room_id}/{uuid}-{파일명}
-- ---------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 52428800)  -- 50MB
on conflict (id) do nothing;

drop policy if exists attachments_read   on storage.objects;
drop policy if exists attachments_write  on storage.objects;
drop policy if exists attachments_delete on storage.objects;

create policy attachments_read on storage.objects for select to authenticated
using (
  bucket_id = 'attachments'
  and public.is_member(public.safe_uuid((storage.foldername(name))[1]), (select auth.uid()))
);

create policy attachments_write on storage.objects for insert to authenticated
with check (
  bucket_id = 'attachments'
  and public.is_member(public.safe_uuid((storage.foldername(name))[1]), (select auth.uid()))
);

create policy attachments_delete on storage.objects for delete to authenticated
using (
  bucket_id = 'attachments'
  and public.is_member(public.safe_uuid((storage.foldername(name))[1]), (select auth.uid()))
);
