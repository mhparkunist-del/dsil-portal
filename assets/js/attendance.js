/* =====================================================================
   DSIL Lab Portal – 출석 시트 (UI)
   탭: 출석 체크 · 출석 로그 · 휴가·출장 · 관리자(PIN)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var A = Object.assign({ lateAfter: '09:00', closeAfter: '11:00', vacationDaysPerHalf: 2, selfRegister: true, holidays: {} }, CFG.attendance || {});
  var U = window.DSILUI;
  var esc = U.esc, pad2 = U.pad2, localDate = U.localDate, fmtDate = U.fmtDate, fmtTime = U.fmtTime, fmtDateTime = U.fmtDateTime;
  var $ = U.$, toast = U.toast, readForm = U.readForm, dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty, dg = U.dg, stat = U.stat, csvCell = U.csvCell, download = U.download;
  var store = window.DSILStore.create(CFG);
  var ADMIN_KEY = 'dsil-budget-admin-unlock';
  var TABS = ['check', 'log', 'leave', 'admin'];
  var DOW = ['일', '월', '화', '수', '목', '금', '토'];
  var STATUS = {
    present: { label: '정상', cls: 'bg-green-lt', code: '○' },
    late: { label: '지각', cls: 'bg-red-lt', code: '△' },
    excused: { label: '정상 참작', cls: 'bg-yellow-lt', code: '◇' },
    absent: { label: '결근', cls: 'bg-red-lt', code: '×' },
    vacation: { label: '휴가', cls: 'bg-azure-lt', code: '휴' },
    trip: { label: '출장', cls: 'bg-purple-lt', code: '출' },
    holiday: { label: '공휴일', cls: 'bg-secondary-lt', code: '공' },
    weekend: { label: '주말', cls: '', code: '' },
    pending: { label: '미체크', cls: 'bg-secondary-lt', code: '·' },
    future: { label: '', cls: '', code: '' }
  };

  var state = {
    ready: false, error: null, member: null,
    members: [], records: [], leaves: [], holidays: {},
    tab: 'check', logMonth: null, adminMonth: null, adminUnlocked: false, highlightDate: null, clockTimer: null
  };

  /* ---------- helpers ---------- */
  function ymd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function today() { return ymd(new Date()); }
  function nowHM() { var d = new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function isWeekend(ds) { var w = new Date(ds + 'T00:00:00').getDay(); return w === 0 || w === 6; }
  function dow(ds) { return DOW[new Date(ds + 'T00:00:00').getDay()]; }
  function halfKey(ds) { var m = Number(ds.slice(5, 7)); return ds.slice(0, 4) + (m <= 6 ? 'H1' : 'H2'); }
  function halfLabel(k) { return k.slice(0, 4) + '년 ' + (k.slice(4) === 'H1' ? '상반기 (1~6월)' : '하반기 (7~12월)'); }
  function monthLabel(d) { return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월'; }
  function daysInMonth(d) { var out = [], n = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); for (var i = 1; i <= n; i++) out.push(ymd(new Date(d.getFullYear(), d.getMonth(), i))); return out; }
  function eachDate(from, to, fn) { var d = new Date(from + 'T00:00:00'), e = new Date(to + 'T00:00:00'); while (d <= e) { fn(ymd(d)); d.setDate(d.getDate() + 1); } }
  function leaveOn(memberId, ds) { return state.leaves.filter(function (l) { return l.memberId === memberId && l.startDate <= ds && ds <= l.endDate; })[0] || null; }
  function recordOn(memberId, ds) { return state.records.filter(function (r) { return r.memberId === memberId && r.date === ds; })[0] || null; }
  function memberById(id) { return state.members.filter(function (m) { return m.id === id; })[0] || null; }

  /* 특정 구성원의 하루 상태 */
  function dayStatus(memberId, ds) {
    var h = state.holidays[ds];
    if (h) return { key: 'holiday', label: h, record: null, leave: null };
    if (isWeekend(ds)) return { key: 'weekend', label: '주말', record: null, leave: null };
    var lv = leaveOn(memberId, ds);
    if (lv) return { key: lv.type, label: STATUS[lv.type].label, record: null, leave: lv };
    var r = recordOn(memberId, ds);
    if (r) return { key: r.status, label: STATUS[r.status] ? STATUS[r.status].label : r.status, record: r, leave: null };
    var t = today();
    if (ds < t || (ds === t && nowHM() >= A.closeAfter)) return { key: 'absent', label: '결근 (미기입)', record: null, leave: null };
    if (ds === t) return { key: 'pending', label: '미체크', record: null, leave: null };
    return { key: 'future', label: '', record: null, leave: null };
  }
  function badge(st) { var s = STATUS[st.key] || STATUS.future; return s.label || st.label ? '<span class="badge ' + (s.cls || 'bg-secondary-lt') + '">' + esc(st.label || s.label) + '</span>' : ''; }

  function vacationUsed(memberId, hk) {
    var n = 0;
    state.leaves.forEach(function (l) { if (l.memberId !== memberId || l.type !== 'vacation') return; eachDate(l.startDate, l.endDate, function (d) { if (!isWeekend(d) && !state.holidays[d] && halfKey(d) === hk) n++; }); });
    return n;
  }
  function monthSummary(memberId, d) {
    var s = { present: 0, late: 0, excused: 0, absent: 0, vacation: 0, trip: 0 };
    daysInMonth(d).forEach(function (ds) { var st = dayStatus(memberId, ds); if (s[st.key] !== undefined) s[st.key]++; });
    return s;
  }

  /* ---------- 관리자 잠금 ---------- */
  function readUnlock() { try { var t = Number(sessionStorage.getItem(ADMIN_KEY) || 0); var mins = Number(CFG.adminUnlockMinutes) > 0 ? Number(CFG.adminUnlockMinutes) : 10; return t > 0 && (Date.now() - t) < mins * 60000; } catch (e) { return false; } }
  function setUnlock(on) { try { if (on) sessionStorage.setItem(ADMIN_KEY, String(Date.now())); else sessionStorage.removeItem(ADMIN_KEY); } catch (e) { /* ignore */ } state.adminUnlocked = on; }
  function isAdminActive() { return state.adminUnlocked; }
  function enterAdmin() {
    if (readUnlock()) { setUnlock(true); state.tab = 'admin'; render(); return; }
    promptDlg({ title: '관리자 확인', message: '관리자 PIN을 입력하세요.', input: 'password', placeholder: 'PIN', okLabel: '열기' }).then(function (pin) {
      if (pin === null) return;
      return store.verifyAdminPin(pin).then(function (ok) {
        if (!ok) { toast('PIN이 올바르지 않습니다.', true); return; }
        setUnlock(true); state.tab = 'admin'; toast('관리자 화면을 열었습니다.'); render();
      });
    }).catch(handleError);
  }

  /* ---------- data ---------- */
  function reload() {
    state.member = store.attSession();
    state.adminUnlocked = readUnlock();
    return Promise.all([store.attListMembers(), store.attListRecords(), store.attListLeaves(), store.attListHolidays()]).then(function (res) {
      state.members = res[0]; state.records = res[1]; state.leaves = res[2]; state.holidays = res[3] || {};
      if (state.tab === 'admin' && !isAdminActive()) state.tab = 'check';
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
    if (!state.member) { app.innerHTML = renderLogin(); return; }

    var m = state.member;
    var t = today();
    var todaySt = dayStatus(m.memberId, t);
    var ms = monthSummary(m.memberId, new Date());
    var hk = halfKey(t);
    var used = vacationUsed(m.memberId, hk);

    var html = '<div class="row row-deck row-cards mb-3">'
      + stat('오늘', todaySt.record ? fmtTime(todaySt.record.checkInAt) : (todaySt.label || '-'), todaySt.record ? STATUS[todaySt.record.status].label + ' 출근' : fmtDate(new Date().toISOString()) + ' ' + dow(t) + '요일', todaySt.record ? (todaySt.record.status === 'present' ? 'text-green' : 'text-yellow') : (todaySt.key === 'absent' ? 'text-red' : ''))
      + stat('이번 달 정상', (ms.present + ms.excused) + '일', '참작 ' + ms.excused + '일 포함', 'text-green')
      + stat('이번 달 지각 · 결근', ms.late + ' · ' + ms.absent, '휴가 ' + ms.vacation + ' · 출장 ' + ms.trip, (ms.late + ms.absent) ? 'text-red' : '')
      + stat('휴가 잔여', (A.vacationDaysPerHalf - used) + '일', halfLabel(hk) + ' · 사용 ' + used + '/' + A.vacationDaysPerHalf, '')
      + '</div>';

    var tab = state.tab === 'log' ? renderLogTab() : state.tab === 'leave' ? renderLeaveTab() : state.tab === 'admin' ? renderAdminTab() : renderCheckTab(todaySt);
    html += '<div class="card mb-3"><div class="card-header"><ul class="nav nav-tabs card-header-tabs" role="tablist">'
      + tabLink('check', 'clock-check', '출석 체크') + tabLink('log', 'list-check', '출석 로그') + tabLink('leave', 'plane-departure', '휴가·출장')
      + tabLink('admin', state.adminUnlocked ? 'lock-open' : 'lock', '관리자') + '</ul></div>' + tab.body + '</div>' + (tab.after || '');
    app.innerHTML = html;
    try { history.replaceState(null, '', '#' + state.tab); } catch (e) { /* ignore */ }

    if (state.tab === 'check') startClock(); else stopClock();
    if (state.highlightDate && state.tab === 'log') {
      var row = $('tr[data-date="' + state.highlightDate + '"]');
      if (row) { row.classList.add('table-active'); try { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { /* ignore */ } }
    }
  }

  function tabLink(id, icon, label) {
    return '<li class="nav-item"><a href="#' + id + '" class="nav-link' + (state.tab === id ? ' active' : '') + '" data-action="tab" data-tab="' + id + '" role="tab"><i class="ti ti-' + icon + ' me-1"></i>' + esc(label) + '</a></li>';
  }

  function renderUserChip() {
    var slot = $('#user-slot');
    if (!slot) return;
    if (!state.member) { slot.innerHTML = ''; return; }
    slot.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="avatar avatar-sm bg-green-lt">' + esc(state.member.name.trim().charAt(0)) + '</span>'
      + '<div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(state.member.name) + '</div><div class="small text-secondary mt-1">' + (isAdminActive() ? '관리자 · 열림' : '출석 로그인') + '</div></div>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="change-pin" title="PIN 변경"><i class="ti ti-key"></i></button>'
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="signout"><i class="ti ti-logout"></i><span class="d-none d-sm-inline ms-1">로그아웃</span></button></div>';
  }

  function renderLogin() {
    var portal = store.getSession();
    return '<div class="container-tight py-4"><div class="card card-md"><div class="card-body">'
      + '<h2 class="h2 text-center mb-2">출석 로그인</h2>'
      + '<p class="text-secondary text-center mb-4">아이디(이름)와 PIN을 입력하면 바로 출석 체크를 할 수 있습니다.' + (A.selfRegister ? ' 처음 쓰는 이름은 입력한 PIN으로 등록됩니다.' : '') + '</p>'
      + '<form id="att-login"><div class="mb-3"><label class="form-label required">아이디 (이름)</label><input type="text" class="form-control" name="name" required value="' + esc(portal ? portal.user.name : '') + '" placeholder="홍길동" autocomplete="username"></div>'
      + '<div class="mb-3"><label class="form-label required">PIN</label><input type="password" class="form-control" name="pin" required inputmode="numeric" autocomplete="current-password" placeholder="숫자 4~8자리"></div>'
      + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100"><i class="ti ti-login me-1"></i>로그인</button></div></form>'
      + '</div></div></div>';
  }

  /* ---------- 출석 체크 탭 ---------- */
  function renderCheckTab(st) {
    var t = today();
    var hm = nowHM();
    var body = '<div class="card-body"><div class="row g-4 align-items-stretch">'
      + '<div class="col-lg-7"><div class="text-center py-3">'
      + '<div class="text-secondary">' + esc(fmtDate(new Date().toISOString())) + ' ' + dow(t) + '요일</div>'
      + '<div class="display-5 fw-bold tnum my-1" id="att-clock">' + hm + '</div>';
    if (st.key === 'holiday') body += '<div class="badge bg-secondary-lt fs-4 py-2 px-3 mt-2">공휴일 · ' + esc(st.label) + '</div><div class="text-secondary mt-3">오늘은 출석 체크가 없습니다.</div>';
    else if (st.key === 'weekend') body += '<div class="badge bg-secondary-lt fs-4 py-2 px-3 mt-2">주말</div><div class="text-secondary mt-3">주말에는 출석 체크가 없습니다.</div>';
    else if (st.leave) body += '<div class="badge ' + STATUS[st.key].cls + ' fs-4 py-2 px-3 mt-2">' + esc(STATUS[st.key].label) + '</div><div class="text-secondary mt-3">오늘은 ' + esc(STATUS[st.key].label) + '(' + esc(st.leave.startDate) + ' ~ ' + esc(st.leave.endDate) + ')으로 등록되어 있어 출석 체크를 하지 않습니다.</div>';
    else if (st.record) body += '<div class="badge ' + STATUS[st.record.status].cls + ' fs-4 py-2 px-3 mt-2"><i class="ti ti-check me-1"></i>' + esc(STATUS[st.record.status].label) + ' 출근 ' + fmtTime(st.record.checkInAt) + '</div>' + (st.record.reason ? '<div class="text-secondary mt-2">사유: ' + esc(st.record.reason) + '</div>' : '') + '<div class="mt-3"><a href="#log" class="btn" data-action="tab" data-tab="log"><i class="ti ti-list-check me-1"></i>출석 로그 보기</a></div>';
    else if (st.key === 'absent') body += '<div class="badge bg-red-lt fs-4 py-2 px-3 mt-2">출석 체크 마감</div><div class="text-secondary mt-3">' + A.closeAfter + ' 이후에는 출석 체크를 할 수 없습니다. 오늘은 미기입(결근)으로 기록됩니다.</div>';
    else {
      var late = hm >= A.lateAfter;
      body += '<div class="mt-3"><button type="button" class="btn btn-primary btn-lg px-5 py-3" data-action="check-in"><i class="ti ti-clock-check me-2"></i>출석 체크</button></div>'
        + (late ? '<div class="text-yellow mt-3"><i class="ti ti-alert-triangle me-1"></i>' + A.lateAfter + ' 이 지나 지각입니다. 사유를 적으면 정상 참작으로 기록됩니다. (' + A.closeAfter + ' 마감)</div>'
          : '<div class="text-secondary mt-3">' + A.lateAfter + ' 전까지 정상 출근, ' + A.closeAfter + ' 이후 마감입니다.</div>');
    }
    body += '</div></div>'
      + '<div class="col-lg-5"><h3 class="card-title mb-2"><i class="ti ti-plane-departure me-1 text-primary"></i>휴가 · 출장 신청</h3>'
      + '<p class="text-secondary small">미리 등록한 날은 출석 체크 없이 시트에 반영됩니다. 휴가는 상·하반기 각 ' + A.vacationDaysPerHalf + '일, 출장은 사유를 적습니다.</p>'
      + '<div class="d-flex flex-wrap gap-2"><button type="button" class="btn" data-action="request-leave" data-type="vacation"><i class="ti ti-beach me-1"></i>휴가 신청</button>'
      + '<button type="button" class="btn" data-action="request-leave" data-type="trip"><i class="ti ti-briefcase me-1"></i>출장 신청</button></div>'
      + '<div class="mt-4"><h3 class="card-title mb-2"><i class="ti ti-info-circle me-1 text-primary"></i>규칙</h3><ul class="text-secondary small mb-0 ps-3">'
      + '<li>' + A.lateAfter + ' 전 체크 → 정상</li><li>' + A.lateAfter + ' ~ ' + A.closeAfter + ' 체크 → 지각 (사유 입력 시 정상 참작)</li><li>' + A.closeAfter + ' 이후 → 체크 불가, 미기입(결근)</li><li>주말·공휴일·휴가·출장일은 체크하지 않음</li></ul></div>'
      + '</div></div></div>';
    return { body: body };
  }

  function startClock() {
    stopClock();
    state.clockTimer = setInterval(function () { var el = $('#att-clock'); if (!el) { stopClock(); return; } var d = new Date(); el.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds()); }, 1000);
  }
  function stopClock() { if (state.clockTimer) { clearInterval(state.clockTimer); state.clockTimer = null; } }

  function doCheckIn() {
    var hm = nowHM();
    if (hm < A.lateAfter) {
      return store.attCheckIn('').then(function (rec) { afterCheckIn(rec); });
    }
    return dialog({ title: '지각 사유', message: A.lateAfter + '이 지났습니다. 사유를 적으면 정상 참작으로, 비워 두면 지각으로 기록됩니다.', bodyHtml: '<textarea class="form-control" name="reason" rows="3" placeholder="예: 병원 진료, 학과 행사"></textarea>', okLabel: '출석 체크' })
      .then(function (v) { if (!v) return; return store.attCheckIn(v.reason).then(function (rec) { afterCheckIn(rec); }); });
  }
  function afterCheckIn(rec) {
    toast(STATUS[rec.status].label + ' 출근 ' + fmtTime(rec.checkInAt) + ' 기록했습니다.');
    state.tab = 'log'; state.logMonth = new Date(); state.highlightDate = rec.date;
    return refresh();
  }

  function requestLeave(type) {
    var isTrip = type === 'trip';
    var t = today();
    var body = '<div class="row g-3">'
      + '<div class="col-6"><label class="form-label required">시작일</label><input type="date" class="form-control" name="startDate" required value="' + t + '" min="' + t + '"></div>'
      + '<div class="col-6"><label class="form-label required">종료일</label><input type="date" class="form-control" name="endDate" required value="' + t + '" min="' + t + '"></div>'
      + '<div class="col-12"><label class="form-label' + (isTrip ? ' required' : '') + '">' + (isTrip ? '출장 사유' : '메모') + '</label><textarea class="form-control" name="reason" rows="2"' + (isTrip ? ' required' : '') + ' placeholder="' + (isTrip ? '예: 삼성전자 협력 미팅 (화성)' : '선택') + '"></textarea></div>'
      + '<div class="col-12 text-secondary small">주말·공휴일은 일수에서 제외됩니다.' + (isTrip ? '' : ' 이번 반기 잔여 ' + (A.vacationDaysPerHalf - vacationUsed(state.member.memberId, halfKey(t))) + '일.') + '</div></div>';
    return dialog({ title: isTrip ? '출장 신청' : '휴가 신청', bodyHtml: body, size: 'lg', okLabel: '신청' }).then(function (v) {
      if (!v) return;
      return store.attRequestLeave({ type: type, startDate: v.startDate, endDate: v.endDate, reason: v.reason }).then(function (l) {
        toast((isTrip ? '출장' : '휴가') + ' ' + l.days + '일을 등록했습니다.');
        state.tab = 'leave';
        return refresh();
      });
    });
  }

  /* ---------- 출석 로그 탭 ---------- */
  function renderLogTab() {
    var d = state.logMonth || new Date();
    var m = state.member;
    var s = monthSummary(m.memberId, d);
    var body = '<div class="card-body py-2 border-bottom d-flex align-items-center flex-wrap gap-2">'
      + '<div class="btn-group"><button type="button" class="btn btn-sm btn-icon" data-action="log-month" data-dir="-1"><i class="ti ti-chevron-left"></i></button><button type="button" class="btn btn-sm" data-action="log-month" data-dir="0">' + monthLabel(d) + '</button><button type="button" class="btn btn-sm btn-icon" data-action="log-month" data-dir="1"><i class="ti ti-chevron-right"></i></button></div>'
      + '<div class="ms-auto d-flex flex-wrap gap-2 small"><span class="badge bg-green-lt">정상 ' + s.present + '</span><span class="badge bg-yellow-lt">참작 ' + s.excused + '</span><span class="badge bg-red-lt">지각 ' + s.late + '</span><span class="badge bg-red-lt">결근 ' + s.absent + '</span><span class="badge bg-azure-lt">휴가 ' + s.vacation + '</span><span class="badge bg-purple-lt">출장 ' + s.trip + '</span></div></div>';
    body += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th class="w-1">날짜</th><th class="w-1">요일</th><th>상태</th><th class="w-1">출근 시각</th><th>사유 · 비고</th></tr></thead><tbody>';
    daysInMonth(d).forEach(function (ds) {
      var st = dayStatus(m.memberId, ds);
      var muted = st.key === 'weekend' || st.key === 'holiday' || st.key === 'future';
      body += '<tr data-date="' + ds + '"' + (muted ? ' class="text-secondary"' : '') + (ds === today() ? ' style="background:rgba(0,65,145,.04)"' : '') + '>'
        + '<td class="text-nowrap">' + ds.slice(5).replace('-', '.') + '</td><td>' + dow(ds) + '</td>'
        + '<td>' + badge(st) + '</td>'
        + '<td class="text-nowrap tnum">' + (st.record ? fmtTime(st.record.checkInAt) : '') + '</td>'
        + '<td class="small">' + esc(st.record ? st.record.reason : (st.leave ? (st.leave.reason || '') : (st.key === 'holiday' ? st.label : ''))) + (st.record && st.record.editedBy ? ' <span class="text-secondary">(관리자 수정)</span>' : '') + '</td></tr>';
    });
    body += '</tbody></table></div>';
    return { body: body };
  }

  /* ---------- 휴가·출장 탭 ---------- */
  function renderLeaveTab() {
    var m = state.member;
    var t = today();
    var y = t.slice(0, 4);
    var mine = state.leaves.filter(function (l) { return l.memberId === m.memberId; }).sort(function (a, b) { return b.startDate.localeCompare(a.startDate); });
    var body = '<div class="card-body"><div class="row g-4"><div class="col-lg-4">'
      + '<h3 class="card-title mb-2"><i class="ti ti-beach me-1 text-primary"></i>휴가 잔여</h3>'
      + ['H1', 'H2'].map(function (h) { var k = y + h; var u = vacationUsed(m.memberId, k); var r = A.vacationDaysPerHalf - u; return '<div class="d-flex justify-content-between align-items-center border-bottom py-2"><span>' + esc(halfLabel(k)) + '</span><span class="tnum"><strong class="' + (r <= 0 ? 'text-red' : '') + '">' + r + '일</strong> <span class="text-secondary">/ ' + A.vacationDaysPerHalf + '일</span></span></div>'; }).join('')
      + '<div class="d-flex gap-2 mt-3"><button type="button" class="btn btn-primary" data-action="request-leave" data-type="vacation"><i class="ti ti-beach me-1"></i>휴가 신청</button><button type="button" class="btn" data-action="request-leave" data-type="trip"><i class="ti ti-briefcase me-1"></i>출장 신청</button></div>'
      + '</div><div class="col-lg-8"><h3 class="card-title mb-2"><i class="ti ti-list me-1 text-primary"></i>내 휴가·출장</h3>';
    if (!mine.length) body += '<div class="text-secondary small">등록된 휴가·출장이 없습니다.</div>';
    else {
      body += '<div class="table-responsive"><table class="table table-sm table-vcenter"><thead><tr><th>종류</th><th>기간</th><th class="text-end">일수</th><th>사유</th><th class="w-1"></th></tr></thead><tbody>'
        + mine.map(function (l) {
          return '<tr><td><span class="badge ' + STATUS[l.type].cls + '">' + STATUS[l.type].label + '</span></td><td class="text-nowrap">' + esc(l.startDate) + (l.endDate !== l.startDate ? ' ~ ' + esc(l.endDate) : '') + '</td><td class="text-end tnum">' + l.days + '</td><td class="small">' + esc(l.reason || '') + '</td>'
            + '<td class="text-end">' + (l.startDate >= t ? '<button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-leave" data-leave="' + esc(l.id) + '" title="취소"><i class="ti ti-x"></i></button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    body += '</div></div></div>';
    return { body: body };
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab() {
    if (!isAdminActive()) {
      return { body: '<div class="card-body">' + empty('lock', '관리자 화면이 잠겨 있습니다', '관리자 PIN을 입력하면 열립니다.') + '<div class="text-center"><button type="button" class="btn btn-primary" data-action="unlock-admin"><i class="ti ti-key me-1"></i>PIN 입력</button></div></div>' };
    }
    var d = state.adminMonth || new Date();
    var days = daysInMonth(d);
    var body = '<div class="card-body py-2 border-bottom d-flex align-items-center flex-wrap gap-2">'
      + '<div class="btn-group"><button type="button" class="btn btn-sm btn-icon" data-action="admin-month" data-dir="-1"><i class="ti ti-chevron-left"></i></button><button type="button" class="btn btn-sm" data-action="admin-month" data-dir="0">' + monthLabel(d) + '</button><button type="button" class="btn btn-sm btn-icon" data-action="admin-month" data-dir="1"><i class="ti ti-chevron-right"></i></button></div>'
      + '<div class="small text-secondary">○ 정상 · ◇ 참작 · △ 지각 · × 결근 · 휴 휴가 · 출 출장 · 공 공휴일. 칸을 누르면 수정합니다.</div>'
      + '<div class="ms-auto d-flex gap-2"><button type="button" class="btn btn-sm" data-action="export-sheet"><i class="ti ti-file-spreadsheet me-1"></i>CSV</button><button type="button" class="btn btn-sm btn-ghost-secondary" data-action="lock-admin"><i class="ti ti-lock me-1"></i>잠금</button></div></div>';
    var members = state.members.filter(function (m) { return m.active !== false; });
    if (!members.length) body += '<div class="card-body">' + empty('users', '구성원이 없습니다', '아래에서 추가하세요.') + '</div>';
    else {
      body += '<div class="table-responsive"><table class="table table-sm table-vcenter card-table att-sheet"><thead><tr><th class="text-nowrap">구성원</th>'
        + days.map(function (ds) { var w = isWeekend(ds) || state.holidays[ds]; return '<th class="text-center px-1' + (w ? ' text-secondary' : '') + '" title="' + esc(ds + ' ' + dow(ds) + (state.holidays[ds] ? ' ' + state.holidays[ds] : '')) + '">' + Number(ds.slice(8)) + '<div class="small fw-normal">' + dow(ds) + '</div></th>'; }).join('')
        + '<th class="text-end text-nowrap">정상/참작</th><th class="text-end text-nowrap">지각/결근</th><th class="text-end text-nowrap">휴가/출장</th></tr></thead><tbody>';
      members.forEach(function (m) {
        var s = monthSummary(m.id, d);
        body += '<tr><td class="text-nowrap fw-medium">' + esc(m.name) + '</td>'
          + days.map(function (ds) {
            var st = dayStatus(m.id, ds);
            var S = STATUS[st.key] || STATUS.future;
            var editable = st.key !== 'weekend' && st.key !== 'holiday' && st.key !== 'future' && !st.leave;
            var cls = st.key === 'late' || st.key === 'absent' ? 'text-red' : st.key === 'excused' ? 'text-yellow' : st.key === 'present' ? 'text-green' : 'text-secondary';
            return '<td class="text-center px-1 ' + cls + '"' + (editable ? ' role="button" data-action="edit-day" data-member="' + esc(m.id) + '" data-date="' + ds + '" title="' + esc(st.label + (st.record && st.record.checkInAt ? ' ' + fmtTime(st.record.checkInAt) : '') + (st.record && st.record.reason ? ' · ' + st.record.reason : '')) + '"' : (st.leave ? ' title="' + esc(st.leave.reason || S.label) + '"' : '')) + '>' + (S.code || '') + '</td>';
          }).join('')
          + '<td class="text-end tnum">' + s.present + '/' + s.excused + '</td><td class="text-end tnum' + ((s.late + s.absent) ? ' text-red' : '') + '">' + s.late + '/' + s.absent + '</td><td class="text-end tnum">' + s.vacation + '/' + s.trip + '</td></tr>';
      });
      body += '</tbody></table></div>';
    }

    var after = '<div class="row row-cards mb-3">'
      + '<div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-users me-1 text-primary"></i>구성원 <span class="text-secondary fw-normal">' + state.members.length + '명</span></h3><div class="card-actions"><button type="button" class="btn btn-sm btn-primary" data-action="add-member"><i class="ti ti-user-plus me-1"></i>추가</button></div></div>';
    if (!state.members.length) after += '<div class="card-body">' + empty('users', '구성원이 없습니다', '') + '</div>';
    else {
      after += '<div class="table-responsive"><table class="table table-sm table-vcenter card-table"><thead><tr><th>이름</th><th>상태</th><th class="w-1"></th></tr></thead><tbody>'
        + state.members.map(function (m) {
          return '<tr><td class="fw-medium">' + esc(m.name) + '</td><td>' + (m.active !== false ? '<span class="badge bg-green-lt">사용</span>' : '<span class="badge bg-secondary-lt">중지</span>') + '</td>'
            + '<td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reset-member-pin" data-member="' + esc(m.id) + '" title="PIN 재설정"><i class="ti ti-key"></i></button>'
            + '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="toggle-member" data-member="' + esc(m.id) + '" title="' + (m.active !== false ? '사용 중지' : '사용 재개') + '"><i class="ti ti-' + (m.active !== false ? 'user-off' : 'user-check') + '"></i></button>'
            + '<button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-member" data-member="' + esc(m.id) + '" title="삭제"><i class="ti ti-trash"></i></button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    after += '</div></div>';

    var hol = Object.keys(state.holidays).sort();
    after += '<div class="col-lg-6"><div class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-calendar-off me-1 text-primary"></i>공휴일 <span class="text-secondary fw-normal">' + hol.length + '일</span></h3></div>'
      + '<div class="card-body border-bottom"><form id="holiday-form" class="row g-2 align-items-end"><div class="col-5"><label class="form-label">날짜</label><input type="date" class="form-control form-control-sm" name="date" required></div><div class="col-5"><label class="form-label">이름</label><input type="text" class="form-control form-control-sm" name="label" required placeholder="예: 대체공휴일"></div><div class="col-2"><button type="submit" class="btn btn-sm btn-primary w-100">추가</button></div></form></div>'
      + '<div class="table-responsive" style="max-height:320px;overflow:auto"><table class="table table-sm table-vcenter card-table"><tbody>'
      + hol.map(function (ds) { return '<tr><td class="text-nowrap">' + esc(ds) + ' <span class="text-secondary">' + dow(ds) + '</span></td><td>' + esc(state.holidays[ds]) + '</td><td class="text-end"><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-holiday" data-date="' + ds + '"><i class="ti ti-x"></i></button></td></tr>'; }).join('')
      + '</tbody></table></div></div></div></div>';

    var leaves = state.leaves.slice().sort(function (a, b) { return b.startDate.localeCompare(a.startDate); });
    after += '<div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-plane-departure me-1 text-primary"></i>휴가·출장 전체 <span class="text-secondary fw-normal">' + leaves.length + '건</span></h3></div>';
    if (!leaves.length) after += '<div class="card-body">' + empty('plane-off', '등록된 휴가·출장이 없습니다', '') + '</div>';
    else {
      after += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>구성원</th><th>종류</th><th>기간</th><th class="text-end">일수</th><th>사유</th><th class="w-1"></th></tr></thead><tbody>'
        + leaves.map(function (l) {
          return '<tr><td>' + esc(l.name) + '</td><td><span class="badge ' + STATUS[l.type].cls + '">' + STATUS[l.type].label + '</span></td><td class="text-nowrap">' + esc(l.startDate) + (l.endDate !== l.startDate ? ' ~ ' + esc(l.endDate) : '') + '</td><td class="text-end tnum">' + l.days + '</td><td class="small">' + esc(l.reason || '') + '</td>'
            + '<td class="text-end"><button type="button" class="btn btn-sm btn-ghost-danger btn-icon" data-action="delete-leave" data-leave="' + esc(l.id) + '" data-admin="1" title="삭제"><i class="ti ti-trash"></i></button></td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    after += '</div>';
    return { body: body, after: after };
  }

  function exportSheet() {
    var d = state.adminMonth || new Date();
    var days = daysInMonth(d);
    var head = ['구성원'].concat(days.map(function (ds) { return ds.slice(5).replace('-', '/') + '(' + dow(ds) + ')'; })).concat(['정상', '참작', '지각', '결근', '휴가', '출장']);
    var lines = state.members.filter(function (m) { return m.active !== false; }).map(function (m) {
      var s = monthSummary(m.id, d);
      return [m.name].concat(days.map(function (ds) { var st = dayStatus(m.id, ds); var S = STATUS[st.key] || STATUS.future; return S.code + (st.record && st.record.checkInAt ? ' ' + fmtTime(st.record.checkInAt) : ''); })).concat([s.present, s.excused, s.late, s.absent, s.vacation, s.trip]).map(csvCell).join(',');
    });
    download('dsil-attendance-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '.csv', '﻿' + head.map(csvCell).join(',') + '\r\n' + lines.join('\r\n'), 'text/csv;charset=utf-8');
  }

  function editDay(memberId, ds) {
    var m = memberById(memberId); if (!m) return Promise.resolve();
    var st = dayStatus(memberId, ds);
    var cur = st.record ? st.record.status : (st.key === 'absent' ? 'absent' : '');
    var body = '<div class="mb-3"><label class="form-label">상태</label><select class="form-select" name="status">'
      + ['present', 'excused', 'late', 'absent'].map(function (k) { return '<option value="' + k + '"' + (cur === k ? ' selected' : '') + '>' + STATUS[k].label + (k === 'absent' ? ' (기록 삭제)' : '') + '</option>'; }).join('')
      + '</select></div><div class="mb-0"><label class="form-label">사유 · 비고</label><input type="text" class="form-control" name="reason" value="' + esc(st.record ? st.record.reason : '') + '"></div>';
    return dialog({ title: m.name + ' · ' + ds + ' (' + dow(ds) + ')', bodyHtml: body, okLabel: '저장' }).then(function (v) {
      if (!v) return;
      return store.attAdminSetDay(memberId, ds, v.status, v.reason).then(function () { toast('저장했습니다.'); setUnlock(true); return refresh(); });
    });
  }

  function addMember() {
    var body = '<div class="mb-3"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required></div>'
      + '<div class="mb-0"><label class="form-label required">초기 PIN</label><input type="password" class="form-control" name="pin" required inputmode="numeric" placeholder="숫자 4~8자리"></div>';
    return dialog({ title: '구성원 추가', bodyHtml: body, okLabel: '추가' }).then(function (v) {
      if (!v) return;
      if (!/^\d{4,8}$/.test(v.pin)) { toast('PIN은 숫자 4~8자리입니다.', true); return; }
      return store.attSaveMember({ name: v.name, active: true }, { pin: v.pin }).then(function () { toast('추가했습니다.'); setUnlock(true); return refresh(); });
    });
  }

  /* ---------- actions ---------- */
  function handleError(err) { console.error(err); toast(err && err.message ? err.message : String(err), true); }
  function refresh() { return reload().then(render).catch(handleError); }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id === 'att-login') {
      e.preventDefault();
      var v = readForm(form);
      store.attLogin(v.name, v.pin).then(function (m) { toast(m.name + '님, 로그인했습니다.'); state.tab = 'check'; return refresh(); }).catch(handleError);
    }
    if (form.id === 'holiday-form') {
      e.preventDefault();
      var h = readForm(form);
      var obj = Object.assign({}, state.holidays); obj[h.date] = h.label.trim();
      store.attSaveHolidays(obj).then(function () { toast('공휴일을 추가했습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    switch (action) {
      case 'tab': {
        e.preventDefault();
        var t = btn.getAttribute('data-tab');
        if (t === 'admin' && !isAdminActive()) { enterAdmin(); return; }
        if (t !== 'log') state.highlightDate = null;
        state.tab = t; render(); break;
      }
      case 'unlock-admin': enterAdmin(); break;
      case 'lock-admin': setUnlock(false); state.tab = 'check'; toast('관리자 화면을 잠갔습니다.'); render(); break;
      case 'refresh': refresh().then(function () { toast('새로고침 완료'); }); break;
      case 'signout': setUnlock(false); store.attLogout().then(function () { state.tab = 'check'; return refresh(); }); break;
      case 'check-in': doCheckIn().catch(handleError); break;
      case 'request-leave': requestLeave(btn.getAttribute('data-type')).catch(handleError); break;
      case 'delete-leave': {
        var lid = btn.getAttribute('data-leave');
        confirmDlg({ title: '신청 취소', message: '이 휴가·출장 신청을 취소할까요?', okLabel: '취소하기', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.attDeleteLeave(lid, { admin: !!btn.getAttribute('data-admin') && isAdminActive() }).then(function () { toast('취소했습니다.'); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'log-month': {
        var d = state.logMonth || new Date(); var dir = Number(btn.getAttribute('data-dir'));
        state.logMonth = dir === 0 ? new Date() : new Date(d.getFullYear(), d.getMonth() + dir, 1); state.highlightDate = null; render(); break;
      }
      case 'admin-month': {
        var d2 = state.adminMonth || new Date(); var dir2 = Number(btn.getAttribute('data-dir'));
        state.adminMonth = dir2 === 0 ? new Date() : new Date(d2.getFullYear(), d2.getMonth() + dir2, 1); render(); break;
      }
      case 'export-sheet': exportSheet(); break;
      case 'edit-day': editDay(btn.getAttribute('data-member'), btn.getAttribute('data-date')).catch(handleError); break;
      case 'add-member': addMember().catch(handleError); break;
      case 'reset-member-pin': {
        var mid = btn.getAttribute('data-member'); var mm = memberById(mid); if (!mm) return;
        promptDlg({ title: mm.name + ' PIN 재설정', message: '새 PIN을 입력하세요.', input: 'password', placeholder: '숫자 4~8자리', okLabel: '재설정' }).then(function (pin) {
          if (pin === null) return;
          if (!/^\d{4,8}$/.test(pin)) { toast('PIN은 숫자 4~8자리입니다.', true); return; }
          return store.attSaveMember({ id: mm.id, name: mm.name, active: mm.active }, { pin: pin }).then(function () { toast('PIN을 재설정했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'toggle-member': {
        var mid2 = btn.getAttribute('data-member'); var m2 = memberById(mid2); if (!m2) return;
        store.attSaveMember({ id: m2.id, name: m2.name, active: m2.active === false }, {}).then(function () { toast('변경했습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
        break;
      }
      case 'delete-member': {
        var mid3 = btn.getAttribute('data-member');
        confirmDlg({ title: '구성원 삭제', message: '출석 기록이 없는 구성원만 삭제됩니다. 삭제할까요?', okLabel: '삭제', danger: true }).then(function (ok) {
          if (!ok) return;
          return store.attDeleteMember(mid3).then(function () { toast('삭제했습니다.'); setUnlock(true); return refresh(); });
        }).catch(handleError);
        break;
      }
      case 'delete-holiday': {
        var ds = btn.getAttribute('data-date');
        var obj = Object.assign({}, state.holidays); delete obj[ds];
        store.attSaveHolidays(obj).then(function () { toast('삭제했습니다.'); setUnlock(true); return refresh(); }).catch(handleError);
        break;
      }
      case 'change-pin': {
        var body = '<div class="mb-3"><label class="form-label required">현재 PIN</label><input type="password" class="form-control" name="oldPin" required inputmode="numeric"></div><div class="mb-0"><label class="form-label required">새 PIN</label><input type="password" class="form-control" name="newPin" required inputmode="numeric" placeholder="숫자 4~8자리"></div>';
        dialog({ title: 'PIN 변경', bodyHtml: body, okLabel: '변경' }).then(function (v) {
          if (!v) return;
          return store.attChangePin(v.oldPin, v.newPin).then(function () { toast('PIN을 변경했습니다.'); });
        }).catch(handleError);
        break;
      }
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
