/* =====================================================================
   DSIL Lab Portal – 소모품 재고 (UI)
   탭: 재고 현황 · 소모 처리 · 입출고 이력 · 담당자(중간 관리자 PIN) · 관리자(PIN)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var INV = Object.assign({ categories: ['기타'], managerUnlockMinutes: 10 }, CFG.inventory || {});
  var U = window.DSILUI;
  var esc = U.esc, won = U.won, nf = U.nf, fmtDate = U.fmtDate, fmtDateTime = U.fmtDateTime, $ = U.$, toast = U.toast, readForm = U.readForm;
  var dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty, dg = U.dg, stat = U.stat, csvCell = U.csvCell, download = U.download;
  var store = window.DSILStore.create(CFG);
  var ADMIN_KEY = 'dsil-budget-admin-unlock';
  var MGR_KEY = 'dsil-inv-manager-unlock';
  var TABS = ['stock', 'consume', 'history', 'manager', 'admin'];
  var MOVE = { init: { label: '초기', cls: 'bg-secondary-lt' }, in: { label: '입고', cls: 'bg-green-lt' }, out: { label: '소모', cls: 'bg-blue-lt' }, adjust: { label: '조정', cls: 'bg-yellow-lt' } };

  var state = {
    ready: false, error: null, session: null, magicLinkSent: false,
    managers: [], items: [], moves: [],
    tab: 'stock', filterLoc: 'all', histType: 'all', consumeLoc: '',
    adminUnlocked: false, manager: null, editingItemId: null
  };

  /* ---------- helpers ---------- */
  function me() { return state.session ? state.session.user : null; }
  function itemById(id) { return state.items.filter(function (x) { return x.id === id; })[0] || null; }
  function managerById(id) { return state.managers.filter(function (x) { return x.id === id; })[0] || null; }
  /* 소모품 담당자 권한: 등록된 담당자 이름과 로그인 이름이 같아야 함 (포털 관리자는 전체) */
  function nameKey(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function isMyManagerEntry(m) {
    var u = me();
    if (!u || !m) return false;
    if (state.session && state.session.isAdmin) return true;
    return nameKey(m.name) === nameKey(u.name);
  }
  function myManagerEntries() { return state.managers.filter(isMyManagerEntry); }
  function locations() { var s = {}; state.items.forEach(function (i) { if (i.location) s[i.location] = true; }); return Object.keys(s).sort(); }
  function isLow(i) { return i.active !== false && i.minQty > 0 && i.qty <= i.minQty; }
  function qtyStr(i) { return nf.format(i.qty) + esc(i.unit || ''); }

  function readUnlock() { try { var t = Number(sessionStorage.getItem(ADMIN_KEY) || 0); var mins = Number(CFG.adminUnlockMinutes) > 0 ? Number(CFG.adminUnlockMinutes) : 10; return t > 0 && (Date.now() - t) < mins * 60000; } catch (e) { return false; } }
  function setUnlock(on) { try { if (on) sessionStorage.setItem(ADMIN_KEY, String(Date.now())); else sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ } state.adminUnlocked = on; }
  function isAdminEligible() { return !!(state.session && state.session.isAdmin); }
  function isAdminActive() { return isAdminEligible() && state.adminUnlocked; }
  function enterAdmin() {
    if (!isAdminEligible()) { toast('관리자 권한이 없습니다.', true); return; }
    if (readUnlock()) { setUnlock(true); state.tab = 'admin'; render(); return; }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요.', input: 'password', placeholder: 'PIN', okLabel: '열기' }).then(function (pin) {
      if (pin === null) return;
      return store.verifyAdminPin(pin).then(function (ok) { if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; } setUnlock(true); state.tab = 'admin'; render(); });
    }).catch(handleError);
  }
  function readManager() {
    try { var m = JSON.parse(sessionStorage.getItem(MGR_KEY) || 'null'); if (m && m.ts && (Date.now() - m.ts) < INV.managerUnlockMinutes * 60000 && m.managerId && m.pin) return m; } catch (e) { /* ignore */ }
    return null;
  }
  function setManager(m) {
    try { if (m) sessionStorage.setItem(MGR_KEY, JSON.stringify({ managerId: m.managerId, pin: m.pin, ts: Date.now() })); else sessionStorage.removeItem(MGR_KEY); } catch (e) { /* ignore */ }
    state.manager = m ? { managerId: m.managerId, pin: m.pin, ts: Date.now() } : null;
  }
  function creds() { return state.manager ? { managerId: state.manager.managerId, pin: state.manager.pin } : null; }
  function touchManager() { if (state.manager) setManager(state.manager); }

  /* ---------- data ---------- */
  function reload() {
    state.session = store.getSession();
    state.adminUnlocked = readUnlock();
    state.manager = readManager();
    if (!state.session) { state.managers = []; state.items = []; state.moves = []; return Promise.resolve(); }
    return Promise.all([store.invListManagers(), store.invListItems(), store.invListMoves()]).then(function (res) {
      state.managers = res[0]; state.items = res[1]; state.moves = res[2].slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      if (state.tab === 'admin' && !isAdminActive()) state.tab = 'stock';
      if (state.manager && !managerById(state.manager.managerId)) setManager(null);
    });
  }

  /* ---------- render ---------- */
  function render() {
    state.adminUnlocked = readUnlock();
    state.manager = readManager();
    renderUserChip();
    var app = $('#app');
    if (!app) return;
    if (state.error) { app.innerHTML = '<div class="alert alert-danger"><h4 class="alert-title">초기화 오류</h4><div class="text-secondary">' + esc(state.error) + '</div></div>'; return; }
    if (!state.ready) { app.innerHTML = '<div class="text-secondary text-center py-5">불러오는 중…</div>'; return; }
    if (!state.session) { app.innerHTML = renderLogin(); return; }

    var active = state.items.filter(function (i) { return i.active !== false; });
    var low = active.filter(isLow);
    var mStart = new Date(); mStart.setDate(1); mStart.setHours(0, 0, 0, 0);
    var outMonth = state.moves.filter(function (m) { return m.type === 'out' && new Date(m.createdAt) >= mStart; });

    var html = '<div class="row row-deck row-cards mb-3">'
      + stat('품목', active.length + '종', locations().length + '개 보관 장소', '')
      + stat('재고 부족', low.length + '종', low.length ? low.slice(0, 2).map(function (i) { return i.name; }).join(', ') + (low.length > 2 ? ' 외' : '') : '최소 수량 이상', low.length ? 'text-red' : 'text-green')
      + stat('이번 달 소모', outMonth.length + '건', Object.keys(outMonth.reduce(function (o, m) { o[m.itemId] = 1; return o; }, {})).length + '종 · 최근 ' + (outMonth[0] ? fmtDate(outMonth[0].createdAt) : '-'), 'text-primary')
      + stat('사용 중지', state.items.filter(function (i) { return i.active === false; }).length + '종', '소모 처리에서 제외', '')
      + '</div>';

    if (low.length) {
      html += '<div class="alert alert-warning mb-3"><div class="d-flex align-items-start gap-2"><i class="ti ti-alert-triangle fs-2"></i><div><h4 class="alert-title mb-1">재고가 부족한 품목이 있습니다</h4>'
        + '<div class="small">' + low.map(function (i) { return esc(i.name) + ' <span class="text-secondary">(' + qtyStr(i) + ' / 최소 ' + nf.format(i.minQty) + esc(i.unit) + ')</span>'; }).join(' · ') + '</div></div></div></div>';
    }

    var tab = state.tab === 'consume' ? renderConsumeTab() : state.tab === 'history' ? renderHistoryTab() : state.tab === 'manager' ? renderManagerTab() : state.tab === 'admin' ? renderAdminTab() : renderStockTab();
    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('stock', 'packages', '재고 현황') + tabLink('consume', 'shopping-cart-minus', '소모 처리') + tabLink('history', 'history', '입출고 이력')
      + tabLink('manager', state.manager ? 'lock-open' : 'lock', '담당자')
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
    var role = state.manager ? '중간 관리자 · 열림' : (isAdminActive() ? '관리자 · 열림' : '구성원');
    slot.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="avatar avatar-sm bg-blue-lt">' + esc((s.user.name || '?').trim().charAt(0)) + '</span>'
      + '<div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(s.user.name) + '</div><div class="small text-secondary mt-1">' + role + '</div></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="signout"><i class="ti ti-logout"></i><span class="d-none d-sm-inline ms-1">로그아웃</span></button></div>';
  }

  function renderLogin() {
    var head = '<div class="container-tight py-4"><div class="card card-md"><div class="card-body">';
    var foot = '</div></div></div>';
    if (store.mode === 'supabase') {
      if (state.magicLinkSent) return head + '<div class="empty"><div class="empty-icon"><i class="ti ti-mail"></i></div><p class="empty-title">메일을 확인하세요</p></div>' + foot;
      return head + '<h2 class="h2 text-center mb-2">로그인</h2><form id="login-form"><div class="mb-3"><label class="form-label required">이메일</label><input type="email" class="form-control" name="email" required></div>'
        + '<div class="mb-3"><label class="form-label">이름</label><input type="text" class="form-control" name="name"></div><div class="form-footer"><button type="submit" class="btn btn-primary w-100">로그인 링크 보내기</button></div></form>' + foot;
    }
    return head + '<h2 class="h2 text-center mb-2">시작하기</h2><p class="text-secondary text-center mb-4">이름을 입력하면 재고를 보고 소모 처리를 할 수 있습니다. 소모 기록에는 이름이 남습니다.</p>'
      + '<form id="login-form"><div class="mb-3"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required placeholder="홍길동" autocomplete="name"></div>'
      + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100">시작</button></div></form>' + foot;
  }

  /* ---------- 재고 현황 ---------- */
  function itemRow(i, withActions) {
    var low = isLow(i);
    return '<tr data-item="' + esc(i.id) + '"' + (i.active === false ? ' class="text-secondary"' : '') + '>'
      + '<td><div class="fw-medium">' + esc(i.name) + (i.active === false ? ' <span class="badge bg-secondary-lt">중지</span>' : '') + '</div><div class="small text-secondary">' + esc(i.category || '') + (i.note ? ' · ' + esc(i.note) : '') + '</div></td>'
      + '<td class="text-nowrap">' + esc(i.location || '-') + '</td>'
      + '<td class="text-end text-nowrap tnum"><span class="' + (low ? 'text-red fw-bold' : 'fw-medium') + '">' + qtyStr(i) + '</span>' + (i.minQty ? '<div class="small text-secondary">최소 ' + nf.format(i.minQty) + '</div>' : '') + '</td>'
      + '<td class="text-end text-nowrap">' + (withActions
        ? '<button type="button" class="btn btn-sm" data-action="restock" data-item="' + esc(i.id) + '"><i class="ti ti-plus me-1"></i>입고</button> <button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="edit-item" data-item="' + esc(i.id) + '" title="수정"><i class="ti ti-edit"></i></button><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-item" data-item="' + esc(i.id) + '" title="삭제"><i class="ti ti-trash"></i></button>'
        : '') + '</td></tr>';
  }

  function renderStockTab() {
    var locs = locations();
    var list = state.items.filter(function (i) { return state.filterLoc === 'all' || i.location === state.filterLoc; }).sort(function (a, b) { return (a.location + a.name).localeCompare(b.location + b.name); });
    var body = '<div class="card-body py-2 border-bottom d-flex flex-wrap gap-2 align-items-center">'
      + '<button type="button" class="btn btn-sm ' + (state.filterLoc === 'all' ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="filter-loc" data-loc="all">전체</button>'
      + locs.map(function (l) { return '<button type="button" class="btn btn-sm ' + (state.filterLoc === l ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="filter-loc" data-loc="' + esc(l) + '"><i class="ti ti-map-pin me-1"></i>' + esc(l) + '</button>'; }).join('')
      + '<a href="#consume" class="ms-auto small" data-action="tab" data-tab="consume">소모 처리는 소모 처리 탭에서 <i class="ti ti-arrow-right"></i></a></div>';
    if (!list.length) body += '<div class="card-body">' + empty('package-off', '등록된 품목이 없습니다', '담당자 탭에서 품목을 등록하세요.') + '</div>';
    else body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>품목</th><th>보관 장소</th><th class="text-end">재고</th><th class="w-1"></th></tr></thead><tbody>' + list.map(function (i) { return itemRow(i, false); }).join('') + '</tbody></table></div>';
    return { body: body };
  }

  function consumeDialog(itemId) {
    var i = itemById(itemId); if (!i) return Promise.resolve();
    var body = '<div class="text-secondary small mb-3"><i class="ti ti-map-pin me-1"></i>' + esc(i.location) + ' · 현재 ' + qtyStr(i) + '</div>'
      + '<div class="mb-3"><label class="form-label required">수량 (' + esc(i.unit) + ')</label><input type="number" class="form-control tnum" name="qty" min="0.01" step="any" max="' + i.qty + '" required value="1"></div>'
      + '<div class="mb-0"><label class="form-label">용도 · 메모</label><input type="text" class="form-control" name="note" placeholder="예: TMD 성장 기판"></div>';
    return dialog({ title: '소모 처리 · ' + i.name, bodyHtml: body, okLabel: '차감' }).then(function (v) {
      if (!v) return;
      return store.invConsume(i.id, Number(v.qty), v.note).then(function (mv) { toast(i.name + ' ' + nf.format(mv.qty) + esc(i.unit) + ' 소모 처리했습니다. 남은 재고 ' + nf.format(mv.stockAfter) + esc(i.unit)); return refresh(); });
    });
  }

  /* ---------- 소모 처리 탭 ---------- */
  function renderConsumeTab() {
    var locs = locations();
    var loc = state.consumeLoc || locs[0] || '';
    var items = state.items.filter(function (i) { return i.active !== false && i.location === loc; });
    var u = me();
    var mine = state.moves.filter(function (m) { return m.type === 'out' && u && m.userName === u.name; }).slice(0, 8);
    var body = '<div class="card-body"><div class="row g-4"><div class="col-lg-6">'
      + '<h3 class="card-title mb-1"><i class="ti ti-shopping-cart-minus me-1 text-primary"></i>소모 처리</h3><p class="text-secondary small mb-3">물건을 꺼낸 보관 장소를 고르고 품목과 수량을 적으면 재고에서 바로 차감됩니다.</p>'
      + '<form id="consume-form"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">어디서 꺼냈나요? (보관 장소)</label><select class="form-select" name="location">' + locs.map(function (l) { return '<option value="' + esc(l) + '"' + (l === loc ? ' selected' : '') + '>' + esc(l) + '</option>'; }).join('') + '</select></div>'
      + '<div class="col-12"><label class="form-label required">품목</label><select class="form-select" name="itemId" required>' + (items.length ? items.map(function (i) { return '<option value="' + esc(i.id) + '">' + esc(i.name) + ' · 재고 ' + qtyStr(i) + '</option>'; }).join('') : '<option value="">이 장소에 품목이 없습니다</option>') + '</select></div>'
      + '<div class="col-4"><label class="form-label required">수량</label><input type="number" class="form-control tnum" name="qty" min="0.01" step="any" required value="1"></div>'
      + '<div class="col-8"><label class="form-label">용도 · 메모</label><input type="text" class="form-control" name="note" placeholder="예: HfO2 증착 실험"></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"' + (items.length ? '' : ' disabled') + '><i class="ti ti-minus me-1"></i>소모 처리</button></div></form>'
      + '</div><div class="col-lg-6"><h3 class="card-title mb-2"><i class="ti ti-user-check me-1 text-primary"></i>내 최근 소모</h3>';
    if (!mine.length) body += '<div class="text-secondary small">아직 소모 기록이 없습니다.</div>';
    else body += '<div class="list-group list-group-flush">' + mine.map(function (m) { return '<div class="list-group-item px-0 d-flex justify-content-between gap-2"><div><span class="text-secondary small me-2">' + fmtDateTime(m.createdAt) + '</span>' + esc(m.itemName) + (m.note ? ' <span class="text-secondary small">· ' + esc(m.note) + '</span>' : '') + '</div><span class="tnum text-nowrap">−' + nf.format(m.qty) + '</span></div>'; }).join('') + '</div>';
    body += '</div></div></div>';
    return { body: body };
  }

  /* ---------- 입출고 이력 ---------- */
  function renderHistoryTab() {
    var list = state.moves.filter(function (m) { return state.histType === 'all' || m.type === state.histType; });
    var body = '<div class="card-body py-2 border-bottom d-flex flex-wrap gap-2 align-items-center"><div class="btn-group">'
      + [['all', '전체'], ['out', '소모'], ['in', '입고'], ['adjust', '조정'], ['init', '초기']].map(function (t) { return '<button type="button" class="btn btn-sm ' + (state.histType === t[0] ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="hist-type" data-type="' + t[0] + '">' + t[1] + '</button>'; }).join('')
      + '</div><button type="button" class="btn btn-sm ms-auto" data-action="export-history"' + (list.length ? '' : ' disabled') + '><i class="ti ti-file-spreadsheet me-1"></i>CSV</button></div>';
    if (!list.length) body += '<div class="card-body">' + empty('history-off', '기록이 없습니다', '') + '</div>';
    else {
      body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">일시</th><th class="w-1">구분</th><th>품목</th><th>보관 장소</th><th class="text-end">수량</th><th class="text-end">재고</th><th>처리자</th><th>메모</th></tr></thead><tbody>'
        + list.map(function (m) {
          var M = MOVE[m.type] || { label: m.type, cls: 'bg-secondary-lt' };
          var sign = m.type === 'out' ? '−' : (m.type === 'adjust' ? (m.qty >= 0 ? '+' : '−') : '+');
          return '<tr><td class="text-nowrap text-secondary">' + fmtDateTime(m.createdAt) + '</td><td><span class="badge ' + M.cls + '">' + M.label + '</span></td><td>' + esc(m.itemName) + '</td><td class="text-nowrap">' + esc(m.location) + '</td>'
            + '<td class="text-end tnum text-nowrap">' + sign + nf.format(Math.abs(m.qty)) + '</td><td class="text-end tnum">' + nf.format(m.stockAfter) + '</td><td class="text-nowrap">' + esc(m.userName) + '</td><td class="small">' + esc(m.note || '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    return { body: body };
  }

  function exportHistory() {
    var list = state.moves.filter(function (m) { return state.histType === 'all' || m.type === state.histType; });
    var head = ['일시', '구분', '품목', '보관 장소', '수량', '재고', '처리자', '메모'];
    var lines = list.map(function (m) { return [fmtDateTime(m.createdAt), (MOVE[m.type] || {}).label || m.type, m.itemName, m.location, m.qty, m.stockAfter, m.userName, m.note].map(csvCell).join(','); });
    download('dsil-inventory-' + new Date().toISOString().slice(0, 10) + '.csv', '﻿' + head.join(',') + '\r\n' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  /* ---------- 담당자 탭 ---------- */
  function itemFormHtml(editing) {
    var cats = INV.categories.map(function (c) { return '<option value="' + esc(c) + '"' + (editing && editing.category === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('');
    var locList = locations().map(function (l) { return '<option value="' + esc(l) + '">'; }).join('');
    return '<form id="item-form" data-id="' + esc(editing ? editing.id : '') + '"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">품목명</label><input type="text" class="form-control" name="name" required value="' + esc(editing ? editing.name : '') + '" placeholder="예: 6인치 SiO2/Si 웨이퍼 (300 nm)"></div>'
      + '<div class="col-6"><label class="form-label">분류</label><select class="form-select" name="category">' + cats + '</select></div>'
      + '<div class="col-6"><label class="form-label required">보관 장소</label><input type="text" class="form-control" name="location" required list="loc-list" value="' + esc(editing ? editing.location : '') + '" placeholder="예: 클린룸 캐비닛 A"><datalist id="loc-list">' + locList + '</datalist></div>'
      + '<div class="col-4"><label class="form-label required">' + (editing ? '현재 보유량' : '초기 보유량') + '</label><input type="number" class="form-control tnum" name="qty" min="0" step="any" required value="' + (editing ? editing.qty : '') + '"></div>'
      + '<div class="col-4"><label class="form-label">단위</label><input type="text" class="form-control" name="unit" value="' + esc(editing ? editing.unit : '개') + '"></div>'
      + '<div class="col-4"><label class="form-label">최소 수량</label><input type="number" class="form-control tnum" name="minQty" min="0" step="any" value="' + (editing ? editing.minQty : '') + '" placeholder="알림 기준"></div>'
      + '<div class="col-12"><label class="form-label">메모</label><input type="text" class="form-control" name="note" value="' + esc(editing ? editing.note : '') + '" placeholder="보관 조건 등"></div>'
      + (editing ? '<div class="col-12"><label class="form-label">보유량 변경 사유 <span class="form-label-description">보유량을 바꾸면 조정 이력에 남습니다</span></label><input type="text" class="form-control" name="adjustNote" placeholder="예: 실사 결과 반영"></div>'
        + '<div class="col-12"><label class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" name="active"' + (editing.active !== false ? ' checked' : '') + '><span class="form-check-label">사용 중 (소모 처리 가능)</span></label></div>' : '')
      + '</div><div class="d-flex justify-content-end gap-2 mt-3">' + (editing ? '<button type="button" class="btn" data-action="cancel-edit-item">취소</button>' : '') + '<button type="submit" class="btn btn-primary"><i class="ti ti-device-floppy me-1"></i>' + (editing ? '저장' : '품목 등록') + '</button></div></form>';
  }

  function renderManagerTab() {
    if (!state.manager) {
      /* 내 이름으로 등록된 담당자만 (포털 관리자는 전체) */
      var mine = myManagerEntries();
      var u = me();
      var opts = mine.map(function (m) { return '<option value="' + esc(m.id) + '">' + esc(m.name) + (m.area ? ' · ' + esc(m.area) : '') + '</option>'; }).join('');
      var body = '<div class="card-body"><div class="container-tight"><h3 class="card-title mb-1"><i class="ti ti-user-shield me-1 text-primary"></i>소모품 담당자 확인</h3>'
        + '<p class="text-secondary small mb-3">담당자로 등록된 계정만 열 수 있습니다. PIN을 입력하면 ' + INV.managerUnlockMinutes + '분 동안 품목 등록·입고·조정이 열립니다.</p>';
      if (!state.managers.length) body += empty('user-off', '등록된 소모품 담당자가 없습니다', '관리자 탭에서 추가하세요.');
      else if (!mine.length) {
        body += empty('user-shield', '담당자로 등록되어 있지 않습니다', '지금 로그인한 계정(' + (u ? u.name : '') + ')은 소모품 담당자가 아닙니다. 관리자에게 담당자 등록을 요청하세요.')
          + '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>담당자</th><th>담당 영역</th></tr></thead><tbody>'
          + state.managers.map(function (m) { return '<tr><td class="fw-medium">' + esc(m.name) + '</td><td class="text-secondary">' + esc(m.area || '-') + '</td></tr>'; }).join('')
          + '</tbody></table></div>';
      } else {
        body += '<form id="mgr-form"><div class="mb-3"><label class="form-label required">담당자</label><select class="form-select" name="managerId" required>' + opts + '</select></div>'
          + '<div class="mb-3"><label class="form-label required">PIN</label><input type="password" class="form-control" name="pin" required inputmode="numeric" autocomplete="off"></div><button type="submit" class="btn btn-primary w-100"><i class="ti ti-key me-1"></i>열기</button></form>'
          + '<div class="text-secondary small mt-3"><i class="ti ti-id me-1"></i>' + esc(u ? u.name : '') + ' 님으로 등록된 담당 ' + mine.length + '건' + (isAdminEligible() ? ' (관리자 계정이라 전체가 보입니다)' : '') + '</div>';
      }
      return { body: body + '</div></div>' };
    }
    /* 등록이 취소됐으면 열려 있던 담당자 모드를 닫음 */
    if (!isMyManagerEntry(managerById(state.manager.managerId))) {
      setManager(null);
      return { body: '<div class="card-body">' + empty('user-shield', '담당자 권한이 없습니다', '담당자 등록이 바뀌어 담당자 모드를 닫았습니다.') + '</div>' };
    }
    var mgr = managerById(state.manager.managerId);
    var editing = state.editingItemId ? itemById(state.editingItemId) : null;
    var low = state.items.filter(isLow);
    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom">'
      + '<div><i class="ti ti-lock-open me-1 text-primary"></i><strong>' + esc(mgr ? mgr.name : '') + '</strong> <span class="text-secondary small">중간 관리자 모드' + (mgr && mgr.area ? ' · ' + esc(mgr.area) : '') + '</span></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-manager"><i class="ti ti-lock me-1"></i>잠금</button></div>'
      + '<div class="card-body"><div class="row g-4"><div class="col-lg-5"><h3 class="card-title mb-3"><i class="ti ti-' + (editing ? 'edit' : 'package') + ' me-1 text-primary"></i>' + (editing ? '품목 수정' : '품목 등록') + '</h3>' + itemFormHtml(editing) + '</div>'
      + '<div class="col-lg-7"><h3 class="card-title mb-2"><i class="ti ti-alert-triangle me-1 text-primary"></i>재고 부족 <span class="text-secondary fw-normal">' + low.length + '종</span></h3>'
      + (low.length ? '<div class="list-group list-group-flush mb-3">' + low.map(function (i) { return '<div class="list-group-item px-0 d-flex justify-content-between align-items-center gap-2"><div>' + esc(i.name) + ' <span class="text-secondary small">· ' + esc(i.location) + '</span></div><div class="text-nowrap"><span class="text-red tnum me-2">' + qtyStr(i) + ' / ' + nf.format(i.minQty) + '</span><button type="button" class="btn btn-sm" data-action="restock" data-item="' + esc(i.id) + '"><i class="ti ti-plus me-1"></i>입고</button></div></div>'; }).join('') + '</div>' : '<div class="text-secondary small mb-3">모든 품목이 최소 수량 이상입니다.</div>')
      + '</div></div></div>';
    var after = '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-packages me-1 text-primary"></i>전체 품목 <span class="text-secondary fw-normal">' + state.items.length + '종</span></h3></div>';
    if (!state.items.length) after += '<div class="card-body">' + empty('package-off', '등록된 품목이 없습니다', '') + '</div>';
    else after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>품목</th><th>보관 장소</th><th class="text-end">재고</th><th class="w-1"></th></tr></thead><tbody>' + state.items.slice().sort(function (a, b) { return (a.location + a.name).localeCompare(b.location + b.name); }).map(function (i) { return itemRow(i, true); }).join('') + '</tbody></table></div>';
    after += '</div>';
    return { body: body, after: after };
  }

  function restockDialog(itemId) {
    var i = itemById(itemId); if (!i) return Promise.resolve();
    var body = '<div class="text-secondary small mb-3">' + esc(i.location) + ' · 현재 ' + qtyStr(i) + '</div><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">입고 수량 (' + esc(i.unit) + ')</label><input type="number" class="form-control tnum" name="qty" min="0.01" step="any" required value="1"></div>'
      + '<div class="col-12"><label class="form-label">메모</label><input type="text" class="form-control" name="note" placeholder="구매처, 발주 번호 등"></div></div>';
    return dialog({ title: '입고 · ' + i.name, bodyHtml: body, size: 'lg', okLabel: '입고' }).then(function (v) {
      if (!v) return;
      return store.invRestock(i.id, Number(v.qty), 0, v.note, creds()).then(function () { toast('입고 처리했습니다.'); touchManager(); return refresh(); });
    });
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab() {
    if (!isAdminActive()) return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 열립니다.') + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom"><div class="text-secondary small"><i class="ti ti-lock-open me-1"></i>관리자 모드 · 소모품 담당자를 두면 그 사람이 본인 계정으로 로그인해 PIN을 넣고 품목·보유량을 관리합니다. 담당자 이름은 포털 로그인 이름과 같아야 합니다.</div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div>'
      + '<div class="card-body"><div class="row g-4"><div class="col-lg-5"><h3 class="card-title mb-3"><i class="ti ti-user-plus me-1 text-primary"></i>중간 관리자 추가</h3>'
      + '<form id="mgr-add-form"><div class="row g-3"><div class="col-12"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required></div>'
      + '<div class="col-12"><label class="form-label">담당 영역</label><input type="text" class="form-control" name="area" placeholder="예: 클린룸 케미컬·기판"></div>'
      + '<div class="col-6"><label class="form-label required">PIN</label><input type="password" class="form-control" name="pin" required inputmode="numeric" autocomplete="new-password" placeholder="숫자 4~8자리"></div>'
      + '<div class="col-6"><label class="form-label required">PIN 확인</label><input type="password" class="form-control" name="pin2" required inputmode="numeric" autocomplete="new-password"></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-user-check me-1"></i>추가</button></div></form></div>'
      + '<div class="col-lg-7"><h3 class="card-title mb-2"><i class="ti ti-users me-1 text-primary"></i>중간 관리자 <span class="text-secondary fw-normal">' + state.managers.length + '명</span></h3>';
    if (!state.managers.length) body += '<div class="text-secondary small">아직 없습니다.</div>';
    else body += '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>이름</th><th>담당 영역</th><th>등록일</th><th class="w-1"></th></tr></thead><tbody>'
      + state.managers.map(function (m) { return '<tr><td class="fw-medium">' + esc(m.name) + '</td><td>' + esc(m.area || '-') + '</td><td class="text-secondary text-nowrap">' + fmtDate(m.createdAt) + '</td><td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reset-mgr-pin" data-mgr="' + esc(m.id) + '" title="PIN 재설정"><i class="ti ti-key"></i></button><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-mgr" data-mgr="' + esc(m.id) + '" title="삭제"><i class="ti ti-trash"></i></button></td></tr>'; }).join('') + '</tbody></table></div>';
    body += '</div></div></div>';
    return { body: body };
  }

  /* ---------- actions ---------- */
  function handleError(err) { console.error(err); toast(err && err.message ? err.message : String(err), true); }
  function refresh() { return reload().then(render).catch(handleError); }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id === 'login-form') {
      e.preventDefault();
      store.signIn(readForm(form)).then(function (res) { if (res && res.magicLinkSent) { state.magicLinkSent = true; render(); return; } return refresh(); }).catch(handleError);
    }
    if (form.id === 'consume-form') {
      e.preventDefault();
      var c = readForm(form);
      if (!c.itemId) { toast('품목을 선택하세요.', true); return; }
      var it = itemById(c.itemId);
      store.invConsume(c.itemId, Number(c.qty), c.note).then(function (mv) { toast((it ? it.name : '') + ' ' + nf.format(mv.qty) + (it ? it.unit : '') + ' 소모 처리했습니다. 남은 재고 ' + nf.format(mv.stockAfter)); return refresh(); }).catch(handleError);
    }
    if (form.id === 'mgr-form') {
      e.preventDefault();
      var m = readForm(form);
      store.invVerifyManager(m.managerId, m.pin).then(function (ok) { if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; } setManager({ managerId: m.managerId, pin: m.pin }); toast('중간 관리자 모드를 열었습니다.'); return refresh(); }).catch(handleError);
    }
    if (form.id === 'item-form') {
      e.preventDefault();
      var v = readForm(form);
      var id = form.getAttribute('data-id') || null;
      var prev = id ? itemById(id) : null;
      var rec = { name: v.name, category: v.category, location: v.location, qty: Number(v.qty), unit: v.unit || '개', minQty: Number(v.minQty) || 0, unitPrice: prev ? (prev.unitPrice || 0) : 0, note: v.note, adjustNote: v.adjustNote || '', active: id ? !!v.active : true };
      if (id) rec.id = id;
      store.invSaveItem(rec, creds()).then(function () { toast(id ? '품목을 수정했습니다.' : '품목을 등록했습니다.'); state.editingItemId = null; touchManager(); return refresh(); }).catch(handleError);
    }
    if (form.id === 'mgr-add-form') {
      e.preventDefault();
      var a = readForm(form);
      if (!/^\d{4,8}$/.test(a.pin)) { toast('PIN은 숫자 4~8자리입니다.', true); return; }
      if (a.pin !== a.pin2) { toast('PIN 확인이 일치하지 않습니다.', true); return; }
      store.invSaveManager({ name: a.name, area: a.area }, { pin: a.pin }).then(function () { toast('중간 관리자를 추가했습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
    }
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.closest('#consume-form') && el.name === 'location') { state.consumeLoc = el.value; render(); }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    var itemId = btn.getAttribute('data-item');
    switch (action) {
      case 'tab': {
        e.preventDefault();
        var t = btn.getAttribute('data-tab');
        if (t === 'admin' && !isAdminActive()) { enterAdmin(); return; }
        state.tab = t; render(); break;
      }
      case 'unlock-admin': enterAdmin(); break;
      case 'lock-admin': setUnlock(false); state.tab = 'stock'; toast('관리자 화면을 잠갔습니다.'); render(); break;
      case 'lock-manager': setManager(null); state.editingItemId = null; toast('중간 관리자 모드를 잠갔습니다.'); render(); break;
      case 'signout': setUnlock(false); setManager(null); store.signOut().then(function () { window.location.replace('../index.html'); }); break;
      case 'refresh': refresh().then(function () { toast('새로고침 완료'); }); break;
      case 'filter-loc': state.filterLoc = btn.getAttribute('data-loc'); render(); break;
      case 'hist-type': state.histType = btn.getAttribute('data-type'); render(); break;
      case 'export-history': exportHistory(); break;
      case 'consume': consumeDialog(itemId).catch(handleError); break;
      case 'restock': if (!state.manager) { toast('중간 관리자 확인이 필요합니다.', true); state.tab = 'manager'; render(); return; } restockDialog(itemId).catch(handleError); break;
      case 'edit-item': state.editingItemId = itemId; render(); var f = $('#item-form'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' }); break;
      case 'cancel-edit-item': state.editingItemId = null; render(); break;
      case 'delete-item':
        confirmDlg({ title: '품목 삭제', message: '소모 기록이 없는 품목만 삭제됩니다. 삭제할까요?', okLabel: '삭제', danger: true }).then(function (ok) { if (!ok) return; return store.invDeleteItem(itemId, creds()).then(function () { toast('삭제했습니다.'); touchManager(); return refresh(); }); }).catch(handleError);
        break;
      case 'reset-mgr-pin': {
        var mid = btn.getAttribute('data-mgr'); var mm = managerById(mid); if (!mm) return;
        promptDlg({ title: mm.name + ' PIN 재설정', message: '새 PIN을 입력하세요.', input: 'password', placeholder: '숫자 4~8자리', okLabel: '재설정' }).then(function (pin) {
          if (pin === null) return;
          if (!/^\d{4,8}$/.test(pin)) { toast('PIN은 숫자 4~8자리입니다.', true); return; }
          return store.invSaveManager({ id: mm.id, name: mm.name, area: mm.area }, { pin: pin }).then(function () { toast('PIN을 재설정했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'delete-mgr': {
        var mid2 = btn.getAttribute('data-mgr');
        confirmDlg({ title: '중간 관리자 삭제', message: '이 중간 관리자를 삭제할까요? 품목과 이력은 유지됩니다.', okLabel: '삭제', danger: true }).then(function (ok) { if (!ok) return; return store.invDeleteManager(mid2).then(function () { toast('삭제했습니다.'); setUnlock(true); return refresh(); }); }).catch(handleError);
        break;
      }
    }
  });

  /* ---------- boot ---------- */
  var initialTab = (window.location.hash || '').replace('#', '');
  if (TABS.indexOf(initialTab) >= 0) state.tab = initialTab;

  function requireSession() {
    var s = store.getSession();
    if (s && s.status !== 'pending') return true;
    window.location.replace('../index.html?next=inventory');
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
