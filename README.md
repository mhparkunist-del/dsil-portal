# DSIL Lab Portal

KAIST Device-to-System Integration Lab (DSIL) 연구실 **내부 운영 도구** 모음입니다.
공개 홈페이지 [dsil.kaist.ac.kr](https://dsil.kaist.ac.kr/) 과 같은 디자인 토큰(색상·헤더·푸터)을 쓰고,
빌드 없이 GitHub Pages 에 바로 올라가는 정적 사이트입니다.

첫 번째 도구는 **과제별 예산 저장·배정 시스템**입니다.

## 과제별 예산 관리 (`budget/`)

| 역할 | 할 수 있는 일 |
|------|----------------|
| 구성원 | 품명·수량·단가·링크·메모로 **구매 요청 제출**, 전체/내 요청의 **미처리 / 처리 / 반려** 상태 확인, 과제별 예산 잔액 열람 |
| 관리자 | 미처리 요청이 한곳에 모인 **인박스**에서 과제 선택 → **처리**(예산 자동 차감) 또는 **반려**(사유 입력), 과제 추가·수정·종료, 잘못 처리한 건 되돌리기 |

- 예산 차감은 **처리(done) 상태의 요청 합계**로만 계산합니다. 반려·미처리 건은 예산에 영향이 없습니다.
- 과제 잔액보다 큰 금액을 배정하려 하면 경고합니다. 사용률 80% 이상은 주황, 초과는 빨강으로 표시됩니다.

## 폴더 구조

```
dsil-portal/
├── index.html              # 포털 홈 (도구 목록)
├── budget/index.html       # 예산 관리 앱
├── assets/
│   ├── css/main.css        # dsil.kaist.ac.kr 디자인 토큰 + 앱 컴포넌트
│   ├── js/config.js        # 백엔드 선택, 관리자 PIN 등 설정
│   ├── js/store.js         # 데이터 계층 (local / supabase 어댑터, 같은 인터페이스)
│   ├── js/budget.js        # 예산 관리 UI
│   ├── js/nav.js           # 모바일 메뉴
│   └── img/logo/           # DSIL 로고
├── supabase/schema.sql     # 공용 DB 스키마 + 권한(RLS)
└── .nojekyll               # GitHub Pages 에서 Jekyll 빌드 생략
```

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
**같은 PC의 같은 브라우저에서만** 데이터가 보입니다. 관리자 화면은 `adminPin`(기본 `0000`)으로 전환합니다.
관리자 탭에서 JSON 내보내기/가져오기로 데이터를 옮길 수 있습니다.

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

1. 저장소 → Settings → Pages → Source: **Deploy from a branch**, Branch: `main` / `(root)`
2. 1~2분 뒤 `https://<계정>.github.io/dsil-portal/` 에서 열립니다.
3. 나중에 `DSIL-lab` 조직으로 옮기면 `portal.dsil.kaist.ac.kr` 같은 서브도메인을 CNAME 으로 붙일 수 있습니다.

## 다음 도구 후보

- 장비 예약 캘린더
- 소모품 재고·발주 시점 관리
- 예산 집행 내역 CSV 내보내기 (행정 보고용)
