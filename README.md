# 우리집 — 가족 메신저

아이폰·아이패드·갤럭시탭에서 똑같이 돌아가는 가족 전용 실시간 메신저입니다.
전화번호도, 앱스토어 심사도, 나이 제한도 없습니다.

## 요구사항 대응

| 요구사항 | 구현 방식 |
|---|---|
| 1. 개인별 등록 | 이메일 + 비밀번호. 가입하면 이름과 고유 색이 자동 배정됩니다 |
| 2. 채팅방 여러 개 | 누구나 방을 만들고, 가족 누구나 들어갈 수 있습니다 |
| 3. 모두 나가면 삭제 | DB 트리거가 마지막 참여자 이탈을 감지해 방·메시지·첨부파일을 전부 지웁니다 |
| 4. 사진/동영상/음성/파일 | Storage 업로드. 사진은 바로 보이고, 동영상·음성은 재생, 나머지는 다운로드 |
| 5. 이모티콘 없음 | 넣지 않았습니다 |
| 6. 빠른 속도 | WebSocket 실시간 + 낙관적 전송(보내는 즉시 화면에 표시) |
| 7. 알림 | 웹 푸시. 앱을 닫아둬도 옵니다 |
| 8. 여러 기기 | PWA. 홈 화면에 추가하면 앱처럼 동작합니다 |

---

## 준비물

- Supabase 계정 (무료)
- Node.js (VAPID 키 생성용, 1분이면 끝납니다)
- 정적 호스팅 한 곳 — Vercel / Netlify / Cloudflare Pages 중 아무거나 (무료)

전부 합쳐 **월 0원**이면 가족 5명 규모는 충분합니다.

---

## 1단계 — Supabase 프로젝트 만들기

1. https://supabase.com 에서 새 프로젝트를 만듭니다.
2. **Region 은 반드시 `Northeast Asia (Seoul)` 로 선택하세요.** 다른 지역을 고르면
   메시지 왕복에 200~300ms가 더 붙어서 요구사항 6번의 체감이 달라집니다.
3. 데이터베이스 비밀번호는 따로 적어 둡니다.

## 2단계 — 데이터베이스 만들기

대시보드 왼쪽 **SQL Editor** 로 들어가 `schema.sql` 내용을 통째로 붙여넣고 실행합니다.
테이블, 보안 정책, 방 자동 삭제 트리거, Storage 버킷이 한 번에 만들어집니다.

> 이미 예전 버전 `schema.sql` 을 실행한 프로젝트라면, 대신 `schema-patch.sql` 을
> 실행하세요. 수정 사항만 덧붙이며 여러 번 실행해도 안전합니다.

## 3단계 — 이메일 확인 끄기

**Authentication → Sign In / Providers → Email** 에서
**Confirm email** 을 끕니다.

가족끼리만 쓰는 앱이라 메일 인증 단계가 오히려 걸림돌이 됩니다.
(아이가 쓸 계정은 부모가 직접 만들어 주면 됩니다.)

## 4단계 — 접속 정보 채우기

**Project Settings → Data API** 에서 두 값을 복사해
`public/config.js` 에 붙여넣습니다.

```js
window.CONFIG = {
  SUPABASE_URL: 'https://xxxxx.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...',
  VAPID_PUBLIC_KEY: '',   // 5단계에서 채웁니다
};
```

> `anon` 키는 공개돼도 괜찮습니다. 실제 접근 제어는 2단계에서 만든 RLS 정책이 합니다.
> **`service_role` 키는 절대 여기에 넣지 마세요.**

## 5단계 — 알림용 열쇠(VAPID) 만들기

```bash
npx web-push generate-vapid-keys
```

출력된 **Public Key** 를 `config.js` 의 `VAPID_PUBLIC_KEY` 에 넣습니다.
**Private Key** 는 다음 단계에서 씁니다. 절대 프론트엔드에 넣지 마세요.

## 6단계 — 알림 발송 함수 배포

```bash
npm install -g supabase
supabase login
supabase link --project-ref <프로젝트-ref>

# 비밀값 등록 (WEBHOOK_SECRET 은 아무 긴 문자열이나 직접 정하세요)
supabase secrets set \
  VAPID_PUBLIC_KEY="<공개키>" \
  VAPID_PRIVATE_KEY="<비밀키>" \
  VAPID_SUBJECT="mailto:본인메일@example.com" \
  WEBHOOK_SECRET="<아무-긴-문자열>"

supabase functions deploy send-push --no-verify-jwt
```

## 7단계 — 메시지가 오면 함수가 돌도록 연결

대시보드 **Database → Webhooks → Create a new hook**

| 항목 | 값 |
|---|---|
| Name | `send-push` |
| Table | `public.messages` |
| Events | `Insert` 만 체크 |
| Type | HTTP Request |
| Method | `POST` |
| URL | `https://<프로젝트-ref>.supabase.co/functions/v1/send-push` |
| HTTP Headers | `Content-Type: application/json`<br>`x-webhook-secret: <6단계에서 정한 값>` |

## 8단계 — 앱 올리기

`public/` 폴더를 그대로 올리면 됩니다.

```bash
npm install -g vercel
cd public
vercel --prod
```

Netlify나 Cloudflare Pages에 폴더를 끌어다 놓아도 똑같이 동작합니다.
**HTTPS 는 필수입니다** — 서비스 워커와 푸시 알림이 HTTPS에서만 동작합니다.
(위 서비스들은 기본으로 HTTPS를 붙여 줍니다.)

## 9단계 — 각 기기에 설치

### 먼저: 여기서 말하는 "계정"

구글이나 애플 계정이 아니라, **이 앱 자체의 계정**입니다.
앱 로그인 화면에서 "가입하기"를 눌러 이름·이메일·비밀번호를 넣으면 끝입니다.

**이메일은 실제로 메일을 받을 필요가 없습니다.** 로그인 ID 역할만 합니다.
3단계에서 이메일 확인을 껐기 때문에 인증 메일이 가지 않고,
비밀번호를 잊으면 Supabase 대시보드 **Authentication → Users** 에서 부모가 직접 바꿉니다.

그래서 아이 계정은 부모 지메일의 `+` 별칭을 쓰면 편합니다.
아이에게 이메일을 따로 만들어 줄 필요가 없습니다.

| 가족 | 이메일 | 이름 |
|---|---|---|
| 아빠 | `hong@gmail.com` | 아빠 |
| 엄마 | `hong+mom@gmail.com` | 엄마 |
| 아이 | `hong+seojun@gmail.com` | 서준 |

### 아이패드 · 아이폰

**순서가 중요합니다.** 아이폰·아이패드는 사파리 탭과 홈 화면 앱이 저장소를 따로 씁니다.
사파리에서 먼저 로그인해도 홈 화면 아이콘으로 열면 로그아웃 상태로 뜹니다.

1. **사파리로** 주소를 엽니다 (크롬 아님 — 사파리만 홈 화면 추가를 지원합니다)
2. **공유** 버튼 → 메뉴를 내려 **홈 화면에 추가** → 추가
3. 사파리 탭을 닫고, **홈 화면 아이콘으로 다시 엽니다**
   → 주소창이 안 보이고 꽉 찬 화면이면 제대로 된 것입니다
4. **이 화면에서** 가입합니다 (사파리에서 미리 가입해도 여기로 이어지지 않습니다)
5. 방 목록 위 안내에서 **알림 켜기** → iOS 권한 팝업에서 **허용**
6. 다른 기기에서 메시지를 보내 알림이 오는지 확인합니다

> 5번의 권한 팝업은 홈 화면 앱에서만 뜹니다. 사파리 탭으로 열어두면 알림이 오지 않습니다
> (iPadOS/iOS 16.4 이상). 이 단계는 건너뛰면 안 됩니다.

### 갤럭시탭 · 안드로이드

크롬으로 주소 열기 → 메뉴 → **앱 설치** → 아이콘으로 열기 → 가입 → **알림 켜기**

안드로이드는 탭과 설치된 앱이 로그인 상태를 공유하므로 순서에 덜 민감하지만,
위와 같은 순서로 하면 확실합니다.

---

## 운영 메모

**무료 한도** — DB 500MB, 파일 1GB, 대역폭 월 5GB. 가족 규모면 넉넉합니다.
사진을 매일 수십 장 주고받으면 1GB는 몇 달 안에 찹니다. 그때는 방을 정리하거나
(모두 나가면 그 방 파일이 전부 삭제됩니다) 유료로 올리면 됩니다.

**7일 미사용 시 일시정지** — Supabase 무료 프로젝트는 일주일 내내 아무도 안 쓰면
잠자기 상태가 되고, 대시보드에서 한 번 눌러 깨워야 합니다. 매일 쓰는 앱이면 해당 없습니다.

**파일 크기 제한** — 50MB. `schema.sql` 의 `file_size_limit` 값을 바꾸면 조정됩니다.
긴 동영상은 원본 그대로 올리면 무거우니 주의하세요.

**메시지 보관** — 방을 유지하는 동안은 계속 남습니다. 대화 목록은 최근 500건까지
불러옵니다. 그보다 오래된 기록도 DB에는 남아 있습니다.

**아이 계정 관리** — 부모가 이메일과 비밀번호를 만들어 주고 관리하는 방식을 권합니다.
비밀번호를 잊으면 Supabase 대시보드 **Authentication → Users** 에서 바로 바꿀 수 있습니다.

**아는 사람만 들어오게** — 3단계에서 이메일 확인을 껐기 때문에, 주소를 아는 사람이
가입 화면에서 계정을 만들 수 있습니다. 가족 전원이 가입을 끝냈다면
**Authentication → Sign In / Providers → Email → Allow new users to sign up** 을 꺼서
문을 잠가 두세요. 이게 가장 확실한 잠금장치입니다.

---

## 파일 구성

```
public/
  index.html      화면 골격
  app.js          인증·방·실시간 메시지·첨부·푸시 전부
  styles.css      라이트/다크 자동 전환
  sw.js           서비스 워커 (알림 수신)
  manifest.json   홈 화면 추가 설정
  config.js       ← 여기만 채우면 됩니다
  icon-*.png      앱 아이콘

schema.sql        DB 전체 (테이블·보안·트리거·버킷)
schema-patch.sql  이미 설치한 DB에 덧붙이는 수정 패치
supabase/functions/send-push/index.ts   알림 발송
```
