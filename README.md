# DSIL Lab Portal

KAIST Device-to-System Integration Lab (DSIL) 연구실 **내부 운영 도구** 모음입니다.
빌드 없이 GitHub Pages 에 바로 올라가는 정적 사이트이며, 디자인은 오픈소스 UI 킷 **[Tabler](https://tabler.io/)** (MIT) 위에
DSIL 홈페이지의 KAIST 블루와 상단 스트립을 얹었습니다. 한글 본문은 **[Pretendard](https://github.com/orioncactus/pretendard)** (OFL) 를 씁니다.

배포 주소: **<https://mhparkunist-del.github.io/dsil-portal/>** (예산 관리: `/budget/`)

첫 번째 도구는 **과제별 예산 저장·배정 시스템**입니다.

## 과제별 예산 관리 (`budget/`)

| 탭 | 누가 | 내용 |
|----|------|------|
| 구매 요청 | 구성원 | 품명·비목·수량·단가·링크·메모로 요청 제출. 승인된 구매 심의에 연결 가능. 내 최근 요청 5건 표시 |
| 요청 조회 | 구성원 | **기간(이번 달·지난 달·최근 30/90일·올해·전체·직접 입력)**, 상태, 비목, 과제, 검색어로 조회. 월별·상태별·과제별·비목별·신청자별 묶어 보기, CSV 내려받기. 본인 미처리 요청은 수정·취소 |
| 구매 심의 | 구성원 | 구매 전에 심의를 올려 과제 예산을 **가할당** 받음. 구매 건을 여러 개로 나눠 적으면 건별로 KAIST 구매 절차 기준이 표시됨. 제출 시 **열람 PIN** 을 정하고, 이후 승인·반려 여부만 보이며 내용은 PIN 으로 열어야 함 |
| 과제 예산 | **관리자** | 과제별·비목별 예산, **실집행 / 가할당 / 잔액** 과 진행 막대. 구성원에게는 보이지 않음 |
| 관리자 | **관리자** | PIN 입력 후 진입. 미처리 구매건 인박스(과제+비목 배정 → 처리 / 반려), 구매 심의 대기(승인·반려), 심의 전체 목록(모든 정보), 과제 추가·수정·종료, **보고서 내보내기**(승인건 선택 → CSV 또는 인쇄용 보고서), **내보내기 이력** |

### 보고서 내보내기와 이력

- 관리자 탭 아래쪽 **보고서 내보내기**에서 처리일 기준 기간·과제·포함 항목(실집행 / 가할당)으로 승인건을 추리고, 체크한 항목만 내보냅니다. 교수님께 과제 할당을 보고하는 용도입니다.
- **CSV**는 Excel 에서 바로 열리고, **인쇄용 보고서**는 과제별 소계와 총계가 있는 새 창을 열어 인쇄하거나 PDF 로 저장합니다.
- 내보낼 때마다 **이력**이 남습니다: 일시, 내보낸 사람, 메모, 조건, 형식, 건수, 합계와 당시 항목 스냅샷. 이력은 지울 수 없고(공용 DB 모드에서는 update/delete 정책 없음), 스냅샷으로 같은 CSV·보고서를 다시 받을 수 있습니다.

### 예산 계산

- **실집행** = 처리(done)된 구매 요청 합계. 반려·미처리 건은 영향 없음.
- **가할당** = 승인된 구매 심의의 승인 금액 − 그 심의에 연결되어 처리된 구매 요청 합계 (0 미만이면 0).
- **잔액** = 비목 예산 − 실집행 − 가할당. 화면의 진행 막대는 진한 부분이 실집행, 옅은 부분이 가할당입니다.
- 배정·승인 시 잔액을 넘기면 경고합니다. 사용률 80% 이상은 노란색, 초과는 빨간색.

### 구매 절차 기준 (`config.js` 의 `procurementTiers`)

| 구매 건 금액 | 절차 |
|---|---|
| 500만원 이하 | 자체 검수 (중앙검수 불필요) |
| 500만원 초과 ~ 1,000만원 미만 | 중앙검수 |
| 1,000만원 이상 ~ 2,000만원 미만 | 구매팀 경유 |
| 2,000만원 이상 | 구매팀 입찰 |

구매 심의에서 구매 건마다 금액을 적으면 건별 적용 절차와 총액 기준 절차가 함께 표시됩니다.

### 관리자 PIN 과 열람 PIN

- **관리자 PIN**: 로그인과 별개로 과제 예산·관리자 탭에 들어갈 때 묻습니다. `config.js` 의 `adminPin`(기본 `0000`), `adminUnlockMinutes`(기본 10분).
  공용 DB 모드에서는 `profiles.is_admin` 인 사람만 이 탭이 보이고, 실제 권한은 DB 의 RLS 가 강제합니다.
- **열람 PIN**: 구매 심의를 올릴 때 신청자가 정하는 숫자 4~8자리. SHA-256 해시로만 저장되며, 심의 내용을 다시 열 때 필요합니다.
  공용 DB 모드에서는 `open_review()` 함수가 서버에서 해시를 비교하므로 PIN 없이는 내용을 읽을 수 없습니다. 예시 데이터의 심의 PIN 은 `1234` 입니다.

비목 기본값은 **재료비 / 연구활동비 / 장비구매비 / 기타** 이고 `assets/js/config.js` 의 `budgetCategories` 에서 바꿉니다.
(`id` 는 저장 키이므로 운영 중에는 `label` 만 수정하세요.)

## 폴더 구조

```text
dsil-portal/
├── index.html              # 포털 홈 (도구 목록)
├── budget/index.html       # 예산 관리 앱
├── assets/
│   ├── css/portal.css      # Tabler 위에 얹는 DSIL 색상·스트립 등 소량의 오버라이드
│   ├── js/config.js        # 백엔드 선택, 관리자 PIN, 비목, 구매 절차 기준 등 설정
│   ├── js/store.js         # 데이터 계층 (local / supabase 어댑터, 같은 인터페이스)
│   ├── js/budget.js        # 예산 관리 UI
│   └── img/logo/           # DSIL 로고
├── supabase/schema.sql     # 공용 DB 스키마 + 권한(RLS) + 심의 열람 함수 + 집계 뷰
└── .nojekyll               # GitHub Pages 에서 Jekyll 빌드 생략
```

외부 의존성은 CDN(jsDelivr)에서 고정 버전으로 불러옵니다: Tabler core 1.5.0, Tabler Icons 3.46.0, Pretendard 1.3.9.

## 실행

빌드 도구가 없습니다. 아래 중 하나로 열면 됩니다.

```powershell
# 1) 파일을 그냥 더블클릭 (file://)  – 로컬 모드 동작
# 2) 간단한 로컬 서버
python -m http.server 8000
# → http://localhost:8000/
```

## 데이터 저장 방식 (두 가지 모드)

`assets/js/config.js` 의 `backend` 값으로 고릅니다.

### 1. `local` (기본) – 설치 없음

브라우저 `localStorage` 에 저장됩니다. 데모·개인 확인용입니다.
**같은 PC의 같은 브라우저에서만** 데이터가 보입니다. 관리자 탭에서 JSON 내보내기/가져오기로 데이터를 옮길 수 있습니다.

### 2. `supabase` – 연구실 공용 (권장)

연구실 전원이 같은 데이터를 봅니다. 무료 티어로 충분합니다.

1. [supabase.com](https://supabase.com) 에서 프로젝트 생성
2. SQL Editor 에 `supabase/schema.sql` 전체를 붙여 넣고 실행
3. Authentication → Providers → Email 에서 magic link 활성화 확인
   (선택) Authentication → Settings 에서 가입 허용 도메인에 `kaist.ac.kr` 추가
4. Project Settings → API 의 **URL** 과 **anon public key** 를 `config.js` 에 입력하고 `backend: 'supabase'`
5. 첫 관리자 지정 (SQL Editor):

   ```sql
   update public.profiles set is_admin = true where email = 'admin@kaist.ac.kr';
   ```

로그인은 이메일 magic link 입니다. 권한은 DB의 RLS 로 강제되므로 anon key 가 공개 저장소에 있어도 괜찮습니다.

## GitHub Pages 배포

- Settings → Pages → Source: **Deploy from a branch**, Branch: `main` / `(root)` 로 설정되어 있습니다. `main` 에 push 하면 1~2분 뒤 자동 반영됩니다.
- 나중에 `DSIL-lab` 조직으로 옮기면 `portal.dsil.kaist.ac.kr` 같은 서브도메인을 CNAME 으로 붙일 수 있습니다.

## 다음 도구 후보

- 장비 예약 캘린더
- 소모품 재고·발주 시점 관리
