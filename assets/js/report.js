/* =====================================================================
   DSIL Lab Portal – 구매 보고서 (승인된 구매 요청의 정산 증빙 양식)
   흐름: 구매 요청 → 관리자 승인(과제 배정) → 구매 후 보고서 작성(영수증·거래내역·검수 사진) → 관리자 확인
   출력: 인쇄용(A4, 한글 양식과 같은 순서) · DOCX 내려받기 (한글에서 열어 hwp 로 저장 가능)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var RP = Object.assign({ inspectionThreshold: 500000, centralThreshold: 5000000, minItemPhotos: 2, maxPhotoEdge: 1400, defaultAccountManager: '', defaultInspector: '' }, CFG.report || {});
  var U = window.DSILUI;
  var esc = U.esc, won = U.won, nf = U.nf, localDate = U.localDate, fmtDate = U.fmtDate, fmtDateTime = U.fmtDateTime, $ = U.$, $all = U.$all, toast = U.toast, readForm = U.readForm;
  var dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty, dg = U.dg;
  var store = window.DSILStore.create(CFG);
  var ADMIN_KEY = 'dsil-budget-admin-unlock';
  var PAY = { woori: '우리카드', shinhan: '신한카드', naverpay: '네이버페이', invoice: '세금계산서', personal: '개인 선결제', card: '법인카드' };
  var PAY_CHOICES = ['woori', 'shinhan', 'naverpay', 'invoice', 'personal'];
  var RSTATUS = { none: { label: '보고서 미작성', cls: 'bg-yellow-lt' }, draft: { label: '작성 중', cls: 'bg-secondary-lt' }, submitted: { label: '제출됨', cls: 'bg-blue-lt' }, verified: { label: '확인 완료', cls: 'bg-green-lt' } };
  var SLOT_ORDER = ['receipt', 'transaction', 'items'];

  var state = { ready: false, error: null, session: null, id: null, print: false, request: null, project: null, form: null, photos: {}, sigs: {}, adminUnlocked: false, saving: false };

  /* ---------- id / mode ---------- */
  (function () {
    var q = {};
    [window.location.search.replace(/^\?/, ''), window.location.hash.replace(/^#/, '')].forEach(function (s) {
      s.split('&').forEach(function (kv) { if (!kv) return; var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); });
    });
    state.id = q.id || null; state.print = q.print === '1' || q.print === 'true';
  })();

  /* ---------- helpers ---------- */
  function readUnlock() { try { var t = Number(sessionStorage.getItem(ADMIN_KEY) || 0); var mins = Number(CFG.adminUnlockMinutes) > 0 ? Number(CFG.adminUnlockMinutes) : 10; return t > 0 && (Date.now() - t) < mins * 60000; } catch (e) { return false; } }
  function setUnlock(on) { try { if (on) sessionStorage.setItem(ADMIN_KEY, String(Date.now())); else sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ } state.adminUnlocked = on; }
  function isAdminEligible() { return !!(state.session && state.session.isAdmin); }
  function isAdminActive() { return isAdminEligible() && state.adminUnlocked; }
  function isOwner() { return !!(state.session && state.request && state.request.requesterId === state.session.user.id); }
  function canEdit() { var st = reportStatus(); return (isOwner() || isAdminActive()) && st !== 'verified'; }
  function reportStatus() { return state.request && state.request.report ? (state.request.report.status || 'draft') : 'none'; }
  function today() { return localDate(new Date().toISOString()); }
  function tierOf(amount) { var a = Number(amount) || 0; return a > RP.centralThreshold ? 'central' : (a > RP.inspectionThreshold ? 'self' : 'none'); }

  function defaultForm() {
    var r = state.request, p = state.project || {};
    var meta = r.meta || {};
    return {
      status: 'draft', item: r.item.replace(/^회의비 · /, ''), amount: r.amount, payment: PAY[meta.payment] ? meta.payment : 'woori',
      accountManager: p.accountManager || RP.defaultAccountManager || '', cardUser: '', endUser: r.requesterName || '',
      inspector: RP.defaultInspector || '', arrivedAt: today(), inspectedAt: today(), naverMatch: false, note: '',
      photos: { receipt: [], transaction: [], items: [] }
    };
  }

  function requirements(form) {
    var pay = form.payment, tier = tierOf(form.amount);
    var slots = [
      { key: 'receipt', min: 1,
        label: pay === 'invoice' ? '전자세금계산서 사본' : (pay === 'naverpay' ? '카드 영수증 (네이버파이낸셜 발행)' : '카드 영수증'),
        hint: pay === 'invoice' ? '공급자·공급받는자·합계가 보이게 전체 캡처' : (pay === 'naverpay' ? '네이버페이 결제 상세의 카드 영수증 보기 화면 전체 캡처. 영수증 하단에 주문 캡처를 이어 붙입니다.' : '승인번호·결제일시·합계가 보이게 캡처') },
      { key: 'transaction', min: 1,
        label: pay === 'invoice' ? '거래명세서 · 이체확인증' : (pay === 'naverpay' ? '네이버 주문 상세 캡처 (배송비 포함 결제금액)' : '카드 거래내역 캡처'),
        hint: pay === 'invoice' ? '입금 내역이 보이는 이체확인증 또는 거래명세서' : (pay === 'naverpay' ? '주문완료·주문상품 화면. 결제금액(배송비 포함)이 영수증 합계와 같아야 합니다.' : '카드사 앱·홈페이지의 해당 거래 한 줄이 보이게') },
      { key: 'items', min: tier === 'none' ? 0 : RP.minItemPhotos, optional: tier === 'none',
        label: '물품 사진 (자체 검수)',
        hint: tier === 'none' ? won(RP.inspectionThreshold) + ' 이하라 검수 사진이 필요 없습니다.' : '1페이지에 1장씩 들어갑니다. 박스 전체, 라벨(모델명·시리얼), 설치·사용 상태를 각각 찍어 주세요.' }
    ];
    var notes = [];
    if (tier === 'none') notes.push({ cls: 'info', text: won(RP.inspectionThreshold) + ' 이하: 검수 없이 영수증과 거래내역만 첨부합니다.' });
    if (tier === 'self') notes.push({ cls: 'warning', text: won(RP.inspectionThreshold) + ' 초과 ' + won(RP.centralThreshold) + ' 이하: 자체 검수 대상입니다. 물품 사진 ' + RP.minItemPhotos + '장 이상을 첨부하고, 검수일자는 물품이 도착한 날로 적습니다. 도착 당일 서류를 작성하고 그날을 검수일자로 하는 것이 원칙입니다.' });
    if (tier === 'central') notes.push({ cls: 'danger', text: won(RP.centralThreshold) + ' 초과: 중앙검수 대상입니다. 물품 사진과 함께 검수자(' + (RP.defaultInspector || '담당자') + ')와 검수 일정을 잡고 검수 확인을 받으세요. 검수일자는 실제 검수한 날짜입니다.' });
    if (pay === 'naverpay') notes.push({ cls: 'warning', text: '네이버페이: 네이버 주문 상세의 결제금액(배송비 포함)과 카드 영수증 합계가 정확히 같아야 합니다. 영수증 하단에 주문 캡처를 같이 첨부하세요. 금액이 다르면 배송비 영수증을 따로 첨부합니다.' });
    if (pay === 'invoice') notes.push({ cls: 'info', text: '세금계산서: 전자세금계산서 사본과 거래명세서(또는 이체확인증)를 첨부합니다. 합계는 세금계산서 합계와 같게 적습니다.' });
    notes.push({ cls: 'secondary', text: '카드실사용자(결제자)와 실구매자(물품사용자)는 참여연구원이어야 하며 서로 같아도 됩니다. 실구매자는 실제로 물품을 쓰는 사람을 적습니다 (검수자 요청).' });
    notes.push({ cls: 'secondary', text: '계정은 과제명 앞부분(약칭)과 과제번호로 표시됩니다. 금액은 영수증 합계와 같게 적습니다.' });
    return { tier: tier, slots: slots, notes: notes };
  }

  function photoCount(form, key) { return (form.photos && form.photos[key] ? form.photos[key] : []).length; }

  function validate(form) {
    var req = requirements(form);
    var missing = [];
    if (!String(form.item || '').trim()) missing.push('구매내역');
    if (!(Number(form.amount) > 0)) missing.push('금액');
    if (!String(form.cardUser || '').trim()) missing.push('카드실사용자');
    if (!String(form.endUser || '').trim()) missing.push('실구매자(물품사용자)');
    if (!form.inspectedAt) missing.push('검수일자');
    if (!String(form.inspector || '').trim()) missing.push('검수자');
    req.slots.forEach(function (s) { if (photoCount(form, s.key) < s.min) missing.push(s.label + ' ' + s.min + '장 이상'); });
    if (form.payment === 'naverpay' && !form.naverMatch) missing.push('네이버 주문 금액과 영수증 합계 일치 확인');
    return missing;
  }

  /* ---------- data ---------- */
  function loadPhotos(form) {
    var keys = [];
    SLOT_ORDER.forEach(function (k) { (form.photos[k] || []).forEach(function (key) { if (!state.photos[key]) keys.push(key); }); });
    return Promise.all(keys.map(function (key) { return store.loadPhoto(key).then(function (v) { state.photos[key] = v; }).catch(function () { state.photos[key] = null; }); }));
  }
  function loadSignatures(form) {
    var names = [form.cardUser, form.endUser].filter(Boolean);
    return Promise.all(names.map(function (n) {
      if (state.sigs[n] !== undefined) return Promise.resolve();
      return store.signatureByName(n).then(function (key) { return key ? store.loadPhoto(key) : null; }).then(function (v) { state.sigs[n] = v || null; }).catch(function () { state.sigs[n] = null; });
    }));
  }

  function reload() {
    state.session = store.getSession();
    state.adminUnlocked = readUnlock();
    return Promise.all([store.listRequests(), store.listProjects()]).then(function (res) {
      state.request = res[0].filter(function (r) { return r.id === state.id; })[0] || null;
      state.project = state.request && state.request.projectId ? (res[1].filter(function (p) { return p.id === state.request.projectId; })[0] || null) : null;
      if (state.request) {
        var saved = state.request.report;
        if (!state.form || saved) state.form = Object.assign(defaultForm(), saved || {}, state.form && !saved ? state.form : {});
        if (!state.form.photos) state.form.photos = { receipt: [], transaction: [], items: [] };
        SLOT_ORDER.forEach(function (k) { if (!Array.isArray(state.form.photos[k])) state.form.photos[k] = []; });
        return loadPhotos(state.form).then(function () { return loadSignatures(state.form); });
      }
    });
  }

  /* ---------- render ---------- */
  function render() {
    state.adminUnlocked = readUnlock();
    renderChrome();
    var app = $('#app');
    if (!app) return;
    if (state.error) { app.innerHTML = '<div class="alert alert-danger"><h4 class="alert-title">오류</h4><div class="text-secondary">' + esc(state.error) + '</div></div>'; return; }
    if (!state.ready) { app.innerHTML = '<div class="text-secondary text-center py-5">불러오는 중…</div>'; return; }
    if (!state.request) { app.innerHTML = '<div class="card"><div class="card-body">' + empty('file-off', '구매 요청을 찾을 수 없습니다', '구매 요청 페이지의 요청 조회에서 보고서 버튼으로 들어오세요.') + '<div class="text-center"><a href="../budget/index.html#query" class="btn">구매 요청으로</a></div></div></div>'; return; }
    if (state.print) { renderPrint(app); return; }
    if (state.request.status !== 'done') {
      app.innerHTML = '<div class="card"><div class="card-body">' + empty('hourglass', '아직 승인되지 않은 요청입니다', '관리자가 과제를 배정(승인)하면 보고서를 작성할 수 있습니다. 현재 상태: ' + ({ pending: '미처리', rejected: '반려' }[state.request.status] || state.request.status)) + '</div></div>';
      return;
    }
    renderEditor(app);
  }

  function renderChrome() {
    var slot = $('#user-slot');
    if (slot) {
      if (!state.session) slot.innerHTML = '';
      else slot.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="avatar avatar-sm bg-blue-lt">' + esc((state.session.user.name || '?').trim().charAt(0)) + '</span><div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(state.session.user.name) + '</div><div class="small text-secondary mt-1">' + (isAdminActive() ? '관리자 · 열림' : (isAdminEligible() ? '관리자 · 잠김' : '구성원')) + '</div></div></div>';
    }
    var pa = $('#page-actions');
    if (pa) {
      var st = reportStatus(); var S = RSTATUS[st] || RSTATUS.none;
      pa.innerHTML = state.request ? '<div class="d-flex align-items-center gap-2 flex-wrap"><span class="badge ' + S.cls + '">' + S.label + '</span>'
        + (state.request.report ? '<button type="button" class="btn btn-sm" data-action="print"><i class="ti ti-printer me-1"></i>인쇄용 보고서</button><button type="button" class="btn btn-sm" data-action="docx"><i class="ti ti-file-type-docx me-1"></i>DOCX</button>' : '')
        + (state.session ? '<label class="btn btn-sm btn-ghost-secondary mb-0" title="표의 이름 아래에 들어갈 내 서명 이미지 (흰 배경 또는 투명 PNG)"><i class="ti ti-signature me-1"></i>내 서명<input type="file" accept="image/*" hidden data-action="add-signature"></label>' : '')
        + (isAdminEligible() && !isAdminActive() ? '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="unlock-admin"><i class="ti ti-lock me-1"></i>관리자</button>' : '') + '</div>' : '';
    }
    document.body.classList.toggle('print-mode', state.print);
  }

  function opt(list, selected) { return list.map(function (v) { return '<option value="' + esc(v) + '"' + (v === selected ? ' selected' : '') + '>' + esc(v) + '</option>'; }).join(''); }
  function personSelect(name, value, cardUsers) {
    var custom = value && cardUsers.indexOf(value) < 0;
    return '<div class="input-group"><select class="form-select" name="' + name + '_sel" data-role="person-select">' + '<option value=""' + (!value ? ' selected' : '') + '>선택…</option>' + opt(cardUsers, custom ? '' : value) + '<option value="__custom"' + (custom ? ' selected' : '') + '>직접 입력</option></select>'
      + '<input type="text" class="form-control' + (custom ? '' : ' d-none') + '" name="' + name + '" value="' + esc(custom ? value : '') + '" placeholder="이름"></div>';
  }

  function renderEditor(app) {
    var r = state.request, p = state.project, f = state.form;
    var req = requirements(f);
    var editable = canEdit();
    var cardUsers = (p && Array.isArray(p.cardUsers) ? p.cardUsers : []).filter(Boolean);
    var st = reportStatus();
    var html = '';

    html += '<div class="row row-cards mb-3"><div class="col-lg-8"><div class="card"><div class="card-body">'
      + '<div class="d-flex justify-content-between align-items-start gap-2 flex-wrap"><div><div class="subheader">승인된 구매 요청</div><h3 class="mb-1">' + (r.kind === 'meeting' ? '<span class="badge bg-green-lt me-1">회의비</span>' : '') + esc(r.item) + '</h3>'
      + '<div class="text-secondary small">' + esc(r.requesterName) + ' · 요청 ' + fmtDate(r.createdAt) + ' · 승인 ' + fmtDate(r.processedAt) + (r.processedBy ? ' (' + esc(r.processedBy) + ')' : '') + '</div></div>'
      + '<div class="text-end"><div class="h2 mb-0 tnum">' + won(r.amount) + '</div><div class="small text-secondary">승인 금액</div></div></div>'
      + '<div class="datagrid mt-3">' + dg('계정 (과제)', p ? esc(p.name) + '<div class="small text-secondary">' + esc(p.code || '') + '</div>' : '<span class="text-danger">과제 정보 없음</span>')
      + dg('계정책임자', esc((p && p.accountManager) || RP.defaultAccountManager || '-')) + dg('카드 실사용자 목록', cardUsers.length ? esc(cardUsers.join(', ')) : '<span class="text-secondary">과제에 등록된 목록 없음 · 직접 입력</span>')
      + dg('비목', esc((CFG.budgetCategories || []).filter(function (c) { return c.id === r.category; }).map(function (c) { return c.label; })[0] || r.category)) + '</div>'
      + '</div></div></div>'
      + '<div class="col-lg-4"><div class="card h-100"><div class="card-body"><div class="subheader">필요한 첨부</div>'
      + req.slots.map(function (s) { var n = photoCount(f, s.key); var ok = n >= s.min; return '<div class="d-flex justify-content-between align-items-center py-1 border-bottom"><span>' + esc(s.label) + (s.optional ? ' <span class="text-secondary small">(선택)</span>' : '') + '</span><span class="badge ' + (s.min === 0 ? 'bg-secondary-lt' : (ok ? 'bg-green-lt' : 'bg-yellow-lt')) + '">' + n + (s.min ? ' / ' + s.min : '') + '장</span></div>'; }).join('')
      + '<div class="mt-2 small">' + (req.tier === 'none' ? '<span class="badge bg-green-lt">검수 불필요</span>' : (req.tier === 'self' ? '<span class="badge bg-yellow-lt">자체 검수</span>' : '<span class="badge bg-red-lt">중앙검수</span>')) + ' <span class="text-secondary">' + won(f.amount) + ' 기준</span></div>'
      + '</div></div></div></div>';

    html += req.notes.map(function (n) { return '<div class="alert alert-' + n.cls + ' py-2 mb-2"><i class="ti ti-info-circle me-1"></i>' + esc(n.text) + '</div>'; }).join('');
    if (r.report && r.report.adminNote && st !== 'verified') html += '<div class="alert alert-danger py-2 mb-2"><i class="ti ti-message-report me-1"></i>관리자 메모: ' + esc(r.report.adminNote) + '</div>';
    if (st === 'verified') html += '<div class="alert alert-success py-2 mb-2"><i class="ti ti-check me-1"></i>' + esc(r.report.verifiedBy || '관리자') + ' 확인 완료 · ' + fmtDateTime(r.report.verifiedAt) + (r.report.adminNote ? ' · ' + esc(r.report.adminNote) : '') + '</div>';

    html += '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-forms me-1 text-primary"></i>기타 정보</h3><div class="card-actions small text-secondary">양식의 표에 들어가는 항목</div></div><div class="card-body">'
      + '<form id="report-form"><fieldset' + (editable ? '' : ' disabled') + '><div class="row g-3">'
      + '<div class="col-md-6"><label class="form-label required">구매내역</label><input type="text" class="form-control" name="item" required value="' + esc(f.item) + '"></div>'
      + '<div class="col-md-3"><label class="form-label required">금액 (원) <span class="form-label-description">영수증 합계</span></label><input type="number" class="form-control tnum" name="amount" min="0" step="1" required value="' + esc(f.amount) + '"></div>'
      + '<div class="col-md-3"><label class="form-label required">결제 방법</label><select class="form-select" name="payment">' + PAY_CHOICES.map(function (k) { return '<option value="' + k + '"' + (f.payment === k ? ' selected' : '') + '>' + PAY[k] + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-md-4"><label class="form-label required">계정책임자</label><input type="text" class="form-control" name="accountManager" required value="' + esc(f.accountManager) + '"></div>'
      + '<div class="col-md-4"><label class="form-label required">카드실사용자 (결제자)</label>' + personSelect('cardUser', f.cardUser, cardUsers) + '</div>'
      + '<div class="col-md-4"><label class="form-label required">실구매자 (물품사용자) <span class="form-label-description">실제 사용자</span></label>' + personSelect('endUser', f.endUser, cardUsers) + '</div>'
      + '<div class="col-md-3"><label class="form-label">물품 도착일</label><input type="date" class="form-control" name="arrivedAt" value="' + esc(f.arrivedAt || '') + '" data-role="arrived"></div>'
      + '<div class="col-md-3"><label class="form-label required">검수일자 <span class="form-label-description">도착일 = 작성일 원칙</span></label><input type="date" class="form-control" name="inspectedAt" required value="' + esc(f.inspectedAt || '') + '"></div>'
      + '<div class="col-md-3"><label class="form-label required">검수자</label><input type="text" class="form-control" name="inspector" required value="' + esc(f.inspector) + '"></div>'
      + '<div class="col-md-3"><label class="form-label">비고</label><input type="text" class="form-control" name="note" value="' + esc(f.note || '') + '"></div>'
      + (f.payment === 'naverpay' ? '<div class="col-12"><label class="form-check"><input class="form-check-input" type="checkbox" name="naverMatch"' + (f.naverMatch ? ' checked' : '') + '><span class="form-check-label">네이버 주문 상세의 결제금액(배송비 포함)과 카드 영수증 합계가 일치함을 확인했습니다.</span></label></div>' : '')
      + '</div></fieldset></form></div></div>';

    html += '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-photo me-1 text-primary"></i>첨부 사진</h3><div class="card-actions small text-secondary">사진은 브라우저에서 ' + RP.maxPhotoEdge + 'px 로 줄여 저장됩니다</div></div><div class="card-body">'
      + req.slots.map(function (s) {
        var keys = f.photos[s.key] || [];
        return '<div class="mb-4"><div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-1"><div><strong>' + esc(s.label) + '</strong>' + (s.min ? ' <span class="badge bg-yellow-lt">필수 ' + s.min + '장</span>' : ' <span class="badge bg-secondary-lt">선택</span>') + '<div class="small text-secondary">' + esc(s.hint) + '</div></div>'
          + (editable ? '<label class="btn btn-sm mb-0"><i class="ti ti-upload me-1"></i>사진 추가<input type="file" accept="image/*" multiple hidden data-action="add-photo" data-slot="' + s.key + '"></label>' : '') + '</div>'
          + '<div class="d-flex flex-wrap gap-2">' + keys.map(function (k) { var src = state.photos[k]; return '<div class="position-relative border rounded p-1" style="width:240px"><img src="' + (src ? esc(src) : '') + '" alt="" style="width:100%;height:200px;object-fit:contain;border-radius:4px;background:#f3f5f8">' + (editable ? '<button type="button" class="btn btn-sm btn-icon btn-danger position-absolute top-0 end-0 m-1" data-action="remove-photo" data-slot="' + s.key + '" data-key="' + esc(k) + '" title="삭제"><i class="ti ti-x"></i></button>' : '') + '</div>'; }).join('')
          + (!keys.length ? '<div class="text-secondary small">아직 없음</div>' : '') + '</div></div>';
      }).join('')
      + '</div></div>';

    var missing = validate(f);
    html += '<div class="card"><div class="card-body d-flex flex-wrap align-items-center gap-2">'
      + '<div class="me-auto small">' + (missing.length ? '<span class="text-yellow"><i class="ti ti-alert-triangle me-1"></i>제출 전 확인: ' + esc(missing.join(', ')) + '</span>' : '<span class="text-green"><i class="ti ti-check me-1"></i>필수 항목이 모두 채워졌습니다</span>') + (r.report && r.report.updatedAt ? '<div class="text-secondary">마지막 저장 ' + fmtDateTime(r.report.updatedAt) + (r.report.updatedBy ? ' · ' + esc(r.report.updatedBy) : '') + '</div>' : '') + '</div>'
      + (editable ? '<button type="button" class="btn" data-action="save-draft"><i class="ti ti-device-floppy me-1"></i>임시 저장</button><button type="button" class="btn btn-primary" data-action="submit"' + (missing.length ? ' disabled' : '') + '><i class="ti ti-send me-1"></i>' + (st === 'submitted' ? '다시 제출' : '제출') + '</button>' : '')
      + (isAdminActive() && st === 'submitted' ? '<button type="button" class="btn btn-outline-danger" data-action="return"><i class="ti ti-arrow-back-up me-1"></i>보완 요청</button><button type="button" class="btn btn-success" data-action="verify"><i class="ti ti-check me-1"></i>확인 완료</button>' : '')
      + (isAdminActive() && st === 'verified' ? '<button type="button" class="btn btn-outline-secondary" data-action="return"><i class="ti ti-arrow-back-up me-1"></i>확인 취소</button>' : '')
      + '</div></div>';
    app.innerHTML = html;
  }

  /* ---------- 인쇄용 (한글 양식과 같은 순서) ---------- */
  function sigImg(name) { var v = state.sigs[name]; return v ? '<img src="' + esc(v) + '" alt="" class="sig">' : ''; }
  function renderPrint(app) {
    var r = state.request, p = state.project || {}, f = state.form;
    var req = requirements(f);
    var imgs = function (key) { return (f.photos[key] || []).map(function (k) { return state.photos[k] ? '<img src="' + esc(state.photos[k]) + '" alt="">' : ''; }).join(''); };
    var receiptLabel = req.slots[0].label, txLabel = req.slots[1].label;
    var html = '<div class="rp-toolbar d-print-none"><button type="button" class="btn btn-primary" onclick="window.print()"><i class="ti ti-printer me-1"></i>인쇄 / PDF 저장</button> <button type="button" class="btn" data-action="docx"><i class="ti ti-file-type-docx me-1"></i>DOCX</button> <a class="btn" href="' + esc(window.location.pathname) + '#id=' + esc(r.id) + '">편집으로</a></div>'
      + '<section class="rp-page">'
      + '<h3>▶ 영수증</h3><div class="rp-imgs">' + imgs('receipt') + '</div>'
      + '<h3>▶ 거래내역</h3><div class="rp-imgs">' + imgs('transaction') + '</div>'
      + '<h3>▶ 기타 정보</h3>'
      + '<table class="rp-table"><tr><th>구매내역</th><td>' + esc(f.item) + '</td><th>계정책임자</th><td>' + esc(f.accountManager) + '</td><th>계정</th><td>' + esc(p.name || '') + (p.code ? '<br>' + esc(p.code) : '') + '</td></tr>'
      + '<tr><th>금 액</th><td class="tnum">￦' + nf.format(Number(f.amount) || 0) + '원</td><th>카드실사용자<br>(결제자)</th><td>' + esc(f.cardUser) + sigImg(f.cardUser) + '</td><th>실구매자<br>(물품사용자)</th><td>' + esc(f.endUser) + sigImg(f.endUser) + '</td></tr>'
      + '<tr><th>검수일자</th><td>' + esc((f.inspectedAt || '').replace(/-/g, '.')) + '</td><th>검수자</th><td>' + esc(f.inspector) + '</td><td colspan="2" class="rp-muted">' + esc(PAY[f.payment] || '') + (f.note ? ' · ' + esc(f.note) : '') + '</td></tr></table>'
      + '<div class="rp-foot">' + esc(receiptLabel) + ' · ' + esc(txLabel) + (req.tier !== 'none' ? ' · 물품 사진 ' + photoCount(f, 'items') + '장' : '') + '</div>'
      + '</section>'
      + (f.photos.items || []).map(function (k) { return state.photos[k] ? '<section class="rp-page rp-photo"><h3>▶ 사진</h3><div class="rp-photo-wrap"><img src="' + esc(state.photos[k]) + '" alt=""></div></section>' : ''; }).join('');
    app.innerHTML = html;
  }

  /* ---------- DOCX ---------- */
  function xmlEsc(s) { return String(s === null || s === undefined ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function imgSize(dataUrl) {
    return new Promise(function (resolve) { var im = new Image(); im.onload = function () { resolve({ w: im.naturalWidth || 1, h: im.naturalHeight || 1 }); }; im.onerror = function () { resolve({ w: 4, h: 3 }); }; im.src = dataUrl; });
  }
  function dataUrlToBytes(dataUrl) {
    var m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(dataUrl || ''); if (!m) return null;
    return { type: m[1] === 'image/png' ? 'png' : 'jpeg', base64: m[2] };
  }
  function docxParagraph(text, opts) {
    opts = opts || {};
    return '<w:p>' + (opts.pageBreak ? '<w:r><w:br w:type="page"/></w:r>' : '') + '<w:pPr>' + (opts.bold ? '<w:keepNext/>' : '') + (opts.spacing !== false ? '<w:spacing w:before="120" w:after="120"/>' : '') + '</w:pPr>'
      + (text !== undefined ? '<w:r><w:rPr>' + (opts.bold ? '<w:b/>' : '') + '<w:sz w:val="' + (opts.size || 22) + '"/></w:rPr><w:t xml:space="preserve">' + xmlEsc(text) + '</w:t></w:r>' : '') + '</w:p>';
  }
  function docxImage(rid, cx, cy, n) {
    return '<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="60" w:after="60"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + n + '" name="Picture ' + n + '"/>'
      + '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">'
      + '<pic:nvPicPr><pic:cNvPr id="' + n + '" name="image' + n + '"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + rid + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
      + '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>';
  }
  function docxCell(text, opts) {
    opts = opts || {};
    var lines = String(text || '').split('\n');
    return '<w:tc><w:tcPr><w:tcW w:w="' + (opts.w || 1500) + '" w:type="dxa"/>' + (opts.span ? '<w:gridSpan w:val="' + opts.span + '"/>' : '') + (opts.shade ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : '') + '<w:vAlign w:val="center"/></w:tcPr>'
      + lines.map(function (ln) { return '<w:p><w:pPr><w:spacing w:before="40" w:after="40"/>' + (opts.center ? '<w:jc w:val="center"/>' : '') + '</w:pPr><w:r><w:rPr>' + (opts.bold ? '<w:b/>' : '') + '<w:sz w:val="20"/></w:rPr><w:t xml:space="preserve">' + xmlEsc(ln) + '</w:t></w:r></w:p>'; }).join('') + (opts.extra || '') + '</w:tc>';
  }

  function buildDocx() {
    if (!window.JSZip) return Promise.reject(new Error('DOCX 라이브러리를 불러오지 못했습니다. 네트워크를 확인하세요.'));
    var r = state.request, p = state.project || {}, f = state.form;
    var req = requirements(f);
    var zip = new JSZip();
    var media = [], rels = [], body = [];
    var n = 0;
    /* EMU (1cm = 360000). 여백 1.5cm 기준 본문 폭 18cm; 사진은 폭에 꽉 채우고 높이는 한 페이지(약 25cm)까지 */
    var MAXW = 6480000, MAXH = 9000000, BIG = 8640000;
    function addImage(dataUrl, maxW, maxH) {
      var b = dataUrlToBytes(dataUrl); if (!b) return Promise.resolve('');
      return imgSize(dataUrl).then(function (sz) {
        n++; var name = 'image' + n + '.' + (b.type === 'png' ? 'png' : 'jpg'); var rid = 'rIdImg' + n;
        zip.file('word/media/' + name, b.base64, { base64: true });
        media.push(name); rels.push('<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/' + name + '"/>');
        var scale = Math.min(maxW / sz.w, maxH / sz.h); var cx = Math.round(sz.w * scale), cy = Math.round(sz.h * scale);
        return docxImage(rid, cx, cy, n);
      });
    }
    function addSlot(title, key, maxH) {
      body.push(docxParagraph(title, { bold: true, size: 26 }));
      var keys = f.photos[key] || [];
      return keys.reduce(function (pr, k) { return pr.then(function () { var v = state.photos[k]; return v ? addImage(v, MAXW, maxH).then(function (x) { body.push(x); }) : null; }); }, Promise.resolve());
    }
    return addSlot('▶ 영수증', 'receipt', BIG).then(function () { return addSlot('▶ 거래내역', 'transaction', BIG); }).then(function () {
      body.push(docxParagraph('▶ 기타 정보', { bold: true, size: 26 }));
      var sigCell = function (name) { var v = state.sigs[name]; return v ? addImage(v, 900000, 360000) : Promise.resolve(''); };
      return Promise.all([sigCell(f.cardUser), sigCell(f.endUser)]).then(function (sigs) {
        var W = [1300, 2000, 1400, 1500, 1400, 2800];
        var border = '<w:tblBorders><w:top w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:left w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:bottom w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:right w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideH w:val="single" w:sz="6" w:space="0" w:color="000000"/><w:insideV w:val="single" w:sz="6" w:space="0" w:color="000000"/></w:tblBorders>';
        body.push('<w:tbl><w:tblPr><w:tblW w:w="' + W.reduce(function (a, b) { return a + b; }, 0) + '" w:type="dxa"/>' + border + '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>' + W.map(function (w) { return '<w:gridCol w:w="' + w + '"/>'; }).join('') + '</w:tblGrid>'
          + '<w:tr>' + docxCell('구매내역', { w: W[0], bold: true, shade: true, center: true }) + docxCell(f.item, { w: W[1] }) + docxCell('계정책임자', { w: W[2], bold: true, shade: true, center: true }) + docxCell(f.accountManager, { w: W[3], center: true }) + docxCell('계정', { w: W[4], bold: true, shade: true, center: true }) + docxCell((p.name || '') + (p.code ? '\n' + p.code : ''), { w: W[5] }) + '</w:tr>'
          + '<w:tr>' + docxCell('금 액', { w: W[0], bold: true, shade: true, center: true }) + docxCell('￦' + nf.format(Number(f.amount) || 0) + '원', { w: W[1] }) + docxCell('카드실사용자\n(결제자)', { w: W[2], bold: true, shade: true, center: true }) + docxCell(f.cardUser, { w: W[3], center: true, extra: sigs[0] }) + docxCell('실구매자\n(물품사용자)', { w: W[4], bold: true, shade: true, center: true }) + docxCell(f.endUser, { w: W[5], center: true, extra: sigs[1] }) + '</w:tr>'
          + '<w:tr>' + docxCell('검수일자', { w: W[0], bold: true, shade: true, center: true }) + docxCell((f.inspectedAt || '').replace(/-/g, '.'), { w: W[1] }) + docxCell('검수자', { w: W[2], bold: true, shade: true, center: true }) + docxCell(f.inspector, { w: W[3], center: true }) + docxCell((PAY[f.payment] || '') + (f.note ? ' · ' + f.note : ''), { w: W[4] + W[5], span: 2 }) + '</w:tr>'
          + '</w:tbl>');
        body.push(docxParagraph(''));
        var items = f.photos.items || [];
        return items.reduce(function (pr, k) {
          return pr.then(function () { var v = state.photos[k]; if (!v) return; body.push(docxParagraph('▶ 사진', { bold: true, size: 26, pageBreak: true })); return addImage(v, MAXW, MAXH).then(function (x) { body.push(x); }); });
        }, Promise.resolve());
      });
    }).then(function () {
      var doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>'
        + body.join('') + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="850" w:right="850" w:bottom="850" w:left="850" w:header="500" w:footer="500" w:gutter="0"/></w:sectPr></w:body></w:document>';
      zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
      zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
      zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels.join('') + '</Relationships>');
      zip.file('word/document.xml', doc);
      return zip;
    });
  }
  function downloadDocx() {
    return buildDocx().then(function (zip) { return zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }); }).then(function (blob) {
      var f = state.form; var name = (f.inspectedAt || today()).replace(/-/g, '').slice(2) + '_' + String(f.item || '구매').replace(/[\\/:*?"<>|]/g, '').slice(0, 20) + '_' + nf.format(Number(f.amount) || 0) + '원.docx';
      var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 800);
      window.__lastDocxBlob = blob;
      toast('DOCX 를 내려받았습니다. 한글에서 열어 hwp 로 저장할 수 있습니다.');
    });
  }

  /* ---------- 사진 처리 ---------- */
  function fileToResizedDataUrl(file, maxEdge, png) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        var im = new Image();
        im.onload = function () {
          var max = maxEdge || RP.maxPhotoEdge, w = im.naturalWidth, h = im.naturalHeight, s = Math.min(1, max / Math.max(w, h));
          var c = document.createElement('canvas'); c.width = Math.round(w * s); c.height = Math.round(h * s);
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          resolve(png ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.82));
        };
        im.onerror = function () { reject(new Error('이미지를 읽을 수 없습니다: ' + file.name)); };
        im.src = reader.result;
      };
      reader.onerror = function () { reject(new Error('파일을 읽을 수 없습니다.')); };
      reader.readAsDataURL(file);
    });
  }

  function collectForm() {
    var form = $('#report-form'); if (!form) return state.form;
    var v = readForm(form);
    var f = state.form;
    f.item = v.item; f.amount = Math.max(0, Math.round(Number(v.amount) || 0)); f.payment = v.payment; f.accountManager = v.accountManager;
    f.cardUser = v.cardUser_sel === '__custom' ? v.cardUser : (v.cardUser_sel || '');
    f.endUser = v.endUser_sel === '__custom' ? v.endUser : (v.endUser_sel || '');
    f.arrivedAt = v.arrivedAt; f.inspectedAt = v.inspectedAt; f.inspector = v.inspector; f.note = v.note; f.naverMatch = !!v.naverMatch;
    return f;
  }

  function persist(status) {
    var f = collectForm();
    var payload = Object.assign({}, f, { status: status });
    return store.saveReport(state.id, payload).then(function () { return reload(); }).then(render);
  }

  /* ---------- actions ---------- */
  function handleError(err) { console.error(err); toast(err && err.message ? err.message : String(err), true); }
  function refresh() { return reload().then(render).catch(handleError); }
  function enterAdmin() {
    if (!isAdminEligible()) return;
    if (readUnlock()) { setUnlock(true); render(); return; }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요.', input: 'password', placeholder: 'PIN', okLabel: '열기' }).then(function (pin) {
      if (pin === null) return;
      return store.verifyAdminPin(pin).then(function (ok) { if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; } setUnlock(true); render(); });
    }).catch(handleError);
  }

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.getAttribute('data-action') === 'add-photo') {
      var slot = el.getAttribute('data-slot'); var files = Array.prototype.slice.call(el.files || []);
      if (!files.length) return;
      collectForm();
      toast('사진 ' + files.length + '장을 저장하는 중…');
      files.reduce(function (pr, file) {
        return pr.then(function () { return fileToResizedDataUrl(file).then(function (d) { return store.savePhoto(d).then(function (key) { state.photos[key] = d; state.form.photos[slot].push(key); }); }); });
      }, Promise.resolve()).then(function () { return store.saveReport(state.id, Object.assign({}, state.form, { status: reportStatus() === 'submitted' ? 'submitted' : 'draft' })); }).then(function () { toast('사진을 첨부했습니다.'); return refresh(); }).catch(handleError);
      return;
    }
    if (el.getAttribute('data-action') === 'add-signature') {
      var sf = el.files && el.files[0]; if (!sf) return;
      fileToResizedDataUrl(sf, 600, true).then(function (d) { return store.savePhoto(d).then(function (key) { return store.setMySignature(key).then(function () { state.sigs[state.session.user.name] = d; }); }); })
        .then(function () { toast('서명을 등록했습니다. 표의 이름 아래에 들어갑니다.'); render(); }).catch(handleError);
      return;
    }
    if (el.getAttribute('data-role') === 'person-select') {
      var input = el.parentElement.querySelector('input[type="text"]');
      if (input) { input.classList.toggle('d-none', el.value !== '__custom'); if (el.value === '__custom') input.focus(); }
      collectForm(); loadSignatures(state.form);
      return;
    }
    if (el.name === 'payment' || el.name === 'amount') { collectForm(); render(); return; }
    if (el.getAttribute('data-role') === 'arrived') { var f = el.closest('form'); if (f && f.inspectedAt && (!f.inspectedAt.value || f.inspectedAt.value < el.value)) f.inspectedAt.value = el.value; }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    switch (action) {
      case 'unlock-admin': enterAdmin(); break;
      case 'save-draft': persist(reportStatus() === 'submitted' ? 'submitted' : 'draft').then(function () { toast('임시 저장했습니다.'); }).catch(handleError); break;
      case 'submit': {
        var missing = validate(collectForm());
        if (missing.length) { toast('부족한 항목: ' + missing.join(', '), true); return; }
        persist('submitted').then(function () { toast('보고서를 제출했습니다. 관리자 확인 후 상태가 바뀝니다.'); }).catch(handleError);
        break;
      }
      case 'verify':
        confirmDlg({ title: '보고서 확인', message: '첨부와 내용을 확인했고 정산 서류로 넘겨도 되는 상태인가요?', okLabel: '확인 완료' }).then(function (ok) { if (!ok) return; return store.verifyReport(state.id, true, '').then(function () { toast('확인 완료로 표시했습니다.'); return refresh(); }); }).catch(handleError);
        break;
      case 'return':
        promptDlg({ title: '보완 요청', message: '작성자에게 전달할 내용을 적어 주세요. 보고서는 작성 중 상태로 돌아갑니다.', input: 'textarea', placeholder: '예: 네이버 주문 캡처에 배송비가 보이지 않습니다', okLabel: '보완 요청', danger: true }).then(function (note) { if (note === null) return; return store.verifyReport(state.id, false, note).then(function () { toast('작성자에게 보완을 요청했습니다.'); return refresh(); }); }).catch(handleError);
        break;
      case 'remove-photo': {
        var slot = btn.getAttribute('data-slot'), key = btn.getAttribute('data-key');
        collectForm();
        state.form.photos[slot] = (state.form.photos[slot] || []).filter(function (k) { return k !== key; });
        store.deletePhoto(key).then(function () { return store.saveReport(state.id, Object.assign({}, state.form, { status: reportStatus() === 'submitted' ? 'submitted' : 'draft' })); }).then(function () { return refresh(); }).catch(handleError);
        break;
      }
      case 'print': {
        collectForm();
        window.open(window.location.pathname + '#id=' + encodeURIComponent(state.id) + '&print=1', '_blank');
        break;
      }
      case 'docx': collectForm(); downloadDocx().catch(handleError); break;
    }
  });

  /* ---------- boot ---------- */
  function requireSession() { var s = store.getSession(); if (s && s.status !== 'pending') return true; window.location.replace('../index.html?next=budget'); return false; }

  store.init().then(function () {
    if (!requireSession()) return;
    state.ready = true;
    store.onChange(function () { if (!state.saving) reload().then(render).catch(handleError); });
    return reload();
  }).then(render).catch(function (err) { state.error = err && err.message ? err.message : String(err); render(); });
})();
