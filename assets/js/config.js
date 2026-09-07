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

  /* 관리자 탭에 들어갈 때마다 묻는 PIN. 공용 DB 모드에서는 profiles.is_admin 인 사람만 이 단계까지 옵니다. */
  adminPin: '0000',
  /* PIN 을 맞힌 뒤 관리자 잠금이 유지되는 시간(분). 지나면 다시 묻습니다. */
  adminUnlockMinutes: 10,

  /* 과제 예산 비목. id 는 저장 키이므로 운영 중에 바꾸지 마세요. label 은 자유롭게 수정 가능. */
  budgetCategories: [
    { id: 'material',  label: '재료비' },
    { id: 'activity',  label: '연구활동비' },
    { id: 'equipment', label: '장비구매비' },
    { id: 'other',     label: '기타' }
  ],

  /* 구매 절차 기준 (KAIST). 금액이 upTo 이하이면 해당 단계, null 은 상한 없음. 위에서부터 차례로 판정. */
  procurementTiers: [
    { upTo: 5000000,  label: '자체 검수',   cls: 'bg-green-lt',  desc: '500만원 이하 · 중앙검수 불필요' },
    { upTo: 9999999,  label: '중앙검수',    cls: 'bg-yellow-lt', desc: '500만원 초과 · 중앙검수 필요' },
    { upTo: 19999999, label: '구매팀 구매', cls: 'bg-orange-lt', desc: '1,000만원 이상 · 구매팀 경유' },
    { upTo: null,     label: '구매팀 입찰', cls: 'bg-red-lt',    desc: '2,000만원 이상 · 구매팀 입찰' }
  ],

  /* 구매 심의 열람 PIN 형식 (숫자 4~8자리) */
  reviewPinPattern: '\\d{4,8}',

  /* local 모드 첫 실행 시 예시 과제·요청을 채워 넣을지 여부 */
  seedDemoData: true,

  /* 예산 사용률 경고 기준 (0.8 = 80%) */
  warnRatio: 0.8,

  labName: 'Device-to-System Integration Lab (DSIL)',
  university: 'KAIST'
};
