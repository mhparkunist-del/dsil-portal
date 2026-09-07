/* =====================================================================
   DSIL Lab Portal – runtime configuration
   ---------------------------------------------------------------------
   backend
     'local'    : 브라우저 localStorage 에 저장 (설치 없이 바로 동작, 데모/개인용)
     'supabase' : Supabase(Postgres) 공용 DB 사용 – 연구실 전체가 같은 데이터를 봄
                  → supabase/schema.sql 을 Supabase SQL Editor 에서 실행한 뒤
                    아래 supabaseUrl / supabaseAnonKey 를 채우세요.
   ===================================================================== */
window.DSIL_CONFIG = {
  backend: 'local',

  supabaseUrl: '',
  supabaseAnonKey: '',

  /* local 모드에서 관리자 화면으로 전환할 때 쓰는 PIN (공용 DB 모드에서는 profiles.is_admin 사용) */
  adminPin: '0000',

  /* local 모드 첫 실행 시 예시 과제·요청을 채워 넣을지 여부 */
  seedDemoData: true,

  /* 예산 사용률 경고 기준 (0.8 = 80%) */
  warnRatio: 0.8,

  labName: 'Device-to-System Integration Lab (DSIL)',
  university: 'KAIST',
  address: 'Room 2302, Building E3-3 (Device Innovation Facility), KAIST, 291 Daehak-ro, Yuseong-gu, Daejeon 34141, Republic of Korea',
};
