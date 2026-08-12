-- =====================================================================
--  notice.sql — 방마다 공지 배너 추가
--
--  이미 돌아가는 DB 에 덧붙이는 패치입니다.
--  Supabase 대시보드 > SQL Editor 에 붙여넣고 실행하세요.
--  여러 번 실행해도 안전합니다.
-- =====================================================================

-- 1. rooms 에 공지 칸을 만듭니다.
alter table public.rooms add column if not exists notice      text;
alter table public.rooms add column if not exists notice_by   uuid references public.profiles(id) on delete set null;
alter table public.rooms add column if not exists notice_at   timestamptz;


-- 2. 방 참여자가 공지를 고칠 수 있게 합니다.
--
--    rooms 에는 지금 select 와 insert 정책만 있고 update 정책이 없습니다.
--    그래서 지금 상태로는 아무도 공지를 못 씁니다. 아래에서 추가합니다.
--
--    이름(name)까지 바꾸지는 못하게, 공지 세 칸만 열어 줍니다.
drop policy if exists rooms_update_notice on public.rooms;
create policy rooms_update_notice on public.rooms for update to authenticated
  using  (public.is_member(id, (select auth.uid())))
  with check (public.is_member(id, (select auth.uid())));


-- 3. 방 이름은 못 바꾸도록 막습니다.
--    (2번 정책만으로는 name 도 수정할 수 있게 열려 버립니다)
create or replace function public.guard_room_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.name is distinct from old.name
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception '방 이름은 바꿀 수 없습니다';
  end if;

  -- 공지 내용이 실제로 바뀐 경우에만 기록을 남깁니다.
  if new.notice is distinct from old.notice then
    new.notice_by := auth.uid();
    new.notice_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_room_update on public.rooms;
create trigger trg_guard_room_update
  before update on public.rooms
  for each row execute function public.guard_room_update();


-- =====================================================================
--  확인
--    select name, notice, notice_at from public.rooms;
-- =====================================================================
