/* =====================================================================
   DSIL Lab Portal – 회의비 처리 (UI)
   회의비 청구는 구매 요청과 같은 requests 저장소에 kind='meeting' 으로 저장되어
   과제 예산(실집행)·보고서·조회에 그대로 잡힙니다. 처리는 여기 관리자 탭 또는 구매 요청의 관리자 탭 어디서든 가능.
   탭: 회의비 청구 · 청구 내역 · 관리자(PIN)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var CATS = (CFG.budgetCategories && CFG.budgetCategories.length) ? CFG.budgetCategories : [{ id: 'other', label: '기타' }];
  var CAT_IDS = CATS.map(function (c) { return c.id; });
  var DEFAULT_CAT = CAT_IDS.indexOf('activity') >= 0 ? 'activity' : CAT_IDS[0];
  var U = window.DSILUI;
  var esc = U.esc, won = U.won, nf = U.nf, pad2 = U.pad2, localDate = U.localDate, fmtDate = U.fmtDate, fmtDateTime = U.fmtDateTime, fmtTime = U.fmtTime;
  var $ = U.$, toast = U.toast, readForm = U.readForm, dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty, dg = U.dg, stat = U.stat, csvCell = U.csvCell, download = U.download;
  var store = window.DSILStore.create(CFG);
  var ADMIN_KEY = 'dsil-budget-admin-unlock';
  var TABS = ['claim', 'list', 'admin'];
  var STATUS = { pending: { label: '미처리', cls: 'bg-yellow-lt' }, done: { label: '처리', cls: 'bg-blue-lt' }, rejected: { label: '반려', cls: 'bg-red-lt' } };
  var PAY = { card: '법인카드', personal: '개인 선결제', invoice: '세금계산서' };

  var state = { ready: false, error: null, session: null, projects: [], requests: [], reviews: [], reviewsFull: false, tab: 'claim', filter: 'all', adminUnlocked: false };

  /* ---------- helpers ---------- */
  function isMine(r) { return !!state.session && r.requesterId === state.session.user.id; }
  function meetings() { return state.requests.filter(function (r) { return r.kind === 'meeting'; }); }
  function projectById(id) { return state.projects.filter(function (p) { return p.id === id; })[0] || null; }
  function catLabel(id) { for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i].label; return id || '-'; }
  function normCat(id) { return CAT_IDS.indexOf(id) >= 0 ? id : CAT_IDS[0]; }
  function catOptions(selected) { return CATS.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join(''); }
  function toLocalInput(iso) { var d = new Date(iso); return isNaN(d) ? '' : localDate(iso) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function attendeeCount(text) { return String(text || '').split(/[,\n、·]/).map(function (s) { return s.trim(); }).filter(Boolean).length; }

  /* 과제·비목별 잔액 = 예산 − 실집행 − 가할당 (구매 요청 페이지와 같은 규칙) */
  function remainOf(p, cat) {
    var budget = Number(p.budgets && p.budgets[cat]) || 0;
    var actual = 0;
    state.requests.forEach(function (r) { if (r.status === 'done' && r.projectId === p.id && normCat(r.category) === cat) actual += Number(r.amount) || 0; });
    var prov = 0;
    if (state.reviewsFull) {
      state.reviews.forEach(function (rv) {
        if (rv.status !== 'approved' || rv.projectId !== p.id || normCat(rv.category) !== cat) return;
        var approved = Number(rv.approvedAmount !== null && rv.approvedAmount !== undefined ? rv.approvedAmount : rv.amount) || 0;
        var used = 0; state.requests.forEach(function (r) { if (r.status === 'done' && r.reviewId === rv.id) used += Number(r.amount) || 0; });
        prov += Math.max(0, approved - used);
      });
    }
    return budget - actual - prov;
  }
  function projectOptions(amount, cat, selectedId) {
    return '<option value="">과제 선택…</option>' + state.projects.filter(function (p) { return p.active !== false; }).map(function (p) {
      var remain = remainOf(p, cat);
      var label = p.name.length > 22 ? p.name.slice(0, 22) + '…' : p.name;
      return '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + '>' + esc((p.code ? p.code + ' ' : '') + label) + ' · ' + esc(catLabel(cat)) + ' 잔액 ' + won(remain) + ((Number(amount) || 0) > remain ? ' (부족)' : '') + '</option>';
    }).join('');
  }

  /* ---------- 관리자 잠금 ---------- */
  function readUnlock() { try { var t = Number(sessionStorage.getItem(ADMIN_KEY) || 0); var mins = Number(CFG.adminUnlockMinutes) > 0 ? Number(CFG.adminUnlockMinutes) : 10; return t > 0 && (Date.now() - t) < mins * 60000; } catch (e) { return false; } }
  function setUnlock(on) { try { if (on) sessionStorage.setItem(ADMIN_KEY, String(Date.now())); else sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ } state.adminUnlocked = on; }
  function isAdminEligible() { return !!(state.session && state.session.isAdmin); }
  function isAdminActive() { return isAdminEligible() && state.adminUnlocked; }
  function touchUnlock() { if (state.adminUnlocked) setUnlock(true); }
  function enterAdmin() {
    if (!isAdminEligible()) { toast('관리자 권한이 없습니다.', true); return; }
    if (readUnlock()) { setUnlock(true); state.tab = 'admin'; return refresh(); }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요.', input: 'password', placeholder: 'PIN', okLabel: '열기' }).then(function (pin) {
      if (pin === null) return;
      return store.verifyAdminPin(pin).then(function (ok) { if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; } setUnlock(true); state.tab = 'admin'; toast('관리자 화면을 열었습니다.'); return refresh(); });
    }).catch(handleError);
  }

  /* ---------- data ---------- */
  function reload() {
    state.session = store.getSession();
    state.adminUnlocked = readUnlock();
    var full = isAdminActive();
    return Promise.all([store.listProjects(), store.listRequests(), state.session ? store.listReviews({ full: full }) : Promise.resolve([])]).then(function (res) {
      state.projects = res[0];
      state.requests = res[1].slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      state.reviews = res[2]; state.reviewsFull = full;
      if (state.tab === 'admin' && !isAdminActive()) state.tab = 'claim';
    });
  }

  /* ---------- render ---------- */
  function render() {
    state.adminUnlocked = readUnlock();
    renderUserChip();
    var app = $('#app');
    if (!app) return;
    if (state.error) { app.innerHTML = '<div class="alert alert-danger"><h4 class="alert-title">초기화 오류</h4><div class="text-secondary">' + esc(state.error) + '</div></div>'; return; }
    if (!state.ready) { app.innerHTML = '<div class="text-secondary text-center py-5">불러오는 중…</div>'; return; }
    if (!state.session) { app.innerHTML = '<div class="text-secondary text-center py-5">포털로 이동 중…</div>'; return; }

    var all = meetings();
    var mine = all.filter(isMine);
    var mStart = new Date(); mStart.setDate(1); mStart.setHours(0, 0, 0, 0);
    var monthDone = all.filter(function (r) { return r.status === 'done' && new Date(r.processedAt || r.createdAt) >= mStart; });
    var pending = all.filter(function (r) { return r.status === 'pending'; });
    var html = '<div class="row row-deck row-cards mb-3">'
      + stat('내 청구', mine.length + '건', '미처리 ' + mine.filter(function (r) { return r.status === 'pending'; }).length + ' · 처리 ' + mine.filter(function (r) { return r.status === 'done'; }).length, 'text-primary')
      + stat('내 처리 금액', won(mine.filter(function (r) { return r.status === 'done'; }).reduce(function (s, r) { return s + r.amount; }, 0)), '과제 배정 완료', '')
      + (isAdminActive()
        ? stat('미처리 회의비', pending.length + '건', won(pending.reduce(function (s, r) { return s + r.amount; }, 0)) + ' 대기', pending.length ? 'text-yellow' : '') + stat('이번 달 처리', monthDone.length + '건', won(monthDone.reduce(function (s, r) { return s + r.amount; }, 0)), '')
        : stat('이번 달 내 회의', mine.filter(function (r) { return new Date(r.createdAt) >= mStart; }).length + '건', '', '') + stat('기본 비목', catLabel(DEFAULT_CAT), '관리자가 배정 시 변경 가능', ''))
      + '</div>';
    var tab = state.tab === 'list' ? renderListTab() : state.tab === 'admin' ? renderAdminTab() : renderClaimTab();
    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('claim', 'receipt', '회의비 청구') + tabLink('list', 'list-details', '청구 내역')
      + (isAdminEligible() ? tabLink('admin', state.adminUnlocked ? 'lock-open' : 'lock', '관리자', pending.length && state.adminUnlocked ? '<span class="badge bg-yellow-lt ms-2">' + pending.length + '</span>' : '') : '')
      + '</ul></div>' + tab.body + '</div>' + (tab.after || '');
    app.innerHTML = html;
    try { history.replaceState(null, '', '#' + state.tab); } catch (e) { /* ignore */ }
  }

  function tabLink(id, icon, label, extra) {
    return '<li class="nav-item"><a href="#' + id + '" class="nav-link' + (state.tab === id ? ' active' : '') + '" data-action="tab" data-tab="' + id + '" role="tab"><i class="ti ti-' + icon + ' me-1"></i>' + esc(label) + (extra || '') + '</a></li>';
  }

  function renderUserChip() {
    var slot = $('#user-slot');
    if (!slot) return;
    if (!state.session) { slot.innerHTML = ''; return; }
    var s = state.session;
    slot.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="avatar avatar-sm bg-blue-lt">' + esc((s.user.name || '?').trim().charAt(0)) + '</span>'
      + '<div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(s.user.name) + '</div><div class="small text-secondary mt-1">' + (!s.isAdmin ? '구성원' : (state.adminUnlocked ? '관리자 · 열림' : '관리자 · 잠김')) + '</div></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="signout"><i class="ti ti-logout"></i><span class="d-none d-sm-inline ms-1">로그아웃</span></button></div>';
  }

  /* ---------- 회의비 청구 탭 ---------- */
  function renderClaimTab() {
    var now = new Date(); now.setMinutes(0, 0, 0);
    var body = '<div class="card-body"><div class="row g-4"><div class="col-lg-7">'
      + '<h3 class="card-title mb-1"><i class="ti ti-receipt me-1 text-primary"></i>회의비 청구</h3>'
      + '<p class="text-secondary small mb-3">회의 정보와 결제 금액을 적어 올리면 관리자가 과제와 비목을 배정하고, 배정된 금액은 과제 예산에서 차감됩니다.</p>'
      + '<form id="meeting-form"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">회의명</label><input type="text" class="form-control" name="title" required placeholder="예: 3D 집적 과제 월간 회의"></div>'
      + '<div class="col-sm-6"><label class="form-label required">회의 일시</label><input type="datetime-local" class="form-control" name="heldAt" required value="' + esc(toLocalInput(now.toISOString())) + '"></div>'
      + '<div class="col-sm-6"><label class="form-label required">장소 (식당·업체)</label><input type="text" class="form-control" name="place" required placeholder="예: 카이마루 2층"></div>'
      + '<div class="col-12"><label class="form-label required">참석자 <span class="form-label-description">쉼표로 구분</span></label><textarea class="form-control" name="attendees" rows="2" required placeholder="홍길동, 이영희, 박철수"></textarea><div class="form-hint" id="attendee-hint">0명</div></div>'
      + '<div class="col-sm-4"><label class="form-label required">금액 (원)</label><input type="number" class="form-control tnum" name="amount" min="0" step="1" required placeholder="0"></div>'
      + '<div class="col-sm-4"><label class="form-label required">결제 방법</label><select class="form-select" name="payment">' + Object.keys(PAY).map(function (k) { return '<option value="' + k + '">' + PAY[k] + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-sm-4"><label class="form-label">비목</label><select class="form-select" name="category">' + catOptions(DEFAULT_CAT) + '</select></div>'
      + '<div class="col-12"><label class="form-label required">회의 목적 · 안건</label><textarea class="form-control" name="purpose" rows="2" required placeholder="논의 내용 요약"></textarea></div>'
      + '<div class="col-12"><label class="form-label">비고 <span class="form-label-description">영수증 번호, 특이사항</span></label><input type="text" class="form-control" name="note"></div>'
      + '</div><div class="d-flex justify-content-between align-items-center mt-3"><span class="small text-secondary" id="per-head"></span><button type="submit" class="btn btn-primary"><i class="ti ti-send me-1"></i>청구 제출</button></div></form>'
      + '</div><div class="col-lg-5"><h3 class="card-title mb-2"><i class="ti ti-user-check me-1 text-primary"></i>내 최근 청구</h3>';
    var mine = meetings().filter(isMine).slice(0, 6);
    if (!mine.length) body += '<div class="text-secondary small">아직 청구가 없습니다.</div>';
    else body += '<div class="list-group list-group-flush">' + mine.map(function (r) {
      var st = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
      return '<div class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2"><div class="text-truncate"><span class="text-secondary small me-2">' + fmtDate(r.meta.heldAt || r.createdAt) + '</span>' + esc(r.meta.title || r.item) + '</div><div class="text-nowrap"><span class="tnum me-2">' + won(r.amount) + '</span><span class="badge ' + st.cls + '">' + st.label + '</span></div></div>';
    }).join('') + '</div>';
    body += '<h3 class="card-title mt-4 mb-2"><i class="ti ti-info-circle me-1 text-primary"></i>안내</h3><ul class="text-secondary small mb-0 ps-3">'
      + '<li>참석자 명단과 회의 목적은 정산 증빙에 그대로 쓰이므로 정확히 적어 주세요.</li><li>처리된 회의비는 구매 요청 페이지의 요청 조회·보고서에도 회의비로 표시됩니다.</li><li>미처리 상태에서는 청구 내역에서 직접 취소할 수 있습니다.</li></ul>'
      + '</div></div></div>';
    return { body: body };
  }

  /* ---------- 청구 내역 탭 ---------- */
  function row(r, admin) {
    var st = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
    var p = r.projectId ? projectById(r.projectId) : null;
    var m = r.meta || {};
    var own = isMine(r);
    var html = '<tr data-id="' + esc(r.id) + '"><td class="text-nowrap text-secondary">' + fmtDate(m.heldAt || r.createdAt) + '</td><td class="text-nowrap">' + esc(r.requesterName) + '</td>'
      + '<td><div class="fw-medium">' + esc(m.title || r.item) + '</div><div class="small text-secondary">' + esc(m.place || '') + (m.attendees ? ' · ' + attendeeCount(m.attendees) + '명' : '') + (m.payment ? ' · ' + esc(PAY[m.payment] || m.payment) : '') + '</div>'
      + (r.status === 'rejected' && r.adminNote ? '<div class="small text-danger">반려 사유: ' + esc(r.adminNote) + '</div>' : '') + '</td>'
      + '<td class="text-end tnum text-nowrap fw-medium">' + won(r.amount) + '</td>';
    if (admin && r.status === 'pending') {
      var cat = normCat(r.category);
      html += '<td><span class="badge ' + st.cls + '">' + st.label + '</span></td>'
        + '<td><div class="d-flex flex-wrap gap-1"><select class="form-select form-select-sm" data-role="assign-project">' + projectOptions(r.amount, cat, '') + '</select><select class="form-select form-select-sm" data-role="assign-cat" style="min-width:7rem">' + catOptions(cat) + '</select></div></td>'
        + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="detail" title="상세"><i class="ti ti-eye"></i></button> <button type="button" class="btn btn-sm btn-primary" data-action="assign">처리</button> <button type="button" class="btn btn-sm btn-outline-danger" data-action="reject">반려</button></td>';
    } else {
      html += '<td><span class="badge ' + st.cls + '">' + st.label + '</span>' + (r.processedAt ? '<div class="small text-secondary text-nowrap">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</div>' : '') + '</td>'
        + '<td>' + (p ? '<div>' + esc(p.name) + '</div><div class="small text-secondary">' + esc(p.code) + ' · ' + esc(catLabel(normCat(r.category))) + '</div>' : '<span class="text-secondary">-</span>') + '</td>'
        + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="detail" title="상세"><i class="ti ti-eye"></i></button>'
        + (admin && r.status !== 'pending' ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reopen" title="미처리로 되돌리기"><i class="ti ti-arrow-back-up"></i></button>' : '')
        + ((admin || (own && r.status === 'pending')) ? '<button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete" title="' + (own && !admin ? '청구 취소' : '삭제') + '"><i class="ti ti-trash"></i></button>' : '') + '</td>';
    }
    return html + '</tr>';
  }

  function chip(val, label) { return '<button type="button" class="btn btn-sm ' + (state.filter === val ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="filter" data-filter="' + val + '">' + label + '</button>'; }

  function renderListTab() {
    var admin = isAdminActive();
    var list = meetings().filter(function (r) { return (admin || isMine(r)) && (state.filter === 'all' || r.status === state.filter); });
    var body = '<div class="card-body py-2 border-bottom d-flex flex-wrap align-items-center gap-2"><div class="btn-group">' + chip('all', '전체') + chip('pending', '미처리') + chip('done', '처리') + chip('rejected', '반려') + '</div>'
      + '<span class="small text-secondary">' + (admin ? '전체 청구' : '내 청구') + ' ' + list.length + '건 · 합계 ' + won(list.reduce(function (s, r) { return s + r.amount; }, 0)) + '</span>'
      + '<button type="button" class="btn btn-sm ms-auto" data-action="export-csv"' + (list.length ? '' : ' disabled') + '><i class="ti ti-file-spreadsheet me-1"></i>CSV</button></div>';
    if (!list.length) body += '<div class="card-body">' + empty('receipt-off', '청구 내역이 없습니다', '') + '</div>';
    else body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">회의일</th><th class="w-1">청구자</th><th>회의</th><th class="text-end">금액</th><th>상태</th><th>배정 과제</th><th class="w-1"></th></tr></thead><tbody>' + list.map(function (r) { return row(r, admin); }).join('') + '</tbody></table></div>';
    return { body: body };
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab() {
    if (!isAdminActive()) return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 열립니다.') + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    var pending = meetings().filter(function (r) { return r.status === 'pending'; });
    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom"><div class="text-secondary small"><i class="ti ti-lock-open me-1"></i>관리자 모드 · 과제와 비목을 고르고 처리를 누르면 해당 비목 잔액에서 차감됩니다. 처리·반려된 건은 청구 내역에서 되돌립니다.</div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div>';
    if (!pending.length) body += '<div class="card-body">' + empty('checks', '미처리 회의비가 없습니다', '') + '</div>';
    else body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">회의일</th><th class="w-1">청구자</th><th>회의</th><th class="text-end">금액</th><th>상태</th><th>배정</th><th class="w-1"></th></tr></thead><tbody>' + pending.map(function (r) { return row(r, true); }).join('') + '</tbody></table></div>';
    return { body: body };
  }

  function showDetail(id) {
    var r = state.requests.filter(function (x) { return x.id === id; })[0]; if (!r) return Promise.resolve();
    var m = r.meta || {}; var p = r.projectId ? projectById(r.projectId) : null; var st = STATUS[r.status] || { label: r.status, cls: '' };
    var html = '<div class="datagrid mb-3">' + dg('회의명', esc(m.title || r.item)) + dg('회의 일시', esc(fmtDateTime(m.heldAt || r.createdAt))) + dg('장소', esc(m.place || '-')) + dg('청구자', esc(r.requesterName) + ' <span class="text-secondary small">· ' + fmtDate(r.createdAt) + '</span>')
      + dg('금액', '<span class="tnum">' + won(r.amount) + '</span>' + (m.attendees ? ' <span class="text-secondary small">(' + attendeeCount(m.attendees) + '명 · 1인 ' + won(r.amount / Math.max(1, attendeeCount(m.attendees))) + ')</span>' : '')) + dg('결제', esc(PAY[m.payment] || m.payment || '-'))
      + dg('상태', '<span class="badge ' + st.cls + '">' + st.label + '</span>' + (r.processedAt ? ' <span class="text-secondary small">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</span>' : ''))
      + (p ? dg('배정 과제', esc(p.name) + ' <span class="text-secondary small">' + esc(p.code) + ' · ' + esc(catLabel(normCat(r.category))) + '</span>') : '') + '</div>'
      + '<div class="mb-3"><div class="subheader">참석자</div><div>' + esc(m.attendees || '-') + '</div></div>'
      + '<div class="mb-3"><div class="subheader">회의 목적 · 안건</div><div style="white-space:pre-wrap">' + esc(m.purpose || '-') + '</div></div>'
      + (r.note ? '<div class="mb-3"><div class="subheader">비고</div><div>' + esc(r.note) + '</div></div>' : '')
      + (r.adminNote ? '<div class="alert alert-' + (r.status === 'rejected' ? 'danger' : 'info') + ' py-2 mb-0"><div class="small fw-medium">관리자 메모</div>' + esc(r.adminNote) + '</div>' : '');
    return dialog({ title: '회의비 상세', html: html, size: 'lg', okLabel: '닫기', hideCancel: true });
  }

  function exportCsv() {
    var admin = isAdminActive();
    var list = meetings().filter(function (r) { return (admin || isMine(r)) && (state.filter === 'all' || r.status === state.filter); });
    var head = ['회의일시', '회의명', '장소', '참석자', '인원', '금액', '결제', '청구자', '상태', '배정 과제', '과제번호', '비목', '처리일', '처리자', '목적', '비고'];
    var lines = list.map(function (r) { var m = r.meta || {}; var p = r.projectId ? projectById(r.projectId) : null;
      return [fmtDateTime(m.heldAt || r.createdAt), m.title || r.item, m.place || '', m.attendees || '', attendeeCount(m.attendees), r.amount, PAY[m.payment] || m.payment || '', r.requesterName, (STATUS[r.status] || {}).label || r.status, p ? p.name : '', p ? p.code : '', catLabel(normCat(r.category)), localDate(r.processedAt), r.processedBy || '', m.purpose || '', r.note].map(csvCell).join(','); });
    download('dsil-meeting-' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + head.join(',') + '\r\n' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ---------- actions ---------- */
  function handleError(err) { console.error(err); toast(err && err.message ? err.message : String(err), true); }
  function refresh() { return reload().then(render).catch(handleError); }

  document.addEventListener('input', function (e) {
    var f = e.target.closest('#meeting-form'); if (!f) return;
    var n = attendeeCount(f.attendees.value); var amt = Number(f.amount.value) || 0;
    var h = $('#attendee-hint'); if (h) h.textContent = n + '명';
    var ph = $('#per-head'); if (ph) ph.textContent = n && amt ? '1인당 ' + won(amt / n) : '';
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id !== 'meeting-form') return;
    e.preventDefault();
    var v = readForm(form);
    var amount = Math.max(0, Math.round(Number(v.amount) || 0));
    var n = attendeeCount(v.attendees);
    if (!v.title.trim()) { toast('회의명을 입력하세요.', true); return; }
    if (!n) { toast('참석자를 입력하세요.', true); return; }
    if (amount <= 0) { toast('금액을 입력하세요.', true); return; }
    var heldAt = new Date(v.heldAt); if (isNaN(heldAt)) { toast('회의 일시를 입력하세요.', true); return; }
    store.createRequest({
      kind: 'meeting', item: '회의비 · ' + v.title.trim(), category: normCat(v.category), link: '', qty: 1, unitPrice: amount, amount: amount,
      note: v.note.trim(), meta: { title: v.title.trim(), heldAt: heldAt.toISOString(), place: v.place.trim(), attendees: v.attendees.trim(), attendeeCount: n, payment: v.payment, purpose: v.purpose.trim() }
    }).then(function () { toast('회의비 청구를 제출했습니다. 관리자 처리 후 상태가 바뀝니다.'); state.tab = 'list'; return refresh(); }).catch(handleError);
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.getAttribute('data-role') === 'assign-cat') {
      var tr = el.closest('tr[data-id]'); var sel = tr && tr.querySelector('select[data-role="assign-project"]');
      var req = tr && state.requests.filter(function (x) { return x.id === tr.getAttribute('data-id'); })[0];
      if (sel && req) sel.innerHTML = projectOptions(req.amount, normCat(el.value), sel.value);
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    var tr = btn.closest('tr[data-id]'); var id = tr ? tr.getAttribute('data-id') : null;
    switch (action) {
      case 'tab': { e.preventDefault(); var t = btn.getAttribute('data-tab'); if (t === 'admin' && !isAdminActive()) { enterAdmin(); return; } state.tab = t; render(); break; }
      case 'unlock-admin': enterAdmin(); break;
      case 'lock-admin': setUnlock(false); state.tab = 'claim'; toast('관리자 화면을 잠갔습니다.'); refresh(); break;
      case 'signout': setUnlock(false); store.signOut().then(function () { window.location.replace('../index.html'); }); break;
      case 'refresh': refresh().then(function () { toast('새로고침 완료'); }); break;
      case 'filter': state.filter = btn.getAttribute('data-filter'); render(); break;
      case 'export-csv': exportCsv(); break;
      case 'detail': showDetail(id).catch(handleError); break;
      case 'assign': {
        var sel = tr.querySelector('select[data-role="assign-project"]'); var catSel = tr.querySelector('select[data-role="assign-cat"]');
        var pid = sel && sel.value; var cat = normCat(catSel && catSel.value);
        if (!pid) { toast('배정할 과제를 선택하세요.', true); return; }
        var req = state.requests.filter(function (x) { return x.id === id; })[0]; var proj = projectById(pid); var remain = remainOf(proj, cat);
        var ask = (Number(req.amount) || 0) > remain ? confirmDlg({ title: '비목 예산 초과', message: '이 과제의 ' + catLabel(cat) + ' 잔액은 ' + won(remain) + '이고 청구 금액은 ' + won(req.amount) + '입니다. 그래도 배정할까요?', okLabel: '초과 배정', danger: true }) : Promise.resolve(true);
        ask.then(function (ok) { if (!ok) return; return store.updateRequest(id, { status: 'done', projectId: pid, category: cat, processedAt: new Date().toISOString(), processedBy: state.session.user.name, adminNote: '' }).then(function () { toast('처리 완료: ' + proj.name + ' · ' + catLabel(cat)); touchUnlock(); return refresh(); }); }).catch(handleError);
        break;
      }
      case 'reject':
        promptDlg({ title: '반려', message: '반려 사유를 적어 주세요. 청구자에게 표시됩니다.', input: 'textarea', okLabel: '반려', danger: true }).then(function (reason) { if (reason === null) return; return store.updateRequest(id, { status: 'rejected', projectId: null, processedAt: new Date().toISOString(), processedBy: state.session.user.name, adminNote: reason.trim() }).then(function () { toast('반려했습니다.'); touchUnlock(); return refresh(); }); }).catch(handleError);
        break;
      case 'reopen': store.updateRequest(id, { status: 'pending', projectId: null, processedAt: null, processedBy: null, adminNote: '' }).then(function () { toast('미처리로 되돌렸습니다.'); touchUnlock(); return refresh(); }).catch(handleError); break;
      case 'delete': {
        var target = state.requests.filter(function (x) { return x.id === id; })[0]; var ownPending = target && isMine(target) && target.status === 'pending' && !isAdminActive();
        confirmDlg({ title: ownPending ? '청구 취소' : '청구 삭제', message: ownPending ? '이 청구를 취소할까요?' : '이 청구를 삭제할까요? 되돌릴 수 없습니다.', okLabel: ownPending ? '취소하기' : '삭제', danger: true }).then(function (ok) { if (!ok) return; return store.deleteRequest(id).then(function () { toast(ownPending ? '청구를 취소했습니다.' : '삭제했습니다.'); touchUnlock(); return refresh(); }); }).catch(handleError);
        break;
      }
    }
  });

  /* ---------- boot ---------- */
  var initialTab = (window.location.hash || '').replace('#', '');
  if (TABS.indexOf(initialTab) >= 0) state.tab = initialTab;
  function requireSession() { var s = store.getSession(); if (s && s.status !== 'pending') return true; window.location.replace('../index.html?next=meeting'); return false; }

  store.init().then(function () {
    if (!requireSession()) return;
    state.ready = true;
    store.onChange(function () { reload().then(render).catch(handleError); });
    return reload();
  }).then(render).catch(function (err) { state.error = err && err.message ? err.message : String(err); render(); });
})();
