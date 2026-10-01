# DSIL Lab Portal 기술 문서

KAIST DSIL(Device-to-System Integration Lab) 내부 업무 포털의 구조, 설계 의도, 수정 방법과 주의사항, 개발하면서 겪은 문제를 정리한 문서입니다. 코드를 고치기 전에 한 번 읽어 주세요. 사용법 위주의 안내는 [README.md](../README.md)에 있습니다.

- 저장소: https://github.com/mhparkunist-del/dsil-portal (공개)
- 사이트: https://mhparkunist-del.github.io/dsil-portal/
- 시작: 2026-09-07, 관리: 박민호

---

## 1. 이 포털이 하려는 일

연구실에서 카톡·엑셀·한글 파일로 흩어져 처리되던 행정 업무를 한곳에 모으는 것이 목적입니다.

| 모듈 | 경로 | 해결하려는 문제 |
|---|---|---|
| 구매 요청 | `budget/` | 구매 건이 관리자에게 모이고, 관리자가 추천 과제를 보고 배정하면 예산이 자동으로 차감됩니다. 신청자는 처리 여부를 직접 확인합니다. 과제 예산 대시보드(관리자 전용)는 2주마다 받는 행정 연구비 현황 엑셀을 기준으로 합니다 |
| 구매 보고서 | `report/` | 정산용 한글 양식(영수증·거래내역·기타 정보 표·검수 사진)을 입력만으로 만들고, 포닥 검수자가 승인·서명합니다 |
| 회의비 처리 | `meeting/` | 참여과제 시트 기준으로 참석자와 1인당 한도를 자동 확인하고 회의록 양식을 만듭니다 |
| 장비 예약 | `equipment/` | 캘린더 예약, 사용 로그, 로그 미작성자 예약 차단, 담당자별 사용자 등급 관리 |
| 소모품 재고 | `inventory/` | 보관 장소별 보유량과 소모 이력 (단가는 다루지 않음) |
| 장비 도입 | `acquisition/` | 장비 구매 계획부터 입찰·계약·구매 완료까지 진행 상황, 결제 과제 분담, 필요 유틸리티, 배치 위치를 한곳에서 관리. 변경 이력은 관리자만 봅니다 |
| 출석 시트 | `archive/attendance/` | 보류. 코드와 스키마는 남아 있음 |

설계 원칙은 다음과 같습니다.

1. **실제 서류 양식을 그대로 재현**합니다. 보고서·회의록은 연구실에서 쓰던 HWP 양식의 표 구조와 순서를 따르고, 인쇄본과 DOCX로 내보내 한글에서 hwp로 저장할 수 있게 합니다.
2. **규칙은 사람이 아니라 화면이 지키게** 합니다. 50만원 초과 검수 사진, 네이버페이 배송비 일치, 1인당 회의비 3만원, 우수신진 미참여 연구원 1명, 로그 7일 기한 같은 규칙을 입력 단계에서 막거나 안내합니다.
3. **권한은 이름으로 확인**합니다. 장비·소모품 담당자, 장비 도입 중간 담당자·구매 담당자, 검수자는 모두 "로그인한 이름이 지정된 이름과 같은가"로 판단합니다. PIN만 알아서는 남의 권한을 쓸 수 없습니다.
4. **설치 없이 바로 쓰는 것**을 우선했습니다. 빌드 도구·서버 없이 정적 파일만으로 GitHub Pages에서 돕니다.

---

## 2. 기술 구성

- 정적 HTML + CSS + 바닐라 JavaScript. 빌드 단계가 없습니다. 파일을 고치고 push하면 1~2분 뒤 사이트에 반영됩니다.
- 배포: GitHub Pages, `main` 브랜치 루트. `.nojekyll`로 Jekyll 처리를 끕니다.
- 외부 라이브러리는 CDN에서 버전을 고정해 불러옵니다.

| 라이브러리 | 버전 | 용도 | 출처 |
|---|---|---|---|
| Tabler core | 1.5.0 | UI 프레임워크 (MIT) | jsDelivr |
| Tabler Icons webfont | 3.46.0 | 아이콘 | jsDelivr |
| Pretendard | 1.3.9 | 한글 글꼴 | jsDelivr |
| FullCalendar | 6.1.21 | 장비 예약 캘린더 | jsDelivr |
| JSZip | 3.10.1 | DOCX 생성 | cdnjs |
| SheetJS (xlsx) | 0.18.5 | 참여과제 엑셀 읽기 | cdnjs |

### 폴더 구조

```text
dsil-portal/
├── index.html                  로그인 포털 + 도구 타일 + 관리자(가입 승인·계정·보안 이벤트)
├── budget/ report/ meeting/ equipment/ inventory/ acquisition/   모듈별 페이지 (각 index.html)
├── archive/attendance/         보류된 출석 시트
├── assets/
│   ├── css/portal.css          Tabler 위 덮어쓰기 (KAIST 블루 #004191, 인쇄 레이아웃, 캘린더)
│   ├── data/participation.js   참여과제 시트 데이터 (엑셀에서 생성)
│   └── js/
│       ├── config.js           모든 설정값 (PIN, 비목, 규칙, 기본 계정, 초기화)
│       ├── ui.js               공용 UI 헬퍼 (esc, won, 모달, 토스트, readForm …)
│       ├── store.js            데이터 계층 (local / supabase 어댑터)
│       ├── budget-core.js      과제 예산 계산 (세목·기준 잔액·긴급도·배정 추천). budget·meeting·acquisition 공용
│       └── portal.js budget.js report.js meeting.js equipment.js inventory.js acquisition.js
├── supabase/schema.sql         공용 DB 스키마·RLS·서버 함수 (아직 미사용)
└── docs/TECHNICAL.md           이 문서
```

각 페이지 JS는 같은 패턴을 따릅니다. `store.init()` → 세션 확인(없으면 `../index.html?next=<모듈>`로 이동) → `reload()`로 데이터 읽기 → `render()`로 `#app`에 HTML 문자열을 그림. 이벤트는 `document`에 한 번 걸고 `data-action` 속성으로 분기합니다.

---

## 3. 데이터 저장 방식 (가장 중요)

`config.js`의 `backend`가 저장 방식을 정합니다. **현재 운영값은 `local`입니다.**

### local 모드 (현재)

- 모든 데이터가 **각 사람의 브라우저 localStorage**에 저장됩니다. 키는 `dsil-portal-v2`, 세션은 `dsil-portal-session-v2`.
- 사진과 서명 이미지는 용량 때문에 IndexedDB `dsil-portal-photos`에 따로 둡니다.
- 따라서 **사람마다, 브라우저마다 데이터가 다릅니다.** A가 올린 구매 요청을 관리자가 자기 PC에서 볼 수 없습니다. 지금은 시연·양식 검증 단계이고, 실사용 전에 공용 DB로 옮겨야 합니다.
- 코드로 모두에게 적용할 수 있는 것은 `config.js`의 기본값뿐입니다 (기본 계정, 기본 장비, 참여과제 시트, 일회성 초기화).

### supabase 모드 (준비됨, 미가동)

- `supabase/schema.sql`을 Supabase SQL Editor에서 실행하고 `config.js`의 `backend`, `supabaseUrl`, `supabaseAnonKey`를 채우면 연구실 전체가 같은 데이터를 봅니다.
- 권한은 RLS(Row Level Security)와 security definer 함수로 서버에서 강제합니다. 예산(`budgets`, `budget_base`)은 관리자만 읽고 구성원은 예산이 빠진 `projects_public` 뷰를 봅니다. 장비·소모품·장비 도입 담당자 확인은 `verify_equipment_manager`, `inv_verify_manager`, `acq_verify_manager`/`acq_actor` 함수가 이름까지 확인합니다.
- **실제 DB에서 실행 검증을 한 적이 없습니다.** 전환할 때 모듈별로 한 번씩 흐름을 돌려 봐야 합니다.

### store.js 규칙

- local과 supabase 어댑터는 **같은 이름·같은 인자·같은 반환 형태**의 함수를 가져야 합니다. 한쪽에만 함수를 추가하면 모드 전환 시 깨집니다.
- `migrate(data, cfg)`가 불러온 데이터를 현재 형태로 맞춥니다. 새 필드를 추가하면 여기에 기본값을 넣어 옛 데이터가 깨지지 않게 하세요.
- 권한 확인은 **store에서** 합니다 (`checkManager`, `checkInvManager`, `verifyReport`의 검수자 확인 등). 화면에서 버튼을 숨기는 것만으로는 부족합니다.

### 주요 데이터

| 키 | 내용 |
|---|---|
| `accounts` | 이름, PIN 해시(SHA-256), role(admin/member), status, signatureKey |
| `projects` | 과제명, 과제번호(code), 세목별 기준 잔액(budgets), budgetBase(행정 현황 기준일·통합 잔액·집행 상태·소진 필요·집행 전 확인), alias(시트 약칭), participants, cardUsers, accountManager. owners 는 예전 값만 보존(사용 안 함) |
| `requests` | 구매 요청과 회의비 청구. `kind`가 purchase/meeting. `report`에 보고서·회의록 JSON |
| `reviews` | 구매 심의 (승인 시 가할당) |
| `exports` | 보고서 내보내기 이력 (삭제 경로 없음) |
| `equipment`, `reservations`, `usageLogs` | 장비, 예약, 사용 로그 |
| `invManagers`, `invItems`, `invMoves` | 소모품 담당자, 품목, 입출고 |
| `meetingLogs`, `security` | 회의비 처리 로그, 보안 이벤트 (추가만) |
| `participationRows`, `participationImport` | 참여과제 시트 원본과 가져오기 정보 |
| `acqManagers`, `acquisitions`, `acqLogs` | 장비 도입 중간 담당자(PIN 해시), 도입 건(건 비밀번호 해시, 결제 항목, 승인 스냅샷), 변경 이력 (추가만) |
| `dataResetId` | 적용된 일회성 초기화 id |

예산 계산 (`budget-core.js` 한 곳에서만): **잔액 = 기준 잔액 − 기준일 이후 실집행 − 가할당**.

- **세목(pool)**: `budgetCategories` 중 `pool` 이 없는 비목 = 연구재료비·연구활동비·연구시설·장비비 (행정 현황과 같음). 회의비(`meeting`)는 `pool: 'activity'` 라 연구활동비에서, 기타는 연구재료비에서 차감됩니다. 비목 선택 화면에는 세목 3개만 나옵니다.
- **기준 잔액**: 관리자가 행정 연구비 현황 엑셀을 올리면 `projects.budgets` 에 그 날짜의 세목별 **잔액**이, `projects.budgetBase.date` 에 기준일이 들어갑니다. 기준일 이전에 처리한 건은 이미 행정 잔액에 반영된 것으로 보고 빼지 않습니다. 기준일이 없는 과제(직접 입력)는 처리 건을 모두 뺍니다.
- **통합 잔액**: 세목 구분 없는 과제(신임교원정착연구비)는 `budgetBase.unified` 하나에서 모든 비목이 차감됩니다.
- **가할당**: 승인된 구매 심의의 미집행분 + 승인된 장비 도입 결제 항목(구매 완료 전). 장비 도입은 구매 완료 시각(`purchasedAt`)이 기준일 이후면 실집행으로 잡힙니다.
- **예산은 관리자만**: 화면은 관리자 PIN 이후에만 금액을 그리고, 공용 DB 에서는 `projects`(budgets·budget_base) 와 `acq_allocations` 를 관리자만 읽습니다. 예전의 과제 담당자(owners) 열람은 없앴습니다.

---

## 4. 모듈별 흐름

### 구매 요청 → 보고서 → 검수

1. 구성원이 구매 요청 (`status: pending`).
2. 관리자가 과제·비목을 배정 (`status: done`). 예산에서 실집행으로 차감.
3. 물품 도착 후 작성자가 보고서 작성. 영수증·거래내역 사진, 50만원 초과면 검수 사진 2장 이상.
4. **검수 요청** (`report.status: submitted`, 화면 표시 "검수 대기").
5. 포닥 검수자(`config.report.inspectors`: 조영민·정학순·이용우) 또는 관리자가 승인 (`verified`, "검수 완료"). 승인자 이름과 그 계정의 서명 이미지가 검수자 칸에 들어갑니다. 보완 요청 시 `draft`로 돌아갑니다.

금액 기준: ≤50만원 검수 없음, 50만~500만원 자체 검수 사진, 500만원 초과 중앙검수 안내. 구매 절차 기준(구매팀·입찰)은 `procurementTiers`.

### 회의비

- 승인 단계가 없습니다. 제출 즉시 과제 회의비에서 차감되고 회의록 작성으로 넘어갑니다.
- 과제 목록은 참여과제 시트 기준, 참석자는 그 과제 참여자(회의 월 기준)만.
- 1인당 `perPersonMax`(30,000원) 초과 금지, "자동 추가"가 최소 인원을 채웁니다.
- `projectRules`: 우수신진은 미참여 연구원 1명 이상 필수.
- 모든 처리가 `meetingLogs`에 남습니다.

### 장비 예약

- 담당자가 등록한 유저·슈퍼유저 등급만 예약. 관리자 계정은 등록 없이 예약 가능.
- 사용 로그 7일 초과 미작성이면 새 예약 차단.
- 담당자 탭은 그 장비 `managerName`과 로그인 이름이 같아야 열림.
- 캘린더에서 지난 시간은 30분 칸 단위로 회색 처리.

### 소모품

- 담당자 이름과 로그인 이름이 같아야 담당자 탭이 열림. 수량만 관리.

### 과제 예산 (관리자)

1. 2주마다 행정 연구비 현황 엑셀을 **구매 요청 > 관리자 > 연구비 현황 엑셀 올리기**로 올림. 브라우저 안에서 SheetJS 로 읽고(서버 전송 없음), `과제명`·`구분` 머리글 행을 찾아 열 이름(장비·재료·활동·현재 잔액·집행 상태·비고)으로 매핑. 기준일은 위쪽 안내 문구의 날짜 → 파일명 yymmdd 순.
2. 미리보기에서 과제 연결(`budget.aliasMap` → 약칭/과제명 일치 → 새 과제)과 제외(`budget.excludeAliases`, 포함 검사) 확인 후 적용. 과제번호·참여자는 유지되고 과제명·기간·세목 잔액·`budgetBase` 가 갱신됨.
3. 집행 상태 문구에 "소진"이 있으면 올해 소진 필요(must), "확인"이 있거나 기간이 없으면 집행 전 확인(check). 긴급도 순서: must → 종료 임박(`mustSpendDays` 이내) → 여유 → check.
4. 미처리 구매 요청마다 추천 3개: 잔액 충분 → must → 종료일 → 요청자 참여 과제. check 과제는 배정 때 한 번 더 확인. 추천 버튼은 일반 배정과 같은 초과 확인을 거침.
5. 기준일 직전 `recentCheckDays`(7일) 안에 처리한 건은 "행정 반영 확인" 목록에 뜸. 기준일이 `refreshDays`(14일)를 넘으면 갱신 안내.

### 장비 도입

1. 구성원 신청 (`status: requested`): 장비명·교수님 컨펌·사용 의도·도입 시기.
2. 중간 담당자(`acqManagers`, 로그인 이름 + 중간 담당자 PIN) 확인 → 구매 담당자 이름과 **건 비밀번호** 지정 (`active`). 또는 반려(`rejected`), 직접 등록.
3. 구매 담당자(로그인 이름 = `purchaserName` + 건 비밀번호)가 진행 항목(`ACQ_PROG_FIELDS`)만 수정. 중간 담당자는 등록 항목(`ACQ_REG_FIELDS`) + 구매 담당자·비밀번호, 관리자는 전부. 허용 필드는 store(공용 DB 는 `acq_update`)에서 역할별로 거름.
4. 관리자 승인 시 그때의 결제 항목을 `approval.payments` 로 저장 → 예산 반영. 이후 결제 항목이 바뀌면 화면에 "재승인 필요", 예산은 재승인 전까지 승인 당시 항목 기준.
5. 모든 변경은 `acqLogs` 에 `{by, role, action, changes:[{field, before, after}], note}` 로 추가만. 관리자 탭에서 열람·CSV.

---

## 5. 자주 하는 수정

대부분 `assets/js/config.js`만 고치면 됩니다.

| 하고 싶은 것 | 고칠 곳 |
|---|---|
| 구성원 추가 | `defaultAccounts`에 `{ name, pin }` 추가. 같은 이름이 있으면 건드리지 않음 |
| 검수자 변경 | `report.inspectors` |
| 계정책임자 기본값 | `report.defaultAccountManager` |
| 회의비 한도·과제별 규칙 | `meeting.perPersonMax`, `meeting.projectRules` |
| 비목 추가 | `budgetCategories`. **id는 저장 키라 운영 중 바꾸면 안 됨**, label만 자유. 세목이 아니면 `pool` 로 차감할 세목 지정 |
| 예산 관리 제외 과제 | `budget.excludeAliases` (이름에 포함되면 제외) |
| 행정 엑셀 구분 ↔ 시트 약칭 | `budget.aliasMap` |
| 현황 갱신 주기·종료 임박 기준 | `budget.refreshDays`, `budget.mustSpendDays`, `budget.recentCheckDays` |
| 장비 도입 단계·유틸리티·결제 수단 | `equipmentAcquisition.stages` / `utilities` / `paymentMethods` (id 변경 금지) |
| 장비 도입 기본 중간 담당자 | `equipmentAcquisition.defaultManagers` 또는 장비 도입 > 관리자 > 중간 담당자 |
| 장비 기본값 | `defaultEquipment` |
| 관리자 PIN | `adminPin` |
| 기록 한 번에 지우기 | `dataReset.id`를 새 값으로, 지울 항목 플래그만 true (아래 참고) |
| 참여과제 시트 갱신 | 회의비 관리자 탭에서 엑셀 업로드, 또는 스크립트로 `assets/data/participation.js` 재생성 |

### 일회성 초기화 (`dataReset`)

`id`가 바뀌면 각 브라우저에서 **한 번만** 실행됩니다. 플래그: `clearRequests`(구매·보고서·회의비·심의·내보내기·회의비 로그, 보고서 사진 포함), `clearEquipment`, `clearInventory`, `clearAcquisitions`(장비 도입 건·이력), `clearSecurity`, `pruneAccounts`, `clearLogs`(전부). 과제·시트·장비·계정·서명은 항상 남습니다.

주의: 누군가 작업 중일 때 배포하면 그 사람 브라우저에서 진행 중이던 건이 사라집니다. 공지하고 돌리세요.

---

## 6. 수정할 때 유의사항

1. **main에 바로 push하지 말고 PR로.** 저장소에 보호 규칙(`protect-main`)이 있어 협업자는 PR만 가능합니다. main에 들어가면 곧바로 라이브 사이트에 반영됩니다.
2. **공개 저장소입니다.** `config.js`에 넣은 값(PIN 기본값, 웹훅 주소, Supabase 키)은 누구나 볼 수 있습니다. 비밀이 필요한 값은 넣지 마세요. PIN 0000은 초기값일 뿐이며 각자 바꾸도록 안내해야 합니다.
3. **사용자 입력은 반드시 `esc()`로 감싸서** HTML에 넣습니다. 화면을 문자열로 조립하므로 빠뜨리면 XSS가 됩니다.
4. **버튼을 `disabled`로 잠그지 말고, 눌렀을 때 이유를 보여 주세요.** 제출 버튼을 잠갔다가 "다음 단계로 안 넘어간다"는 문의가 실제로 있었습니다. 지금은 빠진 항목을 토스트로 알리고 빨간 테두리로 표시합니다.
5. **`render()` 안에서 `state.tab`을 바꾸지 마세요.** 데이터가 오기 전에 한 번 그려질 때 탭이 초기화됩니다. 보여 줄 탭은 지역 변수로 계산합니다.
6. **권한은 이름 비교(`nameKey`: 공백 제거·소문자)** 로 합니다. 담당자·검수자 이름은 포털 로그인 이름과 정확히 같아야 합니다.
7. **옛 데이터 호환**: 필드를 추가하면 `migrate()`에 기본값, supabase 쪽은 `toX/fromX` 매퍼와 `schema.sql`의 `alter table … add column if not exists`까지 함께 고칩니다.
8. **HTML 구조는 모듈 페이지끼리 같게** 유지합니다 (상단 스트립, 네비, `#user-slot`, `#page-actions`, `#app`, `#toast`). 스크립트 순서는 config → (CDN) → ui → store → 페이지 JS.
9. Tabler의 `.navbar-collapse`는 `display:flex !important`라 `hidden` 속성이 안 먹습니다. `.is-hidden` 클래스를 씁니다.
10. 한글이 들어간 파일은 **UTF-8(BOM 없음)** 으로 저장합니다. PowerShell `Set-Content`는 기본 인코딩으로 한글을 깨뜨립니다.

---

## 7. 테스트 방법

브라우저로 직접 확인하는 것이 기본입니다. 개발 중에는 헤드리스 Edge로 자동 점검했습니다.

- 로컬 확인: 저장소 폴더에서 `python -m http.server 8000` 후 http://localhost:8000/ (file:// 로 열어도 대부분 동작).
- 헤드리스 점검 방식: 페이지 HTML을 복사해 에셋 경로를 절대 경로로 바꾸고, `config.js` 앞에 localStorage 시드 스크립트를 넣은 하네스 파일을 만든 뒤 `msedge --headless=new --dump-dom --virtual-time-budget=<ms>`로 결과 DOM을 읽습니다.

헤드리스에서 겪은 함정:

- IndexedDB(사진 저장)는 가상 시간에서 멈추거나 느립니다. 사진이 필요한 테스트는 IndexedDB를 미리 채워 두세요.
- 다운로드가 시작되면 dump-dom이 멈춥니다. `HTMLAnchorElement.prototype.click`을 막아 두어야 하고, 그 때문에 `<a>` 탭은 `dispatchEvent(new MouseEvent('click', …))`로 눌러야 합니다.
- file:// 에서는 쿼리 문자열이 무시되므로 해시(`#id=…`)를 씁니다.
- 창 폭이 약 504px 밑으로 줄지 않아 모바일 캡처가 잘려 보입니다 (실제 넘침 아님).
- 프로필 폴더를 재사용하면 종료 코드 21이 납니다. 테스트마다 새 `--user-data-dir`를 주거나, 여러 페이지를 잇는 흐름만 같은 폴더를 이어 씁니다.

---

## 8. 개발하면서 배운 것

- **HWP 양식 읽기**: 한컴 COM 자동화는 보안 대화상자에서 멈췄습니다. Python `olefile` + `zlib`로 HWP 5.0 레코드(PARA_TEXT, TABLE, LIST_HEADER)와 BinData 이미지를 직접 꺼내 표 구조를 확인했습니다.
- **엑셀 회색 칸 = 미참여**: 참여과제 시트는 셀 채우기 색(테마 0, tint −0.5)으로 미참여를 표시합니다. 값이 아니라 서식을 읽어야 해서 브라우저에서는 SheetJS의 `cellStyles` 옵션을 켭니다.
- **DOCX 직접 생성**: 라이브러리 없이 `document.xml`을 문자열로 만들고 JSZip으로 묶습니다. 이미지 크기는 EMU(1cm = 360000)로 계산하며, 사진은 폭 18cm·높이 최대 24cm로 크게 넣습니다 (사용자 요청).
- **datetime-local의 min**: 분 단위가 step과 맞지 않는 min을 주면 검증이 실패합니다. 시작 min은 오늘 00:00으로 둡니다.
- **장비 예약이 안 된다는 문의**: 로직은 정상이었고, 관리자 계정이 사용자로 등록되지 않았거나 장비가 0개라 빈 목록만 있었던 것이 원인이었습니다. 빈 상태와 권한 없음은 항상 문장으로 안내합니다.
- **정적 사이트의 한계**: local 모드에서는 "모두에게 적용"이 설정 파일 기본값뿐입니다. 데이터 삭제·계정 추가도 설정의 일회성 초기화로 처리했습니다. 공용 DB로 옮기면 이런 우회가 필요 없습니다.
- **구글 캘린더 연동 검토 결과**: "캘린더에 추가" 링크와 ICS 파일은 지금도 가능, 구독형 피드와 자동 등록은 공용 DB·OAuth 설정이 먼저 필요합니다. 아직 구현하지 않았습니다.

---

## 9. 남은 일

- 공용 DB(Supabase) 전환과 실제 환경 검증. 실사용 전에 필수입니다.
- 회의록 계정번호 동기화 (보류).
- 구글 캘린더 연동 (방식 결정 필요).
- 기본 PIN 0000 변경 안내 또는 첫 로그인 시 변경 강제.
- 출석 시트 재개 여부 결정 (`archive/`).
- 장비 도입: 공용 DB 함수(`acq_*`) 실제 실행 검증, 구매 완료 시 장비 예약 목록 자동 등록 검토.
- 과제 예산: 공용 DB 전환 시 관리자 한 명이 엑셀을 올리면 모두에게 반영됨 (local 모드에서는 올린 브라우저에만 있음).
