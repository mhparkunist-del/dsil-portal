/* =====================================================================
   DSIL Lab Portal – 장비 도입 (UI)
   탭: 도입 현황 · 도입 신청 · 내 구매 건(구매 담당자, 건 비밀번호) · 중간 담당자(PIN) · 관리자(PIN)
   흐름: 구성원 신청 → 중간 담당자 확인(구매 담당자·건 비밀번호 지정) → 구매 담당자가 단계·결제·유틸리티·위치 갱신
         → 관리자 승인 시 결제 항목이 과제 예산에 반영 (구매 완료 전 가할당, 구매 완료 후 실집행)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var ACQ = Object.assign({ stages: [{ id: 'plan', label: '장비 도입 계획' }], utilities: [], paymentMethods: [], bidThreshold: 20000000, managerUnlockMinutes: 10 }, CFG.equipmentAcquisition || {});
  var BUD = window.DSILBudget.create(CFG);
  var CATS = BUD.CATS;
  var CAT_IDS = BUD.CAT_IDS;
  var U = window.DSILUI;
  var esc = U.esc, won = U.won, nf = U.nf, fmtDate = U.fmtDate, fmtDateTime = U.fmtDateTime, $ = U.$, $all = U.$all, toast = U.toast, readForm = U.readForm;
  var dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty, dg = U.dg, stat = U.stat, csvCell = U.csvCell, download = U.download;
  var store = window.DSILStore.create(CFG);
  var ADMIN_KEY = 'dsil-budget-admin-unlock';
  var MID_KEY = 'dsil-acq-mid-unlock';
  var PUR_KEY = 'dsil-acq-purchaser-unlock';
  var TABS = ['list', 'request', 'mine', 'mid', 'admin'];
  var UNLOCK_MS = (Number(ACQ.managerUnlockMinutes) > 0 ? Number(ACQ.managerUnlockMinutes) : 10) * 60000;

  var STATUS = {
    requested: { label: '확인 대기', cls: 'bg-yellow-lt' },
    active: { label: '진행 중', cls: 'bg-blue-lt' },
    rejected: { label: '반려', cls: 'bg-red-lt' },
    cancelled: { label: '도입 취소', cls: 'bg-secondary-lt' }
  };
  var APPROVAL = {
    none: { label: '승인 전', cls: 'bg-secondary-lt' },
    approved: { label: '승인', cls: 'bg-green-lt' },
    changed: { label: '재승인 필요', cls: 'bg-orange-lt' },
    rejected: { label: '승인 반려', cls: 'bg-red-lt' }
  };
  var UTIL_STATE = { none: { label: '불필요', cls: 'bg-secondary-lt' }, need: { label: '필요', cls: 'bg-yellow-lt' }, ready: { label: '준비 완료', cls: 'bg-green-lt' } };
  var FIELD_LABEL = {
    name: '장비명', model: '제조사·모델', estAmount: '예상 금액', profConfirmed: '교수님 컨펌', profConfirmedAt: '컨펌 날짜', purpose: '사용 의도',
    targetDate: '주요 도입 시기', timelineNote: '도입 일정 메모', stage: '진행 단계', bidRequired: '입찰 대상', bidFailCount: '유찰 회차',
    payments: '결제 방법', utilities: '필요 유틸리티', location: '배치 위치', note: '비고', purchaserName: '장비 구매 담당자', pin: '장비 등록 비밀번호',
    status: '상태', approval: '승인 결제 항목'
  };
  var ACTION_LABEL = { request: '도입 신청', create: '직접 등록', confirm: '신청 확인·등록', reject: '신청 반려', update: '수정', approve: '승인', revoke: '승인 취소', 'approval-reject': '승인 반려', status: '상태 변경' };
  var ROLE_LABEL = { admin: '관리자', mid: '중간 담당자', purchaser: '구매 담당자', member: '구성원' };

  var state = {
    ready: false, error: null, session: null, magicLinkSent: false,
    managers: [], items: [], projects: [], full: {},
    logs: [], budget: null,
    tab: 'list', listFilter: 'active', adminView: 'approve', logFilter: 'all',
    adminUnlocked: false, mid: null, editId: null, midEditId: null, adminEditId: null
  };

  /* ---------- helpers ---------- */
  function me() { return state.session ? state.session.user : null; }
  function nameKey(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function isMe(name) { var u = me(); return !!u && nameKey(name) === nameKey(u.name); }
  function itemById(id) { return state.items.filter(function (x) { return x.id === id; })[0] || null; }
  function fullById(id) { return state.full[id] || itemById(id); }
  function managerById(id) { return state.managers.filter(function (x) { return x.id === id; })[0] || null; }
  function projectById(id) { return state.projects.filter(function (p) { return p.id === id; })[0] || null; }
  function stageOf(id) { return ACQ.stages.filter(function (s) { return s.id === id; })[0] || ACQ.stages[0]; }
  function catLabel(id) { for (var i = 0; i < CATS.length; i++) if (CATS[i].id === id) return CATS[i].label; return id || '-'; }
  function normCat(id) { return CAT_IDS.indexOf(id) >= 0 ? id : CAT_IDS[0]; }
  function isMidOf(m) { return !!m && (isAdminEligible() || isMe(m.name)); }
  function myMidEntries() { return state.managers.filter(isMidOf); }
  function myPurchases() { return state.items.filter(function (a) { return a.status === 'active' && isMe(a.purchaserName); }); }
  function knownNames() {
    var s = {};
    (CFG.defaultAccounts || []).forEach(function (a) { if (a && a.name) s[a.name] = 1; });
    state.items.forEach(function (a) { if (a.purchaserName) s[a.purchaserName] = 1; });
    if (me()) s[me().name] = 1;
    return Object.keys(s).sort(function (a, b) { return a.localeCompare(b, 'ko'); });
  }
  function payKey(list) {
    return JSON.stringify((list || []).filter(function (p) { return p.projectId && p.amount > 0; }).map(function (p) { return [p.projectId, p.category, Number(p.amount) || 0, p.method || '']; }));
  }
  /* 승인 이후 결제 항목이 바뀌었으면 재승인 필요 (예산에는 승인 당시 항목이 계속 반영됨) */
  function approvalState(a) {
    var ap = a.approval || { status: 'none' };
    if (ap.status === 'approved' && a.payments && payKey(a.payments) !== payKey(ap.payments)) return 'changed';
    return APPROVAL[ap.status] ? ap.status : 'none';
  }
  function paySum(list) { return (list || []).reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0); }

  function badge(map, key) { var s = map[key] || { label: key, cls: 'bg-secondary-lt' }; return '<span class="badge ' + s.cls + '">' + esc(s.label) + '</span>'; }
  function stageBadge(a) {
    var s = stageOf(a.stage);
    return '<span class="badge ' + esc(s.cls || 'bg-secondary-lt') + '">' + esc(s.label) + (a.stage === 'bid_failed' && a.bidFailCount ? ' ' + nf.format(a.bidFailCount) + '회차' : '') + '</span>';
  }
  function stageSteps(a) {
    var list = ACQ.stages.filter(function (s) { return !s.bid || a.bidRequired || s.id === a.stage; });
    return '<ul class="steps steps-counter my-3">' + list.map(function (s) {
      return '<li class="step-item' + (s.id === a.stage ? ' active' : '') + '">' + esc(s.label) + (s.id === 'bid_failed' && a.stage === 'bid_failed' && a.bidFailCount ? ' ' + nf.format(a.bidFailCount) + '회차' : '') + '</li>';
    }).join('') + '</ul>';
  }
  function utilChips(a, onlyNeeded) {
    var u = a.utilities || {};
    var chips = ACQ.utilities.map(function (x) {
      var v = u[x.id] || { state: 'none' };
      if (onlyNeeded && v.state === 'none') return '';
      return '<span class="badge ' + (UTIL_STATE[v.state] || UTIL_STATE.none).cls + ' me-1 mb-1" title="' + esc((UTIL_STATE[v.state] || UTIL_STATE.none).label + (v.note ? ' · ' + v.note : '')) + '">'
        + (v.state === 'ready' ? '<i class="ti ti-check me-1"></i>' : '') + esc(x.label) + '</span>';
    }).join('');
    return chips || '<span class="text-secondary small">없음</span>';
  }
  function fmtMonth(s) { return s ? esc(String(s).replace('-', '.')) : '-'; }
  function payText(p) {
    var pr = projectById(p.projectId);
    return (pr ? (pr.alias || pr.name) : '(과제 없음)') + ' · ' + catLabel(p.category) + ' ' + won(p.amount) + (p.method ? ' (' + p.method + ')' : '');
  }
  /* 이력 값 표시 (문자열, 호출하는 쪽에서 esc) */
  function fmtVal(field, v) {
    if (v === null || v === undefined || v === '') return '(없음)';
    if (typeof v === 'boolean') return v ? '예' : '아니오';
    if (field === 'estAmount') return won(v);
    if (field === 'stage') return stageOf(v).label;
    if (field === 'status') return (STATUS[v] || { label: v }).label;
    if (field === 'targetDate') return String(v).replace('-', '.');
    if (field === 'payments' || field === 'approval') return Array.isArray(v) && v.length ? v.map(payText).join(' / ') : '(없음)';
    if (field === 'utilities') {
      var parts = ACQ.utilities.map(function (x) { var s = v[x.id]; return s && s.state !== 'none' ? x.label + ' ' + UTIL_STATE[s.state].label + (s.note ? '(' + s.note + ')' : '') : ''; }).filter(Boolean);
      return parts.length ? parts.join(', ') : '모두 불필요';
    }
    return String(v);
  }

  /* ---------- 잠금 (관리자 / 중간 담당자 / 구매 담당자) ---------- */
  function readUnlock() { try { var t = Number(sessionStorage.getItem(ADMIN_KEY) || 0); var mins = Number(CFG.adminUnlockMinutes) > 0 ? Number(CFG.adminUnlockMinutes) : 10; return t > 0 && (Date.now() - t) < mins * 60000; } catch (e) { return false; } }
  function setUnlock(on) { try { if (on) sessionStorage.setItem(ADMIN_KEY, String(Date.now())); else sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ } state.adminUnlocked = on; }
  function isAdminEligible() { return !!(state.session && state.session.isAdmin); }
  function isAdminActive() { return isAdminEligible() && state.adminUnlocked; }
  function enterAdmin() {
    if (!isAdminEligible()) { toast('관리자 권한이 없습니다.', true); return; }
    if (readUnlock()) { setUnlock(true); state.tab = 'admin'; refresh(); return; }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요.', input: 'password', placeholder: 'PIN', okLabel: '열기' }).then(function (pin) {
      if (pin === null) return;
      return store.verifyAdminPin(pin).then(function (ok) { if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; } setUnlock(true); state.tab = 'admin'; return refresh(); });
    }).catch(handleError);
  }

  function readMid() {
    try { var m = JSON.parse(sessionStorage.getItem(MID_KEY) || 'null'); if (m && m.ts && (Date.now() - m.ts) < UNLOCK_MS && m.managerId && m.pin) return m; } catch (e) { /* ignore */ }
    return null;
  }
  function setMid(m) {
    try { if (m) sessionStorage.setItem(MID_KEY, JSON.stringify({ managerId: m.managerId, pin: m.pin, ts: Date.now() })); else sessionStorage.removeItem(MID_KEY); } catch (e) { /* ignore */ }
    state.mid = m ? { managerId: m.managerId, pin: m.pin, ts: Date.now() } : null;
  }
  function midCreds() { return state.mid ? { managerId: state.mid.managerId, pin: state.mid.pin } : null; }
  function touchMid() { if (state.mid) setMid(state.mid); }

  /* 구매 담당자: 건별 비밀번호 { <acqId>: { pin, ts } } */
  function readPur() {
    var out = {};
    try {
      var all = JSON.parse(sessionStorage.getItem(PUR_KEY) || '{}') || {};
      Object.keys(all).forEach(function (id) { var v = all[id]; if (v && v.pin && (Date.now() - v.ts) < UNLOCK_MS) out[id] = v; });
    } catch (e) { /* ignore */ }
    return out;
  }
  function setPur(id, pin) {
    var all = readPur();
    if (pin) all[id] = { pin: pin, ts: Date.now() }; else delete all[id];
    try { sessionStorage.setItem(PUR_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }
  function purPin(id) { var v = readPur()[id]; return v ? v.pin : null; }

  /* ---------- 예산 (관리자 화면 전용) : budget-core 공용 계산, 이 건의 기존 승인분은 빼고 ---------- */
  function remainOf(projectId, cat, excludeAcqId) {
    var b = state.budget; var p = projectById(projectId);
    if (!b || !p) return null;
    return BUD.remainFor(p, cat, { requests: b.requests, reviews: b.reviews, allocations: b.allocations.filter(function (al) { return al.acqId !== excludeAcqId; }) });
  }

  /* ---------- data ---------- */
  function reload() {
    state.session = store.getSession();
    state.adminUnlocked = readUnlock();
    state.mid = readMid();
    if (!state.session) { state.items = []; state.managers = []; state.projects = []; return Promise.resolve(); }
    var admin = isAdminActive();
    return Promise.all([store.acqListManagers(), store.acqList(), store.listProjects()]).then(function (res) {
      state.managers = res[0];
      state.items = res[1].slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      state.projects = res[2];
      if (state.mid && !isMidOf(managerById(state.mid.managerId))) setMid(null);
      if (state.tab === 'admin' && !admin) state.tab = 'list';
      /* 전체 필드: 관리자는 목록 그대로, 구매 담당자는 열어 둔 건, 중간 담당자는 편집 중인 건 */
      var full = {};
      if (admin) state.items.forEach(function (a) { full[a.id] = a; });
      var pur = readPur();
      var jobs = Object.keys(pur).filter(function (id) { return !full[id] && itemById(id); }).map(function (id) {
        return store.acqOpen(id, { pin: pur[id].pin }).then(function (a) { full[id] = a; }, function () { setPur(id, null); });
      });
      if (state.midEditId && state.midEditId !== 'new' && state.mid && !full[state.midEditId]) {
        var mid = state.midEditId;
        jobs.push(store.acqOpen(mid, midCreds()).then(function (a) { full[mid] = a; }, function () { state.midEditId = null; }));
      }
      if (state.editId && !pur[state.editId] && !admin) state.editId = null;
      jobs.push(admin ? Promise.all([store.acqListLogs(), store.listRequests(), store.listReviews({ full: true }), store.acqAllocations()]).then(function (r) {
        state.logs = r[0]; state.budget = { requests: r[1], reviews: r[2], allocations: r[3] };
      }) : Promise.resolve().then(function () { state.logs = []; state.budget = null; }));
      return Promise.all(jobs).then(function () { state.full = full; });
    });
  }

  /* ---------- render ---------- */
  function render() {
    state.adminUnlocked = readUnlock();
    state.mid = readMid();
    renderUserChip();
    var app = $('#app');
    if (!app) return;
    if (state.error) { app.innerHTML = '<div class="alert alert-danger"><h4 class="alert-title">초기화 오류</h4><div class="text-secondary">' + esc(state.error) + '</div></div>'; return; }
    if (!state.ready) { app.innerHTML = '<div class="text-secondary text-center py-5">불러오는 중…</div>'; return; }
    if (!state.session) { app.innerHTML = '<div class="text-secondary text-center py-5">로그인이 필요합니다.</div>'; return; }

    var live = state.items.filter(function (a) { return a.status === 'active'; });
    var waiting = state.items.filter(function (a) { return a.status === 'requested'; });
    var utilNeed = live.filter(function (a) { return ACQ.utilities.some(function (x) { return ((a.utilities || {})[x.id] || {}).state === 'need'; }); });
    var html = '<div class="row row-deck row-cards mb-3">'
      + stat('진행 중', live.length + '건', live.filter(function (a) { return a.stage === 'purchased'; }).length + '건 구매 완료', 'text-primary')
      + stat('확인 대기', waiting.length + '건', '중간 담당자 확인 전', waiting.length ? 'text-yellow' : '')
      + stat('입찰 진행', live.filter(function (a) { return stageOf(a.stage).bid; }).length + '건', '유찰 ' + live.filter(function (a) { return a.stage === 'bid_failed'; }).length + '건', '')
      + stat('유틸리티 준비 필요', utilNeed.length + '건', utilNeed.length ? utilNeed.slice(0, 2).map(function (a) { return a.name; }).join(', ') + (utilNeed.length > 2 ? ' 외' : '') : '모두 준비됨', utilNeed.length ? 'text-orange' : 'text-green')
      + '</div>';

    var mine = myPurchases();
    var tab = state.tab === 'request' ? renderRequestTab() : state.tab === 'mine' ? renderMineTab() : state.tab === 'mid' ? renderMidTab() : state.tab === 'admin' ? renderAdminTab() : renderListTab();
    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('list', 'list-details', '도입 현황') + tabLink('request', 'file-plus', '도입 신청')
      + tabLink('mine', 'user-check', '내 구매 건' + (mine.length ? ' ' + mine.length : ''))
      + tabLink('mid', state.mid ? 'lock-open' : 'lock', '중간 담당자')
      + (isAdminEligible() ? tabLink('admin', state.adminUnlocked ? 'lock-open' : 'lock', '관리자') : '')
      + '</ul></div>' + tab.body + '</div>' + (tab.after || '');
    app.innerHTML = html;
    try { history.replaceState(null, '', '#' + state.tab); } catch (e) { /* ignore */ }
  }

  function tabLink(id, icon, label) {
    return '<li class="nav-item"><a href="#' + id + '" class="nav-link' + (state.tab === id ? ' active' : '') + '" data-action="tab" data-tab="' + id + '" role="tab"><i class="ti ti-' + icon + ' me-1"></i>' + esc(label) + '</a></li>';
  }

  function renderUserChip() {
    var slot = $('#user-slot');
    if (!slot) return;
    if (!state.session) { slot.innerHTML = ''; return; }
    var s = state.session;
    var role = isAdminActive() ? '관리자 · 열림' : (state.mid ? '중간 담당자 · 열림' : '구성원');
    slot.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="avatar avatar-sm bg-blue-lt">' + esc((s.user.name || '?').trim().charAt(0)) + '</span>'
      + '<div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(s.user.name) + '</div><div class="small text-secondary mt-1">' + role + '</div></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="signout"><i class="ti ti-logout"></i><span class="d-none d-sm-inline ms-1">로그아웃</span></button></div>';
  }

  /* ---------- 도입 현황 (금액·예산 없음) ---------- */
  function renderListTab() {
    var filters = [['active', '진행 중'], ['requested', '확인 대기'], ['closed', '반려·취소'], ['all', '전체']];
    var list = state.items.filter(function (a) {
      if (state.listFilter === 'all') return true;
      if (state.listFilter === 'closed') return a.status === 'rejected' || a.status === 'cancelled';
      return a.status === state.listFilter;
    });
    var body = '<div class="card-body py-2 border-bottom d-flex flex-wrap gap-2 align-items-center">'
      + filters.map(function (f) { return '<button type="button" class="btn btn-sm ' + (state.listFilter === f[0] ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="list-filter" data-filter="' + f[0] + '">' + esc(f[1]) + '</button>'; }).join('')
      + '<a href="#request" class="ms-auto small" data-action="tab" data-tab="request">새 장비 도입 신청 <i class="ti ti-arrow-right"></i></a></div>';
    if (!list.length) return { body: body + '<div class="card-body">' + empty('device-desktop-off', '해당하는 장비 도입 건이 없습니다', '도입 신청 탭에서 신청하면 중간 담당자가 확인한 뒤 진행됩니다.') + '</div>' };
    body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>장비</th><th>진행 단계</th><th>구매 담당자</th><th>도입 시기</th><th>배치 위치</th><th>필요 유틸리티</th><th class="w-1"></th></tr></thead><tbody>'
      + list.map(function (a) {
        return '<tr><td><div class="fw-medium">' + esc(a.name) + '</div><div class="small text-secondary">' + esc(a.model || '') + (a.model ? ' · ' : '') + badge(STATUS, a.status)
          + (a.profConfirmed ? ' <span class="badge bg-green-lt">교수님 컨펌</span>' : ' <span class="badge bg-yellow-lt">컨펌 전</span>') + '</div></td>'
          + '<td class="text-nowrap">' + stageBadge(a) + '</td>'
          + '<td class="text-nowrap">' + esc(a.purchaserName || '-') + '</td>'
          + '<td class="text-nowrap">' + fmtMonth(a.targetDate) + '</td>'
          + '<td>' + esc(a.location || '-') + '</td>'
          + '<td>' + utilChips(a, true) + '</td>'
          + '<td class="text-end"><button type="button" class="btn btn-sm" data-action="detail" data-id="' + esc(a.id) + '">보기</button></td></tr>';
      }).join('') + '</tbody></table></div>';
    return { body: body };
  }

  function detailDialog(id) {
    var a = fullById(id); if (!a) return Promise.resolve();
    var u = a.utilities || {};
    var html = stageSteps(a)
      + '<div class="datagrid mb-3">'
      + dg('상태', badge(STATUS, a.status)) + dg('구매 담당자', esc(a.purchaserName || '미지정'))
      + dg('교수님 컨펌', a.profConfirmed ? '완료' + (a.profConfirmedAt ? ' (' + esc(a.profConfirmedAt.replace(/-/g, '.')) + ')' : '') : '<span class="text-yellow">컨펌 전</span>')
      + dg('주요 도입 시기', fmtMonth(a.targetDate) + (a.timelineNote ? '<div class="small text-secondary">' + esc(a.timelineNote) + '</div>' : ''))
      + dg('제조사·모델', esc(a.model || '-')) + dg('배치 위치', esc(a.location || '-'))
      + dg('신청', esc(a.requestedBy || '-') + ' · ' + fmtDate(a.createdAt)) + dg('확인·등록', a.registeredBy ? esc(a.registeredBy) + (a.confirmedAt ? ' · ' + fmtDate(a.confirmedAt) : '') : '-')
      + '</div>'
      + '<div class="mb-3"><div class="subheader mb-1">사용 의도</div><div class="text-pre-wrap">' + esc(a.purpose || '-') + '</div></div>'
      + '<div class="mb-3"><div class="subheader mb-1">필요 유틸리티</div><table class="table table-sm mb-0"><tbody>' + ACQ.utilities.map(function (x) {
        var v = u[x.id] || { state: 'none' };
        return '<tr><td class="w-25">' + esc(x.label) + '</td><td class="w-25">' + badge(UTIL_STATE, v.state) + '</td><td class="text-secondary small">' + esc(v.note || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>'
      + (a.note ? '<div class="mb-0"><div class="subheader mb-1">비고</div><div class="text-pre-wrap">' + esc(a.note) + '</div></div>' : '');
    return dialog({ title: a.name, html: html, size: 'lg', hideCancel: true, okLabel: '닫기' });
  }

  /* ---------- 등록 양식 (신청 / 직접 등록 / 확인 / 수정) ---------- */
  function regFormHtml(a, mode) {
    a = a || {};
    var assign = mode === 'new' || mode === 'confirm';
    var canAssign = assign || mode === 'edit' || mode === 'admin';
    var names = knownNames().map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
    var submitLabel = { request: '도입 신청', new: '등록', confirm: '확인하고 등록', edit: '저장', admin: '등록 정보 저장' }[mode];
    return '<form id="reg-form" data-mode="' + esc(mode) + '" data-id="' + esc(a.id || '') + '" novalidate><div class="row g-3">'
      + '<div class="col-md-7"><label class="form-label required">장비명</label><input type="text" class="form-control" name="name" value="' + esc(a.name || '') + '" placeholder="예: ALD 장비"></div>'
      + '<div class="col-md-5"><label class="form-label">제조사·모델</label><input type="text" class="form-control" name="model" value="' + esc(a.model || '') + '"></div>'
      + '<div class="col-md-5"><label class="form-label">예상 금액 (원)</label><input type="number" class="form-control tnum" name="estAmount" min="0" step="1" value="' + (a.estAmount ? esc(a.estAmount) : '') + '"></div>'
      + '<div class="col-md-7"><label class="form-label">교수님 컨펌</label><div class="d-flex gap-2 align-items-center">'
      + '<label class="form-check form-switch mb-0 text-nowrap"><input class="form-check-input" type="checkbox" name="profConfirmed"' + (a.profConfirmed ? ' checked' : '') + '><span class="form-check-label">컨펌 받음</span></label>'
      + '<input type="date" class="form-control" name="profConfirmedAt" value="' + esc(a.profConfirmedAt || '') + '" title="컨펌 날짜"></div></div>'
      + '<div class="col-12"><label class="form-label required">사용 의도</label><textarea class="form-control" name="purpose" rows="3" placeholder="어떤 연구에 어떻게 쓸 장비인지, 기존 장비로 안 되는 이유 등">' + esc(a.purpose || '') + '</textarea></div>'
      + '<div class="col-md-4"><label class="form-label required">주요 도입 시기</label><input type="month" class="form-control" name="targetDate" value="' + esc(a.targetDate || '') + '" placeholder="2026-12"></div>'
      + '<div class="col-md-8"><label class="form-label">도입 일정 메모</label><input type="text" class="form-control" name="timelineNote" value="' + esc(a.timelineNote || '') + '" placeholder="예: 연말 과제 종료 전 계약 필요"></div>'
      + (canAssign ? '<div class="col-12"><hr class="my-1"></div>'
        + '<div class="col-md-4"><label class="form-label' + (assign ? ' required' : '') + '">장비 구매 담당자</label><input type="text" class="form-control" name="purchaserName" list="acq-names" value="' + esc(a.purchaserName || '') + '" placeholder="포털 로그인 이름"><datalist id="acq-names">' + names + '</datalist>'
        + '<div class="form-hint">이 이름으로 로그인한 사람만 진행 상황을 갱신할 수 있습니다.</div></div>'
        + '<div class="col-md-4"><label class="form-label' + (assign ? ' required' : '') + '">장비 등록 비밀번호' + (assign ? '' : ' <span class="form-label-description">바꿀 때만</span>') + '</label><input type="password" class="form-control" name="pin" inputmode="numeric" autocomplete="new-password" placeholder="숫자 4~8자리"></div>'
        + '<div class="col-md-4"><label class="form-label' + (assign ? ' required' : '') + '">비밀번호 확인</label><input type="password" class="form-control" name="pin2" inputmode="numeric" autocomplete="new-password"></div>'
        + '<div class="col-12 small text-secondary"><i class="ti ti-info-circle me-1"></i>비밀번호는 구매 담당자에게 따로 전해 주세요. 포털에는 해시로만 저장되어 다시 볼 수 없습니다.</div>' : '')
      + '</div><div class="d-flex justify-content-end gap-2 mt-3">'
      + (mode === 'confirm' ? '<button type="button" class="btn btn-outline-danger me-auto" data-action="mid-reject" data-id="' + esc(a.id) + '"><i class="ti ti-x me-1"></i>반려</button>' : '')
      + (mode !== 'request' ? '<button type="button" class="btn" data-action="cancel-edit">취소</button>' : '')
      + '<button type="submit" class="btn btn-primary"><i class="ti ti-device-floppy me-1"></i>' + esc(submitLabel) + '</button></div></form>';
  }

  /* 빠진 항목은 빨간 테두리 + 토스트. 버튼은 잠그지 않음 */
  function markMissing(form, checks) {
    $all('.is-invalid', form).forEach(function (el) { el.classList.remove('is-invalid'); });
    var miss = [], first = null;
    checks.forEach(function (c) {
      if (c.ok) return;
      miss.push(c.label);
      var el = c.name ? form.querySelector('[name="' + c.name + '"]') : null;
      if (el) { el.classList.add('is-invalid'); if (!first) first = el; }
    });
    if (miss.length) { toast('빠진 항목: ' + miss.join(', '), true); if (first) first.focus(); }
    return miss.length === 0;
  }

  function readReg(form) {
    var v = readForm(form);
    return {
      fields: { name: v.name, model: v.model, estAmount: Number(v.estAmount) || 0, profConfirmed: !!v.profConfirmed, profConfirmedAt: v.profConfirmedAt, purpose: v.purpose, targetDate: v.targetDate, timelineNote: v.timelineNote },
      purchaserName: v.purchaserName !== undefined ? String(v.purchaserName).trim() : undefined, pin: v.pin || '', pin2: v.pin2 || ''
    };
  }

  function submitReg(form) {
    var mode = form.getAttribute('data-mode');
    var id = form.getAttribute('data-id') || null;
    var r = readReg(form);
    var assign = mode === 'new' || mode === 'confirm';
    var checks = [
      { ok: !!String(r.fields.name).trim(), name: 'name', label: '장비명' },
      { ok: !!String(r.fields.purpose).trim(), name: 'purpose', label: '사용 의도' },
      { ok: /^\d{4}-\d{2}$/.test(r.fields.targetDate || ''), name: 'targetDate', label: '주요 도입 시기' }
    ];
    if (r.purchaserName !== undefined) checks.push({ ok: !!r.purchaserName, name: 'purchaserName', label: '장비 구매 담당자' });
    if (assign || r.pin) {
      checks.push({ ok: /^\d{4,8}$/.test(r.pin), name: 'pin', label: '장비 등록 비밀번호(숫자 4~8자리)' });
      checks.push({ ok: r.pin === r.pin2 && !!r.pin2, name: 'pin2', label: '비밀번호 확인 일치' });
    }
    if (!markMissing(form, checks)) return;
    if (r.fields.profConfirmed === false && mode !== 'request') toast('교수님 컨펌 전으로 저장합니다.');
    var job;
    if (mode === 'request') job = store.acqRequest(r.fields).then(function () { toast('도입 신청을 올렸습니다. 중간 담당자가 확인하면 진행됩니다.'); state.tab = 'list'; state.listFilter = 'requested'; });
    else if (mode === 'new') job = store.acqCreate(r.fields, { purchaserName: r.purchaserName, pin: r.pin }, midCreds()).then(function () { toast('장비 도입 건을 등록했습니다.'); state.midEditId = null; touchMid(); });
    else if (mode === 'confirm') job = store.acqConfirm(id, { purchaserName: r.purchaserName, pin: r.pin }, r.fields, midCreds()).then(function () { toast('신청을 확인하고 등록했습니다.'); state.midEditId = null; touchMid(); });
    else {
      var patch = Object.assign({}, r.fields, { purchaserName: r.purchaserName });
      if (r.pin) patch.newPin = r.pin;
      var auth = mode === 'admin' ? { admin: true } : midCreds();
      job = store.acqUpdate(id, patch, auth).then(function () {
        toast('등록 정보를 저장했습니다.');
        if (mode === 'admin') { state.adminEditId = null; setUnlock(true); } else { state.midEditId = null; touchMid(); }
      });
    }
    job.then(refresh).catch(handleError);
  }

  /* ---------- 도입 신청 탭 ---------- */
  function renderRequestTab() {
    var mineReq = state.items.filter(function (a) { return isMe(a.requestedBy); });
    var body = '<div class="card-body"><div class="row g-4"><div class="col-lg-7">'
      + '<h3 class="card-title mb-1"><i class="ti ti-file-plus me-1 text-primary"></i>장비 도입 신청</h3>'
      + '<p class="text-secondary small mb-3">신청하면 중간 담당자가 내용을 확인하고 장비 구매 담당자를 정해 등록합니다. 예산 배정은 관리자 승인 때 이뤄지므로 여기서는 예산을 신경 쓰지 않아도 됩니다.</p>'
      + regFormHtml({}, 'request') + '</div>'
      + '<div class="col-lg-5"><h3 class="card-title mb-2"><i class="ti ti-history me-1 text-primary"></i>내 신청</h3>';
    if (!mineReq.length) body += '<div class="text-secondary small">아직 신청한 건이 없습니다.</div>';
    else body += '<div class="list-group list-group-flush">' + mineReq.map(function (a) {
      return '<a href="#" class="list-group-item list-group-item-action px-0 d-flex justify-content-between gap-2" data-action="detail" data-id="' + esc(a.id) + '"><div>' + esc(a.name) + '<div class="small text-secondary">' + fmtDate(a.createdAt) + (a.purchaserName ? ' · 구매 담당 ' + esc(a.purchaserName) : '') + '</div></div><div class="text-end text-nowrap">' + badge(STATUS, a.status) + '<div class="mt-1">' + stageBadge(a) + '</div></div></a>';
    }).join('') + '</div>';
    body += '</div></div></div>';
    return { body: body };
  }

  /* ---------- 진행 양식 (구매 담당자 / 관리자) ---------- */
  function projectOptions(selected) {
    var list = state.projects.filter(function (p) { return BUD.isManaged(p) || p.id === selected; });
    return '<option value="">과제 선택</option>' + list.map(function (p) {
      var full = p.name.length > 24 ? p.name.slice(0, 24) + '…' : p.name;
      return '<option value="' + esc(p.id) + '"' + (p.id === selected ? ' selected' : '') + ' title="' + esc(p.name) + '">' + esc(p.alias && p.alias !== p.name ? p.alias + ' · ' + full : p.name) + '</option>';
    }).join('');
  }
  function catOptions(selected) { var sel = BUD.poolOf(selected); return BUD.POOLS.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === sel ? ' selected' : '') + '>' + esc(c.label) + '</option>'; }).join(''); }
  function payRowHtml(p, i) {
    p = p || {};
    return '<div class="row g-2 pay-row mb-2 align-items-end">'
      + '<div class="col-md-4"><label class="form-label small mb-1">과제 ' + (i + 1) + '</label><select class="form-select" name="pay_project">' + projectOptions(p.projectId) + '</select></div>'
      + '<div class="col-md-2 col-6"><label class="form-label small mb-1">비목</label><select class="form-select" name="pay_category">' + catOptions(p.category || 'equipment') + '</select></div>'
      + '<div class="col-md-2 col-6"><label class="form-label small mb-1">금액 (원)</label><input type="number" class="form-control tnum" name="pay_amount" min="0" step="1" value="' + (p.amount ? esc(p.amount) : '') + '"></div>'
      + '<div class="col-md-3 col-10"><label class="form-label small mb-1">결제 수단</label><input type="text" class="form-control" name="pay_method" list="pay-methods" value="' + esc(p.method || '') + '" placeholder="예: 구매팀 발주"></div>'
      + '<div class="col-md-1 col-2 text-end"><button type="button" class="btn btn-ghost-danger btn-icon" data-action="pay-remove" title="이 행 삭제"><i class="ti ti-trash"></i></button></div></div>';
  }

  function progFormHtml(a, who) {
    var u = a.utilities || {};
    var ap = approvalState(a);
    var bidHint = (Number(a.estAmount) || 0) >= (Number(ACQ.bidThreshold) || Infinity) ? '<div class="small text-orange mt-1"><i class="ti ti-alert-circle me-1"></i>예상 금액이 ' + won(ACQ.bidThreshold) + ' 이상이라 구매팀 입찰 대상입니다.</div>' : '';
    var apNote = ap === 'changed' ? '<div class="alert alert-warning py-2 mb-3"><i class="ti ti-alert-triangle me-1"></i>결제 항목이 관리자 승인 내용과 다릅니다. 저장하면 관리자에게 재승인 대상으로 표시되고, 재승인 전까지는 승인 당시 금액이 예산에 반영됩니다.</div>'
      : ap === 'approved' ? '<div class="alert alert-success py-2 mb-3"><i class="ti ti-circle-check me-1"></i>관리자가 결제 항목을 승인했습니다. 결제 항목을 바꾸면 재승인이 필요합니다.</div>'
      : ap === 'rejected' ? '<div class="alert alert-danger py-2 mb-3"><i class="ti ti-circle-x me-1"></i>관리자가 승인을 반려했습니다' + (a.approval && a.approval.note ? ': ' + esc(a.approval.note) : '.') + ' 결제 항목을 고쳐 저장하세요.</div>'
      : '<div class="alert alert-info py-2 mb-3"><i class="ti ti-info-circle me-1"></i>결제 항목은 관리자가 승인해야 과제 예산에 반영됩니다. 남은 예산과 관계없이 계획대로 적어 주세요.</div>';
    var pays = (a.payments && a.payments.length) ? a.payments : [{}];
    return '<form id="prog-form" data-id="' + esc(a.id) + '" data-who="' + esc(who) + '" novalidate>' + apNote
      + '<h4 class="mb-2"><i class="ti ti-progress me-1 text-primary"></i>진행 단계</h4>' + stageSteps(a)
      + '<div class="row g-3 mb-4">'
      + '<div class="col-md-5"><label class="form-label">현재 단계</label><select class="form-select" name="stage">' + ACQ.stages.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === a.stage ? ' selected' : '') + ' data-bid="' + (s.bid ? '1' : '') + '">' + esc(s.label) + (s.bid ? ' (입찰)' : '') + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-md-3"><label class="form-label">유찰 회차</label><input type="number" class="form-control tnum" name="bidFailCount" min="0" step="1" value="' + esc(a.bidFailCount || 0) + '"></div>'
      + '<div class="col-md-4"><label class="form-label">입찰 여부</label><label class="form-check form-switch mt-2"><input class="form-check-input" type="checkbox" name="bidRequired"' + (a.bidRequired ? ' checked' : '') + '><span class="form-check-label">입찰 대상</span></label></div>'
      + '<div class="col-md-5"><label class="form-label">예상 금액 (원)</label><input type="number" class="form-control tnum" name="estAmount" min="0" step="1" value="' + (a.estAmount ? esc(a.estAmount) : '') + '">' + bidHint + '</div>'
      + '</div>'
      + '<h4 class="mb-2"><i class="ti ti-credit-card me-1 text-primary"></i>결제 방법</h4>'
      + '<div id="pay-rows">' + pays.map(payRowHtml).join('') + '</div>'
      + '<datalist id="pay-methods">' + (ACQ.paymentMethods || []).map(function (m) { return '<option value="' + esc(m) + '">'; }).join('') + '</datalist>'
      + '<div class="d-flex flex-wrap justify-content-between align-items-center gap-2 mb-4"><button type="button" class="btn btn-sm" data-action="pay-add"><i class="ti ti-plus me-1"></i>과제 추가</button>'
      + '<div class="small" id="pay-sum">' + paySumHtml(paySum(a.payments), a.estAmount) + '</div></div>'
      + '<h4 class="mb-2"><i class="ti ti-plug me-1 text-primary"></i>필요 유틸리티</h4>'
      + '<div class="table-responsive mb-4"><table class="table table-sm table-vcenter mb-0"><tbody>' + ACQ.utilities.map(function (x) {
        var v = u[x.id] || { state: 'none', note: '' };
        return '<tr><td class="w-1 fw-medium text-nowrap">' + esc(x.label) + '</td><td class="w-1"><div class="btn-group" role="group">' + ['none', 'need', 'ready'].map(function (st) {
          var rid = 'u-' + x.id + '-' + st;
          return '<input type="radio" class="btn-check" name="util_' + esc(x.id) + '" id="' + rid + '" value="' + st + '"' + (v.state === st ? ' checked' : '') + '><label class="btn btn-sm" for="' + rid + '">' + esc(UTIL_STATE[st].label) + '</label>';
        }).join('') + '</div></td><td><input type="text" class="form-control form-control-sm" name="utilnote_' + esc(x.id) + '" value="' + esc(v.note || '') + '" placeholder="사양·공사 일정 등"></td></tr>';
      }).join('') + '</tbody></table></div>'
      + '<div class="row g-3"><div class="col-md-6"><label class="form-label"><i class="ti ti-map-pin me-1 text-primary"></i>장비 배치 위치</label><input type="text" class="form-control" name="location" value="' + esc(a.location || '') + '" placeholder="예: E3-3 2302 클린룸 B-2"></div>'
      + '<div class="col-md-6"><label class="form-label">변경 사유 <span class="form-label-description">이력에 함께 남음</span></label><input type="text" class="form-control" name="logNote" placeholder="예: 1차 입찰 유찰"></div>'
      + '<div class="col-12"><label class="form-label">비고</label><textarea class="form-control" name="note" rows="2">' + esc(a.note || '') + '</textarea></div></div>'
      + '<div class="d-flex justify-content-end gap-2 mt-3"><button type="button" class="btn" data-action="cancel-edit">닫기</button><button type="submit" class="btn btn-primary"><i class="ti ti-device-floppy me-1"></i>저장</button></div></form>';
  }
  function paySumHtml(sum, est) {
    var diff = (Number(est) || 0) > 0 && sum !== Number(est);
    return '합계 <strong class="tnum">' + won(sum) + '</strong>' + (diff ? ' <span class="text-orange">· 예상 금액 ' + won(est) + '과 다름</span>' : '');
  }
  function readPayRows(form) {
    return $all('.pay-row', form).map(function (row) {
      return { projectId: row.querySelector('[name="pay_project"]').value, category: row.querySelector('[name="pay_category"]').value,
        amount: Number(row.querySelector('[name="pay_amount"]').value) || 0, method: row.querySelector('[name="pay_method"]').value.trim() };
    }).filter(function (p) { return p.projectId || p.amount > 0 || p.method; });
  }

  function submitProg(form) {
    var id = form.getAttribute('data-id');
    var who = form.getAttribute('data-who');
    var v = readForm(form);
    var pays = readPayRows(form);
    $all('.is-invalid', form).forEach(function (el) { el.classList.remove('is-invalid'); });
    var bad = [];
    $all('.pay-row', form).forEach(function (row) {
      var pj = row.querySelector('[name="pay_project"]'), am = row.querySelector('[name="pay_amount"]');
      var any = pj.value || Number(am.value) > 0 || row.querySelector('[name="pay_method"]').value.trim();
      if (!any) return;
      if (!pj.value) { pj.classList.add('is-invalid'); bad.push('결제 과제'); }
      if (!(Number(am.value) > 0)) { am.classList.add('is-invalid'); bad.push('결제 금액'); }
    });
    if (bad.length) { toast('결제 방법에 빠진 항목이 있습니다: ' + bad.filter(function (x, i) { return bad.indexOf(x) === i; }).join(', '), true); return; }
    var stage = v.stage;
    var isBid = !!stageOf(stage).bid;
    var utilities = {};
    ACQ.utilities.forEach(function (x) { utilities[x.id] = { state: v['util_' + x.id] || 'none', note: v['utilnote_' + x.id] || '' }; });
    var patch = { stage: stage, bidRequired: !!v.bidRequired || isBid, bidFailCount: Math.max(Number(v.bidFailCount) || 0, stage === 'bid_failed' ? 1 : 0),
      estAmount: Number(v.estAmount) || 0, payments: pays, utilities: utilities, location: v.location, note: v.note, logNote: v.logNote };
    var auth = who === 'admin' ? { admin: true } : { pin: purPin(id) };
    if (who !== 'admin' && !auth.pin) { toast('비밀번호 확인 시간이 지났습니다. 다시 열어 주세요.', true); state.editId = null; refresh(); return; }
    store.acqUpdate(id, patch, auth).then(function () {
      toast('저장했습니다. 변경 내용은 이력에 남습니다.');
      if (who === 'admin') setUnlock(true); else setPur(id, auth.pin);
      return refresh();
    }).catch(handleError);
  }

  /* ---------- 내 구매 건 (구매 담당자) ---------- */
  function renderMineTab() {
    var mine = myPurchases();
    var u = me();
    if (state.editId) {
      var a = state.full[state.editId];
      if (a && purPin(a.id)) {
        return { body: '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom"><div><i class="ti ti-lock-open me-1 text-primary"></i><strong>' + esc(a.name) + '</strong> <span class="text-secondary small">구매 담당자 · ' + Math.round(UNLOCK_MS / 60000) + '분 동안 열림</span></div>'
          + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-pur" data-id="' + esc(a.id) + '"><i class="ti ti-lock me-1"></i>잠금</button></div>'
          + '<div class="card-body">' + progFormHtml(a, 'purchaser') + '</div>' };
      }
    }
    var body = '<div class="card-body">';
    if (mine.length) body += '<p class="text-secondary small mb-3"><i class="ti ti-info-circle me-1"></i>' + esc(u ? u.name : '') + ' 님이 장비 구매 담당자로 지정된 건입니다. 중간 담당자에게 받은 장비 등록 비밀번호를 넣으면 진행 단계·결제 방법·유틸리티·배치 위치를 갱신할 수 있습니다.</p>';
    if (!mine.length) return { body: body + empty('user-question', '담당 중인 장비 구매 건이 없습니다', '중간 담당자가 구매 담당자로 지정하면 여기에 나타납니다. 이름이 포털 로그인 이름과 같아야 합니다.') + '</div>' };
    body += '<div class="row row-cards">' + mine.map(function (a) {
      var open = !!purPin(a.id) && !!state.full[a.id];
      var f = state.full[a.id];
      return '<div class="col-md-6"><div class="card card-sm"><div class="card-body"><div class="d-flex justify-content-between align-items-start gap-2">'
        + '<div><div class="fw-medium">' + esc(a.name) + '</div><div class="small text-secondary">도입 시기 ' + fmtMonth(a.targetDate) + (a.location ? ' · ' + esc(a.location) : '') + '</div></div>' + stageBadge(a) + '</div>'
        + '<div class="mt-2">' + utilChips(a, true) + '</div>'
        + (f ? '<div class="mt-2 small">승인 ' + badge(APPROVAL, approvalState(f)) + ' <span class="text-secondary ms-1">결제 합계 ' + won(paySum(f.payments)) + '</span></div>' : '')
        + '<div class="d-flex justify-content-end gap-2 mt-3"><button type="button" class="btn btn-sm" data-action="detail" data-id="' + esc(a.id) + '">보기</button>'
        + '<button type="button" class="btn btn-sm btn-primary" data-action="pur-open" data-id="' + esc(a.id) + '"><i class="ti ti-' + (open ? 'lock-open' : 'key') + ' me-1"></i>상태 갱신</button></div>'
        + '</div></div></div>';
    }).join('') + '</div></div>';
    return { body: body };
  }

  function openPurchaser(id) {
    var a = itemById(id); if (!a) return;
    var pin = purPin(id);
    var ask = pin ? Promise.resolve(pin) : promptDlg({ title: a.name + ' · 장비 등록 비밀번호', message: '중간 담당자에게 받은 이 건의 비밀번호를 입력하세요.', input: 'password', placeholder: '숫자 4~8자리', okLabel: '열기' });
    ask.then(function (p) {
      if (p === null || p === undefined || p === '') return;
      return store.acqOpen(id, { pin: p }).then(function (full) {
        setPur(id, p); state.full[id] = full; state.editId = id; state.tab = 'mine'; render();
      }, function (err) { setPur(id, null); throw err; });
    }).catch(handleError);
  }

  /* ---------- 중간 담당자 탭 ---------- */
  function renderMidTab() {
    if (!state.mid) {
      var mine = myMidEntries();
      var u = me();
      var body = '<div class="card-body"><div class="container-tight"><h3 class="card-title mb-1"><i class="ti ti-user-shield me-1 text-primary"></i>중간 담당자 확인</h3>'
        + '<p class="text-secondary small mb-3">중간 담당자로 등록된 계정만 열 수 있습니다. 본인 계정으로 로그인한 상태에서 중간 담당자 PIN을 넣으면 ' + Math.round(UNLOCK_MS / 60000) + '분 동안 신청 확인·장비 등록이 열립니다.</p>';
      if (!state.managers.length) body += empty('user-off', '등록된 중간 담당자가 없습니다', '관리자 탭에서 지정하세요.');
      else if (!mine.length) {
        body += empty('user-shield', '중간 담당자로 등록되어 있지 않습니다', '지금 로그인한 계정(' + (u ? u.name : '') + ')은 장비 도입 중간 담당자가 아닙니다.')
          + '<div class="text-secondary small text-center">중간 담당자: ' + state.managers.map(function (m) { return esc(m.name); }).join(', ') + '</div>';
      } else {
        body += '<form id="mid-form"><div class="mb-3"><label class="form-label required">중간 담당자</label><select class="form-select" name="managerId">' + mine.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + '</option>'; }).join('') + '</select></div>'
          + '<div class="mb-3"><label class="form-label required">PIN</label><input type="password" class="form-control" name="pin" inputmode="numeric" autocomplete="off"></div><button type="submit" class="btn btn-primary w-100"><i class="ti ti-key me-1"></i>열기</button></form>';
      }
      return { body: body + '</div></div>' };
    }
    var mgr = managerById(state.mid.managerId);
    var head = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom">'
      + '<div><i class="ti ti-lock-open me-1 text-primary"></i><strong>' + esc(mgr ? mgr.name : '') + '</strong> <span class="text-secondary small">중간 담당자 모드</span></div>'
      + '<div class="d-flex gap-2"><button type="button" class="btn btn-sm btn-primary" data-action="mid-new"><i class="ti ti-plus me-1"></i>직접 등록</button><button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-mid"><i class="ti ti-lock me-1"></i>잠금</button></div></div>';
    if (state.midEditId) {
      var editing = state.midEditId === 'new' ? null : (state.full[state.midEditId] || itemById(state.midEditId));
      var mode = !editing ? 'new' : editing.status === 'requested' ? 'confirm' : 'edit';
      var title = { new: '장비 도입 직접 등록', confirm: '신청 확인 · ' + (editing ? editing.name : ''), edit: '등록 정보 수정 · ' + (editing ? editing.name : '') }[mode];
      return { body: head + '<div class="card-body"><h3 class="card-title mb-1">' + esc(title) + '</h3>'
        + (mode === 'confirm' ? '<p class="text-secondary small mb-3">' + esc(editing.requestedBy) + ' 님이 ' + fmtDate(editing.createdAt) + '에 신청했습니다. 내용을 확인·보완하고 장비 구매 담당자와 비밀번호를 정해 주세요.</p>' : '<p class="text-secondary small mb-3">진행 단계·결제·유틸리티는 구매 담당자가 입력합니다.</p>')
        + regFormHtml(editing || {}, mode) + '</div>' };
    }
    var waiting = state.items.filter(function (a) { return a.status === 'requested'; });
    var active = state.items.filter(function (a) { return a.status === 'active'; });
    var body2 = head + '<div class="card-body"><h3 class="card-title mb-2"><i class="ti ti-inbox me-1 text-primary"></i>확인 대기 신청 <span class="text-secondary fw-normal">' + waiting.length + '건</span></h3>';
    if (!waiting.length) body2 += '<div class="text-secondary small mb-4">확인할 신청이 없습니다.</div>';
    else body2 += '<div class="table-responsive mb-4"><table class="table table-vcenter"><thead><tr><th>장비</th><th>신청</th><th>교수님 컨펌</th><th>도입 시기</th><th class="w-1"></th></tr></thead><tbody>' + waiting.map(function (a) {
      return '<tr><td><div class="fw-medium">' + esc(a.name) + '</div><div class="small text-secondary text-truncate" style="max-width:26rem">' + esc(a.purpose) + '</div></td><td class="text-nowrap">' + esc(a.requestedBy) + '<div class="small text-secondary">' + fmtDate(a.createdAt) + '</div></td>'
        + '<td>' + (a.profConfirmed ? '<span class="badge bg-green-lt">완료</span>' : '<span class="badge bg-yellow-lt">컨펌 전</span>') + '</td><td class="text-nowrap">' + fmtMonth(a.targetDate) + '</td>'
        + '<td class="text-nowrap"><button type="button" class="btn btn-sm btn-primary" data-action="mid-edit" data-id="' + esc(a.id) + '">확인·등록</button></td></tr>';
    }).join('') + '</tbody></table></div>';
    body2 += '<h3 class="card-title mb-2"><i class="ti ti-list-check me-1 text-primary"></i>진행 중 <span class="text-secondary fw-normal">' + active.length + '건</span></h3>';
    if (!active.length) body2 += '<div class="text-secondary small">진행 중인 건이 없습니다.</div>';
    else body2 += '<div class="table-responsive"><table class="table table-vcenter"><thead><tr><th>장비</th><th>진행 단계</th><th>구매 담당자</th><th>등록</th><th class="w-1"></th></tr></thead><tbody>' + active.map(function (a) {
      return '<tr><td class="fw-medium">' + esc(a.name) + '</td><td>' + stageBadge(a) + '</td><td>' + esc(a.purchaserName) + '</td><td class="small text-secondary text-nowrap">' + esc(a.registeredBy || '-') + '</td>'
        + '<td class="text-nowrap"><button type="button" class="btn btn-sm" data-action="mid-edit" data-id="' + esc(a.id) + '"><i class="ti ti-edit me-1"></i>등록 정보</button></td></tr>';
    }).join('') + '</tbody></table></div>';
    return { body: body2 + '</div>' };
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab() {
    if (!isAdminActive()) return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 열립니다.') + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    var needApproval = state.items.filter(function (a) { var s = approvalState(a); return a.status === 'active' && (s === 'changed' || (s !== 'approved' && paySum(a.payments) > 0)); });
    var views = [['approve', 'shield-check', '승인' + (needApproval.length ? ' ' + needApproval.length : '')], ['all', 'list', '전체 건'], ['logs', 'history', '변경 이력'], ['managers', 'users', '중간 담당자']];
    var head = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom"><div class="btn-group">'
      + views.map(function (v) { return '<button type="button" class="btn btn-sm ' + (state.adminView === v[0] ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="admin-view" data-view="' + v[0] + '"><i class="ti ti-' + v[1] + ' me-1"></i>' + esc(v[2]) + '</button>'; }).join('')
      + '</div><button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div>';
    if (state.adminEditId) {
      var a = state.full[state.adminEditId];
      if (a) return { body: head + '<div class="card-body"><h3 class="card-title mb-3">' + esc(a.name) + ' · 관리자 수정</h3><div class="row g-4"><div class="col-xl-5"><h4 class="mb-2">등록 정보</h4>' + regFormHtml(a, 'admin') + '</div><div class="col-xl-7"><h4 class="mb-2">진행 정보</h4>' + progFormHtml(a, 'admin') + '</div></div></div>' };
    }
    var body = state.adminView === 'all' ? adminAllHtml() : state.adminView === 'logs' ? adminLogsHtml() : state.adminView === 'managers' ? adminManagersHtml() : adminApproveHtml(needApproval);
    return { body: head + body };
  }

  function payTableHtml(a, list, withRemain) {
    if (!list || !list.length) return '<div class="text-secondary small">결제 항목 없음</div>';
    return '<div class="table-responsive"><table class="table table-sm table-vcenter mb-0"><thead><tr><th>과제</th><th>비목</th><th>결제 수단</th><th class="text-end">금액</th>' + (withRemain ? '<th class="text-end">현재 잔액</th><th class="text-end">승인 후 잔액</th>' : '') + '</tr></thead><tbody>'
      + list.map(function (p) {
        var pr = projectById(p.projectId);
        var remain = withRemain ? remainOf(p.projectId, normCat(p.category), a.id) : null;
        return '<tr><td>' + '<span title="' + esc(pr ? pr.name : '') + '">' + esc(pr ? (pr.alias || pr.name) : '(삭제된 과제)') + '</span>' + '</td><td>' + esc(catLabel(p.category)) + '</td><td class="text-secondary">' + esc(p.method || '-') + '</td><td class="text-end tnum">' + won(p.amount) + '</td>'
          + (withRemain ? '<td class="text-end tnum">' + (remain === null ? '-' : won(remain)) + '</td><td class="text-end tnum' + (remain !== null && remain - p.amount < 0 ? ' text-danger fw-bold' : '') + '">' + (remain === null ? '-' : won(remain - p.amount)) + '</td>' : '') + '</tr>';
      }).join('') + '<tr class="fw-medium"><td colspan="3">합계</td><td class="text-end tnum">' + won(paySum(list)) + '</td>' + (withRemain ? '<td colspan="2"></td>' : '') + '</tr></tbody></table></div>';
  }

  function adminApproveHtml(needApproval) {
    var approved = state.items.filter(function (a) { return a.status === 'active' && approvalState(a) === 'approved'; });
    var noPay = state.items.filter(function (a) { return a.status === 'active' && approvalState(a) === 'none' && !paySum(a.payments); });
    var body = '<div class="card-body"><p class="text-secondary small mb-3"><i class="ti ti-info-circle me-1"></i>승인하면 결제 항목이 과제 예산에 반영됩니다. 구매 완료 전에는 <strong>가할당</strong>, 구매 완료 후에는 <strong>실집행</strong>으로 잡힙니다. 잔액은 구매 요청·심의·다른 장비 도입 승인분을 뺀 값입니다.</p>';
    if (!needApproval.length) body += empty('shield-check', '승인할 건이 없습니다', noPay.length ? '결제 항목이 아직 없는 진행 건 ' + noPay.length + '건은 구매 담당자가 입력하면 여기에 나타납니다.' : '');
    needApproval.forEach(function (a) {
      var s = approvalState(a);
      body += '<div class="card card-sm mb-3"><div class="card-body"><div class="d-flex justify-content-between align-items-start flex-wrap gap-2 mb-2">'
        + '<div><div class="fw-medium">' + esc(a.name) + ' ' + badge(APPROVAL, s) + '</div><div class="small text-secondary">구매 담당 ' + esc(a.purchaserName) + ' · ' + stageBadge(a) + ' · 예상 ' + won(a.estAmount) + '</div></div>'
        + '<div class="d-flex gap-2"><button type="button" class="btn btn-sm btn-outline-danger" data-action="admin-reject" data-id="' + esc(a.id) + '">반려</button><button type="button" class="btn btn-sm btn-primary" data-action="admin-approve" data-id="' + esc(a.id) + '"><i class="ti ti-check me-1"></i>' + (s === 'changed' ? '재승인' : '승인') + '</button></div></div>'
        + (s === 'changed' ? '<div class="small text-secondary mb-1">승인된 항목 (현재 예산 반영분)</div>' + payTableHtml(a, a.approval.payments, false) + '<div class="small text-secondary mt-3 mb-1">변경된 항목</div>' : '')
        + payTableHtml(a, a.payments, true) + '</div></div>';
    });
    if (approved.length) {
      body += '<h3 class="card-title mt-4 mb-2">승인된 건 <span class="text-secondary fw-normal">' + approved.length + '건</span></h3><div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>장비</th><th>단계</th><th>예산 반영</th><th class="text-end">금액</th><th>승인</th><th class="w-1"></th></tr></thead><tbody>'
        + approved.map(function (a) {
          return '<tr><td>' + esc(a.name) + '</td><td>' + stageBadge(a) + '</td><td>' + (a.stage === 'purchased' ? '<span class="badge bg-blue-lt">실집행</span>' : '<span class="badge bg-azure-lt">가할당</span>') + '</td><td class="text-end tnum">' + won(paySum(a.approval.payments)) + '</td>'
            + '<td class="small text-secondary text-nowrap">' + esc(a.approval.by || '') + ' · ' + fmtDate(a.approval.at) + '</td><td><button type="button" class="btn btn-sm btn-ghost-danger" data-action="admin-revoke" data-id="' + esc(a.id) + '">승인 취소</button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    return body + '</div>';
  }

  function adminAllHtml() {
    if (!state.items.length) return '<div class="card-body">' + empty('device-desktop-off', '장비 도입 건이 없습니다', '') + '</div>';
    return '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>장비</th><th>상태</th><th>단계</th><th>담당</th><th class="text-end">예상 / 결제</th><th>승인</th><th class="w-1"></th></tr></thead><tbody>'
      + state.items.map(function (a) {
        return '<tr><td><div class="fw-medium">' + esc(a.name) + '</div><div class="small text-secondary">' + fmtMonth(a.targetDate) + (a.location ? ' · ' + esc(a.location) : '') + '</div></td>'
          + '<td>' + badge(STATUS, a.status) + '</td><td>' + stageBadge(a) + '</td>'
          + '<td class="small text-nowrap">구매 ' + esc(a.purchaserName || '-') + '<div class="text-secondary">등록 ' + esc(a.registeredBy || '-') + '</div></td>'
          + '<td class="text-end tnum text-nowrap">' + won(a.estAmount) + '<div class="small text-secondary">' + won(paySum(a.payments)) + '</div></td>'
          + '<td>' + badge(APPROVAL, approvalState(a)) + '</td>'
          + '<td class="text-nowrap"><button type="button" class="btn btn-sm" data-action="detail" data-id="' + esc(a.id) + '">보기</button> '
          + (a.status === 'active' ? '<button type="button" class="btn btn-sm" data-action="admin-edit" data-id="' + esc(a.id) + '"><i class="ti ti-edit"></i></button> <button type="button" class="btn btn-sm btn-ghost-danger" data-action="admin-cancel" data-id="' + esc(a.id) + '">도입 취소</button>' : '')
          + (a.status === 'cancelled' ? '<button type="button" class="btn btn-sm" data-action="admin-restore" data-id="' + esc(a.id) + '">다시 진행</button>' : '')
          + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function filteredLogs() { return state.logs.filter(function (l) { return state.logFilter === 'all' || l.acqId === state.logFilter; }); }
  function changeLines(l) {
    return (l.changes || []).map(function (c) {
      return '<div><span class="text-secondary">' + esc(FIELD_LABEL[c.field] || c.field) + '</span> ' + (c.before === null || c.before === undefined || c.before === '' ? '' : '<span class="text-decoration-line-through text-secondary">' + esc(fmtVal(c.field, c.before)) + '</span> → ') + esc(fmtVal(c.field, c.after)) + '</div>';
    }).join('');
  }
  function adminLogsHtml() {
    var ids = {}; state.logs.forEach(function (l) { ids[l.acqId] = l.acqName; });
    var list = filteredLogs();
    var body = '<div class="card-body py-2 border-bottom d-flex flex-wrap gap-2 align-items-center"><select class="form-select form-select-sm w-auto" data-action="log-filter"><option value="all">모든 장비</option>'
      + Object.keys(ids).map(function (id) { var a = itemById(id); return '<option value="' + esc(id) + '"' + (state.logFilter === id ? ' selected' : '') + '>' + esc(a ? a.name : ids[id]) + '</option>'; }).join('')
      + '</select><span class="small text-secondary">' + list.length + '건 · 이력은 지울 수 없습니다</span><button type="button" class="btn btn-sm ms-auto" data-action="export-logs"><i class="ti ti-file-spreadsheet me-1"></i>CSV</button></div>';
    if (!list.length) return body + '<div class="card-body">' + empty('history-off', '변경 이력이 없습니다', '') + '</div>';
    return body + '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">일시</th><th>장비</th><th>처리자</th><th>동작</th><th>변경 내용</th></tr></thead><tbody>'
      + list.map(function (l) {
        return '<tr><td class="text-nowrap text-secondary align-top">' + fmtDateTime(l.createdAt) + '</td><td class="align-top">' + esc(l.acqName) + '</td><td class="text-nowrap align-top">' + esc(l.by) + '<div class="small text-secondary">' + esc(ROLE_LABEL[l.role] || l.role) + '</div></td>'
          + '<td class="text-nowrap align-top"><span class="badge bg-secondary-lt">' + esc(ACTION_LABEL[l.action] || l.action) + '</span></td><td class="small">' + changeLines(l) + (l.note ? '<div class="mt-1"><i class="ti ti-message me-1"></i>' + esc(l.note) + '</div>' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>';
  }
  function exportLogs() {
    var head = ['일시', '장비', '처리자', '역할', '동작', '항목', '이전 값', '새 값', '메모'];
    var lines = [];
    filteredLogs().forEach(function (l) {
      var rows = l.changes && l.changes.length ? l.changes : [{ field: '', before: '', after: '' }];
      rows.forEach(function (c) {
        lines.push([fmtDateTime(l.createdAt), l.acqName, l.by, ROLE_LABEL[l.role] || l.role, ACTION_LABEL[l.action] || l.action, c.field ? (FIELD_LABEL[c.field] || c.field) : '',
          c.field ? fmtVal(c.field, c.before) : '', c.field ? fmtVal(c.field, c.after) : '', l.note].map(csvCell).join(','));
      });
    });
    download('dsil-equipment-acquisition-log-' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + head.join(',') + '\r\n' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function adminManagersHtml() {
    var body = '<div class="card-body"><div class="row g-4"><div class="col-lg-5"><h3 class="card-title mb-1"><i class="ti ti-user-plus me-1 text-primary"></i>중간 담당자 추가</h3>'
      + '<p class="text-secondary small mb-3">이름은 포털 로그인 이름과 같아야 합니다. 중간 담당자는 본인 계정으로 로그인한 뒤 이 PIN으로 신청 확인·장비 등록을 합니다.</p>'
      + '<form id="mgr-add-form"><div class="row g-3"><div class="col-12"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" list="acq-names2"><datalist id="acq-names2">' + knownNames().map(function (n) { return '<option value="' + esc(n) + '">'; }).join('') + '</datalist></div>'
      + '<div class="col-6"><label class="form-label required">PIN</label><input type="password" class="form-control" name="pin" inputmode="numeric" autocomplete="new-password" placeholder="숫자 4~8자리"></div>'
      + '<div class="col-6"><label class="form-label required">PIN 확인</label><input type="password" class="form-control" name="pin2" inputmode="numeric" autocomplete="new-password"></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-user-check me-1"></i>추가</button></div></form></div>'
      + '<div class="col-lg-7"><h3 class="card-title mb-2"><i class="ti ti-users me-1 text-primary"></i>중간 담당자 <span class="text-secondary fw-normal">' + state.managers.length + '명</span></h3>';
    if (!state.managers.length) body += '<div class="text-secondary small">아직 없습니다.</div>';
    else body += '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>이름</th><th>등록일</th><th class="w-1"></th></tr></thead><tbody>'
      + state.managers.map(function (m) { return '<tr><td class="fw-medium">' + esc(m.name) + '</td><td class="text-secondary text-nowrap">' + fmtDate(m.createdAt) + '</td><td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reset-mgr-pin" data-mgr="' + esc(m.id) + '" title="PIN 재설정"><i class="ti ti-key"></i></button><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-mgr" data-mgr="' + esc(m.id) + '" title="삭제"><i class="ti ti-trash"></i></button></td></tr>'; }).join('') + '</tbody></table></div>';
    return body + '</div></div></div>';
  }

  function approveFlow(id) {
    var a = fullById(id); if (!a) return;
    var over = (a.payments || []).filter(function (p) { var r = remainOf(p.projectId, normCat(p.category), a.id); return r !== null && r - p.amount < 0; });
    var ask = over.length
      ? confirmDlg({ title: '비목 예산 초과', message: over.map(function (p) { return payText(p) + ' → 승인 후 잔액 ' + won(remainOf(p.projectId, normCat(p.category), a.id) - p.amount); }).join(' / ') + '. 그래도 승인할까요?', okLabel: '초과 승인', danger: true })
      : confirmDlg({ title: a.name + ' 승인', message: '결제 항목 합계 ' + won(paySum(a.payments)) + '을 과제 예산에 반영합니다.', okLabel: '승인' });
    ask.then(function (ok) {
      if (!ok) return;
      return store.acqApprove(id, '').then(function () { toast('승인했습니다. 과제 예산에 반영됩니다.'); setUnlock(true); return refresh(); });
    }).catch(handleError);
  }

  /* ---------- actions ---------- */
  function handleError(err) { console.error(err); toast(err && err.message ? err.message : String(err), true); }
  function refresh() { return reload().then(render).catch(handleError); }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id === 'reg-form') { e.preventDefault(); submitReg(form); }
    if (form.id === 'prog-form') { e.preventDefault(); submitProg(form); }
    if (form.id === 'mid-form') {
      e.preventDefault();
      var m = readForm(form);
      if (!m.pin) { markMissing(form, [{ ok: false, name: 'pin', label: 'PIN' }]); return; }
      store.acqVerifyManager(m.managerId, m.pin).then(function (ok) { if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; } setMid({ managerId: m.managerId, pin: m.pin }); toast('중간 담당자 모드를 열었습니다.'); return refresh(); }).catch(handleError);
    }
    if (form.id === 'mgr-add-form') {
      e.preventDefault();
      var a = readForm(form);
      if (!markMissing(form, [{ ok: !!a.name.trim(), name: 'name', label: '이름' }, { ok: /^\d{4,8}$/.test(a.pin), name: 'pin', label: 'PIN(숫자 4~8자리)' }, { ok: a.pin === a.pin2 && !!a.pin2, name: 'pin2', label: 'PIN 확인 일치' }])) return;
      store.acqSaveManager({ name: a.name }, { pin: a.pin }).then(function () { toast('중간 담당자를 추가했습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
    }
  });

  document.addEventListener('input', function (e) {
    var form = e.target.closest('#prog-form');
    if (!form) return;
    if (e.target.name === 'pay_amount' || e.target.name === 'estAmount') {
      var s = $('#pay-sum', form);
      if (s) s.innerHTML = paySumHtml(paySum(readPayRows(form)), Number(form.querySelector('[name="estAmount"]').value) || 0);
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.getAttribute('data-action') === 'log-filter') { state.logFilter = el.value; render(); return; }
    var form = el.closest('#prog-form');
    if (form && el.name === 'stage') {
      /* 입찰 단계를 고르면 입찰 대상으로, 유찰이면 회차를 최소 1로 */
      if (stageOf(el.value).bid) form.querySelector('[name="bidRequired"]').checked = true;
      var cnt = form.querySelector('[name="bidFailCount"]');
      if (el.value === 'bid_failed' && !(Number(cnt.value) > 0)) cnt.value = 1;
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT' || btn.tagName === 'SELECT') return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    switch (action) {
      case 'tab': {
        e.preventDefault();
        var t = btn.getAttribute('data-tab');
        if (t === 'admin' && !isAdminActive()) { enterAdmin(); return; }
        state.tab = t; render(); break;
      }
      case 'list-filter': state.listFilter = btn.getAttribute('data-filter'); render(); break;
      case 'detail': e.preventDefault(); detailDialog(id).catch(handleError); break;
      case 'unlock-admin': enterAdmin(); break;
      case 'lock-admin': setUnlock(false); state.adminEditId = null; state.tab = 'list'; toast('관리자 화면을 잠갔습니다.'); refresh(); break;
      case 'admin-view': state.adminView = btn.getAttribute('data-view'); state.adminEditId = null; render(); break;
      case 'lock-mid': setMid(null); state.midEditId = null; toast('중간 담당자 모드를 잠갔습니다.'); render(); break;
      case 'lock-pur': setPur(id, null); delete state.full[id]; state.editId = null; toast('잠갔습니다.'); render(); break;
      case 'pur-open': openPurchaser(id); break;
      case 'mid-new': state.midEditId = 'new'; render(); break;
      case 'mid-edit':
        store.acqOpen(id, midCreds()).then(function (a) { state.full[id] = a; state.midEditId = id; touchMid(); render(); }).catch(handleError);
        break;
      case 'mid-reject': {
        promptDlg({ title: '신청 반려', message: '반려 사유를 적어 주세요. 신청자가 볼 수 있도록 이력에 남습니다.', input: 'textarea', okLabel: '반려' }).then(function (note) {
          if (note === null) return;
          return store.acqRejectRequest(id, note, midCreds()).then(function () { toast('신청을 반려했습니다.'); state.midEditId = null; touchMid(); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'cancel-edit': state.editId = null; state.midEditId = null; state.adminEditId = null; render(); break;
      case 'pay-add': {
        var rows = $('#pay-rows');
        if (rows) rows.insertAdjacentHTML('beforeend', payRowHtml({}, $all('.pay-row', rows).length));
        break;
      }
      case 'pay-remove': {
        var row = btn.closest('.pay-row'); var form = btn.closest('form');
        if (row) row.remove();
        if (form) { var s = $('#pay-sum', form); if (s) s.innerHTML = paySumHtml(paySum(readPayRows(form)), Number(form.querySelector('[name="estAmount"]').value) || 0); }
        break;
      }
      case 'admin-edit': state.adminEditId = id; render(); break;
      case 'admin-approve': approveFlow(id); break;
      case 'admin-reject':
        promptDlg({ title: '승인 반려', message: '반려 사유를 적어 주세요. 구매 담당자 화면에 보입니다.', input: 'textarea', okLabel: '반려' }).then(function (note) {
          if (note === null) return;
          return store.acqRevokeApproval(id, 'rejected', note).then(function () { toast('반려했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      case 'admin-revoke':
        confirmDlg({ title: '승인 취소', message: '승인을 취소하면 이 건의 금액이 과제 예산에서 빠집니다. 취소할까요?', okLabel: '승인 취소', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.acqRevokeApproval(id, 'none', '').then(function () { toast('승인을 취소했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      case 'admin-cancel':
        promptDlg({ title: '도입 취소', message: '취소 사유를 적어 주세요. 승인된 금액은 예산에서 빠집니다.', input: 'textarea', okLabel: '도입 취소' }).then(function (note) {
          if (note === null) return;
          return store.acqSetStatus(id, 'cancelled', note).then(function () { toast('도입을 취소했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      case 'admin-restore':
        store.acqSetStatus(id, 'active', '').then(function () { toast('다시 진행 상태로 바꿨습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
        break;
      case 'export-logs': exportLogs(); break;
      case 'reset-mgr-pin': {
        var mm = managerById(btn.getAttribute('data-mgr')); if (!mm) return;
        promptDlg({ title: mm.name + ' PIN 재설정', message: '새 PIN을 입력하세요.', input: 'password', placeholder: '숫자 4~8자리', okLabel: '재설정' }).then(function (pin) {
          if (pin === null) return;
          if (!/^\d{4,8}$/.test(pin)) { toast('PIN은 숫자 4~8자리입니다.', true); return; }
          return store.acqSaveManager({ id: mm.id, name: mm.name }, { pin: pin }).then(function () { toast('PIN을 재설정했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'delete-mgr': {
        var mid2 = btn.getAttribute('data-mgr');
        confirmDlg({ title: '중간 담당자 삭제', message: '이 중간 담당자를 삭제할까요? 등록한 건과 이력은 그대로 남습니다.', okLabel: '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.acqDeleteManager(mid2).then(function () { toast('삭제했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'signout': setUnlock(false); setMid(null); try { sessionStorage.removeItem(PUR_KEY); } catch (err) { /* ignore */ } store.signOut().then(function () { window.location.replace('../index.html'); }); break;
      case 'refresh': refresh().then(function () { toast('새로고침 완료'); }); break;
    }
  });

  /* ---------- boot ---------- */
  var initialTab = (window.location.hash || '').replace('#', '');
  if (TABS.indexOf(initialTab) >= 0) state.tab = initialTab;

  function requireSession() {
    var s = store.getSession();
    if (s && s.status !== 'pending') return true;
    window.location.replace('../index.html?next=acquisition');
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
