/* =====================================================================
   여기 세 줄만 여러분 값으로 바꾸면 앱이 동작합니다.

   URL 과 키: Supabase 대시보드 > Settings > API Keys
     - SUPABASE_URL : 'https://xxxxx.supabase.co' 형태
     - 키          : Publishable key (sb_publishable_... 로 시작) 를 넣으세요.
                     예전에 만든 프로젝트라 Publishable key 가 없다면
                     Legacy API Keys 탭의 anon key (eyJ... 로 시작) 도 됩니다.

   VAPID 공개키: npx web-push generate-vapid-keys 실행 결과의 Public Key

   ⚠ Secret key (sb_secret_...) 나 service_role 키는 절대 넣지 마세요.
     이 파일은 브라우저에 그대로 노출됩니다.
   ===================================================================== */
window.CONFIG = {
  SUPABASE_URL: 'https://cqtullgrlrrgzxijqxzs.supabase.co/',
  SUPABASE_ANON_KEY: 'sb_publishable_tvuqCv1p15Nv5Zc7Z9vH8A_T8CJ9iyL',
  VAPID_PUBLIC_KEY: 'BKkW9UCMo9DJZvIqNFudEL5_DgwtsH0GE5cg04yCfpAe9LVF5JIBushnQVJVwwJuO00YOYsRBjCAtx3s8Wnj0Xg',
};
