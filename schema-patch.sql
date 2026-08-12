-- =====================================================================
--  schema-patch.sql — 검토 반영 수정본
--
--  이미 schema.sql 을 실행한 프로젝트에 그대로 덧붙여 실행하세요.
--  여러 번 실행해도 안전합니다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Storage 경로 캐스팅 사고 방지
--
--    문제: 정책이 ((storage.foldername(name))[1])::uuid 로 바로 캐스팅합니다.
--    attachments 버킷에 UUID 가 아닌 폴더명을 가진 파일이 단 하나라도 있으면
--    (예: 대시보드에서 손으로 올린 temp/note.txt)
--    "invalid input syntax for type uuid" 가 나면서 그 버킷의 조회가
--    모든 사용자에게 통째로 실패합니다. 사진이 전부 안 보이게 됩니다.
--
--    참고: 최상위에 올린 파일(폴더 없음)은 NULL 이 되어 에러가 아니라 거부됩니다.
--    문제가 되는 건 "UUID 가 아닌 폴더명" 뿐입니다.
-- ---------------------------------------------------------------------

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


-- ---------------------------------------------------------------------
-- 2. 색 배정 방식 교체
--
--    문제: count(*) 로 순번을 매기면 "탈퇴 후 재가입" 때 색이 겹칩니다.
--    3명(색 1,2,3) → 2번이 탈퇴 → 새 가입자는 count=2 → 3번째 색 배정
--    → 이미 쓰고 있는 색과 충돌. 사람마다 다른 색이 이 앱의 핵심 장치이므로
--    실제로 불편합니다.
--
--    해결: 아직 아무도 안 쓰는 색을 앞에서부터 고릅니다.
--    동시 가입 대비로 짧은 잠금을 겁니다 (트랜잭션 끝나면 자동 해제).
--
--    주의: random()/hashtext() 로 바꾸면 안 됩니다. 6색에 5명을 무작위로
--    배정하면 누군가 색이 겹칠 확률이 90.7% 입니다.
-- ---------------------------------------------------------------------

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


-- ---------------------------------------------------------------------
-- 3. 외래키 인덱스
--
--    PostgreSQL 은 FK 에 인덱스를 자동으로 만들지 않습니다.
--    아래 네 개가 비어 있었습니다.
--    특히 push_subscriptions(user_id) 는 메시지가 올 때마다 조회되므로
--    알림 지연에 직접 영향을 줍니다.
-- ---------------------------------------------------------------------

create index if not exists room_members_user_idx  on public.room_members (user_id);
create index if not exists messages_sender_idx    on public.messages (sender_id);
create index if not exists push_subs_user_idx     on public.push_subscriptions (user_id);
create index if not exists rooms_created_by_idx   on public.rooms (created_by);

-- 색 중복을 눈으로 확인할 때 쓰는 보조 인덱스 (2번 로직이 매 가입마다 조회)
create index if not exists profiles_color_idx     on public.profiles (color);


-- ---------------------------------------------------------------------
-- 4. RLS 정책에서 auth.uid() 를 한 번만 계산하도록
--
--    (select auth.uid()) 로 감싸면 행마다 다시 계산하지 않고
--    쿼리당 한 번만 평가됩니다. Supabase 공식 권장 패턴입니다.
--    메시지 500건 조회에서 체감 차이는 작지만, 공짜라 적용합니다.
-- ---------------------------------------------------------------------

drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

drop policy if exists rooms_insert on public.rooms;
create policy rooms_insert on public.rooms for insert to authenticated
  with check (created_by = (select auth.uid()));

drop policy if exists members_insert on public.room_members;
drop policy if exists members_update on public.room_members;
drop policy if exists members_delete on public.room_members;
create policy members_insert on public.room_members for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy members_update on public.room_members for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy members_delete on public.room_members for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists messages_read   on public.messages;
drop policy if exists messages_insert on public.messages;
drop policy if exists messages_delete on public.messages;
create policy messages_read on public.messages for select to authenticated
  using (public.is_member(room_id, (select auth.uid())));
create policy messages_insert on public.messages for insert to authenticated
  with check (
    sender_id = (select auth.uid())
    and public.is_member(room_id, (select auth.uid()))
  );
create policy messages_delete on public.messages for delete to authenticated
  using (sender_id = (select auth.uid()));

drop policy if exists push_all on public.push_subscriptions;
create policy push_all on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));


-- ---------------------------------------------------------------------
-- 5. 이미 들어간 오염 파일이 있는지 점검
--
--    아래 쿼리로 UUID 가 아닌 폴더에 놓인 파일을 찾을 수 있습니다.
--    1번 수정으로 에러는 안 나지만, 접근이 영영 불가능한 파일이므로
--    발견되면 대시보드에서 지우는 편이 낫습니다.
-- ---------------------------------------------------------------------

-- select name from storage.objects
-- where bucket_id = 'attachments'
--   and public.safe_uuid((storage.foldername(name))[1]) is null;
