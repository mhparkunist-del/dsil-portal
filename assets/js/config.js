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

  /* 기본 계정 (local 모드): 처음 열 때 없으면 승인된 구성원으로 만들어 둡니다. 같은 이름이 이미 있으면 건드리지 않습니다.
     참여과제 시트(assets/data/participation.js)의 인원 전체. PIN 은 저장 시 SHA-256 으로 해시되며, 각자 로그인 후 바꾸는 것을 권장합니다. */
  defaultAccounts: [
    { name: '박민호', pin: '0000' }, { name: '음성민', pin: '0000' }, { name: '이현진', pin: '0000' },
    { name: '김형준', pin: '0000' }, { name: '백승훈', pin: '0000' }, { name: '양희수', pin: '0000' },
    { name: '김경선', pin: '0000' }, { name: '위동진', pin: '0000' }, { name: '최서연', pin: '0000' },
    { name: '윤진수', pin: '0000' }, { name: '한기환', pin: '0000' }, { name: '전우민', pin: '0000' },
    { name: '이종현', pin: '0000' }, { name: '이경빈', pin: '0000' }, { name: '장시원', pin: '0000' },
    { name: '추한조', pin: '0000' }, { name: '인유진', pin: '0000' }, { name: '정학순', pin: '0000' },
    { name: '이용우', pin: '0000' }, { name: '조영민', pin: '0000' }, { name: '구현호', pin: '0000' },
    { name: '조동올', pin: '0000' }
  ],

  /* 일회성 데이터 초기화. id 를 바꾸면 그 브라우저에서 딱 한 번 아래 항목을 지웁니다. 과제·참여연구원·장비·계정·서명은 항상 유지.
     clearRequests  : 구매 요청·구매 보고서·회의비 청구·회의록·구매 심의·내보내기 이력·회의비 처리 로그 (보고서 사진도 함께 삭제)
     clearEquipment : 장비 예약과 사용 로그
     clearInventory : 소모품 품목과 입출고 이력 (담당자 지정은 유지)
     clearAcquisitions : 장비 도입 건과 변경 이력 (중간 담당자 지정은 유지)
     clearSecurity  : 보안 이벤트·출석 기록
     pruneAccounts  : 관리자와 defaultAccounts 에 없는 계정 삭제
     clearLogs      : 위 전부 (예전 초기화에서 쓰던 방식) */
  dataReset: { id: '2026-09-16-clean', clearRequests: true, clearInventory: true, clearSecurity: true, pruneAccounts: false },

  /* 기본 장비 (local 모드): 이름이 같은 장비가 없으면 만들어 둡니다. managerPin 은 담당자 PIN, users 는 미리 등록할 사용자와 등급. */
  defaultEquipment: [
    { name: '프로브 스테이션', location: '', managerName: '백승훈', managerPin: '0000', color: '#004191', description: '', rules: '', users: [{ name: '백승훈', grade: 'super' }] }
  ],
  /* PIN 을 맞힌 뒤 관리자 잠금이 유지되는 시간(분). 지나면 다시 묻습니다. */
  adminUnlockMinutes: 10,

  /* 과제 예산 비목. id 는 저장 키이므로 운영 중에 바꾸지 마세요. label 은 자유롭게 수정 가능.
     pool 이 없는 비목이 행정 연구비 현황의 세목(연구재료비·연구활동비·연구시설·장비비)이고,
     pool 이 있는 비목은 그 세목에서 차감됩니다 (회의비 → 연구활동비). */
  budgetCategories: [
    { id: 'material',  label: '연구재료비' },
    { id: 'activity',  label: '연구활동비' },
    { id: 'equipment', label: '연구시설·장비비' },
    { id: 'meeting',   label: '회의비', pool: 'activity' },
    { id: 'other',     label: '기타', pool: 'material' }
  ],

  /* 과제 예산 (관리자 전용). 금액은 이 파일에 넣지 않습니다 (공개 저장소).
     관리자가 구매 요청 > 관리자 탭에서 행정 연구비 현황 엑셀을 올리면 그 브라우저(공용 DB 모드에서는 DB)에만 저장됩니다. */
  budget: {
    refreshDays: 14,            /* 행정 현황 갱신 주기(일). 기준일이 이보다 오래되면 갱신 안내 */
    mustSpendDays: 120,         /* 종료일까지 이 일수 이하로 남으면 '종료 임박' */
    recentCheckDays: 7,         /* 기준일 직전 이 기간에 처리한 건은 행정 잔액 반영 여부 확인 대상으로 표시 */
    /* 예산 관리·배정에서 빼는 과제 (참여과제 시트 약칭 또는 엑셀 구분) */
    excludeAliases: ['개인과제', '이노코어', '성장형포스닥', '기본과제'],
    /* 엑셀 '구분' → 참여과제 시트 약칭. 같은 이름이면 적지 않아도 됩니다 */
    aliasMap: {
      '차세대지능형반도체': '차지반',
      'K-Chips 정부': 'K-chips(정)',
      'K-Chips 민간': 'K-chips(민)',
      '연구개발특구': '개발특구',
      'AI Science Hub': 'AI사이언스허브',
      'AIP 위탁 IITP': 'IITP'
    }
  },

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

  /* 회의비: 참여과제 시트(assets/data/participation.js)에 있는 과제·참여자만 배정. 청구 즉시 과제에 처리되고 회의록 작성으로 넘어감 */
  meeting: {
    perPersonMax: 30000,      /* 1인당 회의비 상한(원). 금액 ÷ 인원이 이 값을 넘으면 제출 불가, 자동 추가로 인원을 채움 */
    autoProcessedBy: '자동 배정 (참여과제)',
    /* 과제별 특별 규칙 (키 = 시트 약칭). minNonParticipants: 그 과제 참여자가 아닌 연구실 연구원(시트에 있는 사람)을 최소 몇 명 포함해야 하는지.
       규칙이 없는 과제는 참여자만 참석자로 넣을 수 있습니다. */
    projectRules: {
      '우수신진': { minNonParticipants: 1 }
    }
  },

  /* 구매 보고서 (구매 후 증빙 양식) */
  report: {
    inspectionThreshold: 500000,     /* 이 금액 초과: 검수 필요 → 자체 검수 물품 사진 첨부 */
    centralThreshold: 5000000,       /* 이 금액 초과: 중앙검수 대상 (물품 사진 + 검수 담당자 절차) */
    minItemPhotos: 2,                /* 검수 사진 최소 장수 */
    maxPhotoEdge: 1400,              /* 첨부 사진 긴 변 픽셀 (브라우저에서 자동 축소) */
    defaultAccountManager: '권지민',  /* 계정책임자 기본값 (과제별로 바꿀 수 있음) */
    /* 검수자(포닥연구원). 제출된 구매 보고서를 승인하면 그 사람의 서명이 검수자 칸에 들어갑니다.
       이름은 포털 로그인 이름과 같아야 하며, 이 명단에 있는 사람과 관리자만 승인·보완 요청을 할 수 있습니다. */
    inspectors: ['조영민', '정학순', '이용우'],
    defaultInspector: ''             /* 비우면 작성자가 위 명단에서 고릅니다 */
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

  /* 장비 도입 (구매 계획·입찰·결제·유틸리티·배치)
     중간 담당자: 신청을 확인·등록하고 장비 구매 담당자와 그 건의 비밀번호를 정함 (로그인 이름 + 중간 담당자 PIN)
     구매 담당자: 로그인 후 그 건의 비밀번호로 진행 상황을 갱신. 모든 변경은 관리자만 보는 이력에 남음
     예산: 관리자가 승인한 결제 항목만 과제 예산에 반영 (구매 완료 전 가할당, 구매 완료 후 실집행)
     stages·utilities 의 id 는 저장 키이므로 운영 중에 바꾸지 마세요. label 은 자유롭게 수정 가능. */
  equipmentAcquisition: {
    stages: [
      { id: 'plan',       label: '장비 도입 계획', cls: 'bg-secondary-lt' },
      { id: 'bid_doc',    label: '입찰서 작성',    cls: 'bg-azure-lt',  bid: true },
      { id: 'bid_before', label: '입찰 전',        cls: 'bg-blue-lt',   bid: true },
      { id: 'bid_failed', label: '유찰',           cls: 'bg-orange-lt', bid: true },
      { id: 'contracted', label: '계약 완료',      cls: 'bg-purple-lt' },
      { id: 'purchased',  label: '구매 완료',      cls: 'bg-green-lt' }
    ],
    utilities: [
      { id: 'n2',    label: 'N2' },
      { id: 'air',   label: '공압' },
      { id: 'power', label: '전기공사' },
      { id: 'water', label: '워터' },
      { id: 'duct',  label: '덕트' }
    ],
    paymentMethods: ['법인카드', '계좌이체', '구매팀 발주', '기타'],
    bidThreshold: 20000000,        /* 이 금액 이상이면 입찰 대상으로 안내 (procurementTiers 의 구매팀 입찰 기준) */
    managerUnlockMinutes: 10,      /* 중간 담당자·구매 담당자 비밀번호 확인 후 잠금 유지 시간(분) */
    /* 기본 중간 담당자 (local 모드): 이름이 없으면 만들어 둡니다. 관리자 탭에서도 추가·PIN 재설정 가능 */
    defaultManagers: []
  },

  /* 소모품 재고 */
  inventory: {
    categories: ['웨이퍼·기판', '케미컬·가스', '전구체·타겟', '소모품·공구', '기타'],
    managerUnlockMinutes: 10     /* 중간 관리자 PIN 확인 후 잠금 유지 시간(분) */
  },

  /* local 모드 첫 실행 시 예시 데이터(과제·요청·장비·출석·재고·예시 계정)를 채울지 여부.
     false 면 관리자 계정(관리자 / 0000)만 있는 빈 상태로 시작합니다. */
  seedDemoData: false,

  /* 예산 사용률 경고 기준 (0.8 = 80%) */
  warnRatio: 0.8,

  labName: 'Device-to-System Integration Lab (DSIL)',
  university: 'KAIST'
};
