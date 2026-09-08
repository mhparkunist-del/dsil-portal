/* =====================================================================
   DSIL Lab Portal – 장비 예약 (UI, Tabler + FullCalendar)
   탭: 캘린더(예약) · 내 예약·로그 · 장비 안내 · 장비 담당자(PIN) · 관리자(PIN)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var EQ = Object.assign({ dayStart: 8, dayEnd: 22, slotMinutes: 30, maxHours: 8, logDueDays: 7, managerUnlockMinutes: 10 }, CFG.equipment || {});
  var U = window.DSILUI;
  var esc = U.esc, pad2 = U.pad2, localDate = U.localDate, fmtDate = U.fmtDate, fmtTime = U.fmtTime, fmtDateTime = U.fmtDateTime;
  var $ = U.$, toast = U.toast, readForm = U.readForm, dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty, dg = U.dg, stat = U.stat;
  var store = window.DSILStore.create(CFG);
  var ADMIN_KEY = 'dsil-budget-admin-unlock';
  var MGR_KEY = 'dsil-equip-manager-unlock';
  var TABS = ['calendar', 'mine', 'info', 'manager', 'admin'];
  var COLORS = [
    { id: '#004191', label: 'KAIST 블루' }, { id: '#2fb344', label: '초록' }, { id: '#f76707', label: '주황' }, { id: '#ae3ec9', label: '보라' },
    { id: '#0ca678', label: '청록' }, { id: '#d63939', label: '빨강' }, { id: '#f59f00', label: '노랑' }, { id: '#4299e1', label: '하늘' }
  ];

  var state = {
    ready: false, error: null, session: null, magicLinkSent: false,
    equipment: [], reservations: [], logs: [],
    tab: 'calendar', filterEq: 'all',
    adminUnlocked: false, manager: null,
    calendar: null, calView: 'timeGridWeek', calDate: null,
    editingEqId: null
  };

  /* ---------- helpers ---------- */
  function nameKey(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function eqById(id) { for (var i = 0; i < state.equipment.length; i++) if (state.equipment[i].id === id) return state.equipment[i]; return null; }
  function resById(id) { for (var i = 0; i < state.reservations.length; i++) if (state.reservations[i].id === id) return state.reservations[i]; return null; }
  function logById(id) { for (var i = 0; i < state.logs.length; i++) if (state.logs[i].id === id) return state.logs[i]; return null; }
  function me() { return state.session ? state.session.user : null; }
  function isMineRes(r) { var u = me(); return !!u && (r.userId === u.id || nameKey(r.userName) === nameKey(u.name)); }
  function isPast(r) { return new Date(r.end) < new Date(); }
  function isRunning(r) { var n = new Date(); return new Date(r.start) <= n && n < new Date(r.end); }
  function isUnlogged(r) { return r.status === 'booked' && !r.logId && isPast(r); }
  function isOverdue(r) { return isUnlogged(r) && (new Date() - new Date(r.end)) > EQ.logDueDays * 86400000; }
  function myUnlogged() { return state.reservations.filter(function (r) { return isMineRes(r) && isUnlogged(r); }); }
  function isBlocked() { return myUnlogged().some(isOverdue); }
  var GRADES = [{ id: 'training', label: '교육' }, { id: 'test', label: '유저 테스트 대기' }, { id: 'user', label: '유저' }, { id: 'super', label: '슈퍼유저' }];
  function gradeLabel(g) { for (var i = 0; i < GRADES.length; i++) if (GRADES[i].id === g) return GRADES[i].label; return g || '-'; }
  function gradeCls(g) { return { training: 'bg-secondary-lt', test: 'bg-yellow-lt', user: 'bg-green-lt', super: 'bg-blue-lt' }[g] || 'bg-secondary-lt'; }
  function gradeOptions(selected) { return GRADES.map(function (g) { return '<option value="' + g.id + '"' + (g.id === selected ? ' selected' : '') + '>' + g.label + '</option>'; }).join(''); }
  function myUser(eq) { var u = me(); return u ? ((eq.users || []).filter(function (x) { return nameKey(x.name) === nameKey(u.name); })[0] || null) : null; }
  /* 유저·슈퍼유저 등급, 또는 포털 관리자 계정 */
  function canReserve(eq) { if (state.session && state.session.isAdmin) return true; var u = myUser(eq); return !!u && (u.grade === 'user' || u.grade === 'super'); }
  function isAuthorized(eq) { return canReserve(eq); }
  function daysLeft(r) { return Math.max(0, Math.ceil((new Date(r.end).getTime() + EQ.logDueDays * 86400000 - Date.now()) / 86400000)); }
  function fmtRange(r) {
    var s = new Date(r.start), e = new Date(r.end);
    var same = localDate(r.start) === localDate(r.end);
    return fmtDate(r.start) + ' ' + fmtTime(r.start) + ' – ' + (same ? '' : fmtDate(r.end) + ' ') + fmtTime(r.end);
  }
  function hours(r) { return Math.round((new Date(r.end) - new Date(r.start)) / 360000) / 10; }
  function toLocalInput(iso) { var d = new Date(iso); return isNaN(d) ? '' : localDate(iso) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  /* 기본 예약 시간: 다음 정각부터 2시간 (표시 시간대 안으로) */
  function defaultSlot() {
    var s = new Date(); s.setMinutes(0, 0, 0); s.setHours(s.getHours() + 1);
    if (s.getHours() < EQ.dayStart) s.setHours(EQ.dayStart, 0, 0, 0);
    if (s.getHours() >= EQ.dayEnd - 1) { s.setDate(s.getDate() + 1); s.setHours(EQ.dayStart, 0, 0, 0); }
    var e = new Date(s.getTime() + 2 * 3600000);
    return { start: toLocalInput(s.toISOString()), end: toLocalInput(e.toISOString()) };
  }
  /* 종료가 시작보다 빠르면 시작 + 슬롯 만큼으로 맞춤 */
  function syncEnd(form) {
    var s = form.querySelector('[data-role="dt-start"]'), e = form.querySelector('[data-role="dt-end"]');
    if (!s || !e || !s.value) return;
    e.min = s.value;
    if (!e.value || e.value <= s.value) { var d = new Date(s.value); d.setMinutes(d.getMinutes() + Math.max(EQ.slotMinutes, 60)); e.value = toLocalInput(d.toISOString()); }
  }
  function resStatus(r) {
    if (r.status === 'cancelled') return { label: '취소', cls: 'bg-secondary-lt' };
    if (isRunning(r)) return { label: '사용 중', cls: 'bg-blue-lt' };
    if (!isPast(r)) return { label: '예정', cls: 'bg-azure-lt' };
    if (r.logId) return { label: '완료 · 로그 작성', cls: 'bg-green-lt' };
    return isOverdue(r) ? { label: '로그 미작성 · 기한 초과', cls: 'bg-red-lt' } : { label: '로그 미작성', cls: 'bg-yellow-lt' };
  }
  function eqBadge(eq) { return '<span class="badge me-1" style="background:' + esc(eq ? eq.color : '#999') + '">&nbsp;</span>'; }

  /* ---------- 관리자 / 담당자 잠금 ---------- */
  function readUnlock() {
    try { var t = Number(sessionStorage.getItem(ADMIN_KEY) || 0); var mins = Number(CFG.adminUnlockMinutes) > 0 ? Number(CFG.adminUnlockMinutes) : 10; return t > 0 && (Date.now() - t) < mins * 60000; } catch (e) { return false; }
  }
  function setUnlock(on) { try { if (on) sessionStorage.setItem(ADMIN_KEY, String(Date.now())); else sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ } state.adminUnlocked = on; }
  function isAdminEligible() { return !!(state.session && state.session.isAdmin); }
  function isAdminActive() { return isAdminEligible() && state.adminUnlocked; }
  function enterAdmin() {
    if (!isAdminEligible()) { toast('관리자 권한이 없습니다.', true); return; }
    if (readUnlock()) { setUnlock(true); state.tab = 'admin'; render(); return; }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요.', input: 'password', placeholder: 'PIN', okLabel: '열기' }).then(function (pin) {
      if (pin === null) return;
      return store.verifyAdminPin(pin).then(function (ok) {
        if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; }
        setUnlock(true); state.tab = 'admin'; toast('관리자 화면을 열었습니다.'); render();
      });
    }).catch(handleError);
  }
  function readManager() {
    try { var m = JSON.parse(sessionStorage.getItem(MGR_KEY) || 'null'); if (m && m.ts && (Date.now() - m.ts) < EQ.managerUnlockMinutes * 60000 && m.equipmentId && m.pin) return m; } catch (e) { /* ignore */ }
    return null;
  }
  function setManager(m) {
    try { if (m) sessionStorage.setItem(MGR_KEY, JSON.stringify({ equipmentId: m.equipmentId, pin: m.pin, ts: Date.now() })); else sessionStorage.removeItem(MGR_KEY); } catch (e) { /* ignore */ }
    state.manager = m ? { equipmentId: m.equipmentId, pin: m.pin, ts: Date.now() } : null;
  }
  function managerOf(equipmentId) { return !!(state.manager && state.manager.equipmentId === equipmentId); }
  function touchManager() { if (state.manager) setManager(state.manager); }

  /* ---------- data ---------- */
  function reload() {
    state.session = store.getSession();
    state.adminUnlocked = readUnlock();
    state.manager = readManager();
    if (!state.session) { state.equipment = []; state.reservations = []; state.logs = []; return Promise.resolve(); }
    return Promise.all([store.listEquipment(), store.listReservations(), store.listUsageLogs()]).then(function (res) {
      state.equipment = res[0];
      state.reservations = res[1].slice().sort(function (a, b) { return String(b.start).localeCompare(String(a.start)); });
      state.logs = res[2];
      if (state.tab === 'admin' && !isAdminActive()) state.tab = 'calendar';
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

    var now = new Date();
    var todayStr = localDate(now.toISOString());
    var upcomingMine = state.reservations.filter(function (r) { return isMineRes(r) && r.status === 'booked' && new Date(r.end) > now; }).length;
    var unlogged = myUnlogged();
    var today = state.reservations.filter(function (r) { return r.status === 'booked' && localDate(r.start) === todayStr; }).length;
    var activeEq = state.equipment.filter(function (e) { return e.active !== false; }).length;
    var blocked = isBlocked();

    var html = '<div class="row row-deck row-cards mb-3">'
      + stat('다가오는 내 예약', upcomingMine + '건', '', 'text-primary')
      + stat('로그 미작성', unlogged.length + '건', blocked ? '기한 초과 · 새 예약 차단' : (unlogged.length ? '다음 예약 전에 작성하세요' : '작성할 로그 없음'), unlogged.length ? (blocked ? 'text-red' : 'text-yellow') : '')
      + stat('오늘 예약', today + '건', '모든 장비', '')
      + stat('사용 가능 장비', activeEq + '대', '', '')
      + '</div>';

    if (unlogged.length) {
      html += '<div class="alert alert-' + (blocked ? 'danger' : 'warning') + ' mb-3"><div class="d-flex align-items-start gap-2"><i class="ti ti-' + (blocked ? 'lock' : 'notes') + ' fs-2"></i><div class="flex-fill">'
        + '<h4 class="alert-title mb-1">' + (blocked ? '로그 기한이 지나 새 예약이 막혀 있습니다' : '사용 로그를 작성해 주세요') + '</h4>'
        + '<div class="small text-secondary mb-2">사용 후 ' + EQ.logDueDays + '일 안에 로그 시트를 작성해야 합니다. 작성하지 않으면 기한이 지난 뒤 새 예약을 할 수 없습니다.</div>'
        + '<div class="d-flex flex-column gap-1">' + unlogged.map(function (r) {
          var eq = eqById(r.equipmentId);
          return '<div class="d-flex flex-wrap align-items-center gap-2"><span>' + eqBadge(eq) + esc(eq ? eq.name : '') + ' · ' + esc(fmtRange(r)) + '</span>'
            + (isOverdue(r) ? '<span class="badge bg-red-lt">기한 초과</span>' : '<span class="badge bg-yellow-lt">' + daysLeft(r) + '일 남음</span>')
            + '<button type="button" class="btn btn-sm btn-primary" data-action="write-log" data-res="' + esc(r.id) + '"><i class="ti ti-pencil me-1"></i>로그 작성</button></div>';
        }).join('') + '</div></div></div></div>';
    }

    var tab = state.tab === 'mine' ? renderMineTab()
      : state.tab === 'info' ? renderInfoTab()
      : state.tab === 'manager' ? renderManagerTab()
      : state.tab === 'admin' ? renderAdminTab()
      : renderCalendarTab(blocked);

    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('calendar', 'calendar-event', '캘린더')
      + tabLink('mine', 'user-check', '내 예약·로그', unlogged.length ? '<span class="badge bg-yellow-lt ms-2">' + unlogged.length + '</span>' : '')
      + tabLink('info', 'device-desktop', '장비 안내')
      + tabLink('manager', state.manager ? 'lock-open' : 'lock', '장비 담당자')
      + (isAdminEligible() ? tabLink('admin', state.adminUnlocked ? 'lock-open' : 'lock', '관리자') : '')
      + '</ul></div>' + tab.body + '</div>' + (tab.after || '');

    app.innerHTML = html;
    try { history.replaceState(null, '', '#' + state.tab); } catch (e) { /* ignore */ }
    if (state.tab === 'calendar') mountCalendar();
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
    var role = state.manager ? '장비 담당자 · 열림' : (isAdminActive() ? '관리자 · 열림' : '구성원');
    slot.innerHTML = '<div class="d-flex align-items-center gap-2">'
      + '<span class="avatar avatar-sm bg-blue-lt">' + esc((s.user.name || '?').trim().charAt(0)) + '</span>'
      + '<div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(s.user.name) + '</div><div class="small text-secondary mt-1">' + role + '</div></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="signout"><i class="ti ti-logout"></i><span class="d-none d-sm-inline ms-1">로그아웃</span></button></div>';
  }

  function renderLogin() {
    var head = '<div class="container-tight py-4"><div class="card card-md"><div class="card-body">';
    var foot = '</div></div></div>';
    if (store.mode === 'supabase') {
      if (state.magicLinkSent) return head + '<div class="empty"><div class="empty-icon"><i class="ti ti-mail"></i></div><p class="empty-title">메일을 확인하세요</p><p class="empty-subtitle text-secondary">로그인 링크를 보냈습니다.</p></div>' + foot;
      return head + '<h2 class="h2 text-center mb-2">로그인</h2><p class="text-secondary text-center mb-4">이메일로 로그인 링크를 보내드립니다.</p>'
        + '<form id="login-form"><div class="mb-3"><label class="form-label required">이메일</label><input type="email" class="form-control" name="email" required placeholder="name@kaist.ac.kr"></div>'
        + '<div class="mb-3"><label class="form-label">이름 <span class="form-label-description">처음 로그인 시</span></label><input type="text" class="form-control" name="name" placeholder="홍길동"></div>'
        + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100">로그인 링크 보내기</button></div></form>' + foot;
    }
    return head + '<h2 class="h2 text-center mb-2">시작하기</h2>'
      + '<p class="text-secondary text-center mb-4">이름을 입력하면 장비 예약 캘린더를 보고 예약할 수 있습니다. 예약에는 장비 담당자가 준 사용자 PIN이 필요합니다.</p>'
      + '<form id="login-form"><div class="mb-3"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required placeholder="홍길동" autocomplete="name"></div>'
      + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100">시작</button></div></form>' + foot;
  }

  /* ---------- 캘린더 탭 ---------- */
  function renderCalendarTab(blocked) {
    var chips = '<button type="button" class="btn btn-sm ' + (state.filterEq === 'all' ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="filter-eq" data-eq="all">전체</button>'
      + state.equipment.filter(function (e) { return e.active !== false; }).map(function (e) {
        return '<button type="button" class="btn btn-sm ' + (state.filterEq === e.id ? 'btn-primary' : 'btn-outline-secondary') + '" data-action="filter-eq" data-eq="' + esc(e.id) + '">' + eqBadge(e) + esc(e.name) + '</button>';
      }).join('');
    var active = state.equipment.filter(function (e) { return e.active !== false; });
    var isAdmin = !!(state.session && state.session.isAdmin);
    var eqOpts = active.map(function (e) {
      var sel = state.filterEq === e.id ? ' selected' : '';
      var mu = myUser(e);
      return '<option value="' + esc(e.id) + '"' + sel + '>' + esc(e.name) + (canReserve(e) ? (isAdmin && !(mu && (mu.grade === 'user' || mu.grade === 'super')) ? ' (관리자)' : '') : (mu ? ' (' + gradeLabel(mu.grade) + ' · 예약 불가)' : ' (미등록)')) + '</option>';
    }).join('');
    var u = me();
    var body = '<div class="card-body"><div class="row g-4">'
      + '<div class="col-lg-8"><div class="d-flex flex-wrap gap-2 mb-3">' + chips + '</div><div id="calendar"></div>'
      + '<div class="text-secondary small mt-2"><i class="ti ti-pointer me-1"></i>빈 시간을 드래그하면 오른쪽 예약 폼에 시간이 채워집니다. 예약 블록을 누르면 상세가 열립니다.</div></div>'
      + '<div class="col-lg-4"><h3 class="card-title mb-3"><i class="ti ti-calendar-plus me-1 text-primary"></i>예약하기</h3>';
    /* 장비가 하나도 없으면 폼 대신 안내 (빈 select 는 제출해도 브라우저 검증 말풍선만 뜸) */
    if (!active.length) {
      body += empty('device-desktop-off', '예약할 장비가 아직 없습니다', isAdmin ? '관리자 탭에서 장비를 추가한 뒤 사용자를 등록하세요.' : '관리자가 장비를 등록하면 여기서 예약할 수 있습니다.')
        + (isAdmin ? '<div class="text-center"><button type="button" class="btn btn-primary" data-action="tab" data-tab="admin"><i class="ti ti-plus me-1"></i>장비 추가</button></div>' : '')
        + '</div></div></div>';
      return { body: body };
    }
    if (blocked) {
      body += '<div class="alert alert-danger"><div class="fw-medium">새 예약이 막혀 있습니다</div><div class="small">사용 로그 기한(' + EQ.logDueDays + '일)이 지난 예약이 있습니다. 위의 로그 작성을 마치면 다시 예약할 수 있습니다.</div></div>';
    }
    /* 어느 장비에도 예약 권한이 없으면 등록 절차 안내 */
    if (!isAdmin && !active.some(canReserve)) {
      var mgrs = active.map(function (e) { var mu = myUser(e); return esc(e.name) + ' → ' + esc(e.managerName || '담당자 미지정') + (mu ? ' (현재 ' + esc(gradeLabel(mu.grade)) + ')' : ''); });
      body += '<div class="alert alert-warning py-2"><div class="fw-medium"><i class="ti ti-user-off me-1"></i>아직 예약 권한이 있는 장비가 없습니다</div><div class="small">장비 담당자가 담당자 탭(PIN)에서 <strong>' + esc(u ? u.name : '') + '</strong> 이름을 <strong>유저</strong> 또는 <strong>슈퍼유저</strong> 등급으로 등록해야 예약할 수 있습니다. 교육·유저 테스트 대기 등급은 예약이 막힙니다.</div><ul class="small mb-0 mt-1 ps-3">' + mgrs.map(function (m) { return '<li>' + m + '</li>'; }).join('') + '</ul></div>';
    }
    var def = defaultSlot();
    body += '<form id="res-form"' + (blocked ? ' class="opacity-50"' : '') + '><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">장비</label><select class="form-select" name="equipmentId" required' + (blocked ? ' disabled' : '') + '>' + eqOpts + '</select></div>'
      + '<div class="col-12"><label class="form-label required">시작 (날짜 · 시각)</label><input type="datetime-local" class="form-control" name="start" required step="' + (EQ.slotMinutes * 60) + '" value="' + def.start + '" min="' + localDate(new Date().toISOString()) + 'T00:00" data-role="dt-start"' + (blocked ? ' disabled' : '') + '></div>'
      + '<div class="col-12"><label class="form-label required">종료 (날짜 · 시각)</label><input type="datetime-local" class="form-control" name="end" required step="' + (EQ.slotMinutes * 60) + '" value="' + def.end + '" min="' + def.start + '" data-role="dt-end"' + (blocked ? ' disabled' : '') + '></div>'
      + '<div class="col-12"><label class="form-label">목적</label><input type="text" class="form-control" name="purpose" placeholder="예: TMD 소자 I-V 측정"' + (blocked ? ' disabled' : '') + '></div>'
      + '</div><div class="d-flex justify-content-between align-items-center mt-3"><span class="small text-secondary">최대 ' + EQ.maxHours + '시간 · ' + EQ.slotMinutes + '분 단위</span>'
      + '<button type="submit" class="btn btn-primary"' + (blocked ? ' disabled' : '') + '><i class="ti ti-calendar-check me-1"></i>예약</button></div></form>'
      + '<div class="text-secondary small mt-3"><i class="ti ti-id me-1"></i>예약자: <strong>' + esc(u ? u.name : '') + '</strong>. 장비 담당자가 유저 또는 슈퍼유저 등급으로 등록한 장비만 예약할 수 있습니다. 내 예약은 캘린더에서 끌어서 시간을 바꿀 수 있습니다.</div>'
      + '</div></div></div>';
    return { body: body };
  }

  function calendarEvents() {
    return state.reservations.filter(function (r) {
      return r.status === 'booked' && (state.filterEq === 'all' || r.equipmentId === state.filterEq);
    }).map(function (r) {
      var eq = eqById(r.equipmentId);
      var mine = isMineRes(r);
      var movable = (mine && new Date(r.start) > new Date()) || managerOf(r.equipmentId);
      return {
        id: r.id, title: r.userName + (state.filterEq === 'all' && eq ? ' · ' + eq.name : '') + (r.purpose ? ' – ' + r.purpose : ''),
        start: r.start, end: r.end,
        editable: movable, startEditable: movable, durationEditable: movable,
        backgroundColor: eq ? eq.color : '#999', borderColor: mine ? '#0c2f5f' : (eq ? eq.color : '#999'), textColor: '#fff',
        classNames: [mine ? 'fc-mine' : 'fc-other', isUnlogged(r) ? 'fc-unlogged' : '']
      };
    });
  }

  function mountCalendar() {
    var el = $('#calendar');
    if (!el) return;
    if (!window.FullCalendar) { el.innerHTML = '<div class="alert alert-warning">캘린더 라이브러리를 불러오지 못했습니다. 네트워크를 확인하세요.</div>'; return; }
    if (state.calendar) { try { state.calendar.destroy(); } catch (e) { /* ignore */ } state.calendar = null; }
    var cal = new FullCalendar.Calendar(el, {
      locale: 'ko',
      initialView: state.calView,
      initialDate: state.calDate || undefined,
      headerToolbar: { left: 'prev,next today', center: 'title', right: 'timeGridWeek,timeGridDay,dayGridMonth,listWeek' },
      buttonText: { today: '오늘', month: '월', week: '주', day: '일', list: '목록' },
      height: 'auto',
      firstDay: 1,
      nowIndicator: true,
      allDaySlot: false,
      slotMinTime: pad2(EQ.dayStart) + ':00:00',
      slotMaxTime: pad2(EQ.dayEnd) + ':00:00',
      slotDuration: '00:' + pad2(EQ.slotMinutes) + ':00',
      slotLabelFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      eventTimeFormat: { hour: '2-digit', minute: '2-digit', hour12: false },
      expandRows: true,
      selectable: true,
      selectMirror: true,
      events: calendarEvents(),
      select: function (info) {
        var f = $('#res-form');
        if (f && !f.start.disabled) {
          f.start.value = toLocalInput(info.start.toISOString());
          f.end.value = toLocalInput(info.end.toISOString());
          f.end.min = f.start.value;
          if (state.filterEq !== 'all') f.equipmentId.value = state.filterEq;
          f.purpose.focus();
        }
        cal.unselect();
      },
      eventClick: function (info) { info.jsEvent.preventDefault(); showReservation(info.event.id); },
      eventDrop: function (info) { moveEvent(info); },
      eventResize: function (info) { moveEvent(info); },
      datesSet: function (info) { state.calView = info.view.type; state.calDate = info.view.currentStart; }
    });
    cal.render();
    state.calendar = cal;
  }

  /* 캘린더에서 끌어서 옮기거나 늘린 경우 */
  function moveEvent(info) {
    var r = resById(info.event.id);
    if (!r) { info.revert(); return; }
    var viaManager = !(isMineRes(r) && new Date(r.start) > new Date());
    store.updateReservation(r.id, { start: info.event.start.toISOString(), end: info.event.end.toISOString() }, { managerPin: viaManager && managerOf(r.equipmentId) ? state.manager.pin : null })
      .then(function () { toast('예약 시간을 ' + fmtRange({ start: info.event.start.toISOString(), end: info.event.end.toISOString() }) + ' 로 바꿨습니다.'); touchManager(); return refresh(); })
      .catch(function (err) { info.revert(); handleError(err); });
  }

  function rescheduleDialog(resId) {
    var r = resById(resId); if (!r) return Promise.resolve();
    var eq = eqById(r.equipmentId);
    var body = '<div class="text-secondary small mb-3">' + eqBadge(eq) + esc(eq ? eq.name : '') + ' · 현재 ' + esc(fmtRange(r)) + '</div><div class="row g-3">'
      + '<div class="col-6"><label class="form-label required">시작 (날짜 · 시각)</label><input type="datetime-local" class="form-control" name="start" required step="' + (EQ.slotMinutes * 60) + '" value="' + esc(toLocalInput(r.start)) + '" data-role="dt-start"></div>'
      + '<div class="col-6"><label class="form-label required">종료 (날짜 · 시각)</label><input type="datetime-local" class="form-control" name="end" required step="' + (EQ.slotMinutes * 60) + '" value="' + esc(toLocalInput(r.end)) + '" min="' + esc(toLocalInput(r.start)) + '" data-role="dt-end"></div>'
      + '<div class="col-12"><label class="form-label">목적</label><input type="text" class="form-control" name="purpose" value="' + esc(r.purpose) + '"></div></div>';
    return dialog({ title: '예약 변경', bodyHtml: body, size: 'lg', okLabel: '변경' }).then(function (v) {
      if (!v) return;
      var start = new Date(v.start), end = new Date(v.end);
      if (isNaN(start) || isNaN(end)) { toast('시작·종료 시각을 입력하세요.', true); return; }
      if (end <= start) { toast('종료 시각이 시작보다 늦어야 합니다.', true); return; }
      var viaManager = !(isMineRes(r) && new Date(r.start) > new Date());
      return store.updateReservation(r.id, { start: start.toISOString(), end: end.toISOString(), purpose: v.purpose }, { managerPin: viaManager && managerOf(r.equipmentId) ? state.manager.pin : null })
        .then(function () { toast('예약을 변경했습니다.'); touchManager(); return refresh(); });
    });
  }

  /* ---------- 예약 상세 / 로그 ---------- */
  function showReservation(id) {
    var r = resById(id);
    if (!r) return;
    var eq = eqById(r.equipmentId);
    var st = resStatus(r);
    var mine = isMineRes(r);
    var log = r.logId ? logById(r.logId) : null;
    var canCancel = r.status === 'booked' && ((mine && new Date(r.start) > new Date()) || managerOf(r.equipmentId));
    var html = '<div class="datagrid mb-3">'
      + dg('장비', eqBadge(eq) + esc(eq ? eq.name : '-') + (eq && eq.location ? ' <span class="text-secondary small">· ' + esc(eq.location) + '</span>' : ''))
      + dg('시간', esc(fmtRange(r)) + ' <span class="text-secondary small">(' + hours(r) + '시간)</span>')
      + dg('예약자', esc(r.userName)) + dg('상태', '<span class="badge ' + st.cls + '">' + st.label + '</span>')
      + (r.purpose ? dg('목적', esc(r.purpose)) : '')
      + (r.status === 'cancelled' ? dg('취소', esc(fmtDateTime(r.cancelledAt)) + (r.cancelledBy ? ' · ' + esc(r.cancelledBy) : '')) : '')
      + '</div>'
      + '<div class="d-flex flex-wrap gap-2">'
      + (canCancel ? '<button type="button" class="btn" data-action="reschedule" data-res="' + esc(r.id) + '"><i class="ti ti-calendar-time me-1"></i>일정 변경</button>' : '')
      + (canCancel ? '<button type="button" class="btn btn-outline-danger" data-action="cancel-res" data-res="' + esc(r.id) + '"><i class="ti ti-calendar-off me-1"></i>예약 취소</button>' : '')
      + (mine && isUnlogged(r) ? '<button type="button" class="btn btn-primary" data-action="write-log" data-res="' + esc(r.id) + '"><i class="ti ti-pencil me-1"></i>로그 작성</button>' : '')
      + (log ? '<button type="button" class="btn" data-action="view-log" data-log="' + esc(log.id) + '"><i class="ti ti-notes me-1"></i>로그 보기</button>' : '')
      + (!mine && isUnlogged(r) && managerOf(r.equipmentId) ? '<button type="button" class="btn" data-action="waive-log" data-res="' + esc(r.id) + '"><i class="ti ti-check me-1"></i>로그 면제</button>' : '')
      + '</div>';
    return dialog({ title: '예약 상세', html: html, size: 'lg', okLabel: '닫기', hideCancel: true });
  }

  function writeLog(resId) {
    var r = resById(resId);
    if (!r) return Promise.resolve();
    var eq = eqById(r.equipmentId);
    var body = '<div class="text-secondary small mb-3">' + eqBadge(eq) + esc(eq ? eq.name : '') + ' · ' + esc(fmtRange(r)) + '</div><div class="row g-3">'
      + '<div class="col-6"><label class="form-label required">실제 사용 시작</label><input type="datetime-local" class="form-control" name="usedStart" required value="' + esc(toLocalInput(r.start)) + '"></div>'
      + '<div class="col-6"><label class="form-label required">실제 사용 종료</label><input type="datetime-local" class="form-control" name="usedEnd" required value="' + esc(toLocalInput(r.end)) + '"></div>'
      + '<div class="col-12"><div class="form-label required">장비 상태</div><div class="d-flex gap-3">'
      + '<label class="form-check mb-0"><input class="form-check-input" type="radio" name="condition" value="normal" checked><span class="form-check-label">정상</span></label>'
      + '<label class="form-check mb-0"><input class="form-check-input" type="radio" name="condition" value="issue"><span class="form-check-label">이상 있음</span></label></div></div>'
      + '<div class="col-12"><label class="form-label required">사용 내용 · 조건</label><textarea class="form-control" name="content" rows="3" required placeholder="시편, 공정/측정 조건, 사용 소모품 등"></textarea></div>'
      + '<div class="col-12"><label class="form-label">특이사항 · 문제</label><textarea class="form-control" name="issues" rows="2" placeholder="이상 증상, 담당자에게 전달할 내용"></textarea></div>'
      + '</div>';
    return dialog({ title: '사용 로그 시트', bodyHtml: body, size: 'lg', okLabel: '로그 저장' }).then(function (v) {
      if (!v) return;
      var s = new Date(v.usedStart), e = new Date(v.usedEnd);
      if (isNaN(s) || isNaN(e) || e <= s) { toast('사용 시간을 확인하세요.', true); return; }
      return store.createUsageLog({ reservationId: r.id, usedStart: s.toISOString(), usedEnd: e.toISOString(), condition: v.condition, content: v.content, issues: v.issues })
        .then(function () { toast('로그를 저장했습니다.'); return refresh(); });
    });
  }

  function viewLog(logId) {
    var log = logById(logId);
    if (!log) return Promise.resolve();
    var eq = eqById(log.equipmentId);
    var html = '<div class="datagrid mb-3">'
      + dg('장비', eqBadge(eq) + esc(eq ? eq.name : '-')) + dg('사용자', esc(log.userName))
      + dg('실제 사용', esc(fmtDateTime(log.usedStart)) + ' – ' + esc(fmtTime(log.usedEnd)))
      + dg('장비 상태', log.condition === 'issue' ? '<span class="badge bg-red-lt">이상 있음</span>' : '<span class="badge bg-green-lt">정상</span>')
      + dg('작성', esc(fmtDateTime(log.createdAt)) + (log.waived ? ' · <span class="badge bg-secondary-lt">담당자 면제 (' + esc(log.waivedBy || '') + ')</span>' : ''))
      + '</div>'
      + '<div class="mb-3"><div class="subheader">사용 내용 · 조건</div><div style="white-space:pre-wrap">' + esc(log.content || '-') + '</div></div>'
      + (log.issues ? '<div class="alert alert-warning py-2"><div class="small fw-medium">특이사항</div><div style="white-space:pre-wrap">' + esc(log.issues) + '</div></div>' : '');
    return dialog({ title: '사용 로그', html: html, size: 'lg', okLabel: '닫기', hideCancel: true });
  }

  /* ---------- 내 예약·로그 탭 ---------- */
  function renderMineTab() {
    var mine = state.reservations.filter(isMineRes);
    if (!mine.length) return { body: '<div class="card-body">' + empty('calendar-off', '아직 예약이 없습니다', '캘린더 탭에서 예약하세요.') + '</div>' };
    var body = '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>장비</th><th>시간</th><th>목적</th><th>상태</th><th class="w-1"></th></tr></thead><tbody>';
    mine.forEach(function (r) {
      var eq = eqById(r.equipmentId);
      var st = resStatus(r);
      body += '<tr><td>' + eqBadge(eq) + esc(eq ? eq.name : '-') + '</td><td class="text-nowrap">' + esc(fmtRange(r)) + '<div class="small text-secondary">' + hours(r) + '시간</div></td>'
        + '<td>' + esc(r.purpose || '-') + '</td><td><span class="badge ' + st.cls + '">' + st.label + '</span>' + (isUnlogged(r) && !isOverdue(r) ? '<div class="small text-secondary">' + daysLeft(r) + '일 남음</div>' : '') + '</td>'
        + '<td class="text-end text-nowrap">'
        + (r.status === 'booked' && new Date(r.start) > new Date() ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reschedule" data-res="' + esc(r.id) + '" title="일정 변경"><i class="ti ti-calendar-time"></i></button><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="cancel-res" data-res="' + esc(r.id) + '" title="예약 취소"><i class="ti ti-calendar-off"></i></button>' : '')
        + (isUnlogged(r) ? '<button type="button" class="btn btn-sm btn-primary" data-action="write-log" data-res="' + esc(r.id) + '"><i class="ti ti-pencil me-1"></i>로그 작성</button>' : '')
        + (r.logId ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="view-log" data-log="' + esc(r.logId) + '" title="로그 보기"><i class="ti ti-notes"></i></button>' : '')
        + '</td></tr>';
    });
    return { body: body + '</tbody></table></div>' };
  }

  /* ---------- 장비 안내 탭 ---------- */
  function renderInfoTab() {
    if (!state.equipment.length) return { body: '<div class="card-body">' + empty('device-desktop-off', '등록된 장비가 없습니다', '관리자 탭에서 장비를 추가하세요.') + '</div>' };
    var now = new Date();
    var cards = state.equipment.map(function (e) {
      var upcoming = state.reservations.filter(function (r) { return r.equipmentId === e.id && r.status === 'booked' && new Date(r.end) > now; }).length;
      var mu = myUser(e);
      var ok = canReserve(e);
      var badge = e.active === false ? '<span class="badge bg-secondary-lt">사용 중지</span>' : (mu ? '<span class="badge ' + gradeCls(mu.grade) + '">' + esc(gradeLabel(mu.grade)) + (ok ? '' : ' · 예약 불가') + '</span>' : '<span class="badge bg-secondary-lt">미등록</span>');
      var users = (e.users || []).length;
      var reservable = (e.users || []).filter(function (x) { return x.grade === 'user' || x.grade === 'super'; }).length;
      return '<div class="col-md-6 col-xl-4"><div class="card' + (e.active === false ? ' card-soon' : '') + '"><div class="card-status-top" style="background:' + esc(e.color) + '"></div><div class="card-body">'
        + '<div class="d-flex justify-content-between align-items-start gap-2 mb-2"><h3 class="card-title mb-0">' + esc(e.name) + '</h3>' + badge + '</div>'
        + '<div class="datagrid mb-3">' + dg('위치', esc(e.location || '-')) + dg('담당자', esc(e.managerName || '-')) + dg('등록 사용자', users + '명 <span class="text-secondary">(예약 가능 ' + reservable + ')</span>') + dg('예정 예약', upcoming + '건') + '</div>'
        + (e.description ? '<div class="mb-2">' + esc(e.description) + '</div>' : '')
        + (e.rules ? '<div class="text-secondary small" style="white-space:pre-wrap"><i class="ti ti-alert-circle me-1"></i>' + esc(e.rules) + '</div>' : '')
        + (!ok && e.active !== false ? '<div class="text-secondary small mt-2">' + (mu ? '유저 등급 승급은 담당자 ' + esc(e.managerName || '') + '에게 요청하세요.' : '담당자 ' + esc(e.managerName || '') + '에게 사용자 등록을 요청하세요.') + '</div>' : '')
        + '</div></div></div>';
    }).join('');
    return { body: '<div class="card-body"><div class="row row-cards">' + cards + '</div></div>' };
  }

  /* ---------- 장비 담당자 탭 ---------- */
  function renderManagerTab() {
    if (!state.manager) {
      var opts = state.equipment.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.name) + (e.managerName ? ' · ' + esc(e.managerName) : '') + '</option>'; }).join('');
      var body = '<div class="card-body"><div class="container-tight"><h3 class="card-title mb-1"><i class="ti ti-user-shield me-1 text-primary"></i>장비 담당자 확인</h3>'
        + '<p class="text-secondary small mb-3">장비를 고르고 담당자 PIN을 입력하면 ' + EQ.managerUnlockMinutes + '분 동안 그 장비의 사용자 등록, 예약 관리, 로그 열람이 열립니다.</p>'
        + (state.equipment.length ? '<form id="mgr-form"><div class="mb-3"><label class="form-label required">장비</label><select class="form-select" name="equipmentId" required>' + opts + '</select></div>'
          + '<div class="mb-3"><label class="form-label required">담당자 PIN</label><input type="password" class="form-control" name="pin" required inputmode="numeric" autocomplete="off"></div>'
          + '<button type="submit" class="btn btn-primary w-100"><i class="ti ti-key me-1"></i>열기</button></form>' : empty('device-desktop-off', '등록된 장비가 없습니다', ''))
        + '</div></div>';
      return { body: body };
    }
    var eq = eqById(state.manager.equipmentId);
    if (!eq) { setManager(null); return { body: '<div class="card-body">' + empty('device-desktop-off', '장비를 찾을 수 없습니다', '') + '</div>' }; }
    var now = new Date();
    var resList = state.reservations.filter(function (r) { return r.equipmentId === eq.id; });
    var logs = state.logs.filter(function (l) { return l.equipmentId === eq.id; }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });

    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom">'
      + '<div><i class="ti ti-lock-open me-1 text-primary"></i><strong>' + esc(eq.name) + '</strong> <span class="text-secondary small">담당자 모드 · ' + esc(eq.managerName || '') + '</span></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-manager"><i class="ti ti-lock me-1"></i>잠금</button></div>';

    body += '<div class="card-body"><div class="row g-4">'
      + '<div class="col-lg-5"><h3 class="card-title mb-1"><i class="ti ti-user-plus me-1 text-primary"></i>사용자 등록</h3>'
      + '<p class="text-secondary small mb-3">포털 로그인 이름과 등급을 정합니다. <strong>유저·슈퍼유저</strong>만 예약할 수 있고, 교육·유저 테스트 대기는 예약이 막힙니다. 같은 이름을 다시 등록하면 등급이 바뀝니다.</p>'
      + '<form id="grant-form"><div class="row g-2">'
      + '<div class="col-7"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required placeholder="포털 로그인 이름과 같게"></div>'
      + '<div class="col-5"><label class="form-label required">등급</label><select class="form-select" name="grade">' + gradeOptions('training') + '</select></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-user-check me-1"></i>등록</button></div></form></div>'
      + '<div class="col-lg-7"><h3 class="card-title mb-2"><i class="ti ti-users me-1 text-primary"></i>등록된 사용자 <span class="text-secondary fw-normal">' + (eq.users || []).length + '명</span></h3>';
    if (!(eq.users || []).length) body += '<div class="text-secondary small">아직 등록된 사용자가 없습니다.</div>';
    else {
      body += '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>이름</th><th>등급</th><th>변경일</th><th>처리자</th><th class="w-1"></th></tr></thead><tbody>'
        + eq.users.map(function (u) {
          return '<tr data-user="' + esc(u.id) + '"><td class="fw-medium">' + esc(u.name) + '</td><td><select class="form-select form-select-sm" data-role="grade" style="min-width:9rem">' + gradeOptions(u.grade) + '</select></td>'
            + '<td class="text-nowrap text-secondary">' + esc(fmtDate(u.grantedAt)) + '</td><td class="text-secondary">' + esc(u.grantedBy || '-') + '</td>'
            + '<td class="text-end"><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="revoke-user" data-user="' + esc(u.id) + '" title="등록 해제"><i class="ti ti-user-off"></i></button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    body += '</div></div></div>';

    var after = '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-calendar-stats me-1 text-primary"></i>' + esc(eq.name) + ' 예약 <span class="text-secondary fw-normal">' + resList.length + '건</span></h3></div>';
    if (!resList.length) after += '<div class="card-body">' + empty('calendar-off', '예약이 없습니다', '') + '</div>';
    else {
      after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>시간</th><th>예약자</th><th>목적</th><th>상태</th><th class="w-1"></th></tr></thead><tbody>';
      resList.forEach(function (r) {
        var st = resStatus(r);
        after += '<tr><td class="text-nowrap">' + esc(fmtRange(r)) + '</td><td>' + esc(r.userName) + '</td><td>' + esc(r.purpose || '-') + '</td><td><span class="badge ' + st.cls + '">' + st.label + '</span></td>'
          + '<td class="text-end text-nowrap">'
          + (r.status === 'booked' && new Date(r.end) > now ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reschedule" data-res="' + esc(r.id) + '" title="일정 변경"><i class="ti ti-calendar-time"></i></button><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="cancel-res" data-res="' + esc(r.id) + '" title="예약 취소"><i class="ti ti-calendar-off"></i></button>' : '')
          + (isUnlogged(r) ? '<button type="button" class="btn btn-sm" data-action="waive-log" data-res="' + esc(r.id) + '"><i class="ti ti-check me-1"></i>로그 면제</button>' : '')
          + (r.logId ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="view-log" data-log="' + esc(r.logId) + '" title="로그 보기"><i class="ti ti-notes"></i></button>' : '')
          + '</td></tr>';
      });
      after += '</tbody></table></div>';
    }
    after += '</div>';

    after += '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-notebook me-1 text-primary"></i>사용 로그 <span class="text-secondary fw-normal">' + logs.length + '건</span></h3></div>';
    if (!logs.length) after += '<div class="card-body">' + empty('notes-off', '작성된 로그가 없습니다', '') + '</div>';
    else {
      after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>실제 사용</th><th>사용자</th><th>상태</th><th>내용</th><th class="w-1"></th></tr></thead><tbody>';
      logs.forEach(function (l) {
        after += '<tr><td class="text-nowrap">' + esc(fmtDateTime(l.usedStart)) + ' – ' + esc(fmtTime(l.usedEnd)) + '</td><td>' + esc(l.userName) + '</td>'
          + '<td>' + (l.condition === 'issue' ? '<span class="badge bg-red-lt">이상</span>' : '<span class="badge bg-green-lt">정상</span>') + (l.waived ? ' <span class="badge bg-secondary-lt">면제</span>' : '') + '</td>'
          + '<td class="text-truncate" style="max-width:320px">' + esc(l.content || '') + (l.issues ? ' <span class="text-danger">· ' + esc(l.issues) + '</span>' : '') + '</td>'
          + '<td class="text-end"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="view-log" data-log="' + esc(l.id) + '"><i class="ti ti-eye"></i></button></td></tr>';
      });
      after += '</tbody></table></div>';
    }
    after += '</div>';
    return { body: body, after: after };
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab() {
    if (!isAdminActive()) {
      return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 열립니다.') + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    }
    var editing = state.editingEqId ? eqById(state.editingEqId) : null;
    var colorOpts = COLORS.map(function (c) { return '<option value="' + c.id + '"' + (editing && editing.color === c.id ? ' selected' : '') + '>' + c.label + '</option>'; }).join('');
    var body = '<div class="card-body py-2 d-flex align-items-center justify-content-between flex-wrap gap-2 border-bottom">'
      + '<div class="text-secondary small"><i class="ti ti-lock-open me-1"></i>관리자 모드 · 장비 목록, 담당자, 담당자 PIN을 설정합니다. 사용자 등록은 장비 담당자가 하며, 아래에서 관리자가 직접 할 수도 있습니다.</div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div>';
    body += '<div class="card-body"><div class="row g-4"><div class="col-lg-5">'
      + '<h3 class="card-title mb-3"><i class="ti ti-' + (editing ? 'edit' : 'device-desktop-plus') + ' me-1 text-primary"></i>' + (editing ? '장비 수정' : '장비 추가')
      + (editing ? ' <button type="button" class="btn btn-sm btn-ghost-secondary ms-2" data-action="cancel-edit-eq">취소</button>' : '') + '</h3>'
      + '<form id="eq-form" data-id="' + esc(editing ? editing.id : '') + '"><div class="row g-3">'
      + '<div class="col-12"><label class="form-label required">장비명</label><input type="text" class="form-control" name="name" required value="' + esc(editing ? editing.name : '') + '" placeholder="예: 프로브 스테이션"></div>'
      + '<div class="col-7"><label class="form-label">위치</label><input type="text" class="form-control" name="location" value="' + esc(editing ? editing.location : '') + '" placeholder="E3-3 2302호"></div>'
      + '<div class="col-5"><label class="form-label">색상</label><select class="form-select" name="color">' + colorOpts + '</select></div>'
      + '<div class="col-6"><label class="form-label">담당자</label><input type="text" class="form-control" name="managerName" value="' + esc(editing ? editing.managerName : '') + '" placeholder="이름"></div>'
      + '<div class="col-6"><label class="form-label' + (editing ? '' : ' required') + '">담당자 PIN' + (editing ? ' <span class="form-label-description">비우면 유지</span>' : '') + '</label><input type="password" class="form-control" name="managerPin"' + (editing ? '' : ' required') + ' inputmode="numeric" autocomplete="new-password" placeholder="숫자 4~8자리"></div>'
      + '<div class="col-12"><label class="form-label">설명</label><input type="text" class="form-control" name="description" value="' + esc(editing ? editing.description : '') + '"></div>'
      + '<div class="col-12"><label class="form-label">사용 규칙</label><textarea class="form-control" name="rules" rows="3" placeholder="한 줄에 하나씩">' + esc(editing ? editing.rules : '') + '</textarea></div>'
      + '<div class="col-12"><label class="form-check form-switch mb-0"><input class="form-check-input" type="checkbox" name="active"' + (!editing || editing.active !== false ? ' checked' : '') + '><span class="form-check-label">예약 가능</span></label></div>'
      + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-device-floppy me-1"></i>' + (editing ? '저장' : '장비 추가') + '</button></div></form></div>'
      + '<div class="col-lg-7"><h3 class="card-title mb-2"><i class="ti ti-devices me-1 text-primary"></i>장비 목록 <span class="text-secondary fw-normal">' + state.equipment.length + '대</span></h3>';
    if (!state.equipment.length) body += '<div class="text-secondary small">아직 장비가 없습니다.</div>';
    else {
      body += '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>장비</th><th>담당자</th><th class="text-end">사용자</th><th class="text-end">예약</th><th class="w-1"></th></tr></thead><tbody>'
        + state.equipment.map(function (e) {
          var cnt = state.reservations.filter(function (r) { return r.equipmentId === e.id && r.status === 'booked'; }).length;
          return '<tr><td>' + eqBadge(e) + '<span class="fw-medium">' + esc(e.name) + '</span>' + (e.active === false ? ' <span class="badge bg-secondary-lt">중지</span>' : '') + '<div class="small text-secondary">' + esc(e.location || '') + '</div></td>'
            + '<td>' + esc(e.managerName || '-') + (e.hasManagerPin ? '' : ' <span class="badge bg-red-lt">PIN 없음</span>') + '</td><td class="text-end tnum">' + (e.users || []).length + '</td><td class="text-end tnum">' + cnt + '</td>'
            + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="edit-eq" data-eq="' + esc(e.id) + '" title="수정"><i class="ti ti-edit"></i></button>'
            + '<button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-eq" data-eq="' + esc(e.id) + '" title="삭제"><i class="ti ti-trash"></i></button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    body += '</div></div></div>';
    /* 관리자 직접 등록: 담당자 PIN 이 없거나 담당자가 자리에 없을 때 */
    var activeEq = state.equipment.filter(function (e) { return e.active !== false; });
    body += '<div class="card-body border-top"><div class="row g-4"><div class="col-lg-5">'
      + '<h3 class="card-title mb-1"><i class="ti ti-user-plus me-1 text-primary"></i>사용자 등록 (관리자)</h3>'
      + '<p class="text-secondary small mb-3">원래는 장비 담당자가 담당자 탭(PIN)에서 등록하지만, 관리자는 여기서 PIN 없이 바로 등록·등급 변경할 수 있습니다. <strong>유저·슈퍼유저</strong>만 예약할 수 있습니다. 관리자 계정 자신은 등록 없이도 모든 장비를 예약할 수 있습니다.</p>'
      + (activeEq.length ? '<form id="admin-grant-form"><div class="row g-2">'
        + '<div class="col-12"><label class="form-label required">장비</label><select class="form-select" name="equipmentId" required>' + activeEq.map(function (e) { return '<option value="' + esc(e.id) + '">' + esc(e.name) + '</option>'; }).join('') + '</select></div>'
        + '<div class="col-7"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required placeholder="포털 로그인 이름과 같게"></div>'
        + '<div class="col-5"><label class="form-label required">등급</label><select class="form-select" name="grade">' + gradeOptions('user') + '</select></div>'
        + '</div><div class="d-flex justify-content-end mt-3"><button type="submit" class="btn btn-primary"><i class="ti ti-user-check me-1"></i>등록</button></div></form>' : '<div class="text-secondary small">먼저 장비를 추가하세요.</div>')
      + '</div><div class="col-lg-7"><h3 class="card-title mb-2"><i class="ti ti-users me-1 text-primary"></i>장비별 등록 사용자</h3>';
    var anyUsers = activeEq.some(function (e) { return (e.users || []).length; });
    if (!anyUsers) body += '<div class="text-secondary small">아직 등록된 사용자가 없습니다. 구성원이 예약하려면 위에서 유저 등급으로 등록해 주세요.</div>';
    else {
      body += '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>장비</th><th>이름</th><th>등급</th><th>처리자</th><th class="w-1"></th></tr></thead><tbody>'
        + activeEq.map(function (e) {
          return (e.users || []).map(function (u) {
            return '<tr data-user="' + esc(u.id) + '" data-eq="' + esc(e.id) + '"><td class="text-nowrap">' + eqBadge(e) + esc(e.name) + '</td><td class="fw-medium">' + esc(u.name) + '</td>'
              + '<td><select class="form-select form-select-sm" data-role="admin-grade" style="min-width:9rem">' + gradeOptions(u.grade) + '</select></td><td class="text-secondary small">' + esc(u.grantedBy || '-') + ' · ' + esc(fmtDate(u.grantedAt)) + '</td>'
              + '<td class="text-end"><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="admin-revoke-user" data-user="' + esc(u.id) + '" data-eq="' + esc(e.id) + '" title="등록 해제"><i class="ti ti-user-off"></i></button></td></tr>';
          }).join('');
        }).join('') + '</tbody></table></div>';
    }
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
    if (form.id === 'res-form') {
      e.preventDefault();
      var v = readForm(form);
      var start = new Date(v.start), end = new Date(v.end);
      if (isNaN(start) || isNaN(end)) { toast('시작·종료 날짜와 시각을 입력하세요.', true); return; }
      if (end <= start) { toast('종료 시각이 시작보다 늦어야 합니다.', true); return; }
      var elapsed = Date.now() - LOAD_AT;
      if (elapsed < SEC.macroThresholdMs && store.securityEvent) {
        store.securityEvent({ type: 'macro_suspect', severity: 'high', name: me() ? me().name : '', detail: '페이지가 뜬 뒤 ' + elapsed + 'ms 만에 예약 제출' });
      }
      store.createReservation({ equipmentId: v.equipmentId, start: start.toISOString(), end: end.toISOString(), purpose: v.purpose })
        .then(function () { toast('예약했습니다.'); return refresh(); }).catch(handleError);
    }
    if (form.id === 'mgr-form') {
      e.preventDefault();
      var m = readForm(form);
      store.verifyManager(m.equipmentId, m.pin).then(function (ok) {
        if (!ok) { toast('담당자 PIN이 올바르지 않습니다.', true); return; }
        setManager({ equipmentId: m.equipmentId, pin: m.pin });
        toast('담당자 모드를 열었습니다.');
        return refresh();
      }).catch(handleError);
    }
    if (form.id === 'grant-form') {
      e.preventDefault();
      var g = readForm(form);
      if (!state.manager) { toast('담당자 확인이 필요합니다.', true); return; }
      store.grantUser(state.manager.equipmentId, state.manager.pin, g.name, g.grade)
        .then(function (u) { toast((u ? u.name : g.name) + ' 님을 ' + gradeLabel(u ? u.grade : g.grade) + ' 등급으로 등록했습니다.'); touchManager(); return refresh(); }).catch(handleError);
    }
    if (form.id === 'admin-grant-form') {
      /* 관리자 경로: 담당자 PIN 없이 등록 (관리자 PIN 확인된 상태) */
      e.preventDefault();
      var ag = readForm(form);
      if (!isAdminActive()) { toast('관리자 확인이 필요합니다.', true); return; }
      if (!ag.equipmentId) { toast('장비를 고르세요.', true); return; }
      store.grantUser(ag.equipmentId, null, ag.name, ag.grade)
        .then(function (u) { toast((u ? u.name : ag.name) + ' 님을 ' + gradeLabel(u ? u.grade : ag.grade) + ' 등급으로 등록했습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
    }
    if (form.id === 'eq-form') {
      e.preventDefault();
      var q = readForm(form);
      var id = form.getAttribute('data-id') || null;
      if (!q.name.trim()) { toast('장비명을 입력하세요.', true); return; }
      if (q.managerPin && !/^\d{4,8}$/.test(q.managerPin)) { toast('담당자 PIN은 숫자 4~8자리로 정하세요.', true); return; }
      var rec = { name: q.name.trim(), location: q.location.trim(), managerName: q.managerName.trim(), description: q.description.trim(), rules: q.rules.trim(), color: q.color, active: !!q.active };
      if (id) rec.id = id;
      store.saveEquipment(rec, { managerPin: q.managerPin || null })
        .then(function () { toast(id ? '장비를 수정했습니다.' : '장비를 추가했습니다.'); state.editingEqId = null; setUnlock(true); return refresh(); }).catch(handleError);
    }
  });

  var LOAD_AT = Date.now();
  var SEC = Object.assign({ macroThresholdMs: 1200 }, CFG.security || {});

  document.addEventListener('change', function (e) {
    var el = e.target;
    if (el.getAttribute('data-role') === 'dt-start' || el.getAttribute('data-role') === 'dt-end') {
      var f = el.closest('form'); if (f) syncEnd(f);
      return;
    }
    if (el.getAttribute('data-role') === 'grade' && state.manager) {
      var row = el.closest('tr[data-user]');
      store.setUserGrade(state.manager.equipmentId, state.manager.pin, row.getAttribute('data-user'), el.value)
        .then(function (u) { toast(u.name + ' 님을 ' + gradeLabel(u.grade) + ' 등급으로 바꿨습니다.'); touchManager(); return refresh(); }).catch(handleError);
    }
    if (el.getAttribute('data-role') === 'admin-grade' && isAdminActive()) {
      var arow = el.closest('tr[data-user]');
      store.setUserGrade(arow.getAttribute('data-eq'), null, arow.getAttribute('data-user'), el.value)
        .then(function (u) { toast(u.name + ' 님을 ' + gradeLabel(u.grade) + ' 등급으로 바꿨습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    var resId = btn.getAttribute('data-res');

    switch (action) {
      case 'reschedule': U.closeAll(); rescheduleDialog(resId).catch(handleError); break;
      case 'tab': {
        e.preventDefault();
        var t = btn.getAttribute('data-tab');
        if (t === 'admin' && !isAdminActive()) { enterAdmin(); return; }
        state.tab = t; render();
        break;
      }
      case 'unlock-admin': enterAdmin(); break;
      case 'lock-admin': setUnlock(false); state.tab = 'calendar'; toast('관리자 화면을 잠갔습니다.'); render(); break;
      case 'lock-manager': setManager(null); toast('담당자 모드를 잠갔습니다.'); render(); break;
      case 'signout':
        setUnlock(false); setManager(null);
        store.signOut().then(function () { window.location.replace('../index.html'); }); break;
      case 'refresh': refresh().then(function () { toast('새로고침 완료'); }); break;
      case 'filter-eq': state.filterEq = btn.getAttribute('data-eq'); render(); break;
      case 'write-log': U.closeAll(); writeLog(resId).catch(handleError); break;
      case 'view-log': U.closeAll(); viewLog(btn.getAttribute('data-log')).catch(handleError); break;
      case 'cancel-res': {
        U.closeAll();
        var r = resById(resId); if (!r) return;
        var viaManager = !isMineRes(r) || new Date(r.start) <= new Date();
        confirmDlg({ title: '예약 취소', message: esc(fmtRange(r)) + ' 예약을 취소할까요?' + (viaManager ? ' (담당자 권한으로 취소)' : ''), okLabel: '취소하기', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.cancelReservation(resId, { managerPin: viaManager && managerOf(r.equipmentId) ? state.manager.pin : null })
            .then(function () { toast('예약을 취소했습니다.'); touchManager(); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'waive-log': {
        U.closeAll();
        var r2 = resById(resId); if (!r2 || !managerOf(r2.equipmentId)) { toast('담당자 확인이 필요합니다.', true); return; }
        promptDlg({ title: '로그 면제', message: r2.userName + '님의 ' + fmtRange(r2) + ' 사용을 로그 작성 없이 완료 처리합니다. 사유를 적어 주세요.', input: 'textarea', placeholder: '예: 담당자가 직접 확인', okLabel: '면제 처리' }).then(function (note) {
          if (note === null) return;
          return store.waiveUsageLog(resId, state.manager.pin, note).then(function () { toast('면제 처리했습니다.'); touchManager(); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'admin-revoke-user': {
        if (!isAdminActive()) return;
        var auid = btn.getAttribute('data-user'), aeq = btn.getAttribute('data-eq');
        confirmDlg({ title: '등록 해제', message: '이 사용자의 등록을 해제할까요? 기존 예약은 유지됩니다.', okLabel: '해제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.revokeUser(aeq, null, auid).then(function () { toast('등록을 해제했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'revoke-user': {
        if (!state.manager) return;
        var uid = btn.getAttribute('data-user');
        confirmDlg({ title: '등록 해제', message: '이 사용자의 등록을 해제할까요? 기존 예약은 유지됩니다.', okLabel: '해제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.revokeUser(state.manager.equipmentId, state.manager.pin, uid).then(function () { toast('등록을 해제했습니다.'); touchManager(); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'edit-eq': state.editingEqId = btn.getAttribute('data-eq'); render(); break;
      case 'cancel-edit-eq': state.editingEqId = null; render(); break;
      case 'delete-eq': {
        var eid = btn.getAttribute('data-eq');
        confirmDlg({ title: '장비 삭제', message: '이 장비를 삭제할까요? 예약 기록이 있으면 삭제되지 않습니다.', okLabel: '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.deleteEquipment(eid).then(function () { toast('장비를 삭제했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
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
    window.location.replace('../index.html?next=equipment');
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
