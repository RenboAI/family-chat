create extension if not exists pg_net with schema extensions;

create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform net.http_post(
    url     := 'https://cqtullgrlrrgzxijqxzs.supabase.co/functions/v1/send-push',
    headers := jsonb_build_object(
                 'Content-Type',     'application/json',
                 'x-webhook-secret', 'anbioa4537fdg@#%HFD1143fca'
               ),
    body    := jsonb_build_object(
                 'type',   'INSERT',
                 'table',  'messages',
                 'record', to_jsonb(new)
               ),
    timeout_milliseconds := 5000
  );
  return new;
end;
$$;

drop trigger if exists trg_notify_new_message on public.messages;
create trigger trg_notify_new_message
  after insert on public.messages
  for each row execute function public.notify_new_message();