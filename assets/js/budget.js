/* =====================================================================
   DSIL Lab Portal – 과제별 예산 관리 (UI, Tabler 컴포넌트 사용)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var CATS = (CFG.budgetCategories && CFG.budgetCategories.length) ? CFG.budgetCategories : [{ id: 'other', label: '기타' }];
  var CAT_IDS = CATS.map(function (c) { return c.id; });
  var store = window.DSILStore.create(CFG);
  var UNLOCK_KEY = 'dsil-budget-admin-unlock';
  var TABS = ['requests', 'budget', 'admin'];

  var STATUS = {
    pending: { label: '미처리', cls: 'bg-yellow-lt' },
    done: { label: '처리', cls: 'bg-blue-lt' },
    rejected: { label: '반려', cls: 'bg-red-lt' }
  };

  var state = {
    ready: false,
    error: null,
    session: null,
    projects: [],
    requests: [],
    tab: 'requests',          // requests | budget | admin
    filter: 'all',            // all | pending | done | rejected
    onlyMine: false,
    editingProjectId: null,
    magicLinkSent: false,
    adminUnlocked: false
  };

  /* ---------- helpers ---------- */
  var nf = new Intl.NumberFormat('ko-KR');
  function won(n) { return nf.format(Math.round(Number(n) || 0)) + '원'; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
  }
  function $(sel, root) { return (root || document).querySelector(sel); }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'portal-toast alert ' + (isError ? 'alert-danger' : 'alert-success') + ' is-visible';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 2600);
  }

  /* Tabler 마크업의 소형 모달 – window.prompt/confirm 대체 */
  function dialog(opts) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      var inputHtml = '';
      if (opts.input === 'textarea') inputHtml = '<textarea class="form-control modal-input" rows="3" placeholder="' + esc(opts.placeholder || '') + '"></textarea>';
      else if (opts.input) inputHtml = '<input class="form-control modal-input" type="' + (opts.input === 'password' ? 'password' : 'text') + '" placeholder="' + esc(opts.placeholder || '') + '" autocomplete="off" inputmode="' + (opts.input === 'password' ? 'numeric' : 'text') + '">';
      wrap.innerHTML = '<div class="modal modal-blur fade show is-open" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="modal-title">'
        + '<div class="modal-dialog modal-sm modal-dialog-centered" role="document"><div class="modal-content">'
        + '<div class="modal-header"><h5 class="modal-title" id="modal-title">' + esc(opts.title || '') + '</h5><button type="button" class="btn-close" data-modal="cancel" aria-label="닫기"></button></div>'
        + '<div class="modal-body">' + (opts.message ? '<p class="mb-' + (inputHtml ? '2' : '0') + '">' + esc(opts.message) + '</p>' : '') + inputHtml + '</div>'
        + '<div class="modal-footer"><button type="button" class="btn btn-link link-secondary" data-modal="cancel">취소</button>'
        + '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + ' ms-auto" data-modal="ok">' + esc(opts.okLabel || '확인') + '</button></div>'
        + '</div></div></div><div class="modal-backdrop fade show"></div>';
      document.body.appendChild(wrap);
      var input = wrap.querySelector('.modal-input');
      (input || wrap.querySelector('[data-modal="ok"]')).focus();
      function close(val) { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(val); }
      function ok() { close(input ? input.value : true); }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && input && input.tagName !== 'TEXTAREA') { e.preventDefault(); ok(); }
      }
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', function (e) {
        var b = e.target.closest('[data-modal]');
        if (b) { if (b.getAttribute('data-modal') === 'ok') ok(); else close(null); return; }
        if (e.target.classList.contains('modal')) close(null);
      });
    });
  }
  function confirmDlg(opts) { return dialog(opts).then(function (v) { return v === true; }); }
  function promptDlg(opts) { return dialog(opts); }

  /* ---------- 비목 ---------- */
  function catLabel(id) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i].label;
    return id || '-';
  }
  function normCat(id) { return CAT_IDS.indexOf(id) >= 0 ? id : CAT_IDS[0]; }
  function budgetOf(p, cat) { return Number(p.budgets && p.budgets[cat]) || 0; }
  function catOptions(selected) {
    return CATS.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.label) + '</option>';
    }).join('');
  }

  /* ---------- 관리자 잠금 ---------- */
  function unlockMinutes() { return Number(CFG.adminUnlockMinutes) > 0 ? Number(CFG.adminUnlockMinutes) : 10; }
  function readUnlock() {
    try {
      var t = Number(sessionStorage.getItem(UNLOCK_KEY) || 0);
      return t > 0 && (Date.now() - t) < unlockMinutes() * 60000;
    } catch (e) { return false; }
  }
  function setUnlock(on) {
    try { if (on) sessionStorage.setItem(UNLOCK_KEY, String(Date.now())); else sessionStorage.removeItem(UNLOCK_KEY); } catch (e) { /* ignore */ }
    state.adminUnlocked = on;
  }
  function isAdminEligible() { return !!(state.session && state.session.isAdmin); }
  function isAdminActive() { return isAdminEligible() && state.adminUnlocked; }

  function enterAdmin() {
    if (!isAdminEligible()) { toast('관리자 권한이 없습니다.', true); return; }
    if (readUnlock()) { setUnlock(true); state.tab = 'admin'; render(); return; }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요. 확인 후 ' + unlockMinutes() + '분 동안 관리자 화면이 열립니다.', input: 'password', placeholder: 'PIN', okLabel: '열기' })
      .then(function (pin) {
        if (pin === null) return;
        return store.verifyAdminPin(pin).then(function (ok) {
          if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; }
          setUnlock(true);
          state.tab = 'admin';
          toast('관리자 화면을 열었습니다.');
          render();
        });
      }).catch(handleError);
  }

  /* ---------- 집계 ---------- */
  function projectById(id) {
    for (var i = 0; i < state.projects.length; i++) if (state.projects[i].id === id) return state.projects[i];
    return null;
  }

  /* 과제별·비목별 집계: 처리(done)된 구매건만 예산에서 차감 */
  function projectStats(p) {
    var byCat = {};
    CAT_IDS.forEach(function (c) { byCat[c] = { budget: budgetOf(p, c), used: 0, count: 0 }; });
    state.requests.forEach(function (r) {
      if (r.status !== 'done' || r.projectId !== p.id) return;
      var b = byCat[normCat(r.category)];
      b.used += Number(r.amount) || 0;
      b.count++;
    });
    var total = 0, used = 0, count = 0;
    CAT_IDS.forEach(function (c) {
      var b = byCat[c];
      b.remain = b.budget - b.used;
      b.ratio = b.budget > 0 ? b.used / b.budget : (b.used > 0 ? 1 : 0);
      total += b.budget; used += b.used; count += b.count;
    });
    return { total: total, used: used, remain: total - used, ratio: total > 0 ? used / total : (used > 0 ? 1 : 0), count: count, byCat: byCat };
  }

  function summary() {
    var s = { pendingCount: 0, pendingAmount: 0, doneCount: 0, doneAmount: 0, activeProjects: 0, totalBudget: 0, totalRemain: 0 };
    state.requests.forEach(function (r) {
      if (r.status === 'pending') { s.pendingCount++; s.pendingAmount += Number(r.amount) || 0; }
      if (r.status === 'done') { s.doneCount++; s.doneAmount += Number(r.amount) || 0; }
    });
    state.projects.forEach(function (p) {
      if (p.active === false) return;
      var st = projectStats(p);
      s.activeProjects++;
      s.totalBudget += st.total;
      s.totalRemain += st.remain;
    });
    return s;
  }

  function barClass(ratio) {
    if (ratio >= 1) return 'bg-red';
    if (ratio >= (Number(CFG.warnRatio) || 0.8)) return 'bg-yellow';
    return 'bg-primary';
  }

  /* ---------- data ---------- */
  function reload() {
    return Promise.all([store.listProjects(), store.listRequests()]).then(function (res) {
      state.projects = res[0];
      state.requests = res[1].slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      state.session = store.getSession();
      state.adminUnlocked = readUnlock();
      if (state.tab === 'admin' && !isAdminActive()) state.tab = 'requests';
    });
  }

  /* ---------- render ---------- */
  function render() {
    state.adminUnlocked = readUnlock();
    renderUserChip();
    renderPageActions();
    var app = $('#app');
    if (!app) return;

    if (state.error) {
      app.innerHTML = '<div class="alert alert-danger"><h4 class="alert-title">초기화 오류</h4><div class="text-secondary">' + esc(state.error) + '</div></div>';
      return;
    }
    if (!state.ready) { app.innerHTML = '<div class="text-secondary text-center py-5">불러오는 중…</div>'; return; }
    if (!state.session) { app.innerHTML = renderLogin(); return; }

    var sum = summary();
    var html = '<div class="row row-deck row-cards mb-3">'
      + stat('미처리 구매건', sum.pendingCount + '건', won(sum.pendingAmount) + ' 대기 중', 'text-yellow')
      + stat('처리 완료', sum.doneCount + '건', won(sum.doneAmount) + ' 집행', 'text-primary')
      + stat('진행 중 과제', sum.activeProjects + '개', '총 예산 ' + won(sum.totalBudget), '')
      + stat('잔여 예산 합계', won(sum.totalRemain), sum.totalBudget > 0 ? '사용률 ' + Math.round((1 - sum.totalRemain / sum.totalBudget) * 100) + '%' : '', '')
      + '</div>';

    var tab = state.tab === 'budget' ? renderBudgetTab() : state.tab === 'admin' ? renderAdminTab(sum) : renderRequestsTab();

    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('requests', 'shopping-cart', '구매 요청')
      + tabLink('budget', 'wallet', '과제 예산')
      + (isAdminEligible() ? tabLink('admin', state.adminUnlocked ? 'lock-open' : 'lock', '관리자', sum.pendingCount ? '<span class="badge bg-yellow-lt ms-2">' + sum.pendingCount + '</span>' : '') : '')
      + '</ul></div>' + tab.body + '</div>' + (tab.after || '');

    app.innerHTML = html;
    try { history.replaceState(null, '', '#' + state.tab); } catch (e) { /* 샌드박스 뷰어에서는 막힐 수 있음 */ }
  }

  function stat(label, value, sub, cls) {
    return '<div class="col-6 col-lg-3"><div class="card card-sm"><div class="card-body">'
      + '<div class="subheader">' + esc(label) + '</div>'
      + '<div class="h1 mb-1 tnum ' + (cls || '') + '">' + esc(value) + '</div>'
      + (sub ? '<div class="text-secondary small">' + esc(sub) + '</div>' : '') + '</div></div></div>';
  }

  function tabLink(id, icon, label, extra) {
    return '<li class="nav-item"><a href="#' + id + '" class="nav-link' + (state.tab === id ? ' active' : '') + '" data-action="tab" data-tab="' + id + '" role="tab">'
      + '<i class="ti ti-' + icon + ' me-1"></i>' + esc(label) + (extra || '') + '</a></li>';
  }

  function renderUserChip() {
    var slot = $('#user-slot');
    if (!slot) return;
    if (!state.session) { slot.innerHTML = ''; return; }
    var s = state.session;
    var initial = (s.user.name || '?').trim().charAt(0);
    var role = !s.isAdmin ? '구성원' : (state.adminUnlocked ? '관리자 · 열림' : '관리자 · 잠김');
    slot.innerHTML = '<div class="d-flex align-items-center gap-2">'
      + '<span class="avatar avatar-sm bg-blue-lt">' + esc(initial) + '</span>'
      + '<div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(s.user.name) + '</div><div class="small text-secondary mt-1">' + role + '</div></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="signout"><i class="ti ti-logout"></i><span class="d-none d-sm-inline ms-1">로그아웃</span></button></div>';
  }

  function renderPageActions() {
    var el = $('#page-actions');
    if (!el) return;
    if (!state.session) { el.innerHTML = ''; return; }
    el.innerHTML = '<div class="d-flex align-items-center gap-2">'
      + (store.mode === 'local' ? '<span class="badge bg-secondary-lt" title="이 브라우저에만 저장됩니다">로컬 저장 모드</span>' : '<span class="badge bg-blue-lt">공용 DB 연결됨</span>')
      + '<button type="button" class="btn btn-sm" data-action="refresh"><i class="ti ti-refresh me-1"></i>새로고침</button></div>';
  }

  function renderLogin() {
    var head = '<div class="container-tight py-4"><div class="card card-md"><div class="card-body">';
    var foot = '</div></div></div>';
    if (store.mode === 'supabase') {
      if (state.magicLinkSent) {
        return head + '<div class="empty"><div class="empty-icon"><i class="ti ti-mail"></i></div><p class="empty-title">메일을 확인하세요</p><p class="empty-subtitle text-secondary">입력한 주소로 로그인 링크를 보냈습니다. 링크를 누르면 이 페이지로 돌아옵니다.</p></div>' + foot;
      }
      return head + '<h2 class="h2 text-center mb-2">로그인</h2>'
        + '<p class="text-secondary text-center mb-4">이메일로 로그인 링크를 보내드립니다.</p>'
        + '<form id="login-form"><div class="mb-3"><label class="form-label required">이메일</label><input type="email" class="form-control" name="email" required placeholder="name@kaist.ac.kr" autocomplete="email"></div>'
        + '<div class="mb-3"><label class="form-label">이름 <span class="form-label-description">처음 로그인 시</span></label><input type="text" class="form-control" name="name" placeholder="홍길동" autocomplete="name"></div>'
        + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100">로그인 링크 보내기</button></div></form>' + foot;
    }
    return head + '<h2 class="h2 text-center mb-2">시작하기</h2>'
      + '<p class="text-secondary text-center mb-4">이름을 입력하면 구매 요청을 올리고 처리 상태를 볼 수 있습니다. 로컬 저장 모드에서는 이 브라우저에만 저장됩니다.</p>'
      + '<form id="login-form"><div class="mb-3"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required placeholder="홍길동" autocomplete="name"></div>'
      + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100">시작</button></div></form>'
      + '<div class="text-secondary small text-center mt-3"><i class="ti ti-lock me-1"></i>관리자 화면은 관리자 탭에서 PIN을 입력하면 열립니다.</div>' + foot;
  }

  /* ---------- 구매 요청 탭 ---------- */
  function renderRequestsTab() {
    var body = '<div class="card-body"><div class="row g-4">'
      + '<div class="col-lg-7">'
      + '<h3 class="card-title mb-3"><i class="ti ti-cart-plus me-1 text-primary"></i>구매 요청 올리기</h3>'
      + '<form id="request-form"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">품명</label><input type="text" class="form-control" name="item" required placeholder="예: 6인치 SiO2/Si 웨이퍼 25매"></div>'
      + '<div class="col-sm-5"><label class="form-label required">비목</label><select class="form-select" name="category">' + catOptions(CAT_IDS[0]) + '</select></div>'
      + '<div class="col-sm-7"><label class="form-label">구매처 / 링크</label><input type="url" class="form-control" name="link" placeholder="https://"></div>'
      + '<div class="col-4"><label class="form-label required">수량</label><input type="number" class="form-control" name="qty" min="1" step="1" value="1" required></div>'
      + '<div class="col-4"><label class="form-label required">단가 (원)</label><input type="number" class="form-control" name="unitPrice" min="0" step="1" required placeholder="0"></div>'
      + '<div class="col-4"><label class="form-label">합계</label><input type="text" class="form-control tnum" name="amountView" readonly value="0원"></div>'
      + '<div class="col-12"><label class="form-label">용도 / 메모</label><textarea class="form-control" name="note" rows="2" placeholder="어떤 실험에 쓰는지, 급한지 등"></textarea></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-send me-1"></i>요청 제출</button></div></form>'
      + '</div>'
      + '<div class="col-lg-5">'
      + '<h3 class="card-title mb-3"><i class="ti ti-route me-1 text-primary"></i>처리 흐름</h3>'
      + '<div class="list-group list-group-flush">'
      + step(1, '요청 제출', '품명·비목·수량·단가를 적어 제출합니다.')
      + step(2, '관리자 확인', '요청은 <span class="badge bg-yellow-lt">미처리</span> 상태로 관리자 화면에 모입니다.')
      + step(3, '과제 배정', '과제와 비목을 배정하면 <span class="badge bg-blue-lt">처리</span>로 바뀌고 해당 비목 잔액에서 차감됩니다.')
      + step(4, '반려', '집행이 어려우면 사유와 함께 <span class="badge bg-red-lt">반려</span>됩니다.')
      + '</div>'
      + '<div class="text-secondary small mt-3">현재 로그인: <strong>' + esc(state.session.user.name) + '</strong></div>'
      + '</div></div></div>';

    var list = state.requests.filter(function (r) {
      if (state.filter !== 'all' && r.status !== state.filter) return false;
      if (state.onlyMine && r.requesterId !== state.session.user.id) return false;
      return true;
    });

    var after = '<div class="card"><div class="card-header">'
      + '<h3 class="card-title"><i class="ti ti-list-details me-1 text-primary"></i>요청 현황</h3>'
      + '<div class="card-actions d-flex align-items-center flex-wrap gap-2">'
      + '<div class="btn-group" role="group">' + chip('all', '전체') + chip('pending', '미처리') + chip('done', '처리') + chip('rejected', '반려') + '</div>'
      + '<label class="form-check mb-0 ms-1"><input class="form-check-input" type="checkbox" data-action="toggle-mine"' + (state.onlyMine ? ' checked' : '') + '><span class="form-check-label">내 요청만</span></label>'
      + '</div></div>';
    if (!list.length) {
      after += '<div class="card-body">' + empty('inbox', '표시할 요청이 없습니다', '조건을 바꾸거나 새 요청을 올려 보세요.') + '</div>';
    } else {
      after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1">날짜</th><th class="w-1">신청자</th><th>품명</th><th class="text-end">금액</th><th>상태</th><th>배정 과제</th>'
        + (isAdminActive() ? '<th class="w-1"></th>' : '')
        + '</tr></thead><tbody>';
      list.forEach(function (r) { after += requestRow(r); });
      after += '</tbody></table></div>';
    }
    after += '</div>';
    return { body: body, after: after };
  }

  function step(n, title, desc) {
    return '<div class="list-group-item px-0 d-flex gap-3"><span class="avatar avatar-sm bg-blue-lt flex-shrink-0">' + n + '</span>'
      + '<div><div class="fw-medium">' + esc(title) + '</div><div class="text-secondary small">' + desc + '</div></div></div>';
  }

  function empty(icon, title, sub) {
    return '<div class="empty py-4"><div class="empty-icon"><i class="ti ti-' + icon + '"></i></div><p class="empty-title">' + esc(title) + '</p>'
      + (sub ? '<p class="empty-subtitle text-secondary">' + esc(sub) + '</p>' : '') + '</div>';
  }

  function chip(val, label) {
    return '<button type="button" class="btn btn-sm ' + (state.filter === val ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="filter" data-filter="' + val + '">' + label + '</button>';
  }

  function itemCell(r) {
    return '<div class="fw-medium">' + esc(r.item)
      + (r.link ? ' <a href="' + esc(r.link) + '" target="_blank" rel="noopener" class="text-secondary" title="링크 열기"><i class="ti ti-external-link"></i></a>' : '') + '</div>'
      + '<div class="small text-secondary"><span class="badge badge-outline text-primary me-1">' + esc(catLabel(r.category)) + '</span>' + esc(r.note || '') + '</div>'
      + (r.status === 'rejected' && r.adminNote ? '<div class="small text-danger">반려 사유: ' + esc(r.adminNote) + '</div>' : '');
  }

  function amountCell(r) {
    return '<td class="text-end text-nowrap"><div class="fw-medium tnum">' + won(r.amount) + '</div><div class="small text-secondary tnum">' + esc(r.qty) + ' × ' + won(r.unitPrice) + '</div></td>';
  }

  function requestRow(r) {
    var st = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
    var p = r.projectId ? projectById(r.projectId) : null;
    var html = '<tr data-id="' + esc(r.id) + '">'
      + '<td class="text-nowrap text-secondary">' + fmtDate(r.createdAt) + '</td>'
      + '<td class="text-nowrap">' + esc(r.requesterName) + '</td>'
      + '<td>' + itemCell(r) + '</td>'
      + amountCell(r)
      + '<td><span class="badge ' + st.cls + '">' + st.label + '</span>'
      + (r.processedAt ? '<div class="small text-secondary text-nowrap">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</div>' : '') + '</td>'
      + '<td>' + (p ? '<div>' + esc(p.name) + '</div><div class="small text-secondary">' + esc(p.code) + '</div>' : '<span class="text-secondary">-</span>') + '</td>';
    if (isAdminActive()) {
      html += '<td class="text-end text-nowrap">'
        + (r.status !== 'pending' ? '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="reopen" title="미처리로 되돌리기"><i class="ti ti-arrow-back-up"></i></button>' : '')
        + '<button type="button" class="btn btn-sm btn-ghost-danger" data-action="delete-request" title="삭제"><i class="ti ti-trash"></i></button></td>';
    }
    return html + '</tr>';
  }

  function projectOptions(amount, cat, selectedId) {
    var opts = '<option value="">과제 선택…</option>';
    state.projects.filter(function (p) { return p.active !== false; }).forEach(function (p) {
      var s = projectStats(p);
      var remain = s.byCat[cat] ? s.byCat[cat].remain : s.remain;
      var short = (Number(amount) || 0) > remain;
      var label = p.name.length > 22 ? p.name.slice(0, 22) + '…' : p.name;
      opts += '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + ' title="' + esc(p.name) + '">'
        + esc((p.code ? p.code + ' ' : '') + label) + ' · ' + esc(catLabel(cat)) + ' 잔액 ' + won(remain) + (short ? ' (부족)' : '') + '</option>';
    });
    return opts;
  }

  /* ---------- 과제 예산 탭 ---------- */
  function renderBudgetTab() {
    if (!state.projects.length) return { body: '<div class="card-body">' + empty('folder-off', '등록된 과제가 없습니다', '관리자 탭에서 과제를 추가하세요.') + '</div>' };
    var cards = '';
    state.projects.slice().sort(function (a, b) { return (a.active === false) - (b.active === false); }).forEach(function (p) {
      var s = projectStats(p);
      var items = state.requests.filter(function (r) { return r.status === 'done' && r.projectId === p.id; });
      var catRows = '';
      CAT_IDS.forEach(function (c) {
        var b = s.byCat[c];
        if (b.budget <= 0 && b.used <= 0) return;
        catRows += '<div class="cat-row"><div class="d-flex justify-content-between small mb-1"><span>' + esc(catLabel(c)) + '</span>'
          + '<span class="tnum"><span class="fw-medium">' + won(b.used) + '</span><span class="text-secondary"> / ' + won(b.budget) + '</span></span></div>'
          + '<div class="progress progress-xs"><div class="progress-bar ' + barClass(b.ratio) + '" style="width:' + Math.min(100, Math.round(b.ratio * 100)) + '%" role="progressbar" aria-valuenow="' + Math.round(b.ratio * 100) + '" aria-valuemin="0" aria-valuemax="100"></div></div></div>';
      });
      cards += '<div class="col-md-6 col-xl-4"><div class="card' + (p.active === false ? ' card-soon' : '') + '">'
        + '<div class="card-status-top ' + (p.active === false ? 'bg-secondary' : barClass(s.ratio)) + '"></div>'
        + '<div class="card-body">'
        + '<div class="d-flex justify-content-between align-items-start gap-2 mb-3"><div><h3 class="card-title mb-1">' + esc(p.name) + '</h3>'
        + '<div class="text-secondary small">' + esc(p.code) + (p.manager ? ' · ' + esc(p.manager) : '') + '<br>' + esc(p.startDate || '-') + ' ~ ' + esc(p.endDate || '-') + '</div></div>'
        + (p.active === false ? '<span class="badge bg-secondary-lt">종료</span>' : '<span class="badge bg-blue-lt">진행</span>') + '</div>'
        + '<div class="d-flex justify-content-between align-items-baseline mb-1"><span class="text-secondary small">총 예산 <span class="tnum">' + won(s.total) + '</span></span>'
        + '<span class="tnum' + (s.remain < 0 ? ' text-danger' : '') + '">잔액 <strong>' + won(s.remain) + '</strong></span></div>'
        + '<div class="progress progress-sm mb-3"><div class="progress-bar ' + barClass(s.ratio) + '" style="width:' + Math.min(100, Math.round(s.ratio * 100)) + '%"></div></div>'
        + catRows
        + (p.note ? '<div class="text-secondary small mt-3"><i class="ti ti-note me-1"></i>' + esc(p.note) + '</div>' : '')
        + '<details class="mt-3"><summary class="text-primary small">배정된 구매건 ' + items.length + '건</summary>'
        + (items.length ? '<ul class="list-unstyled small mt-2 mb-0">' + items.map(function (r) {
          return '<li class="d-flex justify-content-between gap-2 py-1 border-top"><span>' + fmtDate(r.processedAt || r.createdAt) + ' ' + esc(r.item) + ' <span class="text-secondary">(' + esc(r.requesterName) + ' · ' + esc(catLabel(r.category)) + ')</span></span><span class="tnum text-nowrap">' + won(r.amount) + '</span></li>';
        }).join('') + '</ul>' : '<div class="text-secondary small mt-2">아직 없음</div>')
        + '</details>'
        + '</div></div></div>';
    });
    return { body: '<div class="card-body"><div class="row row-cards">' + cards + '</div></div>' };
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab(sum) {
    if (!isAdminActive()) {
      return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 ' + unlockMinutes() + '분 동안 열립니다.')
        + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    }
    var pending = state.requests.filter(function (r) { return r.status === 'pending'; });
    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom">'
      + '<div class="text-secondary small"><i class="ti ti-lock-open me-1"></i>관리자 모드 · 과제와 비목을 고르고 <strong>처리</strong>를 누르면 해당 비목 잔액에서 차감됩니다.</div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div>';
    if (!pending.length) {
      body += '<div class="card-body">' + empty('checks', '미처리 요청이 없습니다', '새 요청이 올라오면 여기에 모입니다.') + '</div>';
    } else {
      body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1">날짜 / 신청자</th><th>품명</th><th class="text-end">금액</th><th>배정 과제</th><th class="w-1">비목</th><th class="w-1"></th>'
        + '</tr></thead><tbody>';
      pending.forEach(function (r) {
        var cat = normCat(r.category);
        body += '<tr data-id="' + esc(r.id) + '">'
          + '<td class="text-nowrap"><div>' + fmtDate(r.createdAt) + '</div><div class="small text-secondary">' + esc(r.requesterName) + '</div></td>'
          + '<td>' + itemCell(r) + '</td>'
          + amountCell(r)
          + '<td><select class="form-select form-select-sm" data-role="assign-project">' + projectOptions(r.amount, cat, '') + '</select></td>'
          + '<td><select class="form-select form-select-sm" data-role="assign-cat">' + catOptions(cat) + '</select></td>'
          + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-primary" data-action="assign">처리</button> '
          + '<button type="button" class="btn btn-sm btn-outline-danger" data-action="reject">반려</button></td>'
          + '</tr>';
      });
      body += '</tbody></table></div>';
    }

    var editing = state.editingProjectId ? projectById(state.editingProjectId) : null;
    var budgetInputs = CATS.map(function (c) {
      return '<div class="col-6 col-md-3"><label class="form-label">' + esc(c.label) + '</label><input type="number" class="form-control tnum" name="budget_' + esc(c.id) + '" min="0" step="1" value="' + (editing ? budgetOf(editing, c.id) : '') + '" placeholder="0"></div>';
    }).join('');

    var after = '<div class="row row-cards mb-3">'
      + '<div class="col-lg-5"><div class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-' + (editing ? 'edit' : 'folder-plus') + ' me-1 text-primary"></i>' + (editing ? '과제 수정' : '과제 추가') + '</h3>'
      + (editing ? '<div class="card-actions"><button type="button" class="btn btn-sm btn-ghost-secondary" data-action="cancel-edit">취소</button></div>' : '') + '</div>'
      + '<div class="card-body"><form id="project-form" data-id="' + esc(editing ? editing.id : '') + '"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">과제명</label><input type="text" class="form-control" name="name" required value="' + esc(editing ? editing.name : '') + '" placeholder="과제명"></div>'
      + '<div class="col-6"><label class="form-label">과제번호</label><input type="text" class="form-control" name="code" value="' + esc(editing ? editing.code : '') + '" placeholder="2026-A01"></div>'
      + '<div class="col-6"><label class="form-label">연구책임자</label><input type="text" class="form-control" name="manager" value="' + esc(editing ? editing.manager : '') + '" placeholder="김교수"></div>'
      + '<div class="col-6"><label class="form-label">시작일</label><input type="date" class="form-control" name="startDate" value="' + esc(editing ? editing.startDate : '') + '"></div>'
      + '<div class="col-6"><label class="form-label">종료일</label><input type="date" class="form-control" name="endDate" value="' + esc(editing ? editing.endDate : '') + '"></div>'
      + '<div class="col-12"><div class="form-label">비목별 예산 (원)</div><div class="row g-2">' + budgetInputs + '</div>'
      + '<div class="text-secondary small mt-2">합계 <strong class="tnum" id="project-total">' + won(editing ? projectStats(editing).total : 0) + '</strong></div></div>'
      + '<div class="col-12"><label class="form-label">비고</label><input type="text" class="form-control" name="note" value="' + esc(editing ? editing.note : '') + '" placeholder="집행 주의사항 등"></div>'
      + '<div class="col-12"><label class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" name="active"' + (!editing || editing.active !== false ? ' checked' : '') + '><span class="form-check-label">진행 중 (배정 가능)</span></label></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-device-floppy me-1"></i>' + (editing ? '저장' : '과제 추가') + '</button></div></form></div></div></div>';

    after += '<div class="col-lg-7"><div class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-folders me-1 text-primary"></i>과제 목록</h3></div>';
    if (!state.projects.length) {
      after += '<div class="card-body">' + empty('folder-off', '아직 과제가 없습니다', '') + '</div>';
    } else {
      after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>과제</th>'
        + '<th class="text-end">총 예산</th><th class="text-end">잔액</th><th class="w-1"></th></tr></thead><tbody>';
      state.projects.forEach(function (p) {
        var s = projectStats(p);
        var catLine = CATS.filter(function (c) { return budgetOf(p, c.id) > 0; }).map(function (c) {
          return esc(c.label) + ' <span class="tnum">' + nf.format(budgetOf(p, c.id)) + '</span>';
        }).join(' · ');
        after += '<tr data-id="' + esc(p.id) + '"><td><div class="fw-medium">' + esc(p.name) + '</div>'
          + '<div class="small text-secondary">' + esc(p.code) + (p.active === false ? ' · 종료' : '') + (catLine ? ' · ' + catLine : '') + '</div></td>'
          + '<td class="text-end tnum text-nowrap">' + won(s.total) + '</td>'
          + '<td class="text-end tnum text-nowrap' + (s.remain < 0 ? ' text-danger' : '') + '">' + won(s.remain) + '</td>'
          + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary" data-action="edit-project" title="수정"><i class="ti ti-edit"></i></button>'
          + '<button type="button" class="btn btn-sm btn-ghost-danger" data-action="delete-project" title="삭제"><i class="ti ti-trash"></i></button></td></tr>';
      });
      after += '</tbody></table></div>';
    }
    after += '</div></div></div>';

    if (store.mode === 'local') {
      after += '<div class="card card-backup"><div class="card-body d-flex align-items-center flex-wrap gap-2">'
        + '<div class="me-auto"><div class="fw-medium"><i class="ti ti-database-export me-1 text-primary"></i>데이터 백업 (로컬 모드)</div><div class="text-secondary small">로컬 모드 데이터는 이 브라우저에만 있습니다. JSON으로 내보내 공유하거나 다른 PC에서 가져올 수 있습니다.</div></div>'
        + '<button type="button" class="btn btn-sm" data-action="export"><i class="ti ti-download me-1"></i>JSON 내보내기</button>'
        + '<label class="btn btn-sm mb-0"><i class="ti ti-upload me-1"></i>JSON 가져오기<input type="file" accept="application/json" data-action="import" hidden></label>'
        + '<button type="button" class="btn btn-sm btn-outline-danger" data-action="reset-demo">예시 데이터로 초기화</button>'
        + '</div></div>';
    }
    return { body: body, after: after };
  }

  /* ---------- actions ---------- */
  function readForm(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else out[el.name] = el.value;
    });
    return out;
  }

  function download(name, text) {
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function handleError(err) {
    console.error(err);
    toast(err && err.message ? err.message : String(err), true);
  }

  function refresh() { return reload().then(render).catch(handleError); }

  function touchUnlock() { if (state.adminUnlocked) setUnlock(true); }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id === 'login-form') {
      e.preventDefault();
      store.signIn(readForm(form)).then(function (res) {
        if (res && res.magicLinkSent) { state.magicLinkSent = true; render(); return; }
        return refresh();
      }).catch(handleError);
    }
    if (form.id === 'request-form') {
      e.preventDefault();
      var r = readForm(form);
      var qty = Math.max(1, parseInt(r.qty, 10) || 1);
      var unit = Math.max(0, Math.round(Number(r.unitPrice) || 0));
      if (!r.item.trim()) { toast('품명을 입력하세요.', true); return; }
      store.createRequest({ item: r.item.trim(), category: normCat(r.category), link: r.link.trim(), qty: qty, unitPrice: unit, amount: qty * unit, note: r.note.trim() })
        .then(function () { toast('요청을 제출했습니다. 관리자 처리 후 상태가 바뀝니다.'); state.filter = 'all'; return refresh(); })
        .catch(handleError);
    }
    if (form.id === 'project-form') {
      e.preventDefault();
      var p = readForm(form);
      var id = form.getAttribute('data-id') || null;
      if (!p.name.trim()) { toast('과제명을 입력하세요.', true); return; }
      var budgets = {};
      CAT_IDS.forEach(function (c) { budgets[c] = Math.max(0, Math.round(Number(p['budget_' + c]) || 0)); });
      var rec = { code: p.code.trim(), name: p.name.trim(), budgets: budgets, startDate: p.startDate, endDate: p.endDate, manager: p.manager.trim(), note: p.note.trim(), active: !!p.active };
      if (id) rec.id = id;
      store.saveProject(rec).then(function () { toast(id ? '과제를 수정했습니다.' : '과제를 추가했습니다.'); state.editingProjectId = null; touchUnlock(); return refresh(); }).catch(handleError);
    }
  });

  document.addEventListener('input', function (e) {
    var rf = e.target.closest('#request-form');
    if (rf) {
      var qty = Math.max(1, parseInt(rf.qty.value, 10) || 0);
      var unit = Math.max(0, Number(rf.unitPrice.value) || 0);
      rf.amountView.value = won(qty * unit);
      return;
    }
    var pf = e.target.closest('#project-form');
    if (pf) {
      var total = 0;
      CAT_IDS.forEach(function (c) { var el = pf.elements['budget_' + c]; if (el) total += Math.max(0, Number(el.value) || 0); });
      var out = $('#project-total'); if (out) out.textContent = won(total);
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    var action = el.getAttribute('data-action');
    var role = el.getAttribute('data-role');
    if (action === 'toggle-mine') { state.onlyMine = el.checked; render(); }
    if (action === 'import' && el.files && el.files[0]) {
      var reader = new FileReader();
      reader.onload = function () {
        try { store.importJSON(JSON.parse(reader.result)); toast('가져오기 완료'); refresh(); }
        catch (err) { handleError(err); }
      };
      reader.readAsText(el.files[0]);
    }
    if (role === 'assign-cat') {
      /* 비목이 바뀌면 과제 목록의 잔액 표시를 그 비목 기준으로 다시 그림 */
      var row = el.closest('tr[data-id]');
      var sel = row && row.querySelector('select[data-role="assign-project"]');
      var req = row && state.requests.filter(function (r) { return r.id === row.getAttribute('data-id'); })[0];
      if (sel && req) sel.innerHTML = projectOptions(req.amount, normCat(el.value), sel.value);
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    var row = btn.closest('tr[data-id]');
    var id = row ? row.getAttribute('data-id') : null;

    switch (action) {
      case 'tab': {
        e.preventDefault();
        var t = btn.getAttribute('data-tab');
        if (t === 'admin') { enterAdmin(); return; }
        state.tab = t; render();
        break;
      }
      case 'unlock-admin':
        enterAdmin(); break;
      case 'lock-admin':
        setUnlock(false); state.tab = 'requests'; toast('관리자 화면을 잠갔습니다.'); render(); break;
      case 'filter':
        state.filter = btn.getAttribute('data-filter'); render(); break;
      case 'refresh':
        refresh().then(function () { toast('새로고침 완료'); }); break;
      case 'signout':
        setUnlock(false);
        store.signOut().then(function () { state.magicLinkSent = false; state.tab = 'requests'; return refresh(); }); break;
      case 'assign': {
        var sel = row.querySelector('select[data-role="assign-project"]');
        var catSel = row.querySelector('select[data-role="assign-cat"]');
        var pid = sel && sel.value;
        var cat = normCat(catSel && catSel.value);
        if (!pid) { toast('배정할 과제를 선택하세요.', true); return; }
        var req = state.requests.filter(function (r) { return r.id === id; })[0];
        var proj = projectById(pid);
        var stats = projectStats(proj);
        var remain = stats.byCat[cat].remain;
        var over = (Number(req.amount) || 0) > remain;
        var ask = over
          ? confirmDlg({ title: '비목 예산 초과', message: '이 과제의 ' + catLabel(cat) + ' 잔액은 ' + won(remain) + '이고 요청 금액은 ' + won(req.amount) + '입니다. 그래도 배정할까요?', okLabel: '초과 배정', danger: true })
          : Promise.resolve(true);
        ask.then(function (ok) {
          if (!ok) return;
          return store.updateRequest(id, { status: 'done', projectId: pid, category: cat, processedAt: new Date().toISOString(), processedBy: state.session.user.name, adminNote: '' })
            .then(function () { toast('처리 완료: ' + proj.name + ' · ' + catLabel(cat)); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'reject':
        promptDlg({ title: '반려', message: '반려 사유를 적어 주세요. 신청자에게 표시됩니다.', input: 'textarea', placeholder: '예: 개인 장비는 과제 예산 집행 불가', okLabel: '반려', danger: true }).then(function (reason) {
          if (reason === null) return;
          return store.updateRequest(id, { status: 'rejected', projectId: null, processedAt: new Date().toISOString(), processedBy: state.session.user.name, adminNote: reason.trim() })
            .then(function () { toast('반려했습니다.'); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      case 'reopen':
        store.updateRequest(id, { status: 'pending', projectId: null, processedAt: null, processedBy: null, adminNote: '' })
          .then(function () { toast('미처리로 되돌렸습니다.'); touchUnlock(); return refresh(); }).catch(handleError);
        break;
      case 'delete-request':
        confirmDlg({ title: '요청 삭제', message: '이 요청을 삭제할까요? 되돌릴 수 없습니다.', okLabel: '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.deleteRequest(id).then(function () { toast('삭제했습니다.'); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      case 'edit-project': {
        state.editingProjectId = id; render();
        var f = $('#project-form'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'cancel-edit':
        state.editingProjectId = null; render(); break;
      case 'delete-project':
        confirmDlg({ title: '과제 삭제', message: '이 과제를 삭제할까요? 배정된 구매건이 있는 과제는 삭제되지 않습니다.', okLabel: '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.deleteProject(id).then(function () { toast('과제를 삭제했습니다.'); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      case 'export':
        download('dsil-budget-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(store.exportJSON(), null, 2));
        break;
      case 'reset-demo':
        confirmDlg({ title: '예시 데이터로 초기화', message: '모든 데이터를 지우고 예시 데이터로 되돌릴까요?', okLabel: '초기화', danger: true }).then(function (ok) {
          if (!ok) return;
          store.resetDemo(); toast('예시 데이터로 초기화했습니다.'); return refresh();
        }).catch(handleError);
        break;
    }
  });

  /* ---------- boot ---------- */
  var initialTab = (window.location.hash || '').replace('#', '');
  if (TABS.indexOf(initialTab) >= 0) state.tab = initialTab;

  store.init().then(function () {
    state.ready = true;
    store.onChange(function () { reload().then(render).catch(handleError); });
    return reload();
  }).then(render).catch(function (err) {
    state.error = err && err.message ? err.message : String(err);
    render();
  });
})();
