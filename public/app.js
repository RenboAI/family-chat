/* =====================================================================
   가족 메신저 — 클라이언트
   ===================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const CFG = window.CONFIG || {};
const sb = createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
  realtime: { params: { eventsPerSecond: 20 } },
});

const $ = (id) => document.getElementById(id);

const state = {
  me: null,             // 내 프로필
  profiles: new Map(),  // id -> profile
  rooms: [],            // 전체 방
  members: new Map(),   // roomId -> [userId]
  lastRead: new Map(),  // roomId -> ISO 문자열
  unread: new Map(),    // roomId -> 숫자
  roomId: null,         // 지금 열어둔 방
  messages: [],
  signed: new Map(),    // storage 경로 -> {url, exp}
  channels: [],
};

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = window.navigator.standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;
const COARSE = window.matchMedia('(pointer: coarse)').matches;

/* ------------------------------------------------------------------ */
/* 잡다한 도구                                                          */
/* ------------------------------------------------------------------ */

function toast(text, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function initial(name) {
  return (name || '?').trim().charAt(0) || '?';
}

function clockOf(iso) {
  return new Date(iso).toLocaleTimeString('ko-KR', {
    hour: 'numeric', minute: '2-digit',
  });
}

function dayOf(iso) {
  const d = new Date(iso);
  const today = new Date();
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return '오늘';
  const y = new Date(today); y.setDate(y.getDate() - 1);
  if (same(d, y)) return '어제';
  return d.toLocaleDateString('ko-KR', {
    year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric',
    month: 'long', day: 'numeric', weekday: 'short',
  });
}

function sizeOf(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)}${u[i]}`;
}

function profileOf(id) {
  return state.profiles.get(id) || { display_name: '알 수 없음', color: '#75879A' };
}

/* 비공개 버킷이라 볼 때마다 서명된 주소가 필요합니다. 50분간 재사용합니다. */
async function signedUrl(path) {
  const hit = state.signed.get(path);
  if (hit && hit.exp > Date.now()) return hit.url;
  const { data, error } = await sb.storage
    .from('attachments').createSignedUrl(path, 3600);
  if (error || !data) return null;
  state.signed.set(path, { url: data.signedUrl, exp: Date.now() + 50 * 60 * 1000 });
  return data.signedUrl;
}

/* ------------------------------------------------------------------ */
/* 로그인                                                               */
/* ------------------------------------------------------------------ */

let signUpMode = false;

function paintAuthMode() {
  $('auth-name').classList.toggle('hidden', !signUpMode);
  $('auth-name').required = signUpMode;
  $('auth-submit').textContent = signUpMode ? '가입하기' : '로그인';
  $('auth-pw').autocomplete = signUpMode ? 'new-password' : 'current-password';
  $('auth-toggle-label').textContent = signUpMode ? '이미 계정이 있나요?' : '처음이신가요?';
  $('auth-toggle').textContent = signUpMode ? '로그인' : '가입하기';
  $('auth-sub').textContent = signUpMode
    ? '가족 각자 계정을 하나씩 만듭니다'
    : '가족만 쓰는 메신저';
  $('auth-error').classList.add('hidden');
}

$('auth-toggle').addEventListener('click', () => {
  signUpMode = !signUpMode;
  paintAuthMode();
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('auth-submit');
  const err = $('auth-error');
  const email = $('auth-email').value.trim();
  const pw = $('auth-pw').value;
  const name = $('auth-name').value.trim();

  btn.disabled = true;
  err.classList.add('hidden');
  try {
    if (signUpMode) {
      const { error } = await sb.auth.signUp({
        email, password: pw, options: { data: { display_name: name } },
      });
      if (error) throw error;
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password: pw });
      if (error) throw error;
    }
  } catch (ex) {
    const m = String(ex.message || ex);
    err.textContent =
      /Invalid login/i.test(m) ? '이메일이나 비밀번호가 맞지 않습니다.' :
      /already registered/i.test(m) ? '이미 가입된 이메일입니다. 로그인해 주세요.' :
      /Password should be/i.test(m) ? '비밀번호는 6자 이상이어야 합니다.' :
      m;
    err.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/* 데이터 불러오기                                                       */
/* ------------------------------------------------------------------ */

async function loadProfiles() {
  const { data } = await sb.from('profiles').select('*');
  state.profiles = new Map((data || []).map((p) => [p.id, p]));
}

async function loadRooms() {
  const [{ data: rooms }, { data: mem }] = await Promise.all([
    sb.from('rooms').select('*').order('created_at', { ascending: true }),
    sb.from('room_members').select('room_id,user_id,last_read_at'),
  ]);

  state.rooms = rooms || [];
  state.members = new Map();
  for (const m of mem || []) {
    if (!state.members.has(m.room_id)) state.members.set(m.room_id, []);
    state.members.get(m.room_id).push(m.user_id);
    if (m.user_id === state.me.id) state.lastRead.set(m.room_id, m.last_read_at);
  }
  renderRooms();
}

function joinedRoomIds() {
  const out = [];
  for (const [rid, list] of state.members) {
    if (list.includes(state.me.id)) out.push(rid);
  }
  return out;
}

async function refreshUnread() {
  const mine = joinedRoomIds().filter((r) => r !== state.roomId);
  await Promise.all(mine.map(async (rid) => {
    const since = state.lastRead.get(rid) || '1970-01-01';
    const { count } = await sb.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', rid)
      .gt('created_at', since)
      .neq('sender_id', state.me.id);
    state.unread.set(rid, count || 0);
  }));
  renderRooms();
}

/* ------------------------------------------------------------------ */
/* 방 목록 그리기                                                        */
/* ------------------------------------------------------------------ */

function renderRooms() {
  const box = $('rooms-list');
  box.innerHTML = '';

  if (!state.rooms.length) {
    box.innerHTML =
      '<div class="empty">' +
      '<div class="empty__line">아직 방이 없습니다</div>' +
      '<div class="empty__hint">위의 + 를 눌러 첫 방을 만들어 보세요</div></div>';
    return;
  }

  for (const room of state.rooms) {
    const ids = state.members.get(room.id) || [];
    const mine = ids.includes(state.me.id);
    const unread = state.unread.get(room.id) || 0;

    const row = document.createElement('button');
    row.className = 'room-row';
    row.setAttribute('aria-current', String(room.id === state.roomId));

    const av = document.createElement('span');
    av.className = 'avatar';
    av.style.background = mine ? 'var(--brand)' : 'var(--muted)';
    av.textContent = room.name.trim().slice(0, 2);

    const body = document.createElement('div');
    body.className = 'room-row__body';

    const nm = document.createElement('div');
    nm.className = 'room-row__name';
    nm.textContent = room.name;

    const meta = document.createElement('div');
    meta.className = 'room-row__meta';
    const dots = document.createElement('span');
    dots.className = 'dots';
    for (const uid of ids.slice(0, 6)) {
      const d = document.createElement('span');
      d.className = 'dot';
      d.style.background = profileOf(uid).color;
      dots.appendChild(d);
    }
    meta.appendChild(dots);
    const cnt = document.createElement('span');
    cnt.textContent = mine ? `${ids.length}명` : `${ids.length}명 · 들어가기`;
    meta.appendChild(cnt);

    body.append(nm, meta);
    row.append(av, body);

    if (unread > 0) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = unread > 99 ? '99+' : String(unread);
      row.appendChild(b);
    }

    row.addEventListener('click', () => openRoom(room.id));
    box.appendChild(row);
  }
}

/* ------------------------------------------------------------------ */
/* 방 열기 / 만들기 / 나가기                                             */
/* ------------------------------------------------------------------ */

async function openRoom(roomId) {
  const ids = state.members.get(roomId) || [];

  // 아직 참여하지 않은 방이면 먼저 들어갑니다.
  if (!ids.includes(state.me.id)) {
    const { error } = await sb.from('room_members')
      .insert({ room_id: roomId, user_id: state.me.id });
    if (error) { toast('방에 들어가지 못했습니다.'); return; }
    ids.push(state.me.id);
    state.members.set(roomId, ids);
  }

  state.roomId = roomId;
  state.unread.set(roomId, 0);
  $('shell').dataset.view = 'chat';

  const room = state.rooms.find((r) => r.id === roomId);
  $('chat-title').textContent = room ? room.name : '';
  $('btn-leave').classList.remove('hidden');
  $('composer').classList.remove('hidden');
  paintChatSub();
  paintNotice();
  renderRooms();

  const { data } = await sb.from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true })
    .limit(500);

  state.messages = data || [];
  renderAllMessages();
  subscribeRoom(roomId);
  markRead();
}

function paintChatSub() {
  const ids = state.members.get(state.roomId) || [];
  const names = ids.map((id) => profileOf(id).display_name).join(', ');
  $('chat-sub').textContent = `${ids.length}명 · ${names}`;
}

function closeRoom() {
  state.roomId = null;
  state.messages = [];
  $('shell').dataset.view = 'rooms';
  $('chat-title').textContent = '대화를 고르세요';
  $('chat-sub').textContent = '';
  $('btn-leave').classList.add('hidden');
  $('btn-notice').classList.add('hidden');
  $('notice').classList.add('hidden');
  $('composer').classList.add('hidden');
  $('msgs').innerHTML =
    '<div class="empty"><div class="empty__line">왼쪽에서 방을 고르세요</div>' +
    '<div class="empty__hint">방이 없으면 + 를 눌러 새로 만들면 됩니다</div></div>';
  renderRooms();
}

$('btn-back').addEventListener('click', () => {
  $('shell').dataset.view = 'rooms';
});

/* --- 새 방 --- */

function modal(html) {
  const back = document.createElement('div');
  back.className = 'sheet-back';
  back.innerHTML = `<div class="sheet">${html}</div>`;
  back.addEventListener('click', (e) => { if (e.target === back) back.remove(); });
  $('modal-root').appendChild(back);
  return back;
}

$('btn-new-room').addEventListener('click', () => {
  const m = modal(`
    <h2>새 채팅방</h2>
    <p>모두가 나가면 이 방과 그 안의 대화·사진은 완전히 사라집니다.</p>
    <input class="field" id="nr-name" placeholder="방 이름" maxlength="30">
    <div class="sheet__actions">
      <button class="btn btn--ghost" data-x>취소</button>
      <button class="btn" id="nr-ok">만들기</button>
    </div>`);

  const input = m.querySelector('#nr-name');
  input.focus();
  m.querySelector('[data-x]').onclick = () => m.remove();

  const go = async () => {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    m.remove();
    const { data, error } = await sb.from('rooms')
      .insert({ name, created_by: state.me.id }).select().single();
    if (error) { toast('방을 만들지 못했습니다.'); return; }
    await sb.from('room_members').insert({ room_id: data.id, user_id: state.me.id });
    await loadRooms();
    openRoom(data.id);
  };
  m.querySelector('#nr-ok').onclick = go;
  input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
});

/* --- 나가기 --- */

$('btn-leave').addEventListener('click', () => {
  const roomId = state.roomId;
  const ids = state.members.get(roomId) || [];
  const last = ids.length <= 1;
  const room = state.rooms.find((r) => r.id === roomId);

  const m = modal(`
    <h2>${room ? room.name : '이 방'}에서 나갑니다</h2>
    <p>${last
      ? '마지막 참여자입니다. 나가는 순간 이 방의 모든 대화와 파일이 영구히 삭제됩니다.'
      : '다시 들어오면 그동안 오간 대화를 볼 수 있습니다.'}</p>
    <div class="sheet__actions">
      <button class="btn btn--ghost" data-x>취소</button>
      <button class="btn" id="lv-ok" style="background:var(--danger);color:#fff">나가기</button>
    </div>`);

  m.querySelector('[data-x]').onclick = () => m.remove();
  m.querySelector('#lv-ok').onclick = async () => {
    m.remove();
    // 마지막 사람이면 첨부파일부터 지웁니다. (방 삭제는 DB 트리거가 처리)
    if (last) {
      const { data: files } = await sb.storage.from('attachments').list(roomId, { limit: 1000 });
      if (files && files.length) {
        await sb.storage.from('attachments')
          .remove(files.map((f) => `${roomId}/${f.name}`));
      }
    }
    const { error } = await sb.from('room_members')
      .delete().eq('room_id', roomId).eq('user_id', state.me.id);
    if (error) { toast('나가지 못했습니다.'); return; }
    closeRoom();
    await loadRooms();
    toast(last ? '방과 대화가 삭제되었습니다.' : '방에서 나왔습니다.');
  };
});

/* ------------------------------------------------------------------ */
/* 메시지 그리기                                                         */
/* ------------------------------------------------------------------ */

function atBottom() {
  const el = $('msgs');
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
}

function toBottom(smooth) {
  const el = $('msgs');
  el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
}

function renderAllMessages() {
  const box = $('msgs');
  box.innerHTML = '';
  let prev = null;
  for (const m of state.messages) {
    const mark = dayMark(m, prev);
    if (mark) box.appendChild(mark);
    box.appendChild(messageEl(m, prev));
    prev = m;
  }
  requestAnimationFrame(() => toBottom(false));
}

function appendMessage(m) {
  const stick = atBottom();
  const box = $('msgs');
  const prev = state.messages[state.messages.length - 2] || null;
  const mark = dayMark(m, prev);
  if (mark) box.appendChild(mark);
  box.appendChild(messageEl(m, prev));
  if (stick) requestAnimationFrame(() => toBottom(true));
}

function dayMark(m, prev) {
  const label = dayOf(m.created_at);
  if (prev && dayOf(prev.created_at) === label) return null;
  const el = document.createElement('div');
  el.className = 'daymark';
  el.textContent = label;
  return el;
}

function messageEl(m, prev) {
  const mine = m.sender_id === state.me.id;
  const who = profileOf(m.sender_id);

  // 같은 사람이 5분 안에 이어 보내면 이름과 프로필을 생략합니다.
  const stack = prev &&
    prev.sender_id === m.sender_id &&
    dayOf(prev.created_at) === dayOf(m.created_at) &&
    (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000;

  const wrap = document.createElement('div');
  wrap.className = 'msg' + (mine ? ' msg--mine' : '') + (stack ? ' msg--stack' : '');
  if (m._pending) wrap.classList.add('msg--pending');
  wrap.dataset.id = m.id;

  if (!mine) {
    if (stack) {
      const gap = document.createElement('div');
      gap.className = 'msg__gap';
      wrap.appendChild(gap);
    } else {
      const av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = who.color;
      av.textContent = initial(who.display_name);
      wrap.appendChild(av);
    }
  }

  const col = document.createElement('div');
  col.className = 'msg__col';

  if (!mine && !stack) {
    const nm = document.createElement('div');
    nm.className = 'msg__who';
    nm.style.color = who.color;
    nm.textContent = who.display_name;
    col.appendChild(nm);
  }

  const kind = (m.attachment_type || '').split('/')[0];
  const bubble = document.createElement('div');
  bubble.className = 'bubble' +
    (m.attachment_path && kind !== 'file' && ['image', 'video', 'audio'].includes(kind)
      ? ' bubble--media' : '');

  if (m.attachment_path) {
    bubble.appendChild(attachmentEl(m, kind));
  }
  if (m.body) {
    const t = document.createElement('div');
    t.textContent = m.body;
    bubble.appendChild(t);
  }

  const time = document.createElement('span');
  time.className = 'bubble__time';
  time.textContent = m._pending ? '보내는 중' : clockOf(m.created_at);
  bubble.appendChild(time);

  col.appendChild(bubble);
  wrap.appendChild(col);
  return wrap;
}

function attachmentEl(m, kind) {
  if (kind === 'image') {
    const img = document.createElement('img');
    img.className = 'att-img';
    img.alt = m.attachment_name || '사진';
    img.loading = 'lazy';
    signedUrl(m.attachment_path).then((u) => { if (u) img.src = u; });
    img.onclick = () => lightbox(img.src);
    return img;
  }
  if (kind === 'video') {
    const v = document.createElement('video');
    v.className = 'att-vid';
    v.controls = true;
    v.preload = 'metadata';
    v.playsInline = true;
    signedUrl(m.attachment_path).then((u) => { if (u) v.src = u; });
    return v;
  }
  if (kind === 'audio') {
    const a = document.createElement('audio');
    a.className = 'att-aud';
    a.controls = true;
    a.preload = 'metadata';
    signedUrl(m.attachment_path).then((u) => { if (u) a.src = u; });
    return a;
  }
  const link = document.createElement('a');
  link.className = 'att-file';
  link.download = m.attachment_name || 'file';
  link.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<path d="M14 2v6h6"/></svg>';
  const box = document.createElement('span');
  const nm = document.createElement('span');
  nm.className = 'att-file__name';
  nm.textContent = m.attachment_name || '파일';
  const sz = document.createElement('span');
  sz.className = 'att-file__size';
  sz.textContent = sizeOf(m.attachment_size);
  box.append(nm, document.createElement('br'), sz);
  link.appendChild(box);
  signedUrl(m.attachment_path).then((u) => { if (u) link.href = u; });
  return link;
}

function lightbox(src) {
  if (!src) return;
  const back = document.createElement('div');
  back.id = 'lightbox';
  const img = document.createElement('img');
  img.src = src;
  back.appendChild(img);
  back.onclick = () => back.remove();
  document.body.appendChild(back);
}

/* ------------------------------------------------------------------ */
/* 보내기                                                               */
/* ------------------------------------------------------------------ */

const input = $('input');

function resizeInput() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 132) + 'px';
  $('btn-send').disabled = !input.value.trim();
}
input.addEventListener('input', resizeInput);

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !COARSE) {
    e.preventDefault();
    sendText();
  }
});

$('btn-send').addEventListener('click', sendText);

async function sendText() {
  const body = input.value.trim();
  if (!body || !state.roomId) return;
  input.value = '';
  resizeInput();
  await postMessage({ body });
}

/* 낙관적 전송: 화면에 먼저 띄우고 서버 응답으로 교체합니다.
   요구사항 6번의 "딜레이가 안 느껴지는" 체감은 대부분 여기서 나옵니다. */
async function postMessage(fields) {
  const roomId = state.roomId;
  const tmpId = 'tmp-' + crypto.randomUUID();
  const optimistic = {
    id: tmpId, room_id: roomId, sender_id: state.me.id,
    created_at: new Date().toISOString(), _pending: true,
    body: null, attachment_path: null, attachment_name: null,
    attachment_type: null, attachment_size: null,
    ...fields,
  };
  state.messages.push(optimistic);
  appendMessage(optimistic);

  const { data, error } = await sb.from('messages')
    .insert({ room_id: roomId, sender_id: state.me.id, ...fields })
    .select().single();

  const node = $('msgs').querySelector(`[data-id="${tmpId}"]`);
  if (error) {
    if (node) {
      node.classList.remove('msg--pending');
      node.style.opacity = '.5';
      const t = node.querySelector('.bubble__time');
      if (t) { t.textContent = '전송 실패'; t.style.color = 'var(--danger)'; }
    }
    return;
  }
  const i = state.messages.findIndex((x) => x.id === tmpId);
  if (i >= 0) state.messages[i] = data;
  if (node) {
    node.dataset.id = data.id;
    node.classList.remove('msg--pending');
    const t = node.querySelector('.bubble__time');
    if (t) t.textContent = clockOf(data.created_at);
  }
  markRead();
}

/* ------------------------------------------------------------------ */
/* 첨부 (사진 / 동영상 / 음성 / 파일)                                    */
/* ------------------------------------------------------------------ */

$('btn-attach').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  for (const f of files) await uploadAndSend(f, f.name);
});

async function uploadAndSend(file, name) {
  const roomId = state.roomId;
  if (!roomId) return;

  const bar = $('upload-bar');
  bar.textContent = `${name} 올리는 중…`;
  bar.classList.remove('hidden');

  try {
    const safe = name.replace(/[^\w.\-가-힣]/g, '_').slice(-80);
    const path = `${roomId}/${crypto.randomUUID()}-${safe}`;
    const { error } = await sb.storage.from('attachments')
      .upload(path, file, { contentType: file.type || 'application/octet-stream' });
    if (error) throw error;

    await postMessage({
      attachment_path: path,
      attachment_name: name,
      attachment_type: file.type || 'application/octet-stream',
      attachment_size: file.size,
    });
  } catch (ex) {
    toast(/exceeded/i.test(String(ex.message)) ? '파일이 너무 큽니다 (최대 50MB).' : '업로드에 실패했습니다.');
  } finally {
    bar.classList.add('hidden');
  }
}

/* --- 음성 녹음 --- */

let recorder = null, chunks = [];

$('btn-rec').addEventListener('click', async () => {
  const btn = $('btn-rec');

  if (recorder && recorder.state === 'recording') {
    recorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // 사파리는 webm 을 못 만들어서 mp4 로 떨어집니다.
    const type = ['audio/webm', 'audio/mp4', 'audio/aac']
      .find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    chunks = [];

    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      btn.classList.remove('is-recording');
      const mime = recorder.mimeType || type || 'audio/webm';
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 1200) return;               // 실수로 누른 경우
      const ext = mime.includes('mp4') ? 'm4a' : mime.includes('aac') ? 'aac' : 'webm';
      const stamp = new Date().toLocaleTimeString('ko-KR', { hour12: false }).replace(/:/g, '');
      await uploadAndSend(new File([blob], `음성_${stamp}.${ext}`, { type: mime }),
        `음성 메시지 (${stamp})`);
    };

    recorder.start();
    btn.classList.add('is-recording');
    toast('녹음 중 — 다시 누르면 전송됩니다');
  } catch {
    toast('마이크를 쓸 수 없습니다. 브라우저 권한을 확인해 주세요.');
  }
});

/* ------------------------------------------------------------------ */
/* 실시간                                                               */
/* ------------------------------------------------------------------ */

function subscribeRoom(roomId) {
  // 방 전용 채널만 갈아끼웁니다.
  state.channels
    .filter((c) => c.topic.includes('room-msgs'))
    .forEach((c) => { sb.removeChannel(c); });
  state.channels = state.channels.filter((c) => !c.topic.includes('room-msgs'));

  const ch = sb.channel(`room-msgs-${roomId}`)
    .on('postgres_changes', {
      event: 'INSERT', schema: 'public', table: 'messages',
      filter: `room_id=eq.${roomId}`,
    }, ({ new: row }) => {
      if (row.sender_id === state.me.id) return;   // 내 것은 이미 화면에 있음
      if (state.messages.some((m) => m.id === row.id)) return;
      state.messages.push(row);
      appendMessage(row);
      markRead();
    })
    .on('postgres_changes', {
      event: 'DELETE', schema: 'public', table: 'messages',
      filter: `room_id=eq.${roomId}`,
    }, ({ old: row }) => {
      state.messages = state.messages.filter((m) => m.id !== row.id);
      const n = $('msgs').querySelector(`[data-id="${row.id}"]`);
      if (n) n.remove();
    })
    .subscribe();

  state.channels.push(ch);
}

function subscribeGlobal() {
  const ch = sb.channel('global')
    // 다른 방에 메시지가 오면 뱃지를 올립니다.
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' },
      ({ new: row }) => {
        if (row.room_id === state.roomId || row.sender_id === state.me.id) return;
        if (!joinedRoomIds().includes(row.room_id)) return;
        state.unread.set(row.room_id, (state.unread.get(row.room_id) || 0) + 1);
        renderRooms();
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' },
      async ({ eventType, old: gone }) => {
        // 마지막 사람이 나가서 방이 사라진 경우
        if (eventType === 'DELETE' && gone && gone.id === state.roomId) {
          closeRoom();
          toast('모두 나가서 이 방은 사라졌습니다.');
        }
        await loadRooms();
        if (state.roomId) paintNotice();
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members' },
      async () => {
        await loadRooms();
        if (state.roomId) paintChatSub();
      })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' },
      async () => { await loadProfiles(); renderRooms(); })
    .subscribe();

  state.channels.push(ch);
}

/* 읽음 표시 */
let readTimer = null;
function markRead() {
  clearTimeout(readTimer);
  readTimer = setTimeout(async () => {
    if (!state.roomId) return;
    const now = new Date().toISOString();
    state.lastRead.set(state.roomId, now);
    await sb.from('room_members').update({ last_read_at: now })
      .eq('room_id', state.roomId).eq('user_id', state.me.id);
  }, 900);
}

/* ------------------------------------------------------------------ */
/* 알림                                                                 */
/* ------------------------------------------------------------------ */

function b64ToU8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

async function enablePush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    toast('이 브라우저는 알림을 지원하지 않습니다.');
    return false;
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('알림이 거부되었습니다.'); return false; }

  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToU8(CFG.VAPID_PUBLIC_KEY),
    });
  }
  const j = sub.toJSON();
  await sb.from('push_subscriptions').upsert({
    user_id: state.me.id,
    endpoint: j.endpoint,
    p256dh: j.keys.p256dh,
    auth: j.keys.auth,
  }, { onConflict: 'endpoint' });

  toast('알림을 켰습니다.');
  return true;
}

function paintNudge() {
  const box = $('notif-nudge');

  // 아이폰·아이패드는 홈 화면에 추가해야만 알림을 받을 수 있습니다.
  if (IS_IOS && !IS_STANDALONE) {
    box.innerHTML =
      '<strong>알림을 받으려면 홈 화면에 추가하세요.</strong><br>' +
      '사파리 아래 <b>공유</b> 버튼 → <b>홈 화면에 추가</b> 를 누른 뒤, ' +
      '홈 화면의 아이콘으로 다시 열어 주세요.';
    box.classList.remove('hidden');
    return;
  }

  if (!('Notification' in window) || Notification.permission === 'granted') {
    box.classList.add('hidden');
    return;
  }
  if (Notification.permission === 'denied') {
    box.innerHTML = '<strong>알림이 꺼져 있습니다.</strong><br>' +
      '브라우저 설정에서 이 사이트의 알림을 허용해 주세요.';
    box.classList.remove('hidden');
    return;
  }

  box.innerHTML =
    '<strong>새 메시지 알림을 켤까요?</strong><br>앱을 닫아둬도 메시지가 오면 알려줍니다.' +
    '<div class="nudge__row"><button class="btn" id="nudge-ok">알림 켜기</button>' +
    '<button class="btn btn--quiet" id="nudge-no">나중에</button></div>';
  box.classList.remove('hidden');
  $('nudge-ok').onclick = async () => { if (await enablePush()) paintNudge(); };
  $('nudge-no').onclick = () => box.classList.add('hidden');
}

/* ------------------------------------------------------------------ */
/* 공지                                                                 */
/* ------------------------------------------------------------------ */

function paintNotice() {
  const room = state.rooms.find((r) => r.id === state.roomId);
  const box = $('notice');
  const btn = $('btn-notice');

  if (!room) {
    box.classList.add('hidden');
    btn.classList.add('hidden');
    return;
  }

  const text = (room.notice || '').trim();

  if (!text) {
    // 공지가 없으면 배너 대신 헤더의 확성기 버튼만 보여 줍니다.
    box.classList.add('hidden');
    btn.classList.remove('hidden');
    return;
  }

  btn.classList.add('hidden');
  box.classList.remove('hidden');

  const el = $('notice-text');
  el.textContent = text;
  el.classList.add('is-clamped');

  // 두 줄을 넘길 때만 '더보기'를 답니다.
  const more = $('notice-more');
  more.textContent = '더보기';
  more.classList.add('hidden');
  // 레이아웃이 잡힌 뒤에 재보므로 두 프레임 기다립니다.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!el.classList.contains('is-clamped')) return;
    const overflows = el.scrollHeight - el.clientHeight > 2;
    more.classList.toggle('hidden', !overflows);
  }));
}

$('notice-more').addEventListener('click', () => {
  const el = $('notice-text');
  const more = $('notice-more');
  const folded = el.classList.toggle('is-clamped');
  more.textContent = folded ? '더보기' : '접기';
});

function openNoticeEditor() {
  const room = state.rooms.find((r) => r.id === state.roomId);
  if (!room) return;

  const current = room.notice || '';
  const m = modal(`
    <h2>공지</h2>
    <p>이 방 사람들 모두에게 대화 위에 고정되어 보입니다.</p>
    <textarea id="nt-input" maxlength="500" placeholder="예) 토요일 오후 2시 할머니댁"></textarea>
    <div class="sheet__actions">
      ${current ? '<button class="btn btn--ghost" id="nt-clear" style="color:var(--danger)">삭제</button>' : ''}
      <button class="btn btn--ghost" data-x>취소</button>
      <button class="btn" id="nt-ok">저장</button>
    </div>`);

  const input = m.querySelector('#nt-input');
  input.value = current;
  input.focus();
  m.querySelector('[data-x]').onclick = () => m.remove();

  const save = async (value) => {
    m.remove();
    const next = value.trim() || null;
    const { error } = await sb.from('rooms')
      .update({ notice: next }).eq('id', room.id);
    if (error) { toast('공지를 저장하지 못했습니다.'); return; }
    room.notice = next;
    paintNotice();
    toast(next ? '공지를 등록했습니다.' : '공지를 삭제했습니다.');
  };

  m.querySelector('#nt-ok').onclick = () => save(input.value);
  const clear = m.querySelector('#nt-clear');
  if (clear) clear.onclick = () => save('');
}

$('btn-notice').addEventListener('click', openNoticeEditor);
$('notice-edit').addEventListener('click', openNoticeEditor);

/* ------------------------------------------------------------------ */
/* 내 정보                                                              */
/* ------------------------------------------------------------------ */

$('btn-me').addEventListener('click', () => {
  const m = modal(`
    <h2>내 정보</h2>
    <p>이 이름과 색으로 가족에게 보입니다.</p>
    <input class="field" id="me-input" value="${state.me.display_name.replace(/"/g, '&quot;')}" maxlength="20">
    <div class="sheet__actions">
      <button class="btn btn--ghost" id="me-out">로그아웃</button>
      <button class="btn" id="me-save">저장</button>
    </div>`);

  m.querySelector('#me-save').onclick = async () => {
    const name = m.querySelector('#me-input').value.trim();
    if (!name) return;
    await sb.from('profiles').update({ display_name: name }).eq('id', state.me.id);
    state.me.display_name = name;
    state.profiles.set(state.me.id, state.me);
    paintMe();
    m.remove();
  };
  m.querySelector('#me-out').onclick = async () => {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
      await sub.unsubscribe();
    }
    await sb.auth.signOut();
    location.reload();
  };
});

function paintMe() {
  $('me-name').textContent = state.me.display_name;
  $('me-avatar').textContent = initial(state.me.display_name);
  $('me-avatar').style.background = state.me.color;
}

/* ------------------------------------------------------------------ */
/* 시작                                                                 */
/* ------------------------------------------------------------------ */

async function start(session) {
  await loadProfiles();

  state.me = state.profiles.get(session.user.id);
  if (!state.me) {                       // 트리거가 아직 안 돈 아주 드문 경우
    await new Promise((r) => setTimeout(r, 700));
    await loadProfiles();
    state.me = state.profiles.get(session.user.id) ||
      { id: session.user.id, display_name: '나', color: '#4A82C4' };
  }

  $('auth-view').classList.add('hidden');
  $('app-view').classList.remove('hidden');
  paintMe();

  await loadRooms();
  await refreshUnread();
  subscribeGlobal();
  paintNudge();

  // 이미 알림을 켜둔 기기면 구독 정보를 조용히 갱신합니다.
  if ('Notification' in window && Notification.permission === 'granted') {
    enablePush().catch(() => {});
  }

  // 앱으로 돌아왔을 때 끊긴 실시간 연결을 복구하고 놓친 메시지를 채웁니다.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    await loadRooms();
    await refreshUnread();
    if (state.roomId) {
      const last = state.messages[state.messages.length - 1];
      const { data } = await sb.from('messages').select('*')
        .eq('room_id', state.roomId)
        .gt('created_at', last ? last.created_at : '1970-01-01')
        .order('created_at', { ascending: true });
      for (const row of data || []) {
        if (state.messages.some((m) => m.id === row.id)) continue;
        state.messages.push(row);
        appendMessage(row);
      }
    }
  });
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// 알림을 눌러 들어온 경우 해당 방을 엽니다.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type === 'open-room' && e.data.roomId) openRoom(e.data.roomId);
});

paintAuthMode();

sb.auth.getSession().then(({ data }) => {
  if (data.session) start(data.session);
  else $('auth-view').classList.remove('hidden');
});

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'SIGNED_IN' && session && !state.me) start(session);
  if (event === 'SIGNED_OUT') location.reload();
});
