// =====================================================================
//  send-push — 새 메시지가 들어오면 같은 방 사람들에게 웹 푸시를 보냅니다.
//
//  실행 방식: Supabase Database Webhook 이 messages 테이블 INSERT 때
//             이 함수를 호출합니다. (README 5단계)
// =====================================================================

import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:family@example.com';
const HOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
});

/** 첨부 종류에 맞는 미리보기 문구 */
function preview(row: Record<string, unknown>): string {
  const body = (row.body as string | null)?.trim();
  if (body) return body.length > 80 ? body.slice(0, 80) + '…' : body;

  const kind = String(row.attachment_type ?? '').split('/')[0];
  if (kind === 'image') return '사진을 보냈습니다';
  if (kind === 'video') return '동영상을 보냈습니다';
  if (kind === 'audio') return '음성 메시지를 보냈습니다';
  if (row.attachment_path) return `파일: ${row.attachment_name ?? '첨부파일'}`;
  return '새 메시지';
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('method not allowed', { status: 405 });
  }
  if (HOOK_SECRET && req.headers.get('x-webhook-secret') !== HOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }

  let payload: { type?: string; record?: Record<string, unknown> };
  try {
    payload = await req.json();
  } catch {
    return new Response('bad request', { status: 400 });
  }

  const row = payload.record;
  if (payload.type !== 'INSERT' || !row) {
    return new Response(JSON.stringify({ skipped: true }), { status: 200 });
  }

  const roomId = row.room_id as string;
  const senderId = row.sender_id as string | null;

  // 방 이름, 보낸 사람 이름, 받을 사람 목록을 한 번에 가져옵니다.
  const [roomRes, senderRes, memberRes] = await Promise.all([
    admin.from('rooms').select('name').eq('id', roomId).single(),
    senderId
      ? admin.from('profiles').select('display_name').eq('id', senderId).single()
      : Promise.resolve({ data: null }),
    admin.from('room_members').select('user_id').eq('room_id', roomId),
  ]);

  const targets = (memberRes.data ?? [])
    .map((m: { user_id: string }) => m.user_id)
    .filter((id: string) => id !== senderId);

  if (!targets.length) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const { data: subs } = await admin
    .from('push_subscriptions')
    .select('id, endpoint, p256dh, auth')
    .in('user_id', targets);

  if (!subs?.length) {
    return new Response(JSON.stringify({ sent: 0 }), { status: 200 });
  }

  const senderName = senderRes.data?.display_name ?? '가족';
  const notification = JSON.stringify({
    title: roomRes.data?.name ?? '우리집',
    body: `${senderName}: ${preview(row)}`,
    roomId,
  });

  const dead: string[] = [];

  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        notification,
      );
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      // 404/410 = 기기에서 앱을 지웠거나 구독이 만료됨 → 정리
      if (code === 404 || code === 410) dead.push(s.id);
      else console.error('push failed', code, String(err));
    }
  }));

  if (dead.length) {
    await admin.from('push_subscriptions').delete().in('id', dead);
  }

  return new Response(
    JSON.stringify({ sent: subs.length - dead.length, removed: dead.length }),
    { headers: { 'content-type': 'application/json' } },
  );
});
