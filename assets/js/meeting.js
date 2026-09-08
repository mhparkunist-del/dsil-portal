/* =====================================================================
   DSIL Lab Portal – 회의비 처리 (UI)
   구매 요청과 달리 관리자 승인 단계가 없습니다.
   청구자가 사용 카드와 과제(참여과제 시트에 있는 과제)를 고르고 참석자를 그 과제의 참여자 중에서 배정하면
   즉시 처리(status done, 과제 예산의 회의비에서 차감)되고 회의록(보고서) 작성 화면으로 넘어갑니다.
   규칙: 1인당 회의비 ≤ config.meeting.perPersonMax (기본 30,000원). 자동 추가 버튼이 금액에 맞춰 인원을 채웁니다.
   탭: 회의비 청구 · 청구 내역 · 관리자(PIN: 참여과제 시트 가져오기, 이전 방식의 미처리 건 처리)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var MCFG = Object.assign({ perPersonMax: 30000, autoProcessedBy: '자동 배정 (참여과제)' }, CFG.meeting || {});
  var CATS = (CFG.budgetCategories && CFG.budgetCategories.length) ? CFG.budgetCategories : [{ id: 'other', label: '기타' }];
  var CAT_IDS = CATS.map(function (c) { return c.id; });
  var DEFAULT_CAT = CAT_IDS.indexOf('meeting') >= 0 ? 'meeting' : (CAT_IDS.indexOf('activity') >= 0 ? 'activity' : CAT_IDS[0]);
  var U = window.DSILUI;
  var esc = U.esc, won = U.won, nf = U.nf, pad2 = U.pad2, localDate = U.localDate, fmtDate = U.fmtDate, fmtDateTime = U.fmtDateTime;
  var $ = U.$, toast = U.toast, readForm = U.readForm, dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty, dg = U.dg, stat = U.stat, csvCell = U.csvCell, download = U.download;
  var store = window.DSILStore.create(CFG);
  var ADMIN_KEY = 'dsil-budget-admin-unlock';
  var TABS = ['claim', 'list', 'admin'];
  var STATUS = { pending: { label: '미처리', cls: 'bg-yellow-lt' }, done: { label: '처리', cls: 'bg-blue-lt' }, rejected: { label: '반려', cls: 'bg-red-lt' } };
  var RSTATUS = { none: { label: '회의록 미작성', cls: 'bg-yellow-lt' }, draft: { label: '회의록 작성 중', cls: 'bg-secondary-lt' }, submitted: { label: '회의록 제출', cls: 'bg-blue-lt' }, verified: { label: '회의록 확인', cls: 'bg-green-lt' } };
  var PAY = { woori: '우리카드', shinhan: '신한카드', personal: '개인 선결제', invoice: '세금계산서', card: '법인카드', naverpay: '네이버페이' };
  var PAY_CHOICES = ['woori', 'shinhan', 'personal', 'invoice'];

  var state = { ready: false, error: null, session: null, projects: [], requests: [], reviews: [], reviewsFull: false, tab: 'claim', filter: 'all', adminUnlocked: false, importInfo: null,
    claim: { projectId: '', heldAt: '', amount: 0, attendees: [], others: '' } };

  /* ---------- helpers ---------- */
  function nameKey(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function isMine(r) { return !!state.session && r.requesterId === state.session.user.id; }
  function meetings() { return state.requests.filter(function (r) { return r.kind === 'meeting'; }); }
  function projectById(id) { return state.projects.filter(function (p) { return p.id === id; })[0] || null; }
  function catLabel(id) { for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i].label; return id || '-'; }
  function normCat(id) { return CAT_IDS.indexOf(id) >= 0 ? id : CAT_IDS[0]; }
  function catOptions(selected) { return CATS.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join(''); }
  function toLocalInput(iso) { var d = new Date(iso); return isNaN(d) ? '' : localDate(iso) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function splitNames(text) { return String(text || '').split(/[,\n、·]/).map(function (s) { return s.trim(); }).filter(Boolean); }
  function attendeeCount(text) { return splitNames(text).length; }
  function monthKey(d) { var x = new Date(d); return isNaN(x) ? '' : x.getFullYear() + '-' + pad2(x.getMonth() + 1); }
  function projectLabel(p) { return (p.alias && p.alias !== p.name ? p.alias + ' · ' : '') + p.name + (p.code ? ' (' + p.code + ')' : ''); }

  /* 시트 기준 참여 여부: 해당 월 칸이 있으면 그 값, 없으면 시트 어딘가에 참여 표시가 있으면 참여 */
  function participates(part, mk) {
    var m = part && part.months && typeof part.months === 'object' ? part.months : {};
    if (mk && Object.prototype.hasOwnProperty.call(m, mk)) return !!m[mk];
    var keys = Object.keys(m);
    return !keys.length || keys.some(function (k) { return m[k]; });
  }
  function eligibleNames(p, mk) { return (p && Array.isArray(p.participants) ? p.participants : []).filter(function (x) { return participates(x, mk); }).map(function (x) { return x.name; }); }
  function hasSheet(p) { return !!(p && Array.isArray(p.participants) && p.participants.length); }
  function myProjects(mk) {
    var me = nameKey(state.session.user.name);
    return state.projects.filter(function (p) { return p.active !== false && eligibleNames(p, mk).some(function (n) { return nameKey(n) === me; }); });
  }
  function minPeople(amount) { return Math.max(1, Math.ceil((Number(amount) || 0) / MCFG.perPersonMax)); }
  function claimTotal() { return state.claim.attendees.length + attendeeCount(state.claim.others); }
  function perHead() { var n = claimTotal(); return n ? (Number(state.claim.amount) || 0) / n : 0; }

  function reportBadge(r) {
    if (r.status !== 'done') return '';
    var st = r.report ? (r.report.status || 'draft') : 'none';
    var S = RSTATUS[st] || RSTATUS.none;
    return '<a href="../report/index.html#id=' + esc(r.id) + '" class="badge ' + S.cls + ' text-decoration-none" title="회의록 열기"><i class="ti ti-file-text me-1"></i>' + S.label + '</a>';
  }

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
    return Promise.all([store.listProjects(), store.listRequests(), state.session ? store.listReviews({ full: full }) : Promise.resolve([]), store.getParticipationInfo ? store.getParticipationInfo().catch(function () { return null; }) : Promise.resolve(null)]).then(function (res) {
      state.projects = res[0];
      state.requests = res[1].slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      state.reviews = res[2]; state.reviewsFull = full;
      state.importInfo = res[3];
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
    var noMinutes = mine.filter(function (r) { return r.status === 'done' && (!r.report || r.report.status === 'draft'); });
    var html = '<div class="row row-deck row-cards mb-3">'
      + stat('내 청구', mine.length + '건', '처리 ' + mine.filter(function (r) { return r.status === 'done'; }).length + (pending.filter(isMine).length ? ' · 미처리 ' + pending.filter(isMine).length : ''), 'text-primary')
      + stat('내 처리 금액', won(mine.filter(function (r) { return r.status === 'done'; }).reduce(function (s, r) { return s + r.amount; }, 0)), '과제 배정 완료', '')
      + stat('회의록 미작성', noMinutes.length + '건', noMinutes.length ? '청구 내역에서 회의록 배지를 누르세요' : '모두 작성됨', noMinutes.length ? 'text-yellow' : '')
      + (isAdminActive()
        ? stat('이번 달 처리', monthDone.length + '건', won(monthDone.reduce(function (s, r) { return s + r.amount; }, 0)) + (pending.length ? ' · 미처리 ' + pending.length + '건' : ''), '')
        : stat('1인당 한도', won(MCFG.perPersonMax), '금액 ÷ 인원이 넘지 않게', ''))
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
  function claimProjectOptions() {
    var mk = monthKey(state.claim.heldAt);
    var mineP = myProjects(mk);
    var sheetP = state.projects.filter(function (p) { return p.active !== false && hasSheet(p); });
    var list = mineP.length ? mineP : sheetP;
    if (!list.length) return '<option value="">참여과제 시트가 없습니다 (관리자 탭에서 가져오기)</option>';
    return '<option value="">과제 선택…</option>' + list.map(function (p) { return '<option value="' + esc(p.id) + '"' + (p.id === state.claim.projectId ? ' selected' : '') + '>' + esc(projectLabel(p)) + ' · 참여자 ' + eligibleNames(p, mk).length + '명</option>'; }).join('');
  }

  function attendeeBlockHtml() {
    var c = state.claim, p = c.projectId ? projectById(c.projectId) : null;
    var mk = monthKey(c.heldAt);
    var names = p ? eligibleNames(p, mk) : [];
    var left = names.filter(function (n) { return c.attendees.indexOf(n) < 0; });
    var total = claimTotal(), need = minPeople(c.amount), ph = perHead(), over = total && ph > MCFG.perPersonMax;
    var html = '<div class="d-flex flex-wrap gap-1 mb-2" id="attendee-chips">'
      + c.attendees.map(function (n) { return '<span class="badge bg-blue-lt rp-chip">' + esc(n) + '<button type="button" class="btn-close btn-close-sm ms-1" data-action="remove-attendee" data-name="' + esc(n) + '" aria-label="빼기" style="font-size:.6rem"></button></span>'; }).join('')
      + splitNames(c.others).map(function (n) { return '<span class="badge bg-secondary-lt rp-chip" title="시트에 없는 참석자">' + esc(n) + '</span>'; }).join('')
      + (!total ? '<span class="text-secondary small">아직 없음</span>' : '') + '</div>'
      + '<div class="d-flex flex-wrap gap-2 align-items-center">'
      + '<select class="form-select form-select-sm w-auto" id="attendee-select"' + (!p ? ' disabled' : '') + '><option value="">' + (p ? (left.length ? '참석자 추가…' : '참여자를 모두 넣었습니다') : '과제를 먼저 고르세요') + '</option>' + left.map(function (n) { return '<option value="' + esc(n) + '">' + esc(n) + '</option>'; }).join('') + '</select>'
      + '<button type="button" class="btn btn-sm btn-outline-primary" data-action="auto-add"' + (!p ? ' disabled' : '') + ' title="금액 ÷ ' + nf.format(MCFG.perPersonMax) + '원 = 최소 인원까지 시트 순서대로 채웁니다"><i class="ti ti-wand me-1"></i>자동 추가</button>'
      + (c.attendees.length ? '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="clear-attendees">비우기</button>' : '')
      + '<span class="small ms-auto ' + (over ? 'text-danger fw-medium' : 'text-secondary') + '" id="per-head">' + (total ? total + '명 · 1인당 ' + won(ph) + (over ? ' · 한도 초과 → ' + need + '명 이상 필요' : '') : (Number(c.amount) > 0 ? won(c.amount) + ' → 최소 ' + need + '명' : '')) + '</span>'
      + '</div>'
      + (p && !names.length ? '<div class="form-hint text-warning">이 과제에 ' + (mk ? mk.replace('-', '년 ') + '월' : '해당 월') + ' 참여자가 없습니다.</div>' : '')
      + '<div class="mt-2"><label class="form-label mb-1">기타 참석자 <span class="form-label-description">시트에 없는 사람 (교수·행정·외부), 쉼표 구분</span></label><input type="text" class="form-control form-control-sm" name="others" value="' + esc(c.others) + '" placeholder="예: 권지민"></div>';
    return html;
  }

  function renderClaimTab() {
    var c = state.claim;
    if (!c.heldAt) { var now = new Date(); now.setMinutes(0, 0, 0); c.heldAt = now.toISOString(); }
    var mk = monthKey(c.heldAt);
    var mineP = myProjects(mk);
    var body = '<div class="card-body"><div class="row g-4"><div class="col-lg-7">'
      + '<h3 class="card-title mb-1"><i class="ti ti-receipt me-1 text-primary"></i>회의비 청구</h3>'
      + '<p class="text-secondary small mb-3">사용 카드와 과제를 고르고 그 과제의 참여자 중에서 참석자를 배정하면 승인 없이 바로 처리됩니다. 제출하면 회의록(영수증 첨부) 작성 화면으로 넘어갑니다.</p>'
      + (!mineP.length ? '<div class="alert alert-warning py-2"><i class="ti ti-alert-triangle me-1"></i>참여과제 시트에서 <strong>' + esc(state.session.user.name) + '</strong> 이름을 찾지 못했습니다. 포털 이름을 시트와 같게 하거나 관리자에게 시트 갱신을 요청하세요. (아래에는 시트에 있는 모든 과제가 보입니다)</div>' : '')
      + '<form id="meeting-form"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">회의명</label><input type="text" class="form-control" name="title" required placeholder="예: 과제 목표 달성을 위한 논의"></div>'
      + '<div class="col-sm-6"><label class="form-label required">회의 일시 <span class="form-label-description">결제 시각</span></label><input type="datetime-local" class="form-control" name="heldAt" required value="' + esc(toLocalInput(c.heldAt)) + '"></div>'
      + '<div class="col-sm-6"><label class="form-label required">회의 장소</label><input type="text" class="form-control" name="place" required placeholder="예: 미래융합소자동 2301호"></div>'
      + '<div class="col-sm-4"><label class="form-label required">사용 카드</label><select class="form-select" name="payment">' + PAY_CHOICES.map(function (k) { return '<option value="' + k + '"' + (k === 'shinhan' ? ' selected' : '') + '>' + PAY[k] + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-sm-8"><label class="form-label required">과제 <span class="form-label-description">참여과제 시트 기준</span></label><select class="form-select" name="projectId" required>' + claimProjectOptions() + '</select></div>'
      + '<div class="col-sm-4"><label class="form-label required">사용 금액 (원)</label><input type="number" class="form-control tnum" name="amount" min="0" step="1" required value="' + (c.amount ? esc(c.amount) : '') + '" placeholder="0"></div>'
      + '<div class="col-sm-8"><label class="form-label">비고 <span class="form-label-description">영수증 번호, 특이사항</span></label><input type="text" class="form-control" name="note"></div>'
      + '<div class="col-12"><label class="form-label required">참석자 <span class="form-label-description">1인당 ' + won(MCFG.perPersonMax) + ' 이하 · 과제 참여자만</span></label><div id="attendee-block">' + attendeeBlockHtml() + '</div></div>'
      + '<div class="col-12"><label class="form-label required">회의 내용 · 안건</label><textarea class="form-control" name="purpose" rows="2" required placeholder="예: 3차원 적층형 CFET 개발 논의"></textarea></div>'
      + '</div><div class="d-flex justify-content-end align-items-center mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-send me-1"></i>청구하고 회의록 작성</button></div></form>'
      + '</div><div class="col-lg-5"><h3 class="card-title mb-2"><i class="ti ti-user-check me-1 text-primary"></i>내 최근 청구</h3>';
    var mine = meetings().filter(isMine).slice(0, 6);
    if (!mine.length) body += '<div class="text-secondary small">아직 청구가 없습니다.</div>';
    else body += '<div class="list-group list-group-flush">' + mine.map(function (r) {
      var st = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
      return '<div class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2"><div class="text-truncate"><span class="text-secondary small me-2">' + fmtDate(r.meta.heldAt || r.createdAt) + '</span>' + esc(r.meta.title || r.item) + '</div><div class="text-nowrap"><span class="tnum me-2">' + won(r.amount) + '</span>' + (r.status === 'done' ? reportBadge(r) : '<span class="badge ' + st.cls + '">' + st.label + '</span>') + '</div></div>';
    }).join('') + '</div>';
    body += '<h3 class="card-title mt-4 mb-2"><i class="ti ti-info-circle me-1 text-primary"></i>규칙</h3><ul class="text-secondary small mb-0 ps-3">'
      + '<li>회의비는 <strong>1인당 ' + won(MCFG.perPersonMax) + '</strong>을 넘을 수 없습니다. 금액을 적으면 필요한 최소 인원이 보이고, 자동 추가가 시트 순서대로 참석자를 채웁니다.</li>'
      + '<li>참석자는 고른 과제의 <strong>참여연구원</strong>(참여과제 시트, 회의 월 기준)만 배정할 수 있습니다. 시트에 없는 사람은 기타 참석자로 적히며 인원수에는 들어갑니다.</li>'
      + '<li>제출 즉시 과제 회의비에서 차감되고, 회의록(회의일자·결제시간·회의명·회의내용·장소·인원·참석자·계정·금액 + 영수증)을 작성해 DOCX로 내려받습니다.</li>'
      + '<li>' + (state.importInfo ? '시트: ' + esc(state.importInfo.source) + (state.importInfo.months && state.importInfo.months.length ? ' (' + esc(state.importInfo.months[0]) + ' ~ ' + esc(state.importInfo.months[state.importInfo.months.length - 1]) + ')' : '') : '아직 가져온 참여과제 시트가 없습니다.') + '</li></ul>'
      + '</div></div></div>';
    return { body: body };
  }

  function refreshAttendeeBlock() {
    var box = $('#attendee-block'); if (box) box.innerHTML = attendeeBlockHtml();
  }

  function autoAdd() {
    var c = state.claim, p = c.projectId ? projectById(c.projectId) : null;
    if (!p) { toast('과제를 먼저 고르세요.', true); return; }
    if (!(Number(c.amount) > 0)) { toast('사용 금액을 먼저 적으세요.', true); return; }
    var mk = monthKey(c.heldAt);
    var names = eligibleNames(p, mk);
    var me = nameKey(state.session.user.name);
    names.sort(function (a, b) { return (nameKey(a) === me ? -1 : 0) - (nameKey(b) === me ? -1 : 0); });
    var need = minPeople(c.amount), added = 0;
    for (var i = 0; i < names.length && claimTotal() < need; i++) {
      if (c.attendees.indexOf(names[i]) >= 0) continue;
      c.attendees.push(names[i]); added++;
    }
    refreshAttendeeBlock();
    if (claimTotal() < need) toast('참여자 ' + names.length + '명으로는 1인당 ' + won(MCFG.perPersonMax) + ' 한도를 못 맞춥니다 (' + need + '명 필요). 금액을 나누거나 기타 참석자를 적으세요.', true);
    else toast(added ? added + '명을 자동으로 추가했습니다 (총 ' + claimTotal() + '명, 1인당 ' + won(perHead()) + ').' : '이미 인원이 충분합니다 (' + claimTotal() + '명).');
  }

  /* ---------- 청구 내역 탭 ---------- */
  function row(r, admin) {
    var st = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
    var p = r.projectId ? projectById(r.projectId) : null;
    var m = r.meta || {};
    var own = isMine(r);
    var html = '<tr data-id="' + esc(r.id) + '"><td class="text-nowrap text-secondary">' + fmtDate(m.heldAt || r.createdAt) + '</td><td class="text-nowrap">' + esc(r.requesterName) + '</td>'
      + '<td><div class="fw-medium">' + esc(m.title || r.item) + '</div><div class="small text-secondary">' + esc(m.place || '') + (m.attendees ? ' · ' + (m.attendeeCount || attendeeCount(m.attendees)) + '명' : '') + (m.payment ? ' · ' + esc(PAY[m.payment] || m.payment) : '') + '</div>'
      + (r.status === 'rejected' && r.adminNote ? '<div class="small text-danger">반려 사유: ' + esc(r.adminNote) + '</div>' : '') + '</td>'
      + '<td class="text-end tnum text-nowrap fw-medium">' + won(r.amount) + (m.attendeeCount ? '<div class="small text-secondary fw-normal">1인 ' + won(r.amount / m.attendeeCount) + '</div>' : '') + '</td>';
    if (admin && r.status === 'pending') {
      var cat = normCat(r.category);
      var suggested = m.suggestedProjectId && projectById(m.suggestedProjectId) ? m.suggestedProjectId : '';
      html += '<td><span class="badge ' + st.cls + '">' + st.label + '</span>' + (suggested ? '<div class="small text-secondary">청구자 지정 과제</div>' : '') + '</td>'
        + '<td><div class="d-flex flex-wrap gap-1"><select class="form-select form-select-sm" data-role="assign-project">' + projectOptions(r.amount, cat, suggested) + '</select><select class="form-select form-select-sm" data-role="assign-cat" style="min-width:7rem">' + catOptions(cat) + '</select></div></td>'
        + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="detail" title="상세"><i class="ti ti-eye"></i></button> <button type="button" class="btn btn-sm btn-primary" data-action="assign">처리</button> <button type="button" class="btn btn-sm btn-outline-danger" data-action="reject">반려</button></td>';
    } else {
      html += '<td>' + (r.status === 'done' ? reportBadge(r) : '<span class="badge ' + st.cls + '">' + st.label + '</span>') + (r.processedAt ? '<div class="small text-secondary text-nowrap">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</div>' : '') + '</td>'
        + '<td>' + (p ? '<div>' + esc(p.alias || p.name) + '</div><div class="small text-secondary">' + esc(p.code || '') + (p.code ? ' · ' : '') + esc(catLabel(normCat(r.category))) + '</div>' : (m.suggestedProjectId && projectById(m.suggestedProjectId) ? '<span class="text-secondary small">청구 과제: ' + esc(projectById(m.suggestedProjectId).name) + '</span>' : '<span class="text-secondary">-</span>')) + '</td>'
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
    var body = '<div class="card-body py-2 border-bottom d-flex flex-wrap align-items-center gap-2"><div class="btn-group">' + chip('all', '전체') + chip('done', '처리') + chip('pending', '미처리') + chip('rejected', '반려') + '</div>'
      + '<span class="small text-secondary">' + (admin ? '전체 청구' : '내 청구') + ' ' + list.length + '건 · 합계 ' + won(list.reduce(function (s, r) { return s + r.amount; }, 0)) + '</span>'
      + '<button type="button" class="btn btn-sm ms-auto" data-action="export-csv"' + (list.length ? '' : ' disabled') + '><i class="ti ti-file-spreadsheet me-1"></i>CSV</button></div>';
    if (!list.length) body += '<div class="card-body">' + empty('receipt-off', '청구 내역이 없습니다', '') + '</div>';
    else body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">회의일</th><th class="w-1">청구자</th><th>회의</th><th class="text-end">금액</th><th>상태 · 회의록</th><th>과제</th><th class="w-1"></th></tr></thead><tbody>' + list.map(function (r) { return row(r, admin); }).join('') + '</tbody></table></div>';
    return { body: body };
  }

  /* ---------- 관리자 탭 ---------- */
  function monthsSummary(part) {
    var m = part.months || {}; var off = Object.keys(m).filter(function (k) { return !m[k]; });
    if (!Object.keys(m).length) return '';
    if (off.length === Object.keys(m).length) return ' <span class="badge bg-red-lt">전 기간 미참여</span>';
    return off.length ? ' <span class="text-secondary small">(' + off.map(function (k) { return k.slice(5).replace(/^0/, '') + '월 ×'; }).join(', ') + ')</span>' : '';
  }

  function renderAdminTab() {
    if (!isAdminActive()) return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 열립니다.') + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    var pending = meetings().filter(function (r) { return r.status === 'pending'; });
    var info = state.importInfo;
    var sheetProjects = state.projects.filter(function (p) { return p.alias || hasSheet(p); });
    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom"><div class="text-secondary small"><i class="ti ti-lock-open me-1"></i>관리자 모드 · 회의비는 청구 즉시 처리되므로 여기서는 참여과제 시트 관리와 이전 방식 청구(미처리)만 다룹니다.</div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div>';
    body += '<div class="card-body border-bottom"><div class="d-flex flex-wrap justify-content-between align-items-start gap-2 mb-2"><div><h3 class="card-title mb-1"><i class="ti ti-table me-1 text-primary"></i>참여과제 시트</h3>'
      + '<div class="small text-secondary">' + (info ? '가져온 파일 <strong>' + esc(info.source) + '</strong>' + (info.importedAt ? ' · ' + fmtDateTime(info.importedAt) + (info.importedBy ? ' · ' + esc(info.importedBy) : '') : '') + ' · ' + info.rows + '행 · 과제 ' + info.projects + '개' + (info.months && info.months.length ? ' · ' + esc(info.months[0]) + ' ~ ' + esc(info.months[info.months.length - 1]) : '') : '아직 가져온 시트가 없습니다.') + '</div></div>'
      + '<label class="btn btn-sm btn-primary mb-0"><i class="ti ti-upload me-1"></i>엑셀 가져오기<input type="file" accept=".xlsx,.xlsm,.xls" hidden data-action="import-sheet"></label></div>'
      + '<div class="small text-secondary mb-2">엑셀 1행에 9월·10월… 같은 월 제목, B열 성명, C열 참여과제(약칭). 회색 칸은 미참여로 읽습니다. 파일 이름의 날짜(예: 260827)로 연도를 정합니다. 가져오면 같은 약칭의 과제에 참여자 목록을 덮어쓰고, 없는 과제는 새로 만듭니다.</div>';
    if (!sheetProjects.length) body += empty('table-off', '참여과제 정보가 없습니다', '엑셀을 가져오면 과제별 참여자가 여기에 나옵니다.');
    else body += '<div class="table-responsive"><table class="table table-sm table-vcenter card-table"><thead><tr><th class="w-1">약칭</th><th class="w-1">과제번호(계정)</th><th>참여자</th><th class="w-1 text-end">인원</th></tr></thead><tbody>'
      + sheetProjects.map(function (p) { return '<tr data-project="' + esc(p.id) + '"><td class="fw-medium text-nowrap">' + esc(p.alias || p.name) + (p.name !== (p.alias || p.name) ? '<div class="small text-secondary fw-normal">' + esc(p.name) + '</div>' : '') + '</td><td class="text-nowrap"><div class="input-group input-group-sm" style="min-width:12rem"><input type="text" class="form-control" data-role="proj-code" value="' + esc(p.code || '') + '" placeholder="N01261349"><button type="button" class="btn" data-action="save-code" title="과제번호 저장"><i class="ti ti-device-floppy"></i></button></div>' + (!p.code ? '<div class="text-warning small">미입력 · 회의록 계정란에 들어갑니다</div>' : '') + '</td><td class="small">' + (p.participants || []).map(function (x) { return esc(x.name) + monthsSummary(x); }).join(', ') + '</td><td class="text-end tnum">' + (p.participants || []).length + '</td></tr>'; }).join('')
      + '</tbody></table></div>';
    body += '</div>';
    body += '<div class="card-body"><h3 class="card-title mb-2"><i class="ti ti-hourglass me-1 text-primary"></i>미처리 회의비 (이전 방식)</h3>';
    if (!pending.length) body += '<div class="text-secondary small">미처리 회의비가 없습니다.</div></div>';
    else body += '</div><div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">회의일</th><th class="w-1">청구자</th><th>회의</th><th class="text-end">금액</th><th>상태</th><th>배정</th><th class="w-1"></th></tr></thead><tbody>' + pending.map(function (r) { return row(r, true); }).join('') + '</tbody></table></div>';
    return { body: body };
  }

  /* 엑셀(참여과제 시트) → payload. SheetJS 가 필요하며 셀 채우기(회색 = 미참여)를 읽으려고 cellStyles 를 켭니다. */
  function parseSheet(file) {
    return new Promise(function (resolve, reject) {
      if (!window.XLSX) { reject(new Error('엑셀 읽기 라이브러리를 불러오지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요.')); return; }
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellStyles: true });
          var sheetName = wb.SheetNames.indexOf('참여과제') >= 0 ? '참여과제' : wb.SheetNames[0];
          var ws = wb.Sheets[sheetName];
          var range = XLSX.utils.decode_range(ws['!ref']);
          var dm = /(\d{2})(\d{2})(\d{2})/.exec(file.name); var baseYear = dm ? 2000 + Number(dm[1]) : new Date().getFullYear(); var baseMonth = dm ? Number(dm[2]) : new Date().getMonth() + 1;
          var monthCols = [];
          for (var c = range.s.c; c <= range.e.c; c++) {
            var h = ws[XLSX.utils.encode_cell({ r: range.s.r, c: c })];
            var v = h && h.v !== undefined ? String(h.v) : '';
            var mm = /^\s*(\d{1,2})월\s*$/.exec(v);
            if (mm) { var mo = Number(mm[1]); monthCols.push({ c: c, key: (mo >= baseMonth ? baseYear : baseYear + 1) + '-' + pad2(mo) }); }
          }
          var rows = [], cur = '';
          for (var r = range.s.r + 1; r <= range.e.r; r++) {
            var nameCell = ws[XLSX.utils.encode_cell({ r: r, c: 1 })], projCell = ws[XLSX.utils.encode_cell({ r: r, c: 2 })];
            if (nameCell && nameCell.v !== undefined && String(nameCell.v).trim()) cur = String(nameCell.v).trim();
            var proj = projCell && projCell.v !== undefined ? String(projCell.v).trim() : '';
            if (!proj || !cur) continue;
            var months = {};
            monthCols.forEach(function (mc) {
              var cell = ws[XLSX.utils.encode_cell({ r: r, c: mc.c })];
              var on = true;
              var s = cell && cell.s; var fg = s && (s.fgColor || (s.fill && s.fill.fgColor));
              if (fg) {
                if (fg.theme === 0 && Number(fg.tint || 0) < 0) on = false;                                    /* 흰색 계열의 어두운 톤 = 회색 */
                else if (fg.rgb) { var rgb = String(fg.rgb).toUpperCase().slice(-6); var g = /^([0-9A-F]{2})\1\1$/.test(rgb); if (g && parseInt(rgb.slice(0, 2), 16) < 0xC8) on = false; }
              }
              months[mc.key] = on;
            });
            rows.push({ name: cur, project: proj, months: months });
          }
          if (!rows.length) throw new Error('시트에서 성명·참여과제 행을 찾지 못했습니다 (B열 성명, C열 과제).');
          resolve({ source: file.name, sheet: sheetName, months: monthCols.map(function (m) { return m.key; }), rows: rows });
        } catch (e) { reject(e); }
      };
      fr.onerror = function () { reject(new Error('파일을 읽을 수 없습니다.')); };
      fr.readAsArrayBuffer(file);
    });
  }

  function showDetail(id) {
    var r = state.requests.filter(function (x) { return x.id === id; })[0]; if (!r) return Promise.resolve();
    var m = r.meta || {}; var p = r.projectId ? projectById(r.projectId) : null; var st = STATUS[r.status] || { label: r.status, cls: '' };
    var n = m.attendeeCount || attendeeCount(m.attendees);
    var html = '<div class="datagrid mb-3">' + dg('회의명', esc(m.title || r.item)) + dg('회의 일시', esc(fmtDateTime(m.heldAt || r.createdAt))) + dg('장소', esc(m.place || '-')) + dg('청구자', esc(r.requesterName) + ' <span class="text-secondary small">· ' + fmtDate(r.createdAt) + '</span>')
      + dg('금액', '<span class="tnum">' + won(r.amount) + '</span>' + (n ? ' <span class="text-secondary small">(' + n + '명 · 1인 ' + won(r.amount / n) + ')</span>' : '')) + dg('사용 카드', esc(PAY[m.payment] || m.payment || '-'))
      + dg('상태', (r.status === 'done' ? reportBadge(r) : '<span class="badge ' + st.cls + '">' + st.label + '</span>') + (r.processedAt ? ' <span class="text-secondary small">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</span>' : ''))
      + (p ? dg('과제', esc(p.alias || p.name) + ' <span class="text-secondary small">' + esc(p.code || '') + ' · ' + esc(catLabel(normCat(r.category))) + '</span>') : '') + '</div>'
      + '<div class="mb-3"><div class="subheader">참석자</div><div>' + esc(m.attendees || '-') + (m.others ? ' <span class="text-secondary">(기타: ' + esc(m.others) + ')</span>' : '') + '</div></div>'
      + '<div class="mb-3"><div class="subheader">회의 내용 · 안건</div><div style="white-space:pre-wrap">' + esc(m.purpose || '-') + '</div></div>'
      + (r.note ? '<div class="mb-3"><div class="subheader">비고</div><div>' + esc(r.note) + '</div></div>' : '')
      + (r.adminNote ? '<div class="alert alert-' + (r.status === 'rejected' ? 'danger' : 'info') + ' py-2 mb-0"><div class="small fw-medium">관리자 메모</div>' + esc(r.adminNote) + '</div>' : '');
    return dialog({ title: '회의비 상세', html: html, size: 'lg', okLabel: '닫기', hideCancel: true });
  }

  function exportCsv() {
    var admin = isAdminActive();
    var list = meetings().filter(function (r) { return (admin || isMine(r)) && (state.filter === 'all' || r.status === state.filter); });
    var head = ['회의일시', '회의명', '장소', '참석자', '인원', '금액', '1인당', '사용 카드', '청구자', '상태', '회의록', '과제', '과제번호', '비목', '처리일', '처리자', '내용', '비고'];
    var lines = list.map(function (r) { var m = r.meta || {}; var p = r.projectId ? projectById(r.projectId) : null; var n = m.attendeeCount || attendeeCount(m.attendees);
      return [fmtDateTime(m.heldAt || r.createdAt), m.title || r.item, m.place || '', m.attendees || '', n, r.amount, n ? Math.round(r.amount / n) : '', PAY[m.payment] || m.payment || '', r.requesterName, (STATUS[r.status] || {}).label || r.status, r.report ? (RSTATUS[r.report.status] || {}).label || r.report.status : (r.status === 'done' ? '미작성' : ''), p ? (p.alias || p.name) : '', p ? p.code : '', catLabel(normCat(r.category)), localDate(r.processedAt), r.processedBy || '', m.purpose || '', r.note].map(csvCell).join(','); });
    download('dsil-meeting-' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + head.join(',') + '\r\n' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ---------- actions ---------- */
  function handleError(err) { console.error(err); toast(err && err.message ? err.message : String(err), true); }
  function refresh() { return reload().then(render).catch(handleError); }

  document.addEventListener('input', function (e) {
    var f = e.target.closest('#meeting-form'); if (!f) return;
    if (e.target.name === 'amount') { state.claim.amount = Math.max(0, Math.round(Number(e.target.value) || 0)); var ph = $('#per-head'); if (ph) { var total = claimTotal(), need = minPeople(state.claim.amount), over = total && perHead() > MCFG.perPersonMax; ph.className = 'small ms-auto ' + (over ? 'text-danger fw-medium' : 'text-secondary'); ph.textContent = total ? total + '명 · 1인당 ' + won(perHead()) + (over ? ' · 한도 초과 → ' + need + '명 이상 필요' : '') : (state.claim.amount > 0 ? won(state.claim.amount) + ' → 최소 ' + need + '명' : ''); } }
    if (e.target.name === 'others') { state.claim.others = e.target.value; var chips = $('#attendee-chips'); if (chips) { var ph2 = $('#per-head'); if (ph2) ph2.textContent = claimTotal() ? claimTotal() + '명 · 1인당 ' + won(perHead()) : ''; } }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.name === 'projectId' && el.closest('#meeting-form')) {
      state.claim.projectId = el.value;
      var p = el.value ? projectById(el.value) : null; var mk = monthKey(state.claim.heldAt);
      var ok = p ? eligibleNames(p, mk) : [];
      var dropped = state.claim.attendees.filter(function (n) { return ok.indexOf(n) < 0; });
      state.claim.attendees = state.claim.attendees.filter(function (n) { return ok.indexOf(n) >= 0; });
      if (dropped.length) toast('이 과제 참여자가 아니어서 뺐습니다: ' + dropped.join(', '), true);
      refreshAttendeeBlock();
      return;
    }
    if (el.name === 'heldAt' && el.closest('#meeting-form')) {
      var d = new Date(el.value); if (!isNaN(d)) state.claim.heldAt = d.toISOString();
      var sel = el.form.projectId; if (sel) sel.innerHTML = claimProjectOptions();
      refreshAttendeeBlock();
      return;
    }
    if (el.id === 'attendee-select') {
      if (el.value && state.claim.attendees.indexOf(el.value) < 0) state.claim.attendees.push(el.value);
      refreshAttendeeBlock();
      return;
    }
    if (el.getAttribute('data-action') === 'import-sheet') {
      var file = el.files && el.files[0]; if (!file) return;
      toast('시트를 읽는 중…');
      parseSheet(file).then(function (payload) {
        return confirmDlg({ title: '참여과제 시트 가져오기', message: payload.source + ': ' + payload.rows.length + '행, 과제 ' + Object.keys(payload.rows.reduce(function (o, r) { o[r.project] = 1; return o; }, {})).length + '개' + (payload.months.length ? ', ' + payload.months[0] + ' ~ ' + payload.months[payload.months.length - 1] : '') + '. 같은 약칭의 과제 참여자 목록을 덮어씁니다.', okLabel: '가져오기' }).then(function (ok) { if (!ok) return; return store.importParticipation(payload).then(function (info) { toast('가져왔습니다: 과제 ' + info.projects + '개 (새로 ' + info.created + ', 갱신 ' + info.updated + ')'); touchUnlock(); return refresh(); }); });
      }).catch(handleError);
      el.value = '';
      return;
    }
    if (el.getAttribute('data-role') === 'assign-cat') {
      var tr = el.closest('tr[data-id]'); var sel2 = tr && tr.querySelector('select[data-role="assign-project"]');
      var req = tr && state.requests.filter(function (x) { return x.id === tr.getAttribute('data-id'); })[0];
      if (sel2 && req) sel2.innerHTML = projectOptions(req.amount, normCat(el.value), sel2.value);
    }
  });

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id !== 'meeting-form') return;
    e.preventDefault();
    var v = readForm(form);
    var c = state.claim;
    var amount = Math.max(0, Math.round(Number(v.amount) || 0)); c.amount = amount; c.others = v.others || '';
    var heldAt = new Date(v.heldAt); if (isNaN(heldAt)) { toast('회의 일시를 입력하세요.', true); return; }
    c.heldAt = heldAt.toISOString();
    var p = v.projectId ? projectById(v.projectId) : null;
    if (!v.title.trim()) { toast('회의명을 입력하세요.', true); return; }
    if (!p) { toast('과제를 선택하세요.', true); return; }
    if (amount <= 0) { toast('사용 금액을 입력하세요.', true); return; }
    var mk = monthKey(c.heldAt); var ok = eligibleNames(p, mk);
    var bad = c.attendees.filter(function (n) { return ok.indexOf(n) < 0; });
    if (bad.length) { toast('이 과제 참여자가 아닙니다: ' + bad.join(', '), true); return; }
    var others = splitNames(c.others);
    var names = c.attendees.concat(others);
    if (!names.length) { toast('참석자를 배정하세요. 자동 추가를 누르면 금액에 맞춰 채워집니다.', true); return; }
    var need = minPeople(amount);
    if (amount / names.length > MCFG.perPersonMax) { toast('1인당 ' + won(amount / names.length) + '으로 한도 ' + won(MCFG.perPersonMax) + '을 넘습니다. ' + need + '명 이상 배정하세요 (자동 추가).', true); return; }
    var cat = normCat(DEFAULT_CAT);
    var remain = remainOf(p, cat);
    var warn = (isAdminActive() && amount > remain) ? confirmDlg({ title: '회의비 예산 초과', message: (p.alias || p.name) + ' 의 회의비 잔액은 ' + won(remain) + '입니다. 그래도 처리할까요?', okLabel: '처리', danger: true }) : Promise.resolve(true);
    warn.then(function (go) {
      if (!go) return;
      var now = new Date().toISOString();
      return store.createRequest({
        kind: 'meeting', item: '회의비 · ' + v.title.trim(), category: cat, link: '', qty: 1, unitPrice: amount, amount: amount, note: (v.note || '').trim(),
        status: 'done', projectId: p.id, processedAt: now, processedBy: MCFG.autoProcessedBy,
        meta: { title: v.title.trim(), heldAt: c.heldAt, place: v.place.trim(), attendees: names.join(', '), attendeeList: c.attendees.slice(), others: others.join(', '), attendeeCount: names.length, payment: v.payment, purpose: v.purpose.trim(), suggestedProjectId: p.id, auto: true }
      }).then(function (rec) {
        toast('회의비를 ' + (p.alias || p.name) + ' 과제로 처리했습니다. 회의록을 작성합니다.');
        state.claim = { projectId: '', heldAt: '', amount: 0, attendees: [], others: '' };
        window.location.href = '../report/index.html#id=' + encodeURIComponent(rec.id);
      });
    }).catch(handleError);
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
      case 'auto-add': { var f = $('#meeting-form'); if (f) { state.claim.amount = Math.max(0, Math.round(Number(f.amount.value) || 0)); state.claim.projectId = f.projectId.value; var d = new Date(f.heldAt.value); if (!isNaN(d)) state.claim.heldAt = d.toISOString(); state.claim.others = f.others ? f.others.value : ''; } autoAdd(); break; }
      case 'remove-attendee': state.claim.attendees = state.claim.attendees.filter(function (n) { return n !== btn.getAttribute('data-name'); }); refreshAttendeeBlock(); break;
      case 'save-code': {
        var prow = btn.closest('tr[data-project]'); var proj0 = prow && projectById(prow.getAttribute('data-project')); var inp = prow && prow.querySelector('[data-role="proj-code"]');
        if (!proj0 || !inp) return;
        var full = Object.assign({}, proj0, { code: inp.value.trim() });
        store.saveProject(full).then(function () { toast((full.alias || full.name) + ' 과제번호를 저장했습니다.'); touchUnlock(); return refresh(); }).catch(handleError);
        break;
      }
      case 'clear-attendees': state.claim.attendees = []; refreshAttendeeBlock(); break;
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
