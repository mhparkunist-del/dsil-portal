/* =====================================================================
   DSIL Lab Portal – 과제별 예산 관리 (UI, Tabler 컴포넌트 사용)
   탭: 구매 요청 · 요청 조회 · 구매 심의 · 과제 예산(관리자) · 관리자(PIN)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var CATS = (CFG.budgetCategories && CFG.budgetCategories.length) ? CFG.budgetCategories : [{ id: 'other', label: '기타' }];
  var CAT_IDS = CATS.map(function (c) { return c.id; });
  var TIERS = (CFG.procurementTiers && CFG.procurementTiers.length) ? CFG.procurementTiers : [{ upTo: null, label: '기준 없음', cls: 'bg-secondary-lt', desc: '' }];
  var PIN_RE = new RegExp('^' + (CFG.reviewPinPattern || '\\d{4,8}') + '$');
  var store = window.DSILStore.create(CFG);
  var UNLOCK_KEY = 'dsil-budget-admin-unlock';
  var TABS = ['requests', 'query', 'review', 'admin'];

  var STATUS = {
    pending: { label: '미처리', cls: 'bg-yellow-lt' },
    done: { label: '처리', cls: 'bg-blue-lt' },
    rejected: { label: '반려', cls: 'bg-red-lt' }
  };
  var RSTATUS = {
    pending: { label: '심의 중', cls: 'bg-yellow-lt' },
    approved: { label: '승인', cls: 'bg-green-lt' },
    rejected: { label: '반려', cls: 'bg-red-lt' }
  };
  var PRESETS = [
    { id: 'month', label: '이번 달' }, { id: 'prev', label: '지난 달' }, { id: '30d', label: '최근 30일' },
    { id: '90d', label: '최근 90일' }, { id: 'year', label: '올해' }, { id: 'all', label: '전체 기간' }, { id: 'custom', label: '직접 입력' }
  ];
  var GROUPS = [
    { id: 'none', label: '묶지 않음' }, { id: 'month', label: '월별' }, { id: 'status', label: '상태별' },
    { id: 'project', label: '과제별' }, { id: 'category', label: '비목별' }, { id: 'requester', label: '신청자별' }
  ];

  var state = {
    ready: false,
    error: null,
    session: null,
    projects: [],
    requests: [],
    reviews: [],
    reviewsFull: false,
    tab: 'requests',
    editingProjectId: null,
    magicLinkSent: false,
    adminUnlocked: false,
    query: { preset: 'month', from: '', to: '', status: 'all', category: 'all', projectId: 'all', q: '', mine: false, groupBy: 'none' },
    exports: [],
    exportFilter: { preset: 'month', from: '', to: '', projectId: 'all', includeRequests: true, includeReviews: true },
    exportSel: null,          /* null = 목록 전체 선택, 아니면 { key: true } */
    exportPurpose: ''
  };

  /* ---------- helpers ---------- */
  var nf = new Intl.NumberFormat('ko-KR');
  function won(n) { return nf.format(Math.round(Number(n) || 0)) + '원'; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function localDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 10);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtDate(iso) { var s = localDate(iso); return s ? s.replace(/-/g, '.') : ''; }
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function presetRange(preset) {
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();
    switch (preset) {
      case 'month': return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
      case 'prev': return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
      case '30d': return { from: ymd(new Date(y, m, now.getDate() - 29)), to: ymd(now) };
      case '90d': return { from: ymd(new Date(y, m, now.getDate() - 89)), to: ymd(now) };
      case 'year': return { from: ymd(new Date(y, 0, 1)), to: ymd(new Date(y, 11, 31)) };
      case 'all': return { from: '', to: '' };
      default: return null;
    }
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function byNewest(a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'portal-toast alert ' + (isError ? 'alert-danger' : 'alert-success') + ' is-visible';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 3000);
  }

  /* Tabler 마크업의 모달. opts.bodyHtml → 폼 값 객체, opts.html → 읽기 전용, opts.input → 문자열, 그 외 → true */
  function dialog(opts) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      var inner = '';
      if (opts.bodyHtml) inner = '<form id="modal-form">' + opts.bodyHtml + '</form>';
      else if (opts.html) inner = opts.html;
      else if (opts.input === 'textarea') inner = '<textarea class="form-control modal-input" rows="3" placeholder="' + esc(opts.placeholder || '') + '"></textarea>';
      else if (opts.input) inner = '<input class="form-control modal-input" type="' + (opts.input === 'password' ? 'password' : 'text') + '" placeholder="' + esc(opts.placeholder || '') + '" autocomplete="off" inputmode="' + (opts.input === 'password' ? 'numeric' : 'text') + '">';
      wrap.innerHTML = '<div class="modal modal-blur fade show is-open" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="modal-title">'
        + '<div class="modal-dialog ' + (opts.size === 'lg' ? 'modal-lg' : 'modal-sm') + ' modal-dialog-centered modal-dialog-scrollable" role="document"><div class="modal-content">'
        + '<div class="modal-header"><h5 class="modal-title" id="modal-title">' + esc(opts.title || '') + '</h5><button type="button" class="btn-close" data-modal="cancel" aria-label="닫기"></button></div>'
        + '<div class="modal-body">' + (opts.message ? '<p class="mb-' + (inner ? '2' : '0') + '">' + esc(opts.message) + '</p>' : '') + inner + '</div>'
        + '<div class="modal-footer">' + (opts.hideCancel ? '' : '<button type="button" class="btn btn-link link-secondary" data-modal="cancel">취소</button>')
        + '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + ' ms-auto" data-modal="ok">' + esc(opts.okLabel || '확인') + '</button></div>'
        + '</div></div></div><div class="modal-backdrop fade show"></div>';
      document.body.appendChild(wrap);
      var input = wrap.querySelector('.modal-input');
      var form = wrap.querySelector('#modal-form');
      var first = input || (form && form.querySelector('input,select,textarea')) || wrap.querySelector('[data-modal="ok"]');
      first.focus();
      function close(val) { document.removeEventListener('keydown', onKey); wrap.remove(); resolve(val); }
      function ok() {
        if (form) { if (!form.reportValidity()) return; close(readForm(form)); return; }
        close(input ? input.value : true);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && (input || form)) { e.preventDefault(); ok(); }
      }
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', function (e) {
        var b = e.target.closest('[data-modal]');
        if (b) { if (b.getAttribute('data-modal') === 'ok') ok(); else close(null); return; }
        if (e.target.classList.contains('modal')) close(null);
      });
      if (form) form.addEventListener('submit', function (e) { e.preventDefault(); ok(); });
    });
  }
  function confirmDlg(opts) { return dialog(opts).then(function (v) { return v === true; }); }
  function promptDlg(opts) { return dialog(opts); }

  /* ---------- 비목 · 구매 절차 ---------- */
  function catLabel(id) {
    for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i].label;
    return id || '-';
  }
  function normCat(id) { return CAT_IDS.indexOf(id) >= 0 ? id : CAT_IDS[0]; }
  function budgetOf(p, cat) { return Number(p.budgets && p.budgets[cat]) || 0; }
  function catOptions(selected, withAll) {
    return (withAll ? '<option value="all">모든 비목</option>' : '') + CATS.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === selected ? ' selected' : '') + '>' + esc(c.label) + '</option>';
    }).join('');
  }
  function tierOf(amount) {
    var a = Number(amount) || 0;
    for (var i = 0; i < TIERS.length; i++) {
      var up = TIERS[i].upTo;
      if (up === null || up === undefined || a <= Number(up)) return TIERS[i];
    }
    return TIERS[TIERS.length - 1];
  }
  function tierBadge(amount) {
    var t = tierOf(amount);
    return '<span class="badge ' + esc(t.cls || 'bg-secondary-lt') + '" title="' + esc(t.desc || '') + '">' + esc(t.label) + '</span>';
  }
  function tierTable() {
    return '<table class="table table-sm mb-0"><tbody>' + TIERS.map(function (t) {
      return '<tr><td class="w-1 text-nowrap"><span class="badge ' + esc(t.cls || 'bg-secondary-lt') + '">' + esc(t.label) + '</span></td><td class="text-secondary small">' + esc(t.desc || '') + '</td></tr>';
    }).join('') + '</tbody></table>';
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
  function touchUnlock() { if (state.adminUnlocked) setUnlock(true); }

  function enterAdmin(target) {
    target = target || 'admin';
    if (!isAdminEligible()) { toast('관리자 권한이 없습니다.', true); return; }
    if (readUnlock()) { setUnlock(true); state.tab = target; refresh(); return; }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요. 확인 후 ' + unlockMinutes() + '분 동안 관리자 화면이 열립니다.', input: 'password', placeholder: 'PIN', okLabel: '열기' })
      .then(function (pin) {
        if (pin === null) return;
        return store.verifyAdminPin(pin).then(function (ok) {
          if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; }
          setUnlock(true);
          state.tab = target;
          toast('관리자 화면을 열었습니다.');
          return refresh();
        });
      }).catch(handleError);
  }

  /* ---------- 집계 ---------- */
  function projectById(id) { for (var i = 0; i < state.projects.length; i++) if (state.projects[i].id === id) return state.projects[i]; return null; }
  function requestById(id) { for (var i = 0; i < state.requests.length; i++) if (state.requests[i].id === id) return state.requests[i]; return null; }
  function reviewById(id) { for (var i = 0; i < state.reviews.length; i++) if (state.reviews[i].id === id) return state.reviews[i]; return null; }
  function isMine(x) { return !!state.session && x.requesterId === state.session.user.id; }

  /* 심의에 연결된 구매 요청의 실집행 합계, 남은 가할당 */
  function reviewActual(rv) {
    return state.requests.reduce(function (s, r) { return s + (r.status === 'done' && r.reviewId === rv.id ? Number(r.amount) || 0 : 0); }, 0);
  }
  function reviewApproved(rv) { return Number(rv.approvedAmount !== null && rv.approvedAmount !== undefined ? rv.approvedAmount : rv.amount) || 0; }
  function reviewProvisional(rv) { return rv.status === 'approved' ? Math.max(0, reviewApproved(rv) - reviewActual(rv)) : 0; }

  /* 과제별·비목별 집계: 실집행(처리된 구매건) + 가할당(승인된 심의의 미집행분) */
  function projectStats(p) {
    var byCat = {};
    CAT_IDS.forEach(function (c) { byCat[c] = { budget: budgetOf(p, c), actual: 0, provisional: 0, count: 0, reviews: 0 }; });
    state.requests.forEach(function (r) {
      if (r.status !== 'done' || r.projectId !== p.id) return;
      var b = byCat[normCat(r.category)];
      b.actual += Number(r.amount) || 0;
      b.count++;
    });
    if (state.reviewsFull) {
      state.reviews.forEach(function (rv) {
        if (rv.status !== 'approved' || rv.projectId !== p.id) return;
        var b = byCat[normCat(rv.category)];
        b.provisional += reviewProvisional(rv);
        b.reviews++;
      });
    }
    var total = 0, actual = 0, provisional = 0, count = 0;
    CAT_IDS.forEach(function (c) {
      var b = byCat[c];
      b.committed = b.actual + b.provisional;
      b.remain = b.budget - b.committed;
      b.ratio = b.budget > 0 ? b.committed / b.budget : (b.committed > 0 ? 1 : 0);
      b.actualRatio = b.budget > 0 ? b.actual / b.budget : 0;
      total += b.budget; actual += b.actual; provisional += b.provisional; count += b.count;
    });
    var committed = actual + provisional;
    return { total: total, actual: actual, provisional: provisional, committed: committed, remain: total - committed,
      ratio: total > 0 ? committed / total : (committed > 0 ? 1 : 0), actualRatio: total > 0 ? actual / total : 0, count: count, byCat: byCat };
  }

  function summary() {
    var s = { pendingCount: 0, pendingAmount: 0, doneCount: 0, doneAmount: 0, reviewPending: 0, activeProjects: 0, totalBudget: 0, totalActual: 0, totalProvisional: 0, totalRemain: 0,
      my: { pending: 0, pendingAmount: 0, done: 0, doneAmount: 0, rejected: 0, rvPending: 0, rvApproved: 0, rvRejected: 0 } };
    state.requests.forEach(function (r) {
      var mine = isMine(r);
      if (r.status === 'pending') { s.pendingCount++; s.pendingAmount += Number(r.amount) || 0; if (mine) { s.my.pending++; s.my.pendingAmount += Number(r.amount) || 0; } }
      if (r.status === 'done') { s.doneCount++; s.doneAmount += Number(r.amount) || 0; if (mine) { s.my.done++; s.my.doneAmount += Number(r.amount) || 0; } }
      if (r.status === 'rejected' && mine) s.my.rejected++;
    });
    state.reviews.forEach(function (rv) {
      if (rv.status === 'pending') s.reviewPending++;
      if (isMine(rv)) { if (rv.status === 'pending') s.my.rvPending++; else if (rv.status === 'approved') s.my.rvApproved++; else if (rv.status === 'rejected') s.my.rvRejected++; }
    });
    state.projects.forEach(function (p) {
      if (p.active === false) return;
      var st = projectStats(p);
      s.activeProjects++;
      s.totalBudget += st.total; s.totalActual += st.actual; s.totalProvisional += st.provisional; s.totalRemain += st.remain;
    });
    return s;
  }

  function barClass(ratio) {
    if (ratio >= 1) return 'bg-red';
    if (ratio >= (Number(CFG.warnRatio) || 0.8)) return 'bg-yellow';
    return 'bg-primary';
  }

  /* 조회 조건 적용 */
  function queryResults() {
    var q = state.query;
    var from = q.from || '', to = q.to || '';
    var needle = (q.q || '').trim().toLowerCase();
    return state.requests.filter(function (r) {
      var d = localDate(r.createdAt);
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (q.status !== 'all' && r.status !== q.status) return false;
      if (q.category !== 'all' && normCat(r.category) !== q.category) return false;
      if (q.projectId === 'none' && r.projectId) return false;
      if (q.projectId !== 'all' && q.projectId !== 'none' && r.projectId !== q.projectId) return false;
      if (q.mine && !isMine(r)) return false;
      if (needle) {
        var hay = [r.item, r.requesterName, r.note, r.adminNote].join(' ').toLowerCase();
        if (hay.indexOf(needle) < 0) return false;
      }
      return true;
    });
  }

  function groupKey(r) {
    switch (state.query.groupBy) {
      case 'month': return localDate(r.createdAt).slice(0, 7).replace('-', '.');
      case 'status': return (STATUS[r.status] || { label: r.status }).label;
      case 'project': { var p = r.projectId ? projectById(r.projectId) : null; return p ? p.name : '미배정'; }
      case 'category': return catLabel(normCat(r.category));
      case 'requester': return r.requesterName || '-';
      default: return '';
    }
  }

  /* ---------- data ---------- */
  function reload() {
    state.session = store.getSession();
    state.adminUnlocked = readUnlock();
    var full = isAdminActive();
    return Promise.all([
      store.listProjects(),
      store.listRequests(),
      state.session ? store.listReviews({ full: full }) : Promise.resolve([]),
      full ? store.listExports() : Promise.resolve([])
    ]).then(function (res) {
      state.projects = res[0];
      state.requests = res[1].slice().sort(byNewest);
      state.reviews = res[2].slice().sort(byNewest);
      state.exports = res[3].slice().sort(byNewest);
      state.reviewsFull = full;
      if (state.tab === 'budget') state.tab = 'admin';
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
    var html;
    if (isAdminActive()) {
      html = '<div class="row row-deck row-cards mb-3">'
        + stat('미처리 구매건', sum.pendingCount + '건', won(sum.pendingAmount) + ' 대기 중', 'text-yellow', 'col-6 col-lg-3')
        + stat('심의 대기', sum.reviewPending + '건', '구매 심의 승인 대기', sum.reviewPending ? 'text-orange' : '', 'col-6 col-lg-3')
        + stat('총 예산', won(sum.totalBudget), '실집행 ' + won(sum.totalActual) + ' · 가할당 ' + won(sum.totalProvisional), 'text-primary', 'col-6 col-lg-3')
        + stat('잔여 예산', won(sum.totalRemain), sum.totalBudget > 0 ? '사용률 ' + Math.round((sum.totalActual + sum.totalProvisional) / sum.totalBudget * 100) + '% (실+가)' : '', '', 'col-6 col-lg-3')
        + '</div>';
    } else {
      html = '<div class="row row-deck row-cards mb-3">'
        + stat('내 미처리 요청', sum.my.pending + '건', won(sum.my.pendingAmount) + ' 대기 중', 'text-yellow', 'col-12 col-md-4')
        + stat('내 처리 완료', sum.my.done + '건', won(sum.my.doneAmount) + ' 집행' + (sum.my.rejected ? ' · 반려 ' + sum.my.rejected + '건' : ''), 'text-primary', 'col-6 col-md-4')
        + stat('내 구매 심의', (sum.my.rvPending + sum.my.rvApproved + sum.my.rvRejected) + '건', '심의 중 ' + sum.my.rvPending + ' · 승인 ' + sum.my.rvApproved + ' · 반려 ' + sum.my.rvRejected, '', 'col-6 col-md-4')
        + '</div>';
    }

    if (state.tab === 'budget') state.tab = 'admin';
    var tab = state.tab === 'query' ? renderQueryTab()
      : state.tab === 'review' ? renderReviewTab()
      : state.tab === 'admin' ? renderAdminTab()
      : renderRequestsTab();

    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('requests', 'cart-plus', '구매 요청')
      + tabLink('query', 'list-search', '요청 조회')
      + tabLink('review', 'shield-check', '구매 심의', sum.my.rvPending && !isAdminActive() ? '<span class="badge bg-yellow-lt ms-2">' + sum.my.rvPending + '</span>' : '')
      + (isAdminEligible() ? tabLink('admin', state.adminUnlocked ? 'lock-open' : 'lock', '관리자 · 과제 예산', (sum.pendingCount + sum.reviewPending) && state.adminUnlocked ? '<span class="badge bg-yellow-lt ms-2">' + (sum.pendingCount + sum.reviewPending) + '</span>' : '') : '')
      + '</ul></div>' + tab.body + '</div>' + (tab.after || '');

    app.innerHTML = html;
    try { history.replaceState(null, '', '#' + state.tab); } catch (e) { /* 샌드박스 뷰어에서는 막힐 수 있음 */ }
  }

  function stat(label, value, sub, cls, col) {
    return '<div class="' + (col || 'col-6 col-lg-3') + '"><div class="card card-sm"><div class="card-body">'
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
      + '<p class="text-secondary text-center mb-4">이름을 입력하면 구매 요청과 구매 심의를 올리고 처리 상태를 볼 수 있습니다. 로컬 저장 모드에서는 이 브라우저에만 저장됩니다.</p>'
      + '<form id="login-form"><div class="mb-3"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required placeholder="홍길동" autocomplete="name"></div>'
      + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100">시작</button></div></form>'
      + '<div class="text-secondary small text-center mt-3"><i class="ti ti-lock me-1"></i>과제 예산과 관리자 화면은 관리자 PIN을 입력해야 열립니다.</div>' + foot;
  }

  /* ---------- 구매 요청 탭 (제출 폼 + 내 최근 요청) ---------- */
  function renderRequestsTab() {
    var mine = state.requests.filter(isMine).slice(0, 5);
    var mineHtml;
    if (!mine.length) {
      mineHtml = '<div class="text-secondary small">아직 올린 요청이 없습니다.</div>';
    } else {
      mineHtml = '<div class="list-group list-group-flush">' + mine.map(function (r) {
        var st = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
        return '<div class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2">'
          + '<div class="text-truncate"><span class="text-secondary small me-2">' + fmtDate(r.createdAt) + '</span>' + esc(r.item) + '</div>'
          + '<div class="text-nowrap"><span class="tnum me-2">' + won(r.amount) + '</span><span class="badge ' + st.cls + '">' + st.label + '</span></div></div>';
      }).join('') + '</div>';
    }
    var myApproved = state.reviews.filter(function (rv) { return isMine(rv) && rv.status === 'approved'; });
    var reviewSelect = '<option value="">없음 (일반 구매)</option>' + myApproved.map(function (rv) {
      var extra = state.reviewsFull ? ' · 가할당 잔여 ' + won(reviewProvisional(rv)) : '';
      return '<option value="' + esc(rv.id) + '">' + esc(fmtDate(rv.createdAt) + ' ' + rv.title + extra) + '</option>';
    }).join('');

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
      + '<div class="col-12"><label class="form-label">관련 구매 심의 <span class="form-label-description">승인된 심의의 가할당에서 집행</span></label><select class="form-select" name="reviewId"' + (myApproved.length ? '' : ' disabled') + '>' + reviewSelect + '</select></div>'
      + '<div class="col-12"><label class="form-label">용도 / 메모</label><textarea class="form-control" name="note" rows="2" placeholder="어떤 실험에 쓰는지, 급한지 등"></textarea></div>'
      + '</div><div class="d-flex justify-content-between align-items-center mt-3"><span class="small text-secondary" id="request-tier"></span><button type="submit" class="btn btn-primary"><i class="ti ti-send me-1"></i>요청 제출</button></div></form>'
      + '</div>'
      + '<div class="col-lg-5">'
      + '<div class="d-flex justify-content-between align-items-center mb-2"><h3 class="card-title mb-0"><i class="ti ti-user-check me-1 text-primary"></i>내 최근 요청</h3>'
      + '<a href="#query" class="small" data-action="tab" data-tab="query" data-mine="1">전체 조회 <i class="ti ti-arrow-right"></i></a></div>'
      + mineHtml
      + '<h3 class="card-title mt-4 mb-2"><i class="ti ti-route me-1 text-primary"></i>처리 흐름</h3>'
      + '<div class="list-group list-group-flush">'
      + step(1, '구매 심의 (필요 시)', '금액이 크거나 나눠 집행할 계획이면 먼저 <a href="#review" data-action="tab" data-tab="review">구매 심의</a>를 올려 과제에 가할당을 받습니다.')
      + step(2, '구매 요청 제출', '품명·비목·수량·단가를 적어 제출합니다. 미처리 상태에서는 직접 수정·취소할 수 있습니다.')
      + step(3, '관리자 배정', '관리자가 과제와 비목을 배정하면 <span class="badge bg-blue-lt">처리</span>로 바뀌고 해당 비목에서 실집행으로 차감됩니다.')
      + '</div>'
      + '</div></div></div>';
    return { body: body };
  }

  function step(n, title, desc) {
    return '<div class="list-group-item px-0 d-flex gap-3"><span class="avatar avatar-sm bg-blue-lt flex-shrink-0">' + n + '</span>'
      + '<div><div class="fw-medium">' + esc(title) + '</div><div class="text-secondary small">' + desc + '</div></div></div>';
  }

  function empty(icon, title, sub) {
    return '<div class="empty py-4"><div class="empty-icon"><i class="ti ti-' + icon + '"></i></div><p class="empty-title">' + esc(title) + '</p>'
      + (sub ? '<p class="empty-subtitle text-secondary">' + esc(sub) + '</p>' : '') + '</div>';
  }

  /* ---------- 요청 조회 탭 ---------- */
  function renderQueryTab() {
    var q = state.query;
    var projOpts = '<option value="all">모든 과제</option><option value="none"' + (q.projectId === 'none' ? ' selected' : '') + '>미배정</option>'
      + state.projects.map(function (p) { return '<option value="' + esc(p.id) + '"' + (q.projectId === p.id ? ' selected' : '') + '>' + esc((p.code ? p.code + ' ' : '') + p.name) + '</option>'; }).join('');

    var body = '<div class="card-body"><form id="query-form"><div class="row g-2 align-items-end">'
      + '<div class="col-6 col-md-3 col-xl-2"><label class="form-label">기간</label><select class="form-select" name="preset">'
      + PRESETS.map(function (p) { return '<option value="' + p.id + '"' + (q.preset === p.id ? ' selected' : '') + '>' + p.label + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-6 col-md-3 col-xl-2' + (q.preset === 'custom' ? '' : ' d-none') + '"><label class="form-label">시작일</label><input type="date" class="form-control" name="from" value="' + esc(q.from) + '"></div>'
      + '<div class="col-6 col-md-3 col-xl-2' + (q.preset === 'custom' ? '' : ' d-none') + '"><label class="form-label">종료일</label><input type="date" class="form-control" name="to" value="' + esc(q.to) + '"></div>'
      + '<div class="col-6 col-md-3 col-xl-2"><label class="form-label">상태</label><select class="form-select" name="status">'
      + '<option value="all">모든 상태</option>' + Object.keys(STATUS).map(function (k) { return '<option value="' + k + '"' + (q.status === k ? ' selected' : '') + '>' + STATUS[k].label + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-6 col-md-3 col-xl-2"><label class="form-label">비목</label><select class="form-select" name="category">' + catOptions(q.category, true) + '</select></div>'
      + '<div class="col-12 col-md-6 col-xl-3"><label class="form-label">과제</label><select class="form-select" name="projectId">' + projOpts + '</select></div>'
      + '<div class="col-12 col-md-6 col-xl-3"><label class="form-label">검색</label><div class="input-group"><input type="search" class="form-control" name="q" value="' + esc(q.q) + '" placeholder="품명, 신청자, 메모"><button type="submit" class="btn btn-primary"><i class="ti ti-search"></i></button></div></div>'
      + '<div class="col-6 col-md-3 col-xl-2"><label class="form-label">묶어 보기</label><select class="form-select" name="groupBy">'
      + GROUPS.map(function (g) { return '<option value="' + g.id + '"' + (q.groupBy === g.id ? ' selected' : '') + '>' + g.label + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-6 col-md-3 col-xl-2"><label class="form-check mb-2"><input class="form-check-input" type="checkbox" name="mine"' + (q.mine ? ' checked' : '') + '><span class="form-check-label">내 요청만</span></label></div>'
      + '</div></form></div>';

    var list = queryResults();
    var total = list.reduce(function (s, r) { return s + (Number(r.amount) || 0); }, 0);
    var counts = { pending: 0, done: 0, rejected: 0 };
    list.forEach(function (r) { if (counts[r.status] !== undefined) counts[r.status]++; });
    var range = q.from || q.to ? (q.from || '…') + ' ~ ' + (q.to || '…') : '전체 기간';

    var after = '<div class="card"><div class="card-header">'
      + '<div><h3 class="card-title mb-0"><i class="ti ti-list-details me-1 text-primary"></i>조회 결과 <span class="text-primary">' + list.length + '건</span> <span class="text-secondary fw-normal">· 합계 <span class="tnum">' + won(total) + '</span></span></h3>'
      + '<div class="text-secondary small mt-1">' + esc(range) + ' · 미처리 ' + counts.pending + ' · 처리 ' + counts.done + ' · 반려 ' + counts.rejected + '</div></div>'
      + '<div class="card-actions"><button type="button" class="btn btn-sm" data-action="export-csv"' + (list.length ? '' : ' disabled') + '><i class="ti ti-file-spreadsheet me-1"></i>CSV 내려받기</button></div>'
      + '</div>';

    if (!list.length) {
      after += '<div class="card-body">' + empty('search-off', '조건에 맞는 요청이 없습니다', '기간을 넓히거나 다른 조건으로 조회해 보세요.') + '</div>';
    } else {
      var admin = isAdminActive();
      after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1">날짜</th><th class="w-1">신청자</th><th>품명</th><th class="text-end">금액</th><th>상태</th><th>배정 과제</th><th class="w-1"></th>'
        + '</tr></thead><tbody>';
      if (q.groupBy === 'none') {
        list.forEach(function (r) { after += requestRow(r, admin); });
      } else {
        var groups = [], map = {};
        list.forEach(function (r) {
          var k = groupKey(r);
          if (!map[k]) { map[k] = { key: k, items: [], total: 0 }; groups.push(map[k]); }
          map[k].items.push(r); map[k].total += Number(r.amount) || 0;
        });
        groups.forEach(function (g) {
          after += '<tr class="bg-light"><td colspan="7"><div class="d-flex justify-content-between"><strong>' + esc(g.key) + ' <span class="text-secondary fw-normal">' + g.items.length + '건</span></strong><span class="tnum">' + won(g.total) + '</span></div></td></tr>';
          g.items.forEach(function (r) { after += requestRow(r, admin); });
        });
      }
      after += '</tbody></table></div>';
    }
    after += '</div>';
    return { body: body, after: after };
  }

  function itemCell(r) {
    var rv = r.reviewId ? reviewById(r.reviewId) : null;
    return '<div class="fw-medium">' + esc(r.item)
      + (r.link ? ' <a href="' + esc(r.link) + '" target="_blank" rel="noopener" class="text-secondary" title="링크 열기"><i class="ti ti-external-link"></i></a>' : '') + '</div>'
      + '<div class="small text-secondary"><span class="badge badge-outline text-primary me-1">' + esc(catLabel(normCat(r.category))) + '</span>'
      + (r.reviewId ? '<span class="badge bg-green-lt me-1" title="' + esc(rv ? rv.title : '') + '"><i class="ti ti-shield-check"></i> 심의</span>' : '') + esc(r.note || '') + '</div>'
      + (r.status === 'rejected' && r.adminNote ? '<div class="small text-danger">반려 사유: ' + esc(r.adminNote) + '</div>' : '');
  }

  function amountCell(r) {
    return '<td class="text-end text-nowrap"><div class="fw-medium tnum">' + won(r.amount) + '</div><div class="small text-secondary tnum">' + esc(r.qty) + ' × ' + won(r.unitPrice) + '</div></td>';
  }

  /* 조회 결과 행. admin=true 면 미처리 행에 배정 컨트롤이 붙고, 본인 미처리 요청은 누구나 수정·취소 가능 */
  function requestRow(r, admin) {
    var st = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
    var p = r.projectId ? projectById(r.projectId) : null;
    var own = isMine(r);
    var canEdit = admin || (own && r.status === 'pending');
    var html = '<tr data-id="' + esc(r.id) + '">'
      + '<td class="text-nowrap text-secondary">' + fmtDate(r.createdAt) + '</td>'
      + '<td class="text-nowrap">' + esc(r.requesterName) + '</td>'
      + '<td>' + itemCell(r) + '</td>'
      + amountCell(r);
    if (admin && r.status === 'pending') {
      var pre = assignDefaults(r);
      html += '<td><span class="badge ' + st.cls + '">' + st.label + '</span></td>'
        + '<td><div class="d-flex flex-wrap gap-1"><select class="form-select form-select-sm" data-role="assign-project">' + projectOptions(r.amount, pre.cat, pre.projectId) + '</select>'
        + '<select class="form-select form-select-sm" data-role="assign-cat" style="min-width:7rem">' + catOptions(pre.cat) + '</select></div></td>'
        + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-primary" data-action="assign">처리</button> '
        + '<button type="button" class="btn btn-sm btn-outline-danger" data-action="reject">반려</button> '
        + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="edit-request" title="수정"><i class="ti ti-edit"></i></button></td>';
    } else {
      html += '<td><span class="badge ' + st.cls + '">' + st.label + '</span>'
        + (r.processedAt ? '<div class="small text-secondary text-nowrap">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</div>' : '') + '</td>'
        + '<td>' + (p ? '<div>' + esc(p.name) + '</div><div class="small text-secondary">' + esc(p.code) + '</div>' : '<span class="text-secondary">-</span>') + '</td>'
        + '<td class="text-end text-nowrap">'
        + (admin && r.status !== 'pending' ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reopen" title="미처리로 되돌리기"><i class="ti ti-arrow-back-up"></i></button>' : '')
        + (canEdit ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="edit-request" title="수정"><i class="ti ti-edit"></i></button>' : '')
        + (canEdit ? '<button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-request" title="' + (own && !admin ? '요청 취소' : '삭제') + '"><i class="ti ti-trash"></i></button>' : '')
        + '</td>';
    }
    return html + '</tr>';
  }

  /* 심의에 연결된 요청이면 심의의 과제·비목을 기본값으로 */
  function assignDefaults(r) {
    var rv = r.reviewId && state.reviewsFull ? reviewById(r.reviewId) : null;
    if (rv && rv.status === 'approved' && rv.projectId) return { projectId: rv.projectId, cat: normCat(rv.category) };
    return { projectId: '', cat: normCat(r.category) };
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

  /* ---------- 구매 심의 탭 ---------- */
  function reviewItemRow(name, amount) {
    return '<div class="row g-2 align-items-center review-item mb-2">'
      + '<div class="col-6"><input type="text" class="form-control form-control-sm" data-field="name" placeholder="품명 / 구매 건" value="' + esc(name || '') + '"></div>'
      + '<div class="col-4"><input type="number" class="form-control form-control-sm tnum" data-field="amount" min="0" step="1" placeholder="금액 (원)" value="' + esc(amount || '') + '"></div>'
      + '<div class="col-2 d-flex align-items-center justify-content-between gap-1"><span class="item-tier small"></span>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="remove-review-item" title="삭제"><i class="ti ti-x"></i></button></div></div>';
  }

  function readReviewItems(form) {
    return $all('.review-item', form).map(function (row) {
      return { name: (row.querySelector('[data-field="name"]').value || '').trim(), amount: Math.max(0, Math.round(Number(row.querySelector('[data-field="amount"]').value) || 0)) };
    }).filter(function (it) { return it.name || it.amount > 0; });
  }

  function updateReviewTotals(form) {
    var total = 0;
    $all('.review-item', form).forEach(function (row) {
      var a = Math.max(0, Number(row.querySelector('[data-field="amount"]').value) || 0);
      total += a;
      row.querySelector('.item-tier').innerHTML = a > 0 ? tierBadge(a) : '';
    });
    var t = $('#review-total', form); if (t) t.textContent = won(total);
    var tt = $('#review-total-tier', form); if (tt) tt.innerHTML = total > 0 ? tierBadge(total) : '';
  }

  function renderReviewTab() {
    var mine = state.reviews.filter(isMine);
    var listHtml;
    if (!mine.length) {
      listHtml = '<div class="text-secondary small">아직 올린 심의가 없습니다.</div>';
    } else {
      listHtml = '<div class="list-group list-group-flush">' + mine.map(function (rv) {
        var st = RSTATUS[rv.status] || { label: rv.status, cls: 'bg-secondary-lt' };
        return '<div class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2" data-id="' + esc(rv.id) + '">'
          + '<div class="text-truncate"><span class="text-secondary small me-2">' + fmtDate(rv.createdAt) + '</span>' + esc(rv.title) + '</div>'
          + '<div class="text-nowrap d-flex align-items-center gap-2"><span class="badge ' + st.cls + '">' + st.label + '</span>'
          + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="open-review" title="PIN 입력 후 열람"><i class="ti ti-lock-open me-1"></i>열기</button></div></div>';
      }).join('') + '</div>';
    }

    var body = '<div class="card-body"><div class="row g-4">'
      + '<div class="col-lg-7">'
      + '<h3 class="card-title mb-1"><i class="ti ti-shield-check me-1 text-primary"></i>구매 심의 올리기</h3>'
      + '<p class="text-secondary small mb-3">구매 요청 전에 심의를 올리면 승인 시 과제 예산에 <strong>가할당</strong>됩니다. 이후 구매 요청을 이 심의에 연결하면 가할당이 실집행으로 바뀝니다.</p>'
      + '<form id="review-form"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">제목 (품목 요약)</label><input type="text" class="form-control" name="title" required placeholder="예: 반도체 파라미터 분석기 액세서리 구매"></div>'
      + '<div class="col-sm-5"><label class="form-label required">비목</label><select class="form-select" name="category">' + catOptions(CAT_IDS[0]) + '</select></div>'
      + '<div class="col-sm-7"><label class="form-label">구매처 / 견적</label><input type="text" class="form-control" name="vendor" placeholder="업체명, 견적 번호·날짜"></div>'
      + '<div class="col-12"><label class="form-label required">용도 / 사유</label><textarea class="form-control" name="purpose" rows="2" required placeholder="어떤 실험·장비에 필요한지"></textarea></div>'
      + '<div class="col-12"><div class="form-label">구매 건 나누기 <span class="form-label-description">건별 금액에 따라 적용 절차가 표시됩니다</span></div>'
      + '<div id="review-items">' + reviewItemRow('', '') + '</div>'
      + '<div class="d-flex justify-content-between align-items-center mt-1">'
      + '<button type="button" class="btn btn-sm" data-action="add-review-item"><i class="ti ti-plus me-1"></i>구매 건 추가</button>'
      + '<div>총액 <strong class="tnum" id="review-total">0원</strong> <span id="review-total-tier"></span></div></div></div>'
      + '<div class="col-sm-6"><label class="form-label required">열람 PIN</label><input type="password" class="form-control" name="pin" required inputmode="numeric" autocomplete="new-password" placeholder="숫자 4~8자리">'
      + '<div class="form-hint">심의 내용을 다시 열어볼 때 필요합니다. 승인·반려 여부는 PIN 없이 보입니다.</div></div>'
      + '<div class="col-sm-6"><label class="form-label required">PIN 확인</label><input type="password" class="form-control" name="pin2" required inputmode="numeric" autocomplete="new-password"></div>'
      + '<div class="col-12"><label class="form-label">메모</label><input type="text" class="form-control" name="note" placeholder="납기, 대안 등"></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-send me-1"></i>심의 요청 제출</button></div></form>'
      + '</div>'
      + '<div class="col-lg-5">'
      + '<h3 class="card-title mb-2"><i class="ti ti-user-check me-1 text-primary"></i>내 구매 심의</h3>'
      + listHtml
      + '<h3 class="card-title mt-4 mb-2"><i class="ti ti-gavel me-1 text-primary"></i>구매 절차 기준</h3>'
      + tierTable()
      + '<div class="text-secondary small mt-2">구매 건별 금액으로 판정합니다. 같은 심의 안에서 여러 건으로 나누면 건마다 절차가 표시됩니다.</div>'
      + '</div></div></div>';
    return { body: body };
  }

  function reviewDetailHtml(rv) {
    var p = rv.projectId ? projectById(rv.projectId) : null;
    var st = RSTATUS[rv.status] || { label: rv.status, cls: 'bg-secondary-lt' };
    var actual = reviewActual(rv), prov = reviewProvisional(rv);
    var linked = state.requests.filter(function (r) { return r.reviewId === rv.id; });
    var items = (rv.items && rv.items.length ? rv.items : [{ name: rv.title, amount: rv.amount }]);
    var html = '<div class="datagrid mb-3">'
      + dg('신청자', esc(rv.requesterName) + ' <span class="text-secondary">· ' + fmtDate(rv.createdAt) + '</span>')
      + dg('상태', '<span class="badge ' + st.cls + '">' + st.label + '</span>' + (rv.processedAt ? ' <span class="text-secondary small">' + fmtDate(rv.processedAt) + (rv.processedBy ? ' · ' + esc(rv.processedBy) : '') + '</span>' : ''))
      + dg('비목', esc(catLabel(normCat(rv.category))))
      + dg('총액', '<span class="tnum">' + won(rv.amount) + '</span> ' + tierBadge(rv.amount))
      + (rv.status === 'approved' ? dg('배정 과제', p ? esc(p.name) + ' <span class="text-secondary small">' + esc(p.code) + '</span>' : '-') : '')
      + (rv.status === 'approved' ? dg('승인 금액 (가할당)', '<span class="tnum">' + won(reviewApproved(rv)) + '</span>') : '')
      + (rv.status === 'approved' ? dg('실집행 / 가할당 잔여', '<span class="tnum">' + won(actual) + '</span> / <span class="tnum">' + won(prov) + '</span>') : '')
      + '</div>'
      + '<div class="mb-3"><div class="subheader">용도 / 사유</div><div>' + esc(rv.purpose || '-') + '</div></div>'
      + (rv.vendor ? '<div class="mb-3"><div class="subheader">구매처 / 견적</div><div>' + esc(rv.vendor) + '</div></div>' : '')
      + '<div class="subheader">구매 건</div><div class="table-responsive"><table class="table table-sm table-vcenter mb-3"><thead><tr><th>품명</th><th class="text-end">금액</th><th class="w-1">절차</th></tr></thead><tbody>'
      + items.map(function (it) { return '<tr><td>' + esc(it.name) + '</td><td class="text-end tnum">' + won(it.amount) + '</td><td>' + tierBadge(it.amount) + '</td></tr>'; }).join('')
      + '</tbody></table></div>'
      + (rv.adminNote ? '<div class="alert alert-' + (rv.status === 'rejected' ? 'danger' : 'info') + ' py-2 mb-3"><div class="small fw-medium">관리자 메모</div>' + esc(rv.adminNote) + '</div>' : '')
      + (rv.note ? '<div class="mb-3"><div class="subheader">메모</div><div>' + esc(rv.note) + '</div></div>' : '');
    if (linked.length) {
      html += '<div class="subheader">연결된 구매 요청 ' + linked.length + '건</div><ul class="list-unstyled small mb-0">' + linked.map(function (r) {
        var s2 = STATUS[r.status] || { label: r.status, cls: 'bg-secondary-lt' };
        return '<li class="d-flex justify-content-between gap-2 py-1 border-top"><span>' + fmtDate(r.createdAt) + ' ' + esc(r.item) + '</span><span class="text-nowrap"><span class="tnum me-2">' + won(r.amount) + '</span><span class="badge ' + s2.cls + '">' + s2.label + '</span></span></li>';
      }).join('') + '</ul>';
    }
    return html;
  }
  function dg(title, content) { return '<div class="datagrid-item"><div class="datagrid-title">' + esc(title) + '</div><div class="datagrid-content">' + content + '</div></div>'; }

  function showReview(rv) {
    return dialog({ title: rv.title, html: reviewDetailHtml(rv), size: 'lg', okLabel: '닫기', hideCancel: true });
  }

  function openReviewWithPin(id) {
    return promptDlg({ title: '심의 열람', message: '이 심의를 올릴 때 정한 열람 PIN을 입력하세요.', input: 'password', placeholder: 'PIN', okLabel: '열기' }).then(function (pin) {
      if (pin === null) return;
      return store.openReview(id, pin).then(function (rv) {
        if (!rv) { toast('PIN이 올바르지 않습니다.', true); return; }
        return showReview(rv);
      });
    });
  }

  function approveReview(id) {
    var rv = reviewById(id);
    if (!rv) return Promise.resolve();
    var cat = normCat(rv.category);
    var body = '<div class="mb-3"><label class="form-label required">배정 과제</label><select class="form-select" name="projectId" required>' + projectOptions(rv.amount, cat, '') + '</select></div>'
      + '<div class="row g-2 mb-3"><div class="col-6"><label class="form-label">비목</label><select class="form-select" name="category">' + catOptions(cat) + '</select></div>'
      + '<div class="col-6"><label class="form-label required">승인 금액 (가할당)</label><input type="number" class="form-control tnum" name="approvedAmount" min="0" step="1" required value="' + esc(rv.amount) + '"></div></div>'
      + '<div class="mb-0"><label class="form-label">관리자 메모 <span class="form-label-description">신청자가 PIN으로 열람 시 표시</span></label><input type="text" class="form-control" name="adminNote" placeholder="예: 2차 구매는 11월 이후"></div>';
    return dialog({ title: '심의 승인 · ' + rv.title, bodyHtml: body, size: 'lg', okLabel: '승인' }).then(function (v) {
      if (!v) return;
      if (!v.projectId) { toast('배정할 과제를 선택하세요.', true); return; }
      var approved = Math.max(0, Math.round(Number(v.approvedAmount) || 0));
      var c = normCat(v.category);
      var stats = projectStats(projectById(v.projectId));
      var remain = stats.byCat[c].remain;
      var ask = approved > remain
        ? confirmDlg({ title: '비목 예산 초과', message: '이 과제의 ' + catLabel(c) + ' 잔액은 ' + won(remain) + '이고 가할당 금액은 ' + won(approved) + '입니다. 그래도 승인할까요?', okLabel: '초과 승인', danger: true })
        : Promise.resolve(true);
      return ask.then(function (ok) {
        if (!ok) return;
        return store.updateReview(id, { status: 'approved', projectId: v.projectId, category: c, approvedAmount: approved, adminNote: v.adminNote.trim(), processedAt: new Date().toISOString(), processedBy: state.session.user.name })
          .then(function () { toast('심의를 승인하고 ' + won(approved) + '을 가할당했습니다.'); touchUnlock(); return refresh(); });
      });
    });
  }

  /* ---------- 과제 예산 탭 (관리자) ---------- */
  function stackedBar(actualRatio, provRatio, warnRatio) {
    var a = Math.min(100, Math.round(actualRatio * 100));
    var p = Math.min(100 - a, Math.round(provRatio * 100));
    var cls = barClass(warnRatio);
    return '<div class="progress progress-sm"><div class="progress-bar ' + cls + '" style="width:' + a + '%" title="실집행"></div>'
      + '<div class="progress-bar ' + cls + ' opacity-50" style="width:' + p + '%" title="가할당"></div></div>';
  }

  function renderBudgetTab() {
    if (!isAdminActive()) {
      return { body: '<div class="card-body">' + empty('lock', '과제 예산은 관리자만 볼 수 있습니다', '관리자 PIN을 입력하면 ' + unlockMinutes() + '분 동안 열립니다.')
        + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-budget"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    }
    if (!state.projects.length) return { body: '<div class="card-body">' + empty('folder-off', '등록된 과제가 없습니다', '관리자 탭에서 과제를 추가하세요.') + '</div>' };
    var legend = '<div class="card-body py-2 border-bottom small text-secondary d-flex flex-wrap gap-3 align-items-center">'
      + '<span><span class="badge bg-primary me-1">&nbsp;</span>실집행 (처리된 구매건)</span><span><span class="badge bg-primary opacity-50 me-1">&nbsp;</span>가할당 (승인된 심의의 미집행분)</span><span>잔액 = 예산 − 실집행 − 가할당</span></div>';
    var cards = '';
    state.projects.slice().sort(function (a, b) { return (a.active === false) - (b.active === false); }).forEach(function (p) {
      var s = projectStats(p);
      var items = state.requests.filter(function (r) { return r.status === 'done' && r.projectId === p.id; });
      var rvs = state.reviews.filter(function (rv) { return rv.status === 'approved' && rv.projectId === p.id && reviewProvisional(rv) > 0; });
      var catRows = '';
      CAT_IDS.forEach(function (c) {
        var b = s.byCat[c];
        if (b.budget <= 0 && b.committed <= 0) return;
        catRows += '<div class="cat-row"><div class="d-flex flex-wrap justify-content-between small mb-1 gap-1"><span class="text-nowrap">' + esc(catLabel(c)) + '</span>'
          + '<span class="tnum text-nowrap ms-auto"><span class="fw-medium">실 ' + won(b.actual) + '</span>' + (b.provisional ? ' <span class="text-secondary">· 가 ' + won(b.provisional) + '</span>' : '') + '<span class="text-secondary"> / ' + won(b.budget) + '</span></span></div>'
          + '<div class="progress progress-xs"><div class="progress-bar ' + barClass(b.ratio) + '" style="width:' + Math.min(100, Math.round(b.actualRatio * 100)) + '%"></div>'
          + '<div class="progress-bar ' + barClass(b.ratio) + ' opacity-50" style="width:' + Math.min(100 - Math.min(100, Math.round(b.actualRatio * 100)), Math.round((b.ratio - b.actualRatio) * 100)) + '%"></div></div></div>';
      });
      cards += '<div class="col-md-6 col-xl-4"><div class="card' + (p.active === false ? ' card-soon' : '') + '">'
        + '<div class="card-status-top ' + (p.active === false ? 'bg-secondary' : barClass(s.ratio)) + '"></div>'
        + '<div class="card-body">'
        + '<div class="d-flex justify-content-between align-items-start gap-2 mb-3"><div><h3 class="card-title mb-1">' + esc(p.name) + '</h3>'
        + '<div class="text-secondary small">' + esc(p.code) + (p.manager ? ' · ' + esc(p.manager) : '') + '<br>' + esc(p.startDate || '-') + ' ~ ' + esc(p.endDate || '-') + '</div></div>'
        + (p.active === false ? '<span class="badge bg-secondary-lt">종료</span>' : '<span class="badge bg-blue-lt">진행</span>') + '</div>'
        + '<div class="d-flex justify-content-between align-items-baseline mb-1"><span class="text-secondary small">총 예산 <span class="tnum">' + won(s.total) + '</span></span>'
        + '<span class="tnum' + (s.remain < 0 ? ' text-danger' : '') + '">잔액 <strong>' + won(s.remain) + '</strong></span></div>'
        + stackedBar(s.actualRatio, s.ratio - s.actualRatio, s.ratio)
        + '<div class="d-flex justify-content-between small text-secondary mt-1 mb-3"><span>실집행 <span class="tnum">' + won(s.actual) + '</span></span><span>가할당 <span class="tnum">' + won(s.provisional) + '</span></span></div>'
        + catRows
        + (p.note ? '<div class="text-secondary small mt-3"><i class="ti ti-note me-1"></i>' + esc(p.note) + '</div>' : '')
        + '<details class="mt-3"><summary class="text-primary small">배정된 구매건 ' + items.length + '건 · 가할당 심의 ' + rvs.length + '건</summary>'
        + (items.length ? '<ul class="list-unstyled small mt-2 mb-0">' + items.map(function (r) {
          return '<li class="d-flex justify-content-between gap-2 py-1 border-top"><span>' + fmtDate(r.processedAt || r.createdAt) + ' ' + esc(r.item) + ' <span class="text-secondary">(' + esc(r.requesterName) + ' · ' + esc(catLabel(normCat(r.category))) + ')</span></span><span class="tnum text-nowrap">' + won(r.amount) + '</span></li>';
        }).join('') + '</ul>' : '')
        + (rvs.length ? '<ul class="list-unstyled small mt-2 mb-0">' + rvs.map(function (rv) {
          return '<li class="d-flex justify-content-between gap-2 py-1 border-top"><span><i class="ti ti-shield-check text-green"></i> ' + esc(rv.title) + ' <span class="text-secondary">(' + esc(rv.requesterName) + ' · ' + esc(catLabel(normCat(rv.category))) + ')</span></span><span class="tnum text-nowrap text-secondary">가 ' + won(reviewProvisional(rv)) + '</span></li>';
        }).join('') + '</ul>' : '')
        + (!items.length && !rvs.length ? '<div class="text-secondary small mt-2">아직 없음</div>' : '')
        + '</details>'
        + '</div></div></div>';
    });
    return { body: legend + '<div class="card-body"><div class="row row-cards">' + cards + '</div></div>' };
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab() {
    if (!isAdminActive()) {
      return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 ' + unlockMinutes() + '분 동안 열립니다.')
        + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    }
    var pending = state.requests.filter(function (r) { return r.status === 'pending'; });
    var rvPending = state.reviews.filter(function (rv) { return rv.status === 'pending'; });

    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom">'
      + '<div class="text-secondary small"><i class="ti ti-lock-open me-1"></i>관리자 모드 · 처리·반려된 건은 <a href="#query" data-action="tab" data-tab="query">요청 조회</a>에서 되돌리거나 수정합니다.</div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div>';

    body += '<div class="card-body pb-2"><h3 class="card-title mb-0"><i class="ti ti-inbox me-1 text-primary"></i>미처리 구매건 <span class="badge bg-yellow-lt ms-1">' + pending.length + '</span></h3></div>';
    if (!pending.length) {
      body += '<div class="card-body pt-0">' + empty('checks', '미처리 요청이 없습니다', '') + '</div>';
    } else {
      body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1">날짜 / 신청자</th><th>품명</th><th class="text-end">금액</th><th>배정 과제</th><th class="w-1">비목</th><th class="w-1"></th>'
        + '</tr></thead><tbody>';
      pending.forEach(function (r) {
        var pre = assignDefaults(r);
        body += '<tr data-id="' + esc(r.id) + '">'
          + '<td class="text-nowrap"><div>' + fmtDate(r.createdAt) + '</div><div class="small text-secondary">' + esc(r.requesterName) + '</div></td>'
          + '<td>' + itemCell(r) + '</td>'
          + amountCell(r)
          + '<td><select class="form-select form-select-sm" data-role="assign-project">' + projectOptions(r.amount, pre.cat, pre.projectId) + '</select></td>'
          + '<td><select class="form-select form-select-sm" data-role="assign-cat">' + catOptions(pre.cat) + '</select></td>'
          + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-primary" data-action="assign">처리</button> '
          + '<button type="button" class="btn btn-sm btn-outline-danger" data-action="reject">반려</button> '
          + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="edit-request" title="수정"><i class="ti ti-edit"></i></button></td>'
          + '</tr>';
      });
      body += '</tbody></table></div>';
    }

    body += '<div class="card-body pb-2 border-top"><h3 class="card-title mb-0"><i class="ti ti-shield-check me-1 text-primary"></i>구매 심의 대기 <span class="badge bg-yellow-lt ms-1">' + rvPending.length + '</span></h3></div>';
    if (!rvPending.length) {
      body += '<div class="card-body pt-0">' + empty('shield-check', '대기 중인 심의가 없습니다', '') + '</div>';
    } else {
      body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1">날짜 / 신청자</th><th>제목</th><th class="text-end">총액</th><th class="w-1">절차</th><th class="w-1"></th></tr></thead><tbody>';
      rvPending.forEach(function (rv) { body += reviewAdminRow(rv); });
      body += '</tbody></table></div>';
    }

    var editing = state.editingProjectId ? projectById(state.editingProjectId) : null;
    var budgetInputs = CATS.map(function (c) {
      return '<div class="col-6 col-md-3"><label class="form-label">' + esc(c.label) + '</label><input type="number" class="form-control tnum" name="budget_' + esc(c.id) + '" min="0" step="1" value="' + (editing ? budgetOf(editing, c.id) : '') + '" placeholder="0"></div>';
    }).join('');

    /* 과제 예산 현황 (관리자 탭에 통합) */
    var budgetView = renderBudgetTab();
    var after = '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-wallet me-1 text-primary"></i>과제 예산 현황</h3></div>' + budgetView.body + '</div>';

    after += '<div class="row row-cards mb-3">'
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
        + '<th class="text-end">총 예산</th><th class="text-end">실집행 · 가할당</th><th class="text-end">잔액</th><th class="w-1"></th></tr></thead><tbody>';
      state.projects.forEach(function (p) {
        var s = projectStats(p);
        var catLine = CATS.filter(function (c) { return budgetOf(p, c.id) > 0; }).map(function (c) {
          return esc(c.label) + ' <span class="tnum">' + nf.format(budgetOf(p, c.id)) + '</span>';
        }).join(' · ');
        after += '<tr data-id="' + esc(p.id) + '"><td><div class="fw-medium">' + esc(p.name) + '</div>'
          + '<div class="small text-secondary">' + esc(p.code) + (p.active === false ? ' · 종료' : '') + (catLine ? ' · ' + catLine : '') + '</div></td>'
          + '<td class="text-end tnum text-nowrap">' + won(s.total) + '</td>'
          + '<td class="text-end tnum text-nowrap">' + won(s.actual) + '<div class="small text-secondary">가 ' + won(s.provisional) + '</div></td>'
          + '<td class="text-end tnum text-nowrap' + (s.remain < 0 ? ' text-danger' : '') + '">' + won(s.remain) + '</td>'
          + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="edit-project" title="수정"><i class="ti ti-edit"></i></button>'
          + '<button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-project" title="삭제"><i class="ti ti-trash"></i></button></td></tr>';
      });
      after += '</tbody></table></div>';
    }
    after += '</div></div></div>';

    /* 전체 심의 목록 (관리자: 모든 정보 열람) */
    after += '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-list-check me-1 text-primary"></i>구매 심의 전체 <span class="text-secondary fw-normal">' + state.reviews.length + '건</span></h3></div>';
    if (!state.reviews.length) {
      after += '<div class="card-body">' + empty('shield-check', '올라온 심의가 없습니다', '') + '</div>';
    } else {
      after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1">날짜 / 신청자</th><th>제목</th><th class="text-end">총액</th><th class="w-1">절차</th><th>상태 · 배정</th><th class="text-end">가할당 잔여</th><th class="w-1"></th></tr></thead><tbody>';
      state.reviews.forEach(function (rv) {
        var st = RSTATUS[rv.status] || { label: rv.status, cls: 'bg-secondary-lt' };
        var p = rv.projectId ? projectById(rv.projectId) : null;
        after += '<tr data-id="' + esc(rv.id) + '">'
          + '<td class="text-nowrap"><div>' + fmtDate(rv.createdAt) + '</div><div class="small text-secondary">' + esc(rv.requesterName) + '</div></td>'
          + '<td><div class="fw-medium">' + esc(rv.title) + '</div><div class="small text-secondary"><span class="badge badge-outline text-primary me-1">' + esc(catLabel(normCat(rv.category))) + '</span>' + (rv.items ? rv.items.length : 1) + '건 · ' + esc(rv.purpose || '') + '</div></td>'
          + '<td class="text-end tnum text-nowrap">' + won(rv.amount) + '</td>'
          + '<td>' + tierBadge(rv.amount) + '</td>'
          + '<td><span class="badge ' + st.cls + '">' + st.label + '</span>' + (p ? '<div class="small text-secondary">' + esc(p.code + ' ' + p.name) + '</div>' : '') + '</td>'
          + '<td class="text-end tnum text-nowrap">' + (rv.status === 'approved' ? won(reviewProvisional(rv)) + '<div class="small text-secondary">승인 ' + won(reviewApproved(rv)) + '</div>' : '<span class="text-secondary">-</span>') + '</td>'
          + '<td class="text-end text-nowrap">'
          + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="show-review" title="상세"><i class="ti ti-eye"></i></button>'
          + (rv.status === 'pending' ? '<button type="button" class="btn btn-sm btn-primary ms-1" data-action="approve-review">승인</button> <button type="button" class="btn btn-sm btn-outline-danger" data-action="reject-review">반려</button>' : '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reopen-review" title="심의 중으로 되돌리기"><i class="ti ti-arrow-back-up"></i></button>')
          + '<button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-review" title="삭제"><i class="ti ti-trash"></i></button></td></tr>';
      });
      after += '</tbody></table></div>';
    }
    after += '</div>';

    after += renderExportCards();

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

  function reviewAdminRow(rv) {
    return '<tr data-id="' + esc(rv.id) + '">'
      + '<td class="text-nowrap"><div>' + fmtDate(rv.createdAt) + '</div><div class="small text-secondary">' + esc(rv.requesterName) + '</div></td>'
      + '<td><div class="fw-medium">' + esc(rv.title) + '</div><div class="small text-secondary"><span class="badge badge-outline text-primary me-1">' + esc(catLabel(normCat(rv.category))) + '</span>' + (rv.items ? rv.items.length : 1) + '건 · ' + esc(rv.purpose || '') + '</div></td>'
      + '<td class="text-end tnum text-nowrap">' + won(rv.amount) + '</td>'
      + '<td>' + tierBadge(rv.amount) + '</td>'
      + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="show-review" title="상세"><i class="ti ti-eye"></i></button> '
      + '<button type="button" class="btn btn-sm btn-primary" data-action="approve-review">승인</button> '
      + '<button type="button" class="btn btn-sm btn-outline-danger" data-action="reject-review">반려</button></td></tr>';
  }

  /* ---------- 보고서 내보내기 · 이력 (관리자) ---------- */
  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return fmtDate(iso) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function exportById(id) { for (var i = 0; i < state.exports.length; i++) if (state.exports[i].id === id) return state.exports[i]; return null; }
  function reportRange(f) { return f && (f.from || f.to) ? (f.from || '…') + ' ~ ' + (f.to || '…') : '전체 기간'; }

  function applyExportForm(form) {
    var v = readForm(form);
    var f = state.exportFilter;
    var changed = v.preset !== f.preset;
    f.preset = v.preset; f.projectId = v.projectId; f.includeRequests = !!v.includeRequests; f.includeReviews = !!v.includeReviews;
    if (f.preset === 'custom') {
      if (changed && !f.from && !f.to) { var r = presetRange('month'); f.from = r.from; f.to = r.to; }
      else { f.from = v.from || ''; f.to = v.to || ''; }
    } else { var range = presetRange(f.preset); f.from = range.from; f.to = range.to; }
  }

  /* 내보내기 후보: 처리된 구매 요청(실집행) + 승인된 심의(가할당), 처리일 기준 */
  function exportCandidates() {
    var f = state.exportFilter;
    var rows = [];
    function inRange(d) { return !(f.from && d < f.from) && !(f.to && d > f.to); }
    if (f.includeRequests) {
      state.requests.forEach(function (r) {
        if (r.status !== 'done') return;
        var d = localDate(r.processedAt || r.createdAt);
        if (!inRange(d) || (f.projectId !== 'all' && r.projectId !== f.projectId)) return;
        var p = projectById(r.projectId);
        rows.push({ key: 'req:' + r.id, kind: '실집행', date: d, requester: r.requesterName, title: r.item, category: catLabel(normCat(r.category)),
          project: p ? p.name : '', code: p ? p.code : '', amount: Number(r.amount) || 0, actual: Number(r.amount) || 0, provisional: 0, by: r.processedBy || '', note: r.note || '' });
      });
    }
    if (f.includeReviews) {
      state.reviews.forEach(function (rv) {
        if (rv.status !== 'approved') return;
        var d = localDate(rv.processedAt || rv.createdAt);
        if (!inRange(d) || (f.projectId !== 'all' && rv.projectId !== f.projectId)) return;
        var p = projectById(rv.projectId);
        rows.push({ key: 'rv:' + rv.id, kind: '가할당', date: d, requester: rv.requesterName, title: rv.title, category: catLabel(normCat(rv.category)),
          project: p ? p.name : '', code: p ? p.code : '', amount: reviewApproved(rv), actual: reviewActual(rv), provisional: reviewProvisional(rv), by: rv.processedBy || '', note: rv.adminNote || '' });
      });
    }
    rows.sort(function (a, b) { return b.date.localeCompare(a.date); });
    return rows;
  }
  function isSelected(key) { return state.exportSel === null || !!state.exportSel[key]; }
  function selectedRows() { return exportCandidates().filter(function (x) { return isSelected(x.key); }); }
  function toggleExportRow(key, on) {
    if (state.exportSel === null) { state.exportSel = {}; exportCandidates().forEach(function (x) { state.exportSel[x.key] = true; }); }
    if (on) state.exportSel[key] = true; else delete state.exportSel[key];
  }

  function renderExportCards() {
    var f = state.exportFilter;
    var rows = exportCandidates();
    var sel = selectedRows();
    var total = sel.reduce(function (s, x) { return s + x.amount; }, 0);
    var projOpts = '<option value="all">모든 과제</option>' + state.projects.map(function (p) {
      return '<option value="' + esc(p.id) + '"' + (f.projectId === p.id ? ' selected' : '') + '>' + esc((p.code ? p.code + ' ' : '') + p.name) + '</option>';
    }).join('');

    var html = '<div class="card mb-3"><div class="card-header"><div><h3 class="card-title mb-0"><i class="ti ti-report me-1 text-primary"></i>보고서 내보내기 <span class="text-secondary fw-normal">승인건</span></h3>'
      + '<div class="text-secondary small mt-1">교수님께 과제 할당을 보고할 때 씁니다. 내보내면 아래 이력에 내보낸 사람·시각·항목이 남습니다.</div></div></div>'
      + '<div class="card-body border-bottom"><form id="export-form"><div class="row g-2 align-items-end">'
      + '<div class="col-6 col-md-3 col-xl-2"><label class="form-label">기간 <span class="form-label-description">처리일</span></label><select class="form-select" name="preset">'
      + PRESETS.map(function (p) { return '<option value="' + p.id + '"' + (f.preset === p.id ? ' selected' : '') + '>' + p.label + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-6 col-md-3 col-xl-2' + (f.preset === 'custom' ? '' : ' d-none') + '"><label class="form-label">시작일</label><input type="date" class="form-control" name="from" value="' + esc(f.from) + '"></div>'
      + '<div class="col-6 col-md-3 col-xl-2' + (f.preset === 'custom' ? '' : ' d-none') + '"><label class="form-label">종료일</label><input type="date" class="form-control" name="to" value="' + esc(f.to) + '"></div>'
      + '<div class="col-12 col-md-6 col-xl-4"><label class="form-label">과제</label><select class="form-select" name="projectId">' + projOpts + '</select></div>'
      + '<div class="col-12 col-md-6 col-xl-4"><label class="form-label">포함</label><div class="d-flex gap-3 pb-2">'
      + '<label class="form-check mb-0"><input class="form-check-input" type="checkbox" name="includeRequests"' + (f.includeRequests ? ' checked' : '') + '><span class="form-check-label">실집행 (처리된 구매건)</span></label>'
      + '<label class="form-check mb-0"><input class="form-check-input" type="checkbox" name="includeReviews"' + (f.includeReviews ? ' checked' : '') + '><span class="form-check-label">가할당 (승인된 심의)</span></label></div></div>'
      + '</div></form></div>';

    if (!rows.length) {
      html += '<div class="card-body">' + empty('file-off', '조건에 맞는 승인건이 없습니다', '기간이나 포함 항목을 바꿔 보세요.') + '</div>';
    } else {
      html += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1"><input class="form-check-input m-0" type="checkbox" data-action="export-select-all"' + (state.exportSel === null ? ' checked' : '') + ' aria-label="전체 선택"></th>'
        + '<th class="w-1">유형</th><th class="w-1">처리일</th><th class="w-1">신청자</th><th>항목</th><th>과제</th><th class="text-end">금액</th></tr></thead><tbody>';
      rows.forEach(function (x) {
        html += '<tr data-key="' + esc(x.key) + '"' + (isSelected(x.key) ? '' : ' class="text-secondary"') + '><td><input class="form-check-input m-0" type="checkbox" data-action="export-select"' + (isSelected(x.key) ? ' checked' : '') + ' aria-label="선택"></td>'
          + '<td><span class="badge ' + (x.kind === '실집행' ? 'bg-blue-lt' : 'bg-green-lt') + '">' + x.kind + '</span></td>'
          + '<td class="text-nowrap">' + esc(x.date.replace(/-/g, '.')) + '</td>'
          + '<td class="text-nowrap">' + esc(x.requester) + '</td>'
          + '<td><div class="fw-medium">' + esc(x.title) + '</div><div class="small text-secondary"><span class="badge badge-outline text-primary me-1">' + esc(x.category) + '</span>'
          + (x.kind === '가할당' ? '실집행 ' + won(x.actual) + ' · 잔여 ' + won(x.provisional) : esc(x.note)) + '</div></td>'
          + '<td>' + esc(x.project) + '<div class="small text-secondary">' + esc(x.code) + '</div></td>'
          + '<td class="text-end tnum text-nowrap">' + won(x.amount) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '<div class="card-body d-flex flex-wrap align-items-center gap-2">'
      + '<div class="me-auto"><strong>' + sel.length + '건</strong> 선택 · 합계 <span class="tnum fw-medium">' + won(total) + '</span></div>'
      + '<input type="text" class="form-control" style="max-width:300px" id="export-purpose" value="' + esc(state.exportPurpose) + '" placeholder="보고 메모 (예: 9월 과제 할당 보고)">'
      + '<button type="button" class="btn" data-action="export-csv-report"' + (sel.length ? '' : ' disabled') + '><i class="ti ti-file-spreadsheet me-1"></i>CSV</button>'
      + '<button type="button" class="btn btn-primary" data-action="export-print-report"' + (sel.length ? '' : ' disabled') + '><i class="ti ti-printer me-1"></i>인쇄용 보고서</button>'
      + '</div></div>';

    html += '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-archive me-1 text-primary"></i>내보내기 이력 <span class="text-secondary fw-normal">' + state.exports.length + '건</span></h3>'
      + '<div class="card-actions small text-secondary">기록은 지워지지 않으며 당시 스냅샷을 그대로 다시 받을 수 있습니다</div></div>';
    if (!state.exports.length) {
      html += '<div class="card-body">' + empty('archive-off', '아직 내보낸 기록이 없습니다', '') + '</div>';
    } else {
      html += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr>'
        + '<th class="w-1">일시</th><th class="w-1">내보낸 사람</th><th>메모 · 조건</th><th class="w-1">형식</th><th class="text-end">건수</th><th class="text-end">합계</th><th class="w-1"></th></tr></thead><tbody>';
      state.exports.forEach(function (lg) {
        var inc = [];
        if (lg.filter && lg.filter.includeRequests) inc.push('실집행');
        if (lg.filter && lg.filter.includeReviews) inc.push('가할당');
        var pj = lg.filter && lg.filter.projectId && lg.filter.projectId !== 'all' ? projectById(lg.filter.projectId) : null;
        html += '<tr data-id="' + esc(lg.id) + '"><td class="text-nowrap">' + fmtDateTime(lg.createdAt) + '</td>'
          + '<td class="text-nowrap">' + esc(lg.exportedBy) + '</td>'
          + '<td><div class="fw-medium">' + (lg.purpose ? esc(lg.purpose) : '<span class="text-secondary">메모 없음</span>') + '</div>'
          + '<div class="small text-secondary">' + esc(reportRange(lg.filter)) + ' · ' + esc(inc.join('+') || '-') + (pj ? ' · ' + esc(pj.code || pj.name) : ' · 모든 과제') + '</div></td>'
          + '<td><span class="badge bg-secondary-lt">' + (lg.format === 'print' ? '보고서' : 'CSV') + '</span></td>'
          + '<td class="text-end tnum">' + esc(lg.count) + '</td>'
          + '<td class="text-end tnum text-nowrap">' + won(lg.totalAmount) + '</td>'
          + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="show-export" title="포함 항목 보기"><i class="ti ti-eye"></i></button>'
          + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="redownload-export" title="CSV 다시 받기"><i class="ti ti-download"></i></button>'
          + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reprint-export" title="보고서 다시 열기"><i class="ti ti-printer"></i></button></td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    return html;
  }

  function doExport(format) {
    var rows = selectedRows();
    if (!rows.length) { toast('내보낼 항목을 선택하세요.', true); return; }
    var w = format === 'print' ? window.open('', '_blank') : null;
    if (format === 'print' && !w) { toast('팝업이 차단되었습니다. 이 사이트의 팝업을 허용해 주세요.', true); return; }
    var f = state.exportFilter;
    var rec = {
      purpose: (state.exportPurpose || '').trim(), format: format, count: rows.length,
      totalAmount: rows.reduce(function (s, x) { return s + x.amount; }, 0),
      filter: { from: f.from, to: f.to, projectId: f.projectId, includeRequests: f.includeRequests, includeReviews: f.includeReviews },
      rows: rows.map(function (x) { return { key: x.key, kind: x.kind, date: x.date, requester: x.requester, title: x.title, category: x.category, project: x.project, code: x.code, amount: x.amount, actual: x.actual, provisional: x.provisional, by: x.by, note: x.note }; })
    };
    store.createExport(rec).then(function (log) {
      if (format === 'csv') downloadReportCsv(log); else openPrintReport(log, w);
      toast('내보내기 완료 · 이력에 기록했습니다.');
      state.exportPurpose = '';
      touchUnlock();
      return refresh();
    }).catch(function (err) { if (w) w.close(); handleError(err); });
  }

  function downloadReportCsv(log) {
    var head = ['유형', '처리일', '신청자', '항목', '비목', '과제', '과제번호', '금액', '실집행', '가할당 잔여', '처리자', '메모'];
    var lines = (log.rows || []).map(function (x) {
      return [x.kind, x.date, x.requester, x.title, x.category, x.project, x.code, x.amount, x.actual, x.provisional, x.by, x.note].map(csvCell).join(',');
    });
    lines.push(['합계', '', '', '', '', '', '', log.totalAmount, '', '', '', ''].map(csvCell).join(','));
    var meta = csvCell('DSIL 과제 할당 보고 · ' + reportRange(log.filter) + ' · 내보낸 사람 ' + log.exportedBy + ' · ' + fmtDateTime(log.createdAt) + (log.purpose ? ' · ' + log.purpose : ''));
    download('dsil-report-' + localDate(log.createdAt) + '.csv', '﻿' + meta + '\r\n' + head.join(',') + '\r\n' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function openPrintReport(log, w) {
    if (!w) { w = window.open('', '_blank'); }
    if (!w) { toast('팝업이 차단되었습니다. 이 사이트의 팝업을 허용해 주세요.', true); return; }
    var groups = [], map = {};
    var sumActual = 0, sumProv = 0;
    (log.rows || []).forEach(function (x) {
      var k = x.code + '|' + x.project;
      if (!map[k]) { map[k] = { project: x.project, code: x.code, rows: [], amount: 0 }; groups.push(map[k]); }
      map[k].rows.push(x); map[k].amount += Number(x.amount) || 0;
      if (x.kind === '실집행') sumActual += Number(x.amount) || 0; else sumProv += Number(x.amount) || 0;
    });
    var body = groups.map(function (g) {
      return '<h2>' + esc(g.project || '(과제 미지정)') + (g.code ? ' <span class="code">' + esc(g.code) + '</span>' : '') + '</h2>'
        + '<table><thead><tr><th>유형</th><th>처리일</th><th>신청자</th><th>항목</th><th>비목</th><th class="num">금액</th><th>비고</th></tr></thead><tbody>'
        + g.rows.map(function (x) {
          return '<tr><td><span class="kind' + (x.kind === '가할당' ? ' prov' : '') + '">' + x.kind + '</span></td><td>' + esc(x.date.replace(/-/g, '.')) + '</td><td>' + esc(x.requester) + '</td><td>' + esc(x.title) + '</td><td>' + esc(x.category) + '</td>'
            + '<td class="num">' + won(x.amount) + '</td><td class="muted">' + (x.kind === '가할당' ? '실집행 ' + won(x.actual) + ' · 잔여 ' + won(x.provisional) : esc(x.note)) + '</td></tr>';
        }).join('')
        + '<tr class="sub"><td colspan="5">소계 · ' + g.rows.length + '건</td><td class="num">' + won(g.amount) + '</td><td></td></tr>'
        + '</tbody></table>';
    }).join('');
    var html = '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><title>DSIL 과제 할당 보고 ' + esc(localDate(log.createdAt)) + '</title>'
      + '<style>body{font-family:Pretendard,"Malgun Gothic","Apple SD Gothic Neo",sans-serif;margin:36px;color:#111;line-height:1.5}'
      + 'h1{font-size:20px;color:#0c2f5f;border-bottom:3px solid #004191;padding-bottom:8px;margin:0 0 6px}h2{font-size:14px;margin:22px 0 6px;color:#0c2f5f}.code{font-weight:400;color:#555;font-size:12px}'
      + '.meta{color:#555;font-size:12.5px;margin-bottom:8px}table{width:100%;border-collapse:collapse;font-size:12px}th,td{border-bottom:1px solid #ddd;padding:5px 7px;text-align:left;vertical-align:top}th{background:#f3f5f8;font-weight:600}'
      + 'td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.sub td{background:#fafbfd;font-weight:600}.muted{color:#666}'
      + '.kind{font-size:10.5px;padding:1px 6px;border-radius:4px;background:#e8eef8;color:#004191;white-space:nowrap}.kind.prov{background:#e6f4ea;color:#1a7f37}'
      + '.total{margin-top:22px;border:1px solid #ddd;padding:10px 14px;display:flex;gap:28px;font-size:13px}.total strong{font-variant-numeric:tabular-nums}'
      + '.actions{margin-top:24px}.actions button{font:inherit;padding:8px 14px;border:1px solid #004191;background:#004191;color:#fff;border-radius:6px;cursor:pointer}'
      + '@media print{.actions{display:none}body{margin:12mm}}</style></head><body>'
      + '<h1>DSIL 과제 할당 보고</h1>'
      + '<div class="meta">기간 ' + esc(reportRange(log.filter)) + ' (처리일 기준) · 내보낸 사람 ' + esc(log.exportedBy) + ' · ' + esc(fmtDateTime(log.createdAt)) + (log.purpose ? ' · ' + esc(log.purpose) : '') + '</div>'
      + '<div class="meta">실집행 = 처리된 구매 요청, 가할당 = 승인된 구매 심의 중 아직 집행되지 않은 배정액</div>'
      + body
      + '<div class="total"><span>실집행 <strong>' + won(sumActual) + '</strong></span><span>가할당(승인) <strong>' + won(sumProv) + '</strong></span><span>총계 <strong>' + won(log.totalAmount) + '</strong> · ' + esc(log.count) + '건</span></div>'
      + '<div class="actions"><button type="button" onclick="window.print()">인쇄 / PDF 저장</button></div>'
      + '</body></html>';
    w.document.open(); w.document.write(html); w.document.close();
  }

  function showExportLog(log) {
    var html = '<div class="datagrid mb-3">'
      + dg('일시', fmtDateTime(log.createdAt)) + dg('내보낸 사람', esc(log.exportedBy)) + dg('형식', log.format === 'print' ? '인쇄용 보고서' : 'CSV')
      + dg('기간', esc(reportRange(log.filter))) + dg('건수 · 합계', esc(log.count) + '건 · <span class="tnum">' + won(log.totalAmount) + '</span>')
      + (log.purpose ? dg('메모', esc(log.purpose)) : '') + '</div>'
      + '<div class="table-responsive"><table class="table table-sm table-vcenter mb-0"><thead><tr><th>유형</th><th>처리일</th><th>신청자</th><th>항목</th><th>과제</th><th class="text-end">금액</th></tr></thead><tbody>'
      + (log.rows || []).map(function (x) {
        return '<tr><td><span class="badge ' + (x.kind === '실집행' ? 'bg-blue-lt' : 'bg-green-lt') + '">' + x.kind + '</span></td><td class="text-nowrap">' + esc(x.date.replace(/-/g, '.')) + '</td><td class="text-nowrap">' + esc(x.requester) + '</td>'
          + '<td>' + esc(x.title) + ' <span class="text-secondary small">' + esc(x.category) + '</span></td><td>' + esc(x.code || x.project) + '</td><td class="text-end tnum">' + won(x.amount) + '</td></tr>';
      }).join('') + '</tbody></table></div>';
    return dialog({ title: '내보내기 이력 · ' + fmtDateTime(log.createdAt), html: html, size: 'lg', okLabel: '닫기', hideCancel: true });
  }

  /* ---------- 요청 수정 모달 ---------- */
  function editRequest(id) {
    var r = requestById(id);
    if (!r) return Promise.resolve();
    var admin = isAdminActive();
    var body = '<div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">품명</label><input type="text" class="form-control" name="item" required value="' + esc(r.item) + '"></div>'
      + '<div class="col-sm-5"><label class="form-label">비목</label><select class="form-select" name="category">' + catOptions(normCat(r.category)) + '</select></div>'
      + '<div class="col-sm-7"><label class="form-label">구매처 / 링크</label><input type="url" class="form-control" name="link" value="' + esc(r.link) + '"></div>'
      + '<div class="col-6"><label class="form-label required">수량</label><input type="number" class="form-control" name="qty" min="1" step="1" required value="' + esc(r.qty) + '"></div>'
      + '<div class="col-6"><label class="form-label required">단가 (원)</label><input type="number" class="form-control" name="unitPrice" min="0" step="1" required value="' + esc(r.unitPrice) + '"></div>'
      + '<div class="col-12"><label class="form-label">용도 / 메모</label><textarea class="form-control" name="note" rows="2">' + esc(r.note) + '</textarea></div>'
      + (admin ? '<div class="col-12"><label class="form-label">관리자 메모 <span class="form-label-description">반려 시 신청자에게 표시</span></label><input type="text" class="form-control" name="adminNote" value="' + esc(r.adminNote) + '"></div>' : '')
      + '</div>';
    return dialog({ title: '요청 수정', bodyHtml: body, size: 'lg', okLabel: '저장' }).then(function (v) {
      if (!v) return;
      var qty = Math.max(1, parseInt(v.qty, 10) || 1);
      var unit = Math.max(0, Math.round(Number(v.unitPrice) || 0));
      var patch = { item: v.item.trim(), category: normCat(v.category), link: v.link.trim(), qty: qty, unitPrice: unit, amount: qty * unit, note: v.note.trim() };
      if (admin) patch.adminNote = v.adminNote.trim();
      return store.updateRequest(id, patch).then(function () { toast('요청을 수정했습니다.'); touchUnlock(); return refresh(); });
    });
  }

  /* ---------- CSV ---------- */
  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportCsv(list) {
    var head = ['요청일', '신청자', '품명', '비목', '수량', '단가', '합계', '상태', '배정 과제', '과제번호', '연결 심의', '처리일', '처리자', '메모', '반려 사유', '링크'];
    var rows = list.map(function (r) {
      var p = r.projectId ? projectById(r.projectId) : null;
      var rv = r.reviewId ? reviewById(r.reviewId) : null;
      return [localDate(r.createdAt), r.requesterName, r.item, catLabel(normCat(r.category)), r.qty, r.unitPrice, r.amount,
        (STATUS[r.status] || { label: r.status }).label, p ? p.name : '', p ? p.code : '', rv ? rv.title : (r.reviewId ? '연결됨' : ''), localDate(r.processedAt), r.processedBy || '', r.note, r.status === 'rejected' ? r.adminNote : '', r.link].map(csvCell).join(',');
    });
    var q = state.query;
    var name = 'dsil-requests-' + (q.from || 'all') + '_' + (q.to || 'all') + '.csv';
    download(name, '﻿' + head.join(',') + '\r\n' + rows.join('\r\n'), 'text/csv;charset=utf-8');
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

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
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

  function applyQueryForm(form) {
    var v = readForm(form);
    var q = state.query;
    var presetChanged = v.preset !== q.preset;
    q.preset = v.preset; q.status = v.status; q.category = v.category; q.projectId = v.projectId; q.q = v.q || ''; q.mine = !!v.mine; q.groupBy = v.groupBy;
    if (q.preset === 'custom') {
      if (presetChanged && !q.from && !q.to) { var r = presetRange('month'); q.from = r.from; q.to = r.to; }
      else { q.from = v.from || ''; q.to = v.to || ''; }
    } else {
      var range = presetRange(q.preset); q.from = range.from; q.to = range.to;
    }
  }

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
      store.createRequest({ item: r.item.trim(), category: normCat(r.category), link: r.link.trim(), qty: qty, unitPrice: unit, amount: qty * unit, note: r.note.trim(), reviewId: r.reviewId || null })
        .then(function () { toast('요청을 제출했습니다. 관리자 처리 후 상태가 바뀝니다.'); return refresh(); })
        .catch(handleError);
    }
    if (form.id === 'review-form') {
      e.preventDefault();
      var v = readForm(form);
      var items = readReviewItems(form);
      var amount = items.reduce(function (s, it) { return s + it.amount; }, 0);
      if (!v.title.trim()) { toast('제목을 입력하세요.', true); return; }
      if (!items.length || amount <= 0) { toast('구매 건과 금액을 하나 이상 입력하세요.', true); return; }
      if (!PIN_RE.test(v.pin)) { toast('열람 PIN은 숫자 4~8자리로 정하세요.', true); return; }
      if (v.pin !== v.pin2) { toast('PIN 확인이 일치하지 않습니다.', true); return; }
      window.DSILStore.hashPin(v.pin).then(function (h) {
        return store.createReview({ title: v.title.trim(), category: normCat(v.category), vendor: v.vendor.trim(), purpose: v.purpose.trim(), items: items, amount: amount, note: v.note.trim(), pinHash: h });
      }).then(function () {
        toast('심의 요청을 제출했습니다. 승인 여부는 목록에서, 내용은 PIN으로 열어 볼 수 있습니다.');
        return refresh();
      }).catch(handleError);
    }
    if (form.id === 'query-form') {
      e.preventDefault();
      applyQueryForm(form); render();
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
      var tier = $('#request-tier'); if (tier) tier.innerHTML = qty * unit > 0 ? '적용 절차 ' + tierBadge(qty * unit) : '';
      return;
    }
    var vf = e.target.closest('#review-form');
    if (vf) { updateReviewTotals(vf); return; }
    if (e.target.id === 'export-purpose') { state.exportPurpose = e.target.value; return; }
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
    var qf = el.closest('#query-form');
    if (qf && el.name !== 'q') { applyQueryForm(qf); render(); return; }
    var xf = el.closest('#export-form');
    if (xf) { applyExportForm(xf); state.exportSel = null; render(); return; }
    if (action === 'export-select-all') { state.exportSel = el.checked ? null : {}; render(); return; }
    if (action === 'export-select') { toggleExportRow(el.closest('tr[data-key]').getAttribute('data-key'), el.checked); render(); return; }
    if (action === 'import' && el.files && el.files[0]) {
      var reader = new FileReader();
      reader.onload = function () {
        try { store.importJSON(JSON.parse(reader.result)); toast('가져오기 완료'); refresh(); }
        catch (err) { handleError(err); }
      };
      reader.readAsText(el.files[0]);
    }
    if (role === 'assign-cat') {
      var row = el.closest('tr[data-id]');
      var sel = row && row.querySelector('select[data-role="assign-project"]');
      var req = row && requestById(row.getAttribute('data-id'));
      if (sel && req) sel.innerHTML = projectOptions(req.amount, normCat(el.value), sel.value);
    }
    var mf = el.closest('#modal-form');
    if (mf && el.name === 'category' && mf.elements.projectId) {
      var amt = mf.elements.approvedAmount ? Number(mf.elements.approvedAmount.value) || 0 : 0;
      mf.elements.projectId.innerHTML = projectOptions(amt, normCat(el.value), mf.elements.projectId.value);
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    var row = btn.closest('[data-id]');
    var id = row ? row.getAttribute('data-id') : null;

    switch (action) {
      case 'tab': {
        e.preventDefault();
        var t = btn.getAttribute('data-tab');
        if (t === 'budget') t = 'admin';
        if (t === 'admin' && !isAdminActive()) { enterAdmin('admin'); return; }
        if (btn.getAttribute('data-mine')) { state.query.mine = true; state.query.preset = 'all'; state.query.from = ''; state.query.to = ''; }
        state.tab = t; render();
        break;
      }
      case 'unlock-admin':
        enterAdmin('admin'); break;
      case 'unlock-budget':
        enterAdmin('admin'); break;
      case 'lock-admin':
        setUnlock(false); state.tab = 'requests'; toast('관리자 화면을 잠갔습니다.'); refresh(); break;
      case 'refresh':
        refresh().then(function () { toast('새로고침 완료'); }); break;
      case 'signout':
        setUnlock(false);
        store.signOut().then(function () { window.location.replace('../index.html'); }); break;
      case 'export-csv':
        exportCsv(queryResults()); break;
      case 'add-review-item': {
        var box = $('#review-items');
        if (box) { box.insertAdjacentHTML('beforeend', reviewItemRow('', '')); box.lastElementChild.querySelector('input').focus(); }
        break;
      }
      case 'remove-review-item': {
        var item = btn.closest('.review-item');
        var box2 = $('#review-items');
        if (item && box2 && box2.children.length > 1) { item.remove(); updateReviewTotals($('#review-form')); }
        else if (item) { $all('input', item).forEach(function (i) { i.value = ''; }); updateReviewTotals($('#review-form')); }
        break;
      }
      case 'open-review':
        openReviewWithPin(id).catch(handleError); break;
      case 'show-review': {
        var rv = reviewById(id);
        if (rv && !rv.limited) showReview(rv); else openReviewWithPin(id).catch(handleError);
        break;
      }
      case 'approve-review':
        approveReview(id).catch(handleError); break;
      case 'reject-review':
        promptDlg({ title: '심의 반려', message: '반려 사유를 적어 주세요. 신청자가 PIN으로 열람하면 표시됩니다.', input: 'textarea', placeholder: '예: 견적 재확인 필요', okLabel: '반려', danger: true }).then(function (reason) {
          if (reason === null) return;
          return store.updateReview(id, { status: 'rejected', projectId: null, approvedAmount: null, adminNote: reason.trim(), processedAt: new Date().toISOString(), processedBy: state.session.user.name })
            .then(function () { toast('심의를 반려했습니다.'); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      case 'reopen-review':
        store.updateReview(id, { status: 'pending', projectId: null, approvedAmount: null, adminNote: '', processedAt: null, processedBy: null })
          .then(function () { toast('심의 중으로 되돌렸습니다.'); touchUnlock(); return refresh(); }).catch(handleError);
        break;
      case 'delete-review':
        confirmDlg({ title: '심의 삭제', message: '이 심의를 삭제할까요? 연결된 구매 요청이 있으면 삭제되지 않습니다.', okLabel: '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.deleteReview(id).then(function () { toast('심의를 삭제했습니다.'); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      case 'assign': {
        var sel = row.querySelector('select[data-role="assign-project"]');
        var catSel = row.querySelector('select[data-role="assign-cat"]');
        var pid = sel && sel.value;
        var cat = normCat(catSel && catSel.value);
        if (!pid) { toast('배정할 과제를 선택하세요.', true); return; }
        var req = requestById(id);
        var proj = projectById(pid);
        var stats = projectStats(proj);
        var remain = stats.byCat[cat].remain;
        var linkedRv = req.reviewId ? reviewById(req.reviewId) : null;
        /* 심의 연결 건은 그 심의의 가할당이 실집행으로 바뀌므로, 잔액 판정에 그만큼을 더해 준다 */
        if (linkedRv && linkedRv.status === 'approved' && linkedRv.projectId === pid && normCat(linkedRv.category) === cat) remain += reviewProvisional(linkedRv);
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
      case 'edit-request':
        editRequest(id).catch(handleError); break;
      case 'delete-request': {
        var target = requestById(id);
        var ownPending = target && isMine(target) && target.status === 'pending' && !isAdminActive();
        confirmDlg({ title: ownPending ? '요청 취소' : '요청 삭제', message: ownPending ? '이 요청을 취소할까요?' : '이 요청을 삭제할까요? 되돌릴 수 없습니다.', okLabel: ownPending ? '취소하기' : '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.deleteRequest(id).then(function () { toast(ownPending ? '요청을 취소했습니다.' : '삭제했습니다.'); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'edit-project': {
        state.editingProjectId = id; render();
        var f = $('#project-form'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      }
      case 'cancel-edit':
        state.editingProjectId = null; render(); break;
      case 'delete-project':
        confirmDlg({ title: '과제 삭제', message: '이 과제를 삭제할까요? 배정된 구매건이나 심의가 있는 과제는 삭제되지 않습니다.', okLabel: '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.deleteProject(id).then(function () { toast('과제를 삭제했습니다.'); touchUnlock(); return refresh(); });
        }).catch(handleError);
        break;
      case 'export-csv-report':
        doExport('csv'); break;
      case 'export-print-report':
        doExport('print'); break;
      case 'show-export': {
        var lg = exportById(id); if (lg) showExportLog(lg);
        break;
      }
      case 'redownload-export': {
        var lg2 = exportById(id); if (lg2) downloadReportCsv(lg2);
        break;
      }
      case 'reprint-export': {
        var lg3 = exportById(id); if (lg3) openPrintReport(lg3, window.open('', '_blank'));
        break;
      }
      case 'export':
        download('dsil-budget-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(store.exportJSON(), null, 2));
        break;
      case 'reset-demo':
        confirmDlg({ title: '예시 데이터로 초기화', message: '모든 데이터를 지우고 예시 데이터로 되돌릴까요? 예시 심의의 열람 PIN은 1234 입니다.', okLabel: '초기화', danger: true }).then(function (ok) {
          if (!ok) return;
          store.resetDemo(); toast('예시 데이터로 초기화했습니다.'); return refresh();
        }).catch(handleError);
        break;
    }
  });

  /* ---------- boot ---------- */
  var initialTab = (window.location.hash || '').replace('#', '');
  if (initialTab === 'budget') initialTab = 'admin';
  if (TABS.indexOf(initialTab) >= 0) state.tab = initialTab;
  (function () {
    var r = presetRange(state.query.preset); state.query.from = r.from; state.query.to = r.to;
    var x = presetRange(state.exportFilter.preset); state.exportFilter.from = x.from; state.exportFilter.to = x.to;
  })();

  function requireSession() {
    var s = store.getSession();
    if (s && s.status !== 'pending') return true;
    window.location.replace('../index.html?next=budget');
    return false;
  }

  store.init().then(function () {
    if (!requireSession()) return;
    state.ready = true;
    store.onChange(function () { reload().then(render).catch(handleError); });
    return reload();
  }).then(render).catch(function (err) {
    state.error = err && err.message ? err.message : String(err);
    render();
  });
})();
