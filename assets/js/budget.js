/* =====================================================================
   DSIL Lab Portal – 과제별 예산 관리 (UI, Tabler 컴포넌트 사용)
   탭: 구매 요청 · 요청 조회 · 구매 심의 · 관리자(PIN: 미처리 배정 + 과제 예산 대시보드)
   과제 예산은 관리자만 봅니다. 잔액 계산은 budget-core.js (기준 잔액 − 기준일 이후 집행 − 가할당)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var BUD = window.DSILBudget.create(CFG);
  var CATS = BUD.CATS;
  var CAT_IDS = BUD.CAT_IDS;
  var TIERS = (CFG.procurementTiers && CFG.procurementTiers.length) ? CFG.procurementTiers : [{ upTo: null, label: '기준 없음', cls: 'bg-secondary-lt', desc: '' }];
  var PIN_RE = new RegExp('^' + (CFG.reviewPinPattern || '\\d{4,8}') + '$');
  var store = window.DSILStore.create(CFG);
  var UNLOCK_KEY = 'dsil-budget-admin-unlock';
  var TABS = ['requests', 'query', 'review', 'admin'];
  var PR = Object.assign({ teams: [], professorThreshold: 5000000, cycles: ['일회성', '매월', '비정기(필요할 때마다)'], usageMinLength: 10 }, CFG.purchaseRequest || {});
  var USAGE_MIN = Number(PR.usageMinLength) || 0;
  var PROF_MIN = Number(PR.professorThreshold) || 5000000;   /* 이 금액 초과: 교수님 컨펌 (구매행정) */
  var URG = {
    must: { label: '올해 소진 필요', cls: 'bg-red-lt', dot: 'bg-red' },
    soon: { label: '종료 임박', cls: 'bg-orange-lt', dot: 'bg-orange' },
    later: { label: '여유', cls: 'bg-green-lt', dot: 'bg-green' },
    check: { label: '집행 전 확인', cls: 'bg-secondary-lt', dot: 'bg-secondary' },
    ended: { label: '종료', cls: 'bg-secondary-lt', dot: 'bg-secondary' }
  };

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
    budgetSort: 'urgency',
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
  function poolOf(id) { return BUD.poolOf(id); }
  function budgetOf(p, cat) { return Number(p.budgets && p.budgets[cat]) || 0; }
  /* 고를 수 있는 비목은 행정 세목(연구재료비·연구활동비·연구시설·장비비)만. 회의비 등은 해당 세목으로 */
  function catOptions(selected, withAll) {
    var sel = selected === 'all' ? 'all' : poolOf(selected);
    return (withAll ? '<option value="all"' + (sel === 'all' ? ' selected' : '') + '>모든 세목</option>' : '') + BUD.POOLS.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.label) + '</option>';
    }).join('');
  }
  function cycleOptions(selected) {
    return '<option value="">선택…</option>' + PR.cycles.map(function (c) { return '<option value="' + esc(c) + '"' + (c === selected ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('')
      + (selected && PR.cycles.indexOf(selected) < 0 ? '<option value="' + esc(selected) + '" selected>' + esc(selected) + '</option>' : '');
  }
  /* 구매 컨펌: 팀(중간관리자) · 관련 과제 */
  function teamManager(id) { var t = PR.teams.filter(function (x) { return x.id === id; })[0]; return t && t.manager ? t.manager : ''; }
  function teamOptions(selected) {
    return '<option value="">팀 선택…</option>' + PR.teams.map(function (t) {
      return '<option value="' + esc(t.id) + '"' + (t.id === selected ? ' selected' : '') + '>' + esc(t.id) + (t.manager ? ' · 중간관리자 ' + esc(t.manager) : '') + '</option>';
    }).join('');
  }
  /* 구성원이 고르는 관련 과제: 이름만 (예산 정보 없음), 예산 관리 제외 과제는 빼고 */
  function relatedOptions(selected) {
    var list = state.projects.filter(function (p) { return BUD.isManaged(p) || p.id === selected; })
      .sort(function (a, b) { return String(a.alias || a.name).localeCompare(String(b.alias || b.name), 'ko'); });
    return '<option value="">과제 선택…</option>' + list.map(function (p) {
      var full = p.alias && p.alias !== p.name ? ' · ' + (p.name.length > 26 ? p.name.slice(0, 26) + '…' : p.name) : '';
      return '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + ' title="' + esc(p.name) + '">' + esc((p.alias || p.name) + full) + '</option>';
    }).join('') + '<option value="unknown"' + (selected === 'unknown' ? ' selected' : '') + '>잘 모르겠음 (관리자가 판단)</option>';
  }
  function relatedName(r) {
    if (r.kind === 'meeting' || !r.meta) return '';
    var p = r.meta.suggestedProjectId ? projectById(r.meta.suggestedProjectId) : null;
    return p ? (p.alias || p.name) : (r.meta.relatedUnknown ? '모름' : '');
  }
  function needsProfessor(amount) { return (Number(amount) || 0) > PROF_MIN; }
  function confirmGuideHtml(amount) {
    return needsProfessor(amount)
      ? '<div class="alert alert-warning py-2 mb-0 small"><i class="ti ti-alert-triangle me-1"></i><strong>' + won(PROF_MIN) + ' 초과</strong>: 구매행정 시스템으로 <strong>교수님 컨펌</strong>을 받은 뒤 올려 주세요. 컨펌한 사람에 교수님 성함을 적습니다.</div>'
      : '<div class="alert alert-secondary py-2 mb-0 small"><i class="ti ti-users me-1"></i><strong>' + won(PROF_MIN) + ' 이하</strong>: 팀 <strong>중간관리자</strong>가 컨펌합니다. 교수님 컨펌이 꼭 필요한 물품은 중간관리자가 판단해 교수님께 컨펌받습니다.</div>';
  }
  function confirmBadges(r) {
    var m = r.meta || {};
    if (!m.team && !m.confirmedBy) return '';
    return '<span class="badge bg-azure-lt me-1" title="팀 · 컨펌한 사람"><i class="ti ti-user-check me-1"></i>' + esc([m.team, m.confirmedBy ? m.confirmedBy + ' 컨펌' : ''].filter(Boolean).join(' · ')) + '</span>';
  }

  /* 빠진 항목은 빨간 테두리 + 토스트로 알림 (버튼은 잠그지 않음) */
  function markMissing(form, checks) {
    $all('.is-invalid', form).forEach(function (el) { el.classList.remove('is-invalid'); });
    var miss = [], first = null;
    checks.forEach(function (c) {
      if (c.ok) return;
      miss.push(c.label);
      var el = form.querySelector('[name="' + c.name + '"]');
      if (el) { el.classList.add('is-invalid'); if (!first) first = el; }
    });
    if (miss.length) { toast('빠진 항목: ' + miss.join(', '), true); if (first) first.focus(); }
    return !miss.length;
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

  /* 과제 집계 (budget-core). 세목별 기준 잔액 − 기준일 이후 실집행 − 가할당(승인된 구매 심의 중 미집행).
     byCat[비목] 은 그 비목이 차감되는 세목(통합 잔액 과제는 통합) 집계를 가리킴 */
  function budgetCtx() { return { requests: state.requests, reviews: state.reviewsFull ? state.reviews : [] }; }
  function projectStats(p) {
    var s = BUD.stats(p, budgetCtx());
    var byCat = {};
    CAT_IDS.forEach(function (c) { byCat[c] = s.unified ? s.pools.unified : s.pools[poolOf(c)]; });
    var committed = s.actual + s.provisional;
    return { total: s.budget, actual: s.actual, provisional: s.provisional, committed: committed, remain: s.remain, unified: s.unified, pools: s.pools,
      ratio: s.budget > 0 ? committed / s.budget : (committed > 0 ? 1 : 0), actualRatio: s.budget > 0 ? s.actual / s.budget : 0, byCat: byCat };
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
      if (!BUD.isManaged(p)) return;
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
      if (q.category !== 'all' && poolOf(r.category) !== q.category) return false;
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
      if (state.tab === 'budget') state.tab = 'admin';   /* 예전 주소(#budget) */
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
        + stat('현재 잔액', won(sum.totalRemain), '기준 ' + won(sum.totalBudget) + ' − 집행 ' + won(sum.totalActual) + ' − 가할당 ' + won(sum.totalProvisional), 'text-primary', 'col-6 col-lg-3')
        + stat('올해 소진 필요', won(mustSpendSummary().total), mustSpendSummary().count + '개 과제 · 이월불가·종료', mustSpendSummary().total > 0 ? 'text-red' : '', 'col-6 col-lg-3')
        + '</div>';
    } else {
      html = '<div class="row row-deck row-cards mb-3">'
        + stat('내 미처리 요청', sum.my.pending + '건', won(sum.my.pendingAmount) + ' 대기 중', 'text-yellow', 'col-12 col-md-4')
        + stat('내 처리 완료', sum.my.done + '건', won(sum.my.doneAmount) + ' 집행' + (sum.my.rejected ? ' · 반려 ' + sum.my.rejected + '건' : ''), 'text-primary', 'col-6 col-md-4')
        + stat('내 구매 심의', (sum.my.rvPending + sum.my.rvApproved + sum.my.rvRejected) + '건', '심의 중 ' + sum.my.rvPending + ' · 승인 ' + sum.my.rvApproved + ' · 반려 ' + sum.my.rvRejected, '', 'col-6 col-md-4')
        + '</div>';
    }

    /* 과제 예산은 관리자 탭에만 있습니다. (state.tab 은 그대로 두고 화면에 그릴 탭만 계산) */
    var view = state.tab === 'budget' ? 'admin' : state.tab;
    if (view === 'admin' && !isAdminEligible()) view = 'requests';
    state.view = view;
    var tab = view === 'query' ? renderQueryTab()
      : view === 'review' ? renderReviewTab()
      : view === 'admin' ? renderAdminTab()
      : renderRequestsTab();

    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('requests', 'cart-plus', '구매 요청')
      + tabLink('query', 'list-search', '요청 조회')
      + tabLink('review', 'shield-check', '구매 심의', sum.my.rvPending && !isAdminActive() ? '<span class="badge bg-yellow-lt ms-2">' + sum.my.rvPending + '</span>' : '')
      + (isAdminEligible() ? tabLink('admin', state.adminUnlocked ? 'lock-open' : 'lock', '관리자 · 과제 예산', (sum.pendingCount + sum.reviewPending) && state.adminUnlocked ? '<span class="badge bg-yellow-lt ms-2">' + (sum.pendingCount + sum.reviewPending) + '</span>' : '') : '')
      + '</ul></div>' + tab.body + '</div>' + (tab.after || '');

    app.innerHTML = html;
    try { history.replaceState(null, '', '#' + view); } catch (e) { /* 샌드박스 뷰어에서는 막힐 수 있음 */ }
  }

  function stat(label, value, sub, cls, col) {
    return '<div class="' + (col || 'col-6 col-lg-3') + '"><div class="card card-sm"><div class="card-body">'
      + '<div class="subheader">' + esc(label) + '</div>'
      + '<div class="h1 mb-1 tnum ' + (cls || '') + '">' + esc(value) + '</div>'
      + (sub ? '<div class="text-secondary small">' + esc(sub) + '</div>' : '') + '</div></div></div>';
  }

  function tabLink(id, icon, label, extra) {
    return '<li class="nav-item"><a href="#' + id + '" class="nav-link' + ((state.view || state.tab) === id ? ' active' : '') + '" data-action="tab" data-tab="' + id + '" role="tab">'
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
          + '<div class="text-nowrap"><span class="tnum me-2">' + won(r.amount) + '</span>' + (r.status === 'done' ? reportBadge(r) : '<span class="badge ' + st.cls + '">' + st.label + '</span>') + '</div></div>';
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
      + '<form id="request-form" novalidate><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">품명</label><input type="text" class="form-control" name="item" required placeholder="예: 6인치 SiO2/Si 웨이퍼 25매"></div>'
      + '<div class="col-sm-5"><label class="form-label required">비목</label><select class="form-select" name="category">' + catOptions(CAT_IDS[0]) + '</select></div>'
      + '<div class="col-sm-7"><label class="form-label">구매처 / 링크</label><input type="url" class="form-control" name="link" placeholder="https://"></div>'
      + '<div class="col-4"><label class="form-label required">수량</label><input type="number" class="form-control" name="qty" min="1" step="1" value="1" required></div>'
      + '<div class="col-4"><label class="form-label required">단가 (원)</label><input type="number" class="form-control" name="unitPrice" min="0" step="1" required placeholder="0"></div>'
      + '<div class="col-4"><label class="form-label">합계</label><input type="text" class="form-control tnum" name="amountView" readonly value="0원"></div>'
      + '<div class="col-12"><label class="form-label">관련 구매 심의 <span class="form-label-description">승인된 심의의 가할당에서 집행</span></label><select class="form-select" name="reviewId"' + (myApproved.length ? '' : ' disabled') + '>' + reviewSelect + '</select></div>'
      + '<div class="col-12"><label class="form-label required">사용 용도</label>'
      + '<div class="alert alert-info py-2 mb-2 small"><i class="ti ti-info-circle me-1"></i><strong>어떤 용도로 쓰는지 상세히 적어 주세요.</strong> 무엇을 위해 사는지 알 수 있으면 관리자가 알맞은 과제를 배정할 수 있습니다.'
      + '<div class="text-secondary mt-1">예: 메탈 증착을 위한 증착기 유지보수용 오일 구매</div></div>'
      + '<textarea class="form-control" name="note" rows="2" placeholder="예: 메탈 증착을 위한 증착기 유지보수용 오일 구매"></textarea></div>'
      + '<div class="col-sm-6"><label class="form-label required">구매 주기</label><select class="form-select" name="cycle">' + cycleOptions('') + '</select>'
      + '<div class="form-hint">같은 물품을 얼마나 자주 사는지</div></div>'
      + '<div class="col-12"><hr class="my-1"><div class="subheader mt-2"><i class="ti ti-user-check me-1"></i>컨펌 · 관련 과제</div></div>'
      + '<div class="col-12" id="confirm-guide">' + confirmGuideHtml(0) + '</div>'
      + '<div class="col-sm-4"><label class="form-label required">팀</label><select class="form-select" name="team">' + teamOptions('') + '</select></div>'
      + '<div class="col-sm-8"><label class="form-label required">컨펌한 사람</label><input type="text" class="form-control" name="confirmedBy" placeholder="팀 중간관리자 이름 (500만원 초과는 교수님)">'
      + '<div class="form-hint">누구에게 컨펌받았는지 이름을 적어 주세요.</div></div>'
      + '<div class="col-12"><label class="form-label required">가장 관련 있는 과제</label><select class="form-select" name="relatedProjectId">' + relatedOptions('') + '</select>'
      + '<div class="form-hint">이 물품을 쓰는 연구와 가장 가까운 과제를 고르면, 관리자가 예산을 고려해 최대한 맞춰 배정합니다.</div></div>'
      + '</div><div class="d-flex justify-content-between align-items-center mt-3"><span class="small text-secondary" id="request-tier"></span><button type="submit" class="btn btn-primary"><i class="ti ti-send me-1"></i>요청 제출</button></div></form>'
      + '</div>'
      + '<div class="col-lg-5">'
      + '<div class="d-flex justify-content-between align-items-center mb-2"><h3 class="card-title mb-0"><i class="ti ti-user-check me-1 text-primary"></i>내 최근 요청</h3>'
      + '<a href="#query" class="small" data-action="tab" data-tab="query" data-mine="1">전체 조회 <i class="ti ti-arrow-right"></i></a></div>'
      + mineHtml
      + '<h3 class="card-title mt-4 mb-2"><i class="ti ti-route me-1 text-primary"></i>처리 흐름</h3>'
      + '<div class="list-group list-group-flush">'
      + step(1, '컨펌 받기', won(PROF_MIN) + ' 이하는 <strong>각 팀 중간관리자</strong>가 컨펌합니다(교수님 컨펌이 꼭 필요한 물품은 중간관리자가 판단해 교수님께 컨펌). ' + won(PROF_MIN) + ' 초과는 지금처럼 <strong>구매행정 시스템으로 교수님</strong>께 컨펌받습니다.')
      + step(2, '구매 요청 제출', '사용 용도·구매 주기·팀·컨펌한 사람·가장 관련 있는 과제를 적어 제출합니다. 미처리 상태에서는 직접 수정·취소할 수 있습니다.')
      + step(3, '관리자 과제 배정', '관리자가 2주마다 갱신되는 과제별 재료비·장비비·연구활동비 잔액을 보고 과제를 배정하면 <span class="badge bg-blue-lt">처리</span>로 바뀝니다. 고른 관련 과제에 최대한 맞춥니다.')
      + step(4, '구매 후 보고서', '물품이 오면 요청 조회의 <span class="badge bg-yellow-lt">보고서 미작성</span> 배지를 눌러 영수증·거래내역·검수 사진을 첨부하고 제출합니다. 50만원 초과는 검수 사진, 네이버페이는 주문 캡처가 필요합니다.')
      + step(5, '검수 승인', '포닥연구원 검수자(' + esc((CFG.report && CFG.report.inspectors || []).join(', ') || '지정 필요') + ')가 <span class="badge bg-blue-lt">검수 대기</span> 건을 열어 승인하면 검수자 칸에 서명이 들어가고 <span class="badge bg-green-lt">검수 완료</span>가 됩니다.')
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
    var meetingSub = r.kind === 'meeting' && r.meta ? [r.meta.place, r.meta.attendeeCount ? r.meta.attendeeCount + '명' : '', r.meta.heldAt ? fmtDate(r.meta.heldAt) + ' 회의' : ''].filter(Boolean).join(' · ') : '';
    var sug = r.meta && r.meta.suggestedProjectId && projectById(r.meta.suggestedProjectId) ? projectById(r.meta.suggestedProjectId) : null;
    return '<div class="fw-medium">' + (r.kind === 'meeting' ? '<span class="badge bg-green-lt me-1">회의비</span>' : '') + esc(r.item)
      + (r.link ? ' <a href="' + esc(r.link) + '" target="_blank" rel="noopener" class="text-secondary" title="링크 열기"><i class="ti ti-external-link"></i></a>' : '') + '</div>'
      + '<div class="small text-secondary"><span class="badge badge-outline text-primary me-1">' + esc(catLabel(normCat(r.category))) + '</span>'
      + (r.reviewId ? '<span class="badge bg-green-lt me-1" title="' + esc(rv ? rv.title : '') + '"><i class="ti ti-shield-check"></i> 심의</span>' : '')
      + (r.meta && r.meta.cycle ? '<span class="badge bg-secondary-lt me-1" title="구매 주기"><i class="ti ti-repeat me-1"></i>' + esc(r.meta.cycle) + '</span>' : '')
      + confirmBadges(r) + esc(meetingSub || r.note || '')
      + (r.kind === 'meeting'
        ? (sug && r.status === 'pending' ? '<span class="ms-1">· 청구 과제 ' + esc(sug.code || sug.name) + '</span>' : '')
        : (sug ? '<span class="ms-1">· 관련 과제 <span title="' + esc(sug.name) + '">' + esc(sug.alias || sug.name) + '</span></span>' : (r.meta && r.meta.relatedUnknown ? '<span class="ms-1">· 관련 과제 모름</span>' : ''))) + '</div>'
      + (r.status === 'rejected' && r.adminNote ? '<div class="small text-danger">반려 사유: ' + esc(r.adminNote) + '</div>' : '');
  }

  function amountCell(r) {
    return '<td class="text-end text-nowrap"><div class="fw-medium tnum">' + won(r.amount) + '</div><div class="small text-secondary tnum">' + esc(r.qty) + ' × ' + won(r.unitPrice) + '</div></td>';
  }

  /* 구매 보고서 상태 배지 + 링크 (승인된 건만) */
  var RSTATUS = { none: { label: '보고서 미작성', cls: 'bg-yellow-lt' }, draft: { label: '보고서 작성 중', cls: 'bg-secondary-lt' }, submitted: { label: '검수 대기', cls: 'bg-blue-lt' }, verified: { label: '검수 완료', cls: 'bg-green-lt' } };
  function reportBadge(r) {
    if (r.status !== 'done') return '';
    var st = r.report ? (r.report.status || 'draft') : 'none';
    var S = RSTATUS[st] || RSTATUS.none;
    return '<a href="../report/index.html#id=' + esc(r.id) + '" class="badge ' + S.cls + ' text-decoration-none" title="구매 보고서 열기"><i class="ti ti-file-text me-1"></i>' + S.label + '</a>';
  }
  function cardUsersHint(projectId) {
    var p = projectId ? projectById(projectId) : null;
    return '<div class="small text-secondary mt-1" data-role="card-users">' + (p && p.cardUsers && p.cardUsers.length ? '카드 실사용자: ' + esc(p.cardUsers.join(', ')) : (p ? '카드 실사용자 목록 없음' : '')) + '</div>';
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
        + '<select class="form-select form-select-sm" data-role="assign-cat" style="min-width:7rem">' + catOptions(pre.cat) + '</select></div>' + cardUsersHint(pre.projectId) + '</td>'
        + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-primary" data-action="assign">처리</button> '
        + '<button type="button" class="btn btn-sm btn-outline-danger" data-action="reject">반려</button> '
        + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="edit-request" title="수정"><i class="ti ti-edit"></i></button></td>';
    } else {
      html += '<td><span class="badge ' + st.cls + '">' + st.label + '</span>'
        + (r.processedAt ? '<div class="small text-secondary text-nowrap">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</div>' : '')
        + (r.status === 'done' ? '<div class="mt-1">' + reportBadge(r) + '</div>' : '') + '</td>'
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
    var sug = r.meta && r.meta.suggestedProjectId && projectById(r.meta.suggestedProjectId) ? r.meta.suggestedProjectId : '';
    return { projectId: sug, cat: normCat(r.category) };
  }

  /* 배정 후보: 예산 관리 대상 과제만, 급한 순 */
  function projectOptions(amount, cat, selectedId) {
    var opts = '<option value="">과제 선택…</option>';
    var list = state.projects.filter(function (p) { return BUD.isManaged(p) || p.id === selectedId; }).map(function (p) { return { p: p, u: BUD.urgency(p) }; });
    list.sort(function (a, b) { return a.u.rank - b.u.rank || (a.u.days === null ? 1e9 : a.u.days) - (b.u.days === null ? 1e9 : b.u.days); });
    list.forEach(function (x) {
      var p = x.p;
      var remain = BUD.remainFor(p, cat, budgetCtx());
      var short = (Number(amount) || 0) > remain;
      var label = (p.alias || p.name);
      opts += '<option value="' + esc(p.id) + '"' + (p.id === selectedId ? ' selected' : '') + ' title="' + esc(p.name) + '">'
        + esc(label) + ' · ' + esc(BUD.isUnified(p) ? '통합' : catLabel(poolOf(cat))) + ' 잔액 ' + won(remain) + (x.u.days !== null && x.u.days >= 0 ? ' · D-' + x.u.days : '') + (short ? ' (부족)' : '') + '</option>';
    });
    return opts;
  }

  /* 배정 추천 3개: 잔액 충분 → 올해 소진 필요 → 종료일 → 요청자 참여 과제 (budget-core suggest) */
  /* 요청자가 고른 관련 과제를 맨 위에(★), 그 아래 추천 3개 (관련 과제와 겹치면 빼고) */
  function suggestHtml(r, cat) {
    var relId = r.kind !== 'meeting' && r.meta && r.meta.suggestedProjectId;
    var rel = relId && BUD.isManaged(projectById(relId)) ? projectById(relId) : null;
    var list = BUD.suggest(r.amount, poolOf(cat), r.requesterName, state.projects, budgetCtx(), 4).filter(function (x) { return !rel || x.project.id !== rel.id; }).slice(0, 3);
    if (rel) {
      var rr = BUD.remainFor(rel, poolOf(cat), budgetCtx());
      list.unshift({ project: rel, remain: rr, after: rr - (Number(r.amount) || 0), enough: rr >= (Number(r.amount) || 0) && rr > 0, urgency: BUD.urgency(rel), member: false, requested: true });
    }
    if (!list.length) return '<div class="small text-secondary mt-1" data-role="suggest">추천할 과제가 없습니다 (잔액 있는 과제 없음)</div>';
    var n = 0;
    return '<div class="mt-2 d-flex flex-column gap-1" data-role="suggest">' + list.map(function (x) {
      var p = x.project, u = URG[x.urgency.level] || URG.later;
      return '<button type="button" class="btn btn-sm btn-outline-' + (x.enough ? 'primary' : 'danger') + ' text-start justify-content-start" data-action="assign-pick" data-project="' + esc(p.id) + '" title="' + esc(p.name) + '">'
        + '<span class="status-dot ' + u.dot.replace('bg-', 'status-') + ' me-2"></span><span class="fw-medium me-1">' + (x.requested ? '★ 요청자 관련 과제 · ' : (++n) + '. ') + esc(p.alias || p.name) + '</span>'
        + '<span class="small tnum text-secondary">' + won(x.remain) + ' → <span class="' + (x.after < 0 ? 'text-danger' : '') + '">' + won(x.after) + '</span>'
        + (x.urgency.days !== null ? ' · D-' + x.urgency.days : '') + ' · ' + esc(u.label) + (x.urgency.check && x.urgency.level !== 'check' ? ' · <span class="text-orange">집행 전 확인</span>' : '') + (x.member ? ' · 참여' : '') + '</span></button>';
    }).join('') + '</div>';
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

  /* ---------- 과제 예산 대시보드 (관리자) ---------- */
  function poolShort(id) { return { equipment: '장비비', material: '재료비', activity: '활동비' }[id] || catLabel(id); }
  function dday(days) { return days === null ? '-' : days < 0 ? '종료' : 'D-' + days; }
  function managedBudgetProjects() {
    return state.projects.filter(function (p) { return BUD.isManaged(p) && (BUD.base(p) || CAT_IDS.some(function (c) { return budgetOf(p, c) > 0; })); });
  }
  function urgencyOf(p) { return BUD.urgency(p); }
  function urgBadge(u) {
    var s = URG[u.level] || URG.later;
    return '<span class="badge ' + s.cls + '">' + esc(s.label) + '</span>' + (u.check && u.level !== 'check' ? '<div class="mt-1"><span class="badge bg-orange-lt">집행 전 확인</span></div>' : '');
  }

  /* 올해 소진 필요(이월불가·종료 표시 과제)의 남은 잔액 */
  function mustSpendSummary() {
    var out = { total: 0, count: 0 };
    managedBudgetProjects().forEach(function (p) {
      if (urgencyOf(p).level !== 'must') return;
      var s = projectStats(p);
      out.total += Math.max(0, s.remain); out.count++;
    });
    return out;
  }
  /* 올해 12/31 까지 끝나는 과제의 세목별 잔액과 월 집행 필요액 */
  function yearEndSummary() {
    var today = BUD.localDate(new Date().toISOString());
    var yearEnd = today.slice(0, 4) + '-12-31';
    var pools = {}; BUD.POOL_IDS.forEach(function (id) { pools[id] = 0; });
    var unified = 0, count = 0;
    managedBudgetProjects().forEach(function (p) {
      if (!p.endDate || p.endDate > yearEnd || p.endDate < today || urgencyOf(p).level === 'check') return;
      var s = projectStats(p); count++;
      if (s.unified) unified += Math.max(0, s.pools.unified.remain);
      else BUD.POOL_IDS.forEach(function (id) { pools[id] += Math.max(0, s.pools[id].remain); });
    });
    var months = Math.max(1, Math.ceil(BUD.dayDiff(today, yearEnd) / 30.4));
    return { pools: pools, unified: unified, count: count, months: months, yearEnd: yearEnd };
  }
  /* 기준일 직전 며칠 동안 처리한 건: 행정 잔액에 반영됐는지 확인 대상 */
  function recentBeforeBase() {
    var days = Number(CFG.budget && CFG.budget.recentCheckDays) || 7;
    return state.requests.filter(function (r) {
      var p = r.status === 'done' ? projectById(r.projectId) : null;
      var b = p && BUD.base(p);
      if (!b) return false;
      var d = localDate(r.processedAt || r.createdAt);
      return d <= b.date && BUD.dayDiff(d, b.date) < days;
    });
  }

  function poolCell(s, id) {
    var b = s.pools[id];
    if (!b || (b.budget === 0 && b.actual === 0 && b.provisional === 0)) return '<td class="text-end text-secondary">-</td>';
    var used = b.actual + b.provisional;
    return '<td class="text-end tnum text-nowrap"><div class="fw-medium' + (b.remain < 0 ? ' text-danger' : '') + '">' + won(b.remain) + '</div>'
      + (used ? '<div class="small text-secondary">기준 ' + won(b.budget) + (b.actual ? ' − 집행 ' + won(b.actual) : '') + (b.provisional ? ' − 가 ' + won(b.provisional) : '') + '</div>' : '') + '</td>';
  }

  function renderBudgetDashboard() {
    var fr = BUD.freshness(state.projects);
    var upload = '<label class="btn btn-sm btn-primary mb-0"><i class="ti ti-file-spreadsheet me-1"></i>연구비 현황 엑셀 올리기<input type="file" accept=".xlsx,.xls" data-action="import-budget" hidden></label>';
    var head = '<div class="card-body py-2 border-bottom d-flex flex-wrap gap-2 align-items-center">'
      + (fr ? '<div class="small"><i class="ti ti-calendar-stats me-1 text-primary"></i>행정 현황 기준일 <strong>' + esc(fr.date.replace(/-/g, '.')) + '</strong> <span class="text-secondary">· ' + fr.age + '일 전 · ' + esc(fr.source) + (fr.importedBy ? ' · ' + esc(fr.importedBy) + ' 올림' : '') + '</span></div>' : '<div class="small text-secondary">아직 행정 연구비 현황을 올리지 않았습니다.</div>')
      + '<div class="ms-auto d-flex gap-2 flex-wrap"><button type="button" class="btn btn-sm" data-action="export-purchase-log"><i class="ti ti-download me-1"></i>구매기록 내보내기</button>' + upload + '</div></div>';
    if (fr && fr.stale) head += '<div class="alert alert-warning m-3 mb-0"><i class="ti ti-alert-triangle me-1"></i>기준일로부터 ' + fr.age + '일이 지났습니다. 행정 현황은 ' + fr.refreshDays + '일마다 갱신하기로 했으니 새 현황 엑셀을 올려 주세요. 그 사이 행정에서 처리된 건이 잔액에 빠져 있을 수 있습니다.</div>';
    if (!fr) head += '<div class="alert alert-info m-3 mb-0"><i class="ti ti-info-circle me-1"></i>행정 연구비 현황 엑셀(학생공유_연구비 시트)을 올리면 과제별 잔액·기한이 채워집니다. 파일은 서버로 보내지 않고 이 브라우저에서만 읽어 저장합니다.</div>';

    var list = managedBudgetProjects();
    if (!list.length) return { body: head + '<div class="card-body">' + empty('folder-off', '예산이 있는 과제가 없습니다', '연구비 현황 엑셀을 올리거나 아래 과제 추가에서 직접 입력하세요.') + '</div>' };

    /* 올해 말까지 써야 하는 돈 */
    var ye = yearEndSummary();
    var ms = mustSpendSummary();
    var yeTotal = BUD.POOL_IDS.reduce(function (s, id) { return s + ye.pools[id]; }, 0) + ye.unified;
    var top = '<div class="card-body border-bottom"><div class="row g-3">'
      + '<div class="col-lg-7"><div class="subheader mb-2">' + esc(ye.yearEnd.slice(0, 4)) + '년 12월 31일까지 종료되는 과제 ' + ye.count + '개 · 남은 기간 약 ' + ye.months + '개월</div>'
      + '<table class="table table-sm mb-0"><thead><tr><th>세목</th><th class="text-end">남은 잔액</th><th class="text-end">월 집행 필요</th></tr></thead><tbody>'
      + BUD.POOLS.map(function (c) { var v = ye.pools[c.id]; return v > 0 ? '<tr><td>' + esc(c.label) + '</td><td class="text-end tnum fw-medium">' + won(v) + '</td><td class="text-end tnum">' + won(v / ye.months) + '</td></tr>' : ''; }).join('')
      + (ye.unified > 0 ? '<tr><td>통합 잔액</td><td class="text-end tnum fw-medium">' + won(ye.unified) + '</td><td class="text-end tnum">' + won(ye.unified / ye.months) + '</td></tr>' : '')
      + '<tr class="fw-bold"><td>합계</td><td class="text-end tnum">' + won(yeTotal) + '</td><td class="text-end tnum">' + won(yeTotal / ye.months) + '</td></tr></tbody></table></div>'
      + '<div class="col-lg-5"><div class="card card-sm bg-red-lt h-100"><div class="card-body"><div class="subheader">이월불가·종료 (올해 소진·정산 필요)</div><div class="h1 tnum mb-1">' + won(ms.total) + '</div>'
      + '<div class="small">' + list.filter(function (p) { return urgencyOf(p).level === 'must'; }).map(function (p) { return esc(p.alias || p.name) + ' ' + won(Math.max(0, projectStats(p).remain)); }).join('<br>') + '</div></div></div></div>'
      + '</div></div>';

    var recent = recentBeforeBase();
    var recentHtml = recent.length ? '<div class="card-body py-2 border-bottom"><details><summary class="small text-orange"><i class="ti ti-alert-circle me-1"></i>기준일 직전에 처리한 ' + recent.length + '건은 행정 잔액에 반영된 것으로 계산했습니다. 반영 여부를 확인하세요.</summary>'
      + '<ul class="list-unstyled small mt-2 mb-0">' + recent.map(function (r) { var p = projectById(r.projectId); return '<li class="py-1 border-top d-flex justify-content-between gap-2"><span>' + fmtDate(r.processedAt) + ' ' + esc(r.item) + ' <span class="text-secondary">(' + esc(r.requesterName) + ' · ' + esc(p ? (p.alias || p.name) : '') + ' · ' + esc(catLabel(poolOf(r.category))) + ')</span></span><span class="tnum">' + won(r.amount) + '</span></li>'; }).join('') + '</ul></details></div>' : '';

    /* 과제 표: 긴급도 → 종료일 순 (또는 잔액 순) */
    var rows = list.map(function (p) { return { p: p, s: projectStats(p), u: urgencyOf(p) }; });
    rows.sort(state.budgetSort === 'remain'
      ? function (a, b) { return b.s.remain - a.s.remain; }
      : function (a, b) { return a.u.rank - b.u.rank || (a.u.days === null ? 1e9 : a.u.days) - (b.u.days === null ? 1e9 : b.u.days) || b.s.remain - a.s.remain; });
    var tot = { remain: 0 }; BUD.POOL_IDS.forEach(function (id) { tot[id] = 0; }); tot.unified = 0;
    var sortBtns = '<div class="btn-group btn-group-sm">' + [['urgency', '급한 순'], ['remain', '잔액 순']].map(function (x) { return '<button type="button" class="btn ' + (state.budgetSort === x[0] ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="budget-sort" data-sort="' + x[0] + '">' + x[1] + '</button>'; }).join('') + '</div>';
    var table = '<div class="card-body py-2 border-bottom d-flex justify-content-between align-items-center flex-wrap gap-2"><div class="small text-secondary">잔액 = 행정 기준 잔액 − 기준일 이후 포털 집행 − 가할당(승인된 구매 심의 중 미집행)</div>' + sortBtns + '</div>'
      + '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1"></th><th>과제</th><th class="w-1">종료</th>'
      + BUD.POOLS.map(function (c) { return '<th class="text-end">' + esc(c.label) + '</th>'; }).join('') + '<th class="text-end">합계</th></tr></thead><tbody>'
      + rows.map(function (x) {
        var p = x.p, s = x.s, b = BUD.base(p) || {};
        var post = state.requests.filter(function (r) { return r.status === 'done' && r.projectId === p.id && (!b.date || localDate(r.processedAt || r.createdAt) > b.date); });
        if (s.unified) tot.unified += s.pools.unified.remain; else BUD.POOL_IDS.forEach(function (id) { tot[id] += s.pools[id].remain; });
        tot.remain += s.remain;
        var cells = s.unified
          ? '<td colspan="' + BUD.POOLS.length + '" class="text-center tnum"><span class="fw-medium' + (s.remain < 0 ? ' text-danger' : '') + '">' + won(s.remain) + '</span> <span class="small text-secondary">통합 잔액 (세목 구분 없음)' + (s.actual ? ' · 기준 ' + won(s.budget) + ' − 집행 ' + won(s.actual) : '') + '</span></td>'
          : BUD.POOL_IDS.map(function (id) { return poolCell(s, id); }).join('');
        return '<tr><td>' + urgBadge(x.u) + '</td>'
          + '<td><div class="fw-medium">' + esc(p.alias || p.name) + '</div><div class="small text-secondary text-truncate" style="max-width:24rem" title="' + esc(p.name) + '">' + esc(p.name) + '</div>'
          + (b.status || b.note ? '<div class="small">' + (b.status ? '<span class="text-body">' + esc(b.status) + '</span>' : '') + (b.note ? ' <span class="text-secondary">· ' + esc(b.note) + '</span>' : '') + '</div>' : '')
          + (post.length ? '<details class="small"><summary class="text-primary">기준일 이후 집행 ' + post.length + '건</summary><ul class="list-unstyled mb-0">' + post.map(function (r) { return '<li class="d-flex justify-content-between gap-2 border-top py-1"><span>' + fmtDate(r.processedAt) + ' ' + esc(r.item) + ' <span class="text-secondary">(' + esc(r.requesterName) + ' · ' + esc(catLabel(poolOf(r.category))) + ')</span></span><span class="tnum">' + won(r.amount) + '</span></li>'; }).join('') + '</ul></details>' : '') + '</td>'
          + '<td class="text-nowrap small">' + esc((p.endDate || '-').replace(/-/g, '.').slice(2)) + '<div class="' + (x.u.days !== null && x.u.days <= 100 ? 'text-red fw-medium' : 'text-secondary') + '">' + dday(x.u.days) + '</div></td>'
          + cells + '<td class="text-end tnum fw-bold text-nowrap' + (s.remain < 0 ? ' text-danger' : '') + '">' + won(s.remain) + '</td></tr>';
      }).join('')
      + '<tr class="fw-bold"><td></td><td>합계' + (tot.unified ? ' <span class="small fw-normal text-secondary">(통합 잔액 ' + won(tot.unified) + ' 별도)</span>' : '') + '</td><td></td>' + BUD.POOL_IDS.map(function (id) { return '<td class="text-end tnum">' + won(tot[id]) + '</td>'; }).join('') + '<td class="text-end tnum">' + won(tot.remain) + '</td></tr>'
      + '</tbody></table></div>';
    var exNames = (CFG.budget && CFG.budget.excludeAliases) || [];
    var foot = '<div class="card-body py-2 small text-secondary border-top"><i class="ti ti-eye-off me-1"></i>예산 관리·배정 제외: ' + (exNames.length ? exNames.map(esc).join(', ') : '없음') + ' <span class="text-secondary">(config.js budget.excludeAliases)</span></div>';
    return { body: head + top + recentHtml + table + foot };
  }

  /* ---------- 행정 연구비 현황 엑셀 가져오기 (브라우저에서만 읽음) ---------- */
  function cellNum(v) { if (typeof v === 'number') return v; var n = Number(String(v || '').replace(/[,\s원]/g, '')); return isNaN(n) ? 0 : n; }
  function ymdFrom(y, m, d) { y = Number(y); if (y < 100) y += 2000; return y + '-' + pad2(m) + '-' + pad2(d); }
  function parsePeriod(s) {
    var m = String(s || '').match(/(\d{2,4})\.(\d{1,2})\.(\d{1,2})\s*~\s*(\d{2,4})\.(\d{1,2})\.(\d{1,2})/);
    return m ? { start: ymdFrom(m[1], m[2], m[3]), end: ymdFrom(m[4], m[5], m[6]) } : null;
  }
  function parseBudgetWorkbook(buf, fileName) {
    if (!window.XLSX) throw new Error('엑셀 읽기 도구를 불러오지 못했습니다. 인터넷 연결을 확인하고 새로고침하세요.');
    var wb = window.XLSX.read(buf, { type: 'array' });
    var found = null;
    wb.SheetNames.some(function (sn) {
      var rows = window.XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
      for (var i = 0; i < Math.min(rows.length, 40); i++) {
        var r = rows[i].map(function (c) { return String(c).trim(); });
        if (r.indexOf('과제명') >= 0 && r.indexOf('구분') >= 0) { found = { sheet: sn, rows: rows, head: i }; return true; }
      }
      return false;
    });
    if (!found) throw new Error('과제명·구분 머리글이 있는 시트를 찾지 못했습니다. 행정 연구비 현황 양식인지 확인하세요.');
    var head = found.rows[found.head].map(function (c) { return String(c).replace(/\s+/g, ''); });
    function col(re) { for (var i = 0; i < head.length; i++) if (re.test(head[i])) return i; return -1; }
    var C = { name: col(/^과제명$/), key: col(/^구분$/), period: col(/기한|기간/), unified: col(/현재잔액/), equipment: col(/장비/), material: col(/재료/), activity: col(/활동/), status: col(/집행/), note: col(/비고/) };
    if (C.material < 0 || C.activity < 0) throw new Error('연구재료비·연구활동비 열을 찾지 못했습니다.');
    /* 기준일: 위쪽 안내 문구의 날짜 → 파일명 yymmdd → 오늘 */
    var date = '';
    found.rows.slice(0, found.head).some(function (r) { var m = r.join(' ').match(/(20\d{2})[-.](\d{1,2})[-.](\d{1,2})/); if (m) { date = ymdFrom(m[1], m[2], m[3]); return true; } return false; });
    if (!date) { var fm = String(fileName || '').match(/(\d{2})(\d{2})(\d{2})(?!\d)/); if (fm) date = ymdFrom(fm[1], fm[2], fm[3]); }
    if (!date) date = localDate(new Date().toISOString());
    var out = [];
    for (var i = found.head + 1; i < found.rows.length; i++) {
      var r = found.rows[i];
      var name = String(r[C.name] || '').trim();
      if (!name) { if (out.length) break; continue; }
      var key = String(r[C.key] || '').trim();
      var per = C.period >= 0 ? parsePeriod(r[C.period]) : null;
      var eq = C.equipment >= 0 ? cellNum(r[C.equipment]) : 0, mat = cellNum(r[C.material]), act = cellNum(r[C.activity]);
      var uni = C.unified >= 0 ? cellNum(r[C.unified]) : 0;
      var status = C.status >= 0 ? String(r[C.status] || '').trim() : '', note = C.note >= 0 ? String(r[C.note] || '').trim() : '';
      out.push({ name: name, key: key, alias: (CFG.budget && CFG.budget.aliasMap && CFG.budget.aliasMap[key]) || key,
        start: per ? per.start : '', end: per ? per.end : '', periodText: C.period >= 0 ? String(r[C.period] || '') : '', open: !!per,
        equipment: eq, material: mat, activity: act, unified: (eq + mat + act === 0 && uni > 0) ? uni : null,
        status: status, note: note, mustSpend: /소진/.test(status), checkFirst: !per || /확인/.test(status + ' ' + note), excluded: BUD.excludedName(key) || BUD.excludedName(name) });
    }
    if (!out.length) throw new Error('과제 행을 찾지 못했습니다.');
    return { sheet: found.sheet, date: date, rows: out };
  }
  function matchProject(row) {
    var k = BUD.cfg && row.alias;
    var key = String(k || '').replace(/\s+/g, '').toLowerCase();
    var nm = row.name.replace(/\s+/g, '').toLowerCase();
    return state.projects.filter(function (p) {
      return (p.alias && String(p.alias).replace(/\s+/g, '').toLowerCase() === key) || String(p.name).replace(/\s+/g, '').toLowerCase() === nm;
    })[0] || null;
  }
  function importBudgetFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try { parsed = parseBudgetWorkbook(new Uint8Array(reader.result), file.name); } catch (err) { handleError(err); return; }
      var cur = BUD.freshness(state.projects);
      var html = '<div class="mb-3"><label class="form-label required">행정 현황 기준일</label><input type="date" class="form-control" name="date" value="' + esc(parsed.date) + '">'
        + '<div class="form-hint">이 날짜 이후에 포털에서 처리한 건만 잔액에서 뺍니다. 엑셀 위쪽 안내 문구나 파일명에서 읽었습니다.</div>'
        + (cur && parsed.date < cur.date ? '<div class="text-danger small mt-1">지금 기준일(' + esc(cur.date) + ')보다 이전 날짜입니다.</div>' : '') + '</div>'
        + '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>구분</th><th>연결</th><th>기간</th><th class="text-end">장비비</th><th class="text-end">재료비</th><th class="text-end">활동비</th><th>집행 상태</th></tr></thead><tbody>'
        + parsed.rows.map(function (r) {
          var m = r.excluded ? null : matchProject(r);
          return '<tr' + (r.excluded ? ' class="text-secondary"' : '') + '><td class="text-nowrap fw-medium">' + esc(r.key) + '</td>'
            + '<td class="small">' + (r.excluded ? '<span class="badge bg-secondary-lt">제외</span>' : m ? '<span class="badge bg-green-lt">' + esc(m.alias || m.name) + '</span>' : '<span class="badge bg-blue-lt">새 과제</span>') + '</td>'
            + '<td class="small text-nowrap">' + esc(r.open ? r.start.slice(2).replace(/-/g, '.') + '~' + r.end.slice(2).replace(/-/g, '.') : r.periodText || '-') + '</td>'
            + (r.unified !== null ? '<td colspan="3" class="text-center tnum small">통합 ' + won(r.unified) + '</td>' : '<td class="text-end tnum small">' + (r.equipment ? nf.format(r.equipment) : '-') + '</td><td class="text-end tnum small">' + (r.material ? nf.format(r.material) : '-') + '</td><td class="text-end tnum small">' + (r.activity ? nf.format(r.activity) : '-') + '</td>')
            + '<td class="small">' + esc(r.status) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
        + '<div class="small text-secondary">새 과제는 엑셀 구분을 약칭으로 만듭니다. 제외 과제는 가져오지 않습니다. 과제명·기간·세목 잔액·집행 상태가 갱신되고 과제번호·참여자 등은 그대로 둡니다.</div>';
      dialog({ title: '연구비 현황 가져오기 · ' + file.name, bodyHtml: html, size: 'lg', okLabel: '적용' }).then(function (v) {
        if (!v) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date || '')) { toast('기준일을 입력하세요.', true); return; }
        var now = new Date().toISOString();
        var by = state.session ? state.session.user.name : '';
        var jobs = parsed.rows.filter(function (r) { return !r.excluded; }).map(function (r) {
          var p = matchProject(r);
          var budgets = {}; CAT_IDS.forEach(function (c) { budgets[c] = 0; });
          budgets.equipment = Math.round(r.equipment); budgets.material = Math.round(r.material); budgets.activity = Math.round(r.activity);
          var rec = Object.assign({}, p || { code: '', manager: '', note: '', participants: [], cardUsers: [], owners: [] }, {
            name: r.name, alias: p && p.alias ? p.alias : r.alias, startDate: r.start || (p ? p.startDate : ''), endDate: r.end || (p ? p.endDate : ''), budgets: budgets, active: true,
            budgetBase: { date: v.date, source: file.name, importedAt: now, importedBy: by, unified: r.unified, status: r.status, note: r.note, mustSpend: r.mustSpend, checkFirst: r.checkFirst, open: r.open, period: r.periodText }
          });
          return rec;
        });
        var seen = jobs.map(function (j) { return j.id; });
        var dropped = state.projects.filter(function (p) { return BUD.base(p) && seen.indexOf(p.id) < 0 && !BUD.isExcluded(p); });
        return jobs.reduce(function (pr, rec) { return pr.then(function () { return store.saveProject(rec); }); }, Promise.resolve()).then(function () {
          toast('연구비 현황을 적용했습니다: ' + jobs.length + '개 과제 · 기준일 ' + v.date + (dropped.length ? ' · 새 현황에 없는 과제 ' + dropped.map(function (p) { return p.alias || p.name; }).join(', ') : ''));
          touchUnlock(); return refresh();
        });
      }).catch(handleError);
    };
    reader.onerror = function () { toast('파일을 읽지 못했습니다.', true); };
    reader.readAsArrayBuffer(file);
  }

  /* ---------- 구매기록 내보내기: 연구비 엑셀 '구매기록' 시트와 같은 열 ---------- */
  function exportPurchaseLog() {
    var list = state.requests.filter(function (r) { return r.status === 'done' && r.kind !== 'meeting'; })
      .sort(function (a, b) { return String(a.processedAt || a.createdAt).localeCompare(String(b.processedAt || b.createdAt)); });
    if (!list.length) { toast('처리된 구매 요청이 없습니다.', true); return; }
    var head = ['날짜', '이름', '구매품목', '구매상세정보', '가격 (VAT포함)', '할당과제', '세목', '구매주기', '팀', '컨펌', '관련 과제', '처리일', '처리자'];
    var rows = list.map(function (r) {
      var p = projectById(r.projectId);
      var d = localDate(r.createdAt).replace(/-/g, '').slice(2);
      return [d, r.requesterName, r.item, r.note || (r.item + ', ' + (r.qty || 1) + 'EA'), Number(r.amount) || 0, p ? (p.alias || p.name) : '', catLabel(poolOf(r.category)), (r.meta && r.meta.cycle) || '', (r.meta && r.meta.team) || '', (r.meta && r.meta.confirmedBy) || '', relatedName(r), localDate(r.processedAt), r.processedBy || ''];
    });
    var name = 'DSIL_구매기록_' + localDate(new Date().toISOString()).replace(/-/g, '').slice(2);
    if (window.XLSX) {
      var ws = window.XLSX.utils.aoa_to_sheet([head].concat(rows));
      ws['!cols'] = [{ wch: 8 }, { wch: 8 }, { wch: 24 }, { wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 11 }, { wch: 8 }];
      var wb = window.XLSX.utils.book_new(); window.XLSX.utils.book_append_sheet(wb, ws, '구매기록');
      window.XLSX.writeFile(wb, name + '.xlsx');
    } else {
      download(name + '.csv', '﻿' + [head].concat(rows).map(function (r) { return r.map(csvCell).join(','); }).join('\r\n'), 'text/csv;charset=utf-8');
    }
    toast(list.length + '건을 내보냈습니다.');
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
          + '<td>' + itemCell(r) + suggestHtml(r, pre.cat) + '</td>'
          + amountCell(r)
          + '<td><select class="form-select form-select-sm" data-role="assign-project">' + projectOptions(r.amount, pre.cat, pre.projectId) + '</select>' + cardUsersHint(pre.projectId) + '</td>'
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
    var budgetInputs = BUD.POOLS.map(function (c) {
      return '<div class="col-6 col-md-4"><label class="form-label">' + esc(c.label) + '</label><input type="number" class="form-control tnum" name="budget_' + esc(c.id) + '" min="0" step="1" value="' + (editing ? budgetOf(editing, c.id) : '') + '" placeholder="0"></div>';
    }).join('');

    /* 과제 예산 현황 (관리자 탭에 통합) */
    var budgetView = renderBudgetDashboard();
    var after = '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-wallet me-1 text-primary"></i>과제 예산 현황 <span class="badge bg-secondary-lt ms-1"><i class="ti ti-lock me-1"></i>관리자 전용</span></h3></div>' + budgetView.body + '</div>';

    after += '<div class="row row-cards mb-3">'
      + '<div class="col-lg-5"><div class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-' + (editing ? 'edit' : 'folder-plus') + ' me-1 text-primary"></i>' + (editing ? '과제 수정' : '과제 추가') + '</h3>'
      + (editing ? '<div class="card-actions"><button type="button" class="btn btn-sm btn-ghost-secondary" data-action="cancel-edit">취소</button></div>' : '') + '</div>'
      + '<div class="card-body"><form id="project-form" data-id="' + esc(editing ? editing.id : '') + '"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">과제명</label><input type="text" class="form-control" name="name" required value="' + esc(editing ? editing.name : '') + '" placeholder="과제명"></div>'
      + '<div class="col-6"><label class="form-label">과제번호 <span class="form-label-description">보고서 계정란</span></label><input type="text" class="form-control" name="code" value="' + esc(editing ? editing.code : '') + '" placeholder="G04260010(00)"></div>'
      + '<div class="col-6"><label class="form-label">연구책임자</label><input type="text" class="form-control" name="manager" value="' + esc(editing ? editing.manager : '') + '" placeholder="김교수"></div>'
      + '<div class="col-6"><label class="form-label">약칭 <span class="form-label-description">참여과제 시트의 과제 이름</span></label><input type="text" class="form-control" name="alias" value="' + esc(editing ? (editing.alias || '') : '') + '" placeholder="우수신진"></div>'
      + '<div class="col-6"><label class="form-label">참여자 <span class="form-label-description">회의비 참석자 후보 · 시트에서 가져옴</span></label><div class="form-control-plaintext small text-secondary">' + (editing && editing.participants && editing.participants.length ? esc(editing.participants.map(function (x) { return x.name; }).join(', ')) : '없음 (회의비 페이지 관리자 탭에서 시트 가져오기)') + '</div></div>'
      + '<div class="col-6"><label class="form-label">계정책임자 <span class="form-label-description">보고서 기본값</span></label><input type="text" class="form-control" name="accountManager" value="' + esc(editing ? (editing.accountManager || '') : (CFG.report && CFG.report.defaultAccountManager || '')) + '" placeholder="권지민"></div>'
      + '<div class="col-6"><label class="form-label">카드 실사용자 목록 <span class="form-label-description">참여연구원, 쉼표 구분</span></label><input type="text" class="form-control" name="cardUsers" value="' + esc(editing && editing.cardUsers ? editing.cardUsers.join(', ') : '') + '" placeholder="박민호, 위동진"></div>'
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
          + '<div class="small text-secondary">' + esc(p.code) + (p.active === false ? ' · 종료' : '') + (catLine ? ' · ' + catLine : '') + '</div>'
          + (BUD.isExcluded(p) ? '<div class="small"><span class="badge bg-secondary-lt">예산 관리 제외</span></div>' : BUD.base(p) ? '<div class="small text-secondary">행정 현황 ' + esc(BUD.base(p).date) + ' 기준' + (BUD.isUnified(p) ? ' · 통합 잔액' : '') + '</div>' : '') + '</td>'
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
        + '<button type="button" class="btn btn-sm btn-outline-danger" data-action="reset-demo">' + (CFG.seedDemoData ? '예시 데이터로 초기화' : '모든 데이터 삭제') + '</button>'
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
      + '<div class="col-12"><label class="form-label">사용 용도 <span class="form-label-description">어떤 용도로 쓰는지 상세히</span></label><textarea class="form-control" name="note" rows="3">' + esc(r.note) + '</textarea></div>'
      + (r.kind !== 'meeting' ? '<div class="col-sm-6"><label class="form-label">구매 주기</label><select class="form-select" name="cycle">' + cycleOptions((r.meta && r.meta.cycle) || '') + '</select></div>'
        + '<div class="col-sm-6"><label class="form-label">팀</label><select class="form-select" name="team">' + teamOptions((r.meta && r.meta.team) || '') + '</select></div>'
        + '<div class="col-sm-6"><label class="form-label">컨펌한 사람</label><input type="text" class="form-control" name="confirmedBy" value="' + esc((r.meta && r.meta.confirmedBy) || '') + '"></div>'
        + '<div class="col-sm-6"><label class="form-label">가장 관련 있는 과제</label><select class="form-select" name="relatedProjectId">' + relatedOptions(r.meta && r.meta.relatedUnknown ? 'unknown' : ((r.meta && r.meta.suggestedProjectId) || '')) + '</select></div>' : '')
      + (admin ? '<div class="col-12"><label class="form-label">관리자 메모 <span class="form-label-description">반려 시 신청자에게 표시</span></label><input type="text" class="form-control" name="adminNote" value="' + esc(r.adminNote) + '"></div>' : '')
      + '</div>';
    return dialog({ title: '요청 수정', bodyHtml: body, size: 'lg', okLabel: '저장' }).then(function (v) {
      if (!v) return;
      var qty = Math.max(1, parseInt(v.qty, 10) || 1);
      var unit = Math.max(0, Math.round(Number(v.unitPrice) || 0));
      var patch = { item: v.item.trim(), category: normCat(v.category), link: v.link.trim(), qty: qty, unitPrice: unit, amount: qty * unit, note: v.note.trim() };
      if (v.cycle !== undefined) {
        patch.meta = Object.assign({}, r.meta || {}, { cycle: v.cycle, team: v.team, confirmedBy: (v.confirmedBy || '').trim(), confirmRoute: needsProfessor(qty * unit) ? 'professor' : 'team',
          suggestedProjectId: v.relatedProjectId === 'unknown' ? '' : v.relatedProjectId, relatedUnknown: v.relatedProjectId === 'unknown' });
      }
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
    var head = ['요청일', '신청자', '품명', '비목', '수량', '단가', '합계', '상태', '배정 과제', '과제번호', '연결 심의', '처리일', '처리자', '사용 용도', '구매 주기', '팀', '컨펌한 사람', '관련 과제', '반려 사유', '링크'];
    var rows = list.map(function (r) {
      var p = r.projectId ? projectById(r.projectId) : null;
      var rv = r.reviewId ? reviewById(r.reviewId) : null;
      return [localDate(r.createdAt), r.requesterName, r.item, catLabel(normCat(r.category)), r.qty, r.unitPrice, r.amount,
        (STATUS[r.status] || { label: r.status }).label, p ? p.name : '', p ? p.code : '', rv ? rv.title : (r.reviewId ? '연결됨' : ''), localDate(r.processedAt), r.processedBy || '', r.note, (r.meta && r.meta.cycle) || '', (r.meta && r.meta.team) || '', (r.meta && r.meta.confirmedBy) || '', relatedName(r), r.status === 'rejected' ? r.adminNote : '', r.link].map(csvCell).join(',');
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
      if (!markMissing(form, [
        { name: 'item', label: '품명', ok: !!r.item.trim() },
        { name: 'unitPrice', label: '단가', ok: String(r.unitPrice).trim() !== '' && Number(r.unitPrice) >= 0 },
        { name: 'note', label: '사용 용도(' + USAGE_MIN + '자 이상으로 상세히)', ok: r.note.trim().length >= USAGE_MIN },
        { name: 'cycle', label: '구매 주기', ok: !!r.cycle },
        { name: 'team', label: '팀', ok: !!r.team },
        { name: 'confirmedBy', label: '컨펌한 사람', ok: !!r.confirmedBy.trim() },
        { name: 'relatedProjectId', label: '가장 관련 있는 과제', ok: !!r.relatedProjectId }
      ])) return;
      var meta = { cycle: r.cycle, team: r.team, confirmedBy: r.confirmedBy.trim(), confirmRoute: needsProfessor(qty * unit) ? 'professor' : 'team',
        suggestedProjectId: r.relatedProjectId === 'unknown' ? '' : r.relatedProjectId, relatedUnknown: r.relatedProjectId === 'unknown' };
      store.createRequest({ item: r.item.trim(), category: normCat(r.category), link: r.link.trim(), qty: qty, unitPrice: unit, amount: qty * unit, note: r.note.trim(), reviewId: r.reviewId || null, meta: meta })
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
      var prev = id ? projectById(id) : null;
      var budgets = {};
      CAT_IDS.forEach(function (c) { budgets[c] = BUD.POOL_IDS.indexOf(c) >= 0 ? Math.max(0, Math.round(Number(p['budget_' + c]) || 0)) : 0; });
      /* 폼에 없는 필드(참여자·행정 현황 기준 등)는 그대로 유지 */
      var rec = Object.assign({}, prev || {}, { code: p.code.trim(), name: p.name.trim(), budgets: budgets, startDate: p.startDate, endDate: p.endDate, manager: p.manager.trim(), note: p.note.trim(), active: !!p.active,
        alias: (p.alias || '').trim(), accountManager: (p.accountManager || '').trim(),
        cardUsers: String(p.cardUsers || '').split(/[,\n、]/).map(function (s) { return s.trim(); }).filter(Boolean) });
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
      var guide = $('#confirm-guide'); if (guide) guide.innerHTML = confirmGuideHtml(qty * unit);
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
    /* 팀을 고르면 그 팀 중간관리자 이름을 채움 (비어 있거나 다른 팀 중간관리자로 채워져 있을 때만) */
    if (el.name === 'team' && el.form && el.form.elements.confirmedBy) {
      var cb = el.form.elements.confirmedBy, mgrs = PR.teams.map(function (t) { return t.manager; }).filter(Boolean);
      if (teamManager(el.value) && (!cb.value.trim() || mgrs.indexOf(cb.value.trim()) >= 0)) cb.value = teamManager(el.value);
    }
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
    if (action === 'import-budget' && el.files && el.files[0]) { importBudgetFile(el.files[0]); el.value = ''; return; }
    if (role === 'assign-cat') {
      var row = el.closest('tr[data-id]');
      var sel = row && row.querySelector('select[data-role="assign-project"]');
      var req = row && requestById(row.getAttribute('data-id'));
      if (sel && req) sel.innerHTML = projectOptions(req.amount, normCat(el.value), sel.value);
      var sg = row && row.querySelector('[data-role="suggest"]');
      if (sg && req) sg.outerHTML = suggestHtml(req, el.value);
    }
    if (role === 'assign-project') {
      /* 과제를 고르면 그 과제의 카드 실사용자 목록을 바로 보여줌 */
      var cell = el.closest('td') || el.parentElement;
      var hint = cell && cell.querySelector('[data-role="card-users"]');
      if (hint) hint.outerHTML = cardUsersHint(el.value);
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
      case 'budget-sort':
        state.budgetSort = btn.getAttribute('data-sort'); touchUnlock(); render(); break;
      case 'export-purchase-log':
        exportPurchaseLog(); touchUnlock(); break;
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
      case 'assign-pick':
        /* 추천 과제 버튼: 그 과제를 고른 상태로 아래 처리와 같은 확인을 거침 */
        var pickSel = row && row.querySelector('select[data-role="assign-project"]');
        if (pickSel) pickSel.value = btn.getAttribute('data-project');
        /* falls through */
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
        if (linkedRv && linkedRv.status === 'approved' && linkedRv.projectId === pid && (BUD.isUnified(proj) || poolOf(linkedRv.category) === poolOf(cat))) remain += reviewProvisional(linkedRv);
        var over = (Number(req.amount) || 0) > remain;
        var urg = BUD.urgency(proj);
        if (!over && urg.check) over = null;   /* 집행 전 확인 과제: 아래에서 따로 확인 */
        var ask = over === null
          ? confirmDlg({ title: '집행 전 확인 과제', message: (proj.alias || proj.name) + ' 은(는) 행정 현황에 "' + ((BUD.base(proj) || {}).status || '집행 전 확인') + '"로 표시된 과제입니다. 이 과제로 배정할까요?', okLabel: '배정' })
          : over
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
        confirmDlg({ title: CFG.seedDemoData ? '예시 데이터로 초기화' : '모든 데이터 삭제', message: CFG.seedDemoData ? '모든 데이터를 지우고 예시 데이터로 되돌릴까요?' : '이 브라우저의 모든 데이터(계정 포함)를 지우고 관리자 계정만 남길까요? 되돌릴 수 없습니다.', okLabel: CFG.seedDemoData ? '초기화' : '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return Promise.resolve(store.resetDemo()).then(function () { toast(CFG.seedDemoData ? '예시 데이터로 초기화했습니다.' : '모든 데이터를 지웠습니다.'); if (!store.getSession()) { window.location.replace('../index.html'); return; } return refresh(); });
        }).catch(handleError);
        break;
    }
  });

  /* ---------- boot ---------- */
  var initialTab = (window.location.hash || '').replace('#', '');
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
