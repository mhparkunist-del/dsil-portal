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

  /* 장비 예약 */
  equipment: {
    dayStart: 8,               /* 캘린더 표시 시작 시각 (0~23) */
    dayEnd: 22,                /* 캘린더 표시 종료 시각 (1~24) */
    slotMinutes: 30,           /* 예약 시간 단위(분) */
    maxHours: 8,               /* 1회 최대 예약 시간 */
    logDueDays: 7,             /* 사용 후 로그 작성 기한(일). 지나도록 미작성이면 새 예약 차단 */
    managerUnlockMinutes: 10   /* 장비 담당자 PIN 확인 후 잠금 유지 시간(분) */
  },

  /* 출석 시트 */
  attendance: {
    openAfter: '06:00',          /* 이 시각부터 출석 체크 가능 (전날 11:00 ~ 오늘 06:00 사이는 불가) */
    lateAfter: '09:00',          /* 이 시각 이후 출석 체크는 지각 (사유를 적으면 정상 참작) */
    closeAfter: '11:00',         /* 이 시각 이후에는 출석 체크 불가 → 미기입(결근) */
    vacationDaysPerHalf: 2,      /* 상반기(1~6월)·하반기(7~12월) 각 휴가 일수 */
    selfRegister: true,          /* 처음 로그인하는 이름은 입력한 PIN 으로 자동 등록. false 면 관리자가 등록해야 함 */
    /* 공휴일 초기값. 이후에는 관리자 탭에서 추가·삭제 (저장된 목록이 우선). 매년 확인해서 갱신하세요. */
    holidays: {
      '2026-01-01': '신정', '2026-02-16': '설날 연휴', '2026-02-17': '설날', '2026-02-18': '설날 연휴',
      '2026-03-01': '삼일절', '2026-03-02': '삼일절 대체공휴일', '2026-05-05': '어린이날', '2026-05-24': '부처님오신날', '2026-05-25': '부처님오신날 대체공휴일',
      '2026-06-03': '지방선거일', '2026-06-06': '현충일', '2026-08-15': '광복절', '2026-08-17': '광복절 대체공휴일',
      '2026-09-24': '추석 연휴', '2026-09-25': '추석', '2026-09-26': '추석 연휴', '2026-09-28': '추석 대체공휴일',
      '2026-10-03': '개천절', '2026-10-05': '개천절 대체공휴일', '2026-10-09': '한글날', '2026-12-25': '성탄절'
    }
  },

  /* 보안: 로그인 잠금·매크로 의심 감지·알림 */
  security: {
    maxLoginFailures: 5,       /* 같은 이름으로 연속 실패 허용 횟수. 넘으면 잠금 */
    lockoutMinutes: 10,        /* 잠금 시간(분) */
    macroThresholdMs: 1200,    /* 페이지가 뜬 뒤 이 시간(ms) 안에 제출되면 매크로 의심으로 기록·알림 */
    /* 알림 웹훅(Discord 또는 Slack incoming webhook URL). 비우면 포털 관리자 화면의 보안 이벤트에만 남습니다.
       이 파일은 공개 저장소에 올라가므로 웹훅 주소가 노출됩니다. 노출이 싫으면 공용 DB 모드에서 DB 트리거 알림을 쓰세요. */
    alertWebhookUrl: ''
  },

  /* 소모품 재고 */
  inventory: {
    categories: ['웨이퍼·기판', '케미컬·가스', '전구체·타겟', '소모품·공구', '기타'],
    managerUnlockMinutes: 10     /* 중간 관리자 PIN 확인 후 잠금 유지 시간(분) */
  },

  /* local 모드 첫 실행 시 예시 과제·요청을 채워 넣을지 여부 */
  seedDemoData: true,

  /* 예산 사용률 경고 기준 (0.8 = 80%) */
  warnRatio: 0.8,

  labName: 'Device-to-System Integration Lab (DSIL)',
  university: 'KAIST'
};
