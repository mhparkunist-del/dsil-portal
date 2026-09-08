/* =====================================================================
   DSIL Lab Portal – 로그인 포털 (홈)
   이름 + PIN 로그인 → 2×2 메뉴. 회원가입 신청은 관리자 승인 후 사용.
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var U = window.DSILUI;
  var esc = U.esc, fmtDate = U.fmtDate, fmtDateTime = U.fmtDateTime, $ = U.$, toast = U.toast, readForm = U.readForm, dialog = U.dialog, confirmDlg = U.confirmDlg, promptDlg = U.promptDlg, empty = U.empty;
  var store = window.DSILStore.create(CFG);
  var TOOLS = [
    { id: 'budget', href: 'budget/index.html', icon: 'shopping-cart', color: 'bg-blue-lt', title: '구매 요청' },
    { id: 'equipment', href: 'equipment/index.html', icon: 'calendar-event', color: 'bg-orange-lt', title: '장비 예약' },
    { id: 'meeting', href: 'meeting/index.html', icon: 'users-group', color: 'bg-green-lt', title: '회의비 처리' },
    { id: 'inventory', href: 'inventory/index.html', icon: 'packages', color: 'bg-purple-lt', title: '소모품 재고' }
  ];
  var STATUS = { active: { label: '사용 중', cls: 'bg-green-lt' }, pending: { label: '승인 대기', cls: 'bg-yellow-lt' }, disabled: { label: '중지', cls: 'bg-secondary-lt' }, rejected: { label: '거절', cls: 'bg-red-lt' } };

  var SEC = Object.assign({ maxLoginFailures: 5, lockoutMinutes: 10, macroThresholdMs: 1200 }, CFG.security || {});
  var LOAD_AT = Date.now();
  var FAILS_KEY = 'dsil-login-fails';
  var state = { ready: false, error: null, session: null, accounts: [], events: [], magicLinkSent: false, next: null };

  function nameKey(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function readFails() { try { return JSON.parse(localStorage.getItem(FAILS_KEY) || '{}'); } catch (e) { return {}; } }
  function writeFails(obj) { try { localStorage.setItem(FAILS_KEY, JSON.stringify(obj)); } catch (e) { /* ignore */ } }
  function lockedUntil(name) { var f = readFails()[nameKey(name)]; return f && f.lockedUntil && f.lockedUntil > Date.now() ? f.lockedUntil : 0; }
  function noteFailure(name) {
    var all = readFails(); var k = nameKey(name); var f = all[k] || { count: 0, first: Date.now() };
    if (Date.now() - f.first > SEC.lockoutMinutes * 60000) f = { count: 0, first: Date.now() };
    f.count++;
    if (f.count >= SEC.maxLoginFailures) f.lockedUntil = Date.now() + SEC.lockoutMinutes * 60000;
    all[k] = f; writeFails(all);
    return f;
  }
  function clearFailure(name) { var all = readFails(); delete all[nameKey(name)]; writeFails(all); }
  (function () { try { var n = new URLSearchParams(window.location.search).get('next'); if (n && TOOLS.some(function (t) { return t.id === n; })) state.next = n; } catch (e) { /* ignore */ } })();

  function reload() {
    state.session = store.getSession();
    if (state.session && state.session.isAdmin) {
      return Promise.all([store.listAccounts(), store.listSecurityEvents()]).then(function (res) { state.accounts = res[0]; state.events = res[1]; });
    }
    state.accounts = []; state.events = [];
    return Promise.resolve();
  }

  function render() {
    var app = $('#app');
    renderChrome();
    if (!app) return;
    if (state.error) { app.innerHTML = '<div class="alert alert-danger"><h4 class="alert-title">초기화 오류</h4><div class="text-secondary">' + esc(state.error) + '</div></div>'; return; }
    if (!state.ready) { app.innerHTML = '<div class="text-secondary text-center py-5">불러오는 중…</div>'; return; }
    if (!state.session) { app.innerHTML = renderLogin(); return; }
    if (state.session.status === 'pending') {
      app.innerHTML = '<div class="container-tight py-5"><div class="card card-md"><div class="card-body">' + empty('hourglass', '관리자 승인 대기 중입니다', '승인이 끝나면 메뉴를 쓸 수 있습니다.') + '<div class="text-center"><button type="button" class="btn" data-action="signout">로그아웃</button></div></div></div></div>';
      return;
    }
    var html = '<div class="tool-grid"><div class="row g-4">' + TOOLS.map(function (t) {
      return '<div class="col-md-6"><a href="' + t.href + '" class="card card-link card-link-pop tool-tile"><span class="avatar ' + t.color + '"><i class="ti ti-' + t.icon + '"></i></span><h3 class="tool-title">' + esc(t.title) + '</h3></a></div>';
    }).join('') + '</div></div>';
    if (state.session.isAdmin) html += renderAdmin();
    app.innerHTML = html;
  }

  function renderChrome() {
    var slot = $('#user-slot');
    var menu = $('#navbar-menu');
    var toggler = $('.navbar-toggler');
    var ok = !!(state.session && state.session.status !== 'pending');
    if (menu) menu.classList.toggle('is-hidden', !ok);
    if (toggler) toggler.classList.toggle('is-hidden', !ok);
    if (!slot) return;
    if (!state.session) { slot.innerHTML = ''; return; }
    var s = state.session;
    slot.innerHTML = '<div class="d-flex align-items-center gap-2"><span class="avatar avatar-sm ' + (s.isAdmin ? 'bg-primary text-white' : 'bg-blue-lt') + '">' + esc((s.user.name || '?').trim().charAt(0)) + '</span>'
      + '<div class="d-none d-md-block lh-1"><div class="small fw-medium">' + esc(s.user.name) + '</div><div class="small text-secondary mt-1">' + (s.isAdmin ? '관리자' : '구성원') + '</div></div>'
      + (store.mode === 'local' ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="change-pin" title="PIN 변경"><i class="ti ti-key"></i></button>' : '')
      + '<button type="button" class="btn btn-sm btn-ghost-secondary" data-action="signout"><i class="ti ti-logout"></i><span class="d-none d-sm-inline ms-1">로그아웃</span></button></div>';
  }

  function renderLogin() {
    var head = '<div class="container-tight py-5"><div class="card card-md"><div class="card-body p-4">'
      + '<div class="text-center mb-4"><img src="assets/img/logo/KAIST_DSIL_Final.png" alt="KAIST DSIL" style="height:44px"><div class="text-secondary small mt-2">Lab Portal</div></div>';
    var foot = '</div></div></div>';
    if (store.mode === 'supabase') {
      if (state.magicLinkSent) return head + '<div class="empty py-2"><div class="empty-icon"><i class="ti ti-mail"></i></div><p class="empty-title">메일을 확인하세요</p><p class="empty-subtitle text-secondary">로그인 링크를 보냈습니다. 처음 로그인한 계정은 관리자 승인 후 메뉴를 쓸 수 있습니다.</p></div>' + foot;
      return head + '<h2 class="h2 text-center mb-3">로그인 · 회원가입</h2>'
        + '<form id="login-form"><div class="mb-3"><label class="form-label required">이메일</label><input type="email" class="form-control" name="email" required placeholder="name@kaist.ac.kr" autocomplete="email"></div>'
        + '<div class="mb-3"><label class="form-label">이름 <span class="form-label-description">처음이면 입력</span></label><input type="text" class="form-control" name="name" placeholder="홍길동" autocomplete="name"></div>'
        + '<div class="form-footer"><button type="submit" class="btn btn-primary w-100"><i class="ti ti-mail me-1"></i>로그인 링크 보내기</button></div></form>'
        + '<div class="text-secondary small text-center mt-3">처음 로그인한 계정은 가입 신청으로 처리되며 관리자 승인 후 사용할 수 있습니다.</div>' + foot;
    }
    return head + '<h2 class="h2 text-center mb-3">로그인</h2>'
      + '<form id="login-form"><div class="mb-3"><label class="form-label required">이름</label><input type="text" class="form-control form-control-lg" name="name" required placeholder="홍길동" autocomplete="username"></div>'
      + '<div class="mb-3"><label class="form-label required">PIN</label><input type="password" class="form-control form-control-lg" name="pin" required inputmode="numeric" autocomplete="current-password" placeholder="숫자 4~8자리"></div>'
      + '<div class="form-footer"><button type="submit" class="btn btn-primary btn-lg w-100"><i class="ti ti-login me-1"></i>로그인</button></div></form>'
      + '<div class="text-center mt-4"><span class="text-secondary small">계정이 없나요?</span> <button type="button" class="btn btn-link p-0 align-baseline" data-action="signup">회원가입 신청</button></div>'
      + '<div class="text-secondary small text-center mt-2">가입 신청은 관리자가 승인한 뒤 로그인할 수 있습니다.</div>' + foot;
  }

  function renderAdmin() {
    var pending = state.accounts.filter(function (a) { return a.status === 'pending'; });
    var others = state.accounts.filter(function (a) { return a.status !== 'pending'; });
    var html = '<div class="tool-grid mt-4"><div class="card mb-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-user-plus me-1 text-primary"></i>가입 신청 ' + (pending.length ? '<span class="badge bg-yellow-lt ms-1">' + pending.length + '</span>' : '') + '</h3></div>';
    if (!pending.length) html += '<div class="card-body text-secondary small">대기 중인 가입 신청이 없습니다.</div>';
    else {
      html += '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>이름</th><th>신청일</th><th class="w-1"></th></tr></thead><tbody>'
        + pending.map(function (a) { return '<tr><td class="fw-medium">' + esc(a.name) + (a.email ? ' <span class="text-secondary small">' + esc(a.email) + '</span>' : '') + '</td><td class="text-secondary text-nowrap">' + fmtDateTime(a.createdAt) + '</td><td class="text-end text-nowrap"><button type="button" class="btn btn-sm btn-primary" data-action="approve" data-id="' + esc(a.id) + '"><i class="ti ti-check me-1"></i>승인</button> <button type="button" class="btn btn-sm btn-outline-danger" data-action="reject" data-id="' + esc(a.id) + '">거절</button></td></tr>'; }).join('')
        + '</tbody></table></div>';
    }
    html += '</div><div class="card"><div class="card-header"><h3 class="card-title"><i class="ti ti-users me-1 text-primary"></i>계정 <span class="text-secondary fw-normal">' + others.length + '개</span></h3></div>'
      + '<div class="table-responsive"><table class="table table-vcenter card-table"><thead><tr><th>이름</th><th>권한</th><th>상태</th><th>승인</th><th class="w-1"></th></tr></thead><tbody>'
      + others.map(function (a) {
        var st = STATUS[a.status] || STATUS.pending;
        var self = state.session && a.id === state.session.user.id;
        return '<tr><td class="fw-medium">' + esc(a.name) + (a.email ? ' <span class="text-secondary small">' + esc(a.email) + '</span>' : '') + (self ? ' <span class="badge bg-blue-lt">나</span>' : '') + '</td>'
          + '<td>' + (a.role === 'admin' ? '<span class="badge bg-primary text-white">관리자</span>' : '<span class="badge bg-secondary-lt">구성원</span>') + '</td>'
          + '<td><span class="badge ' + st.cls + '">' + st.label + '</span></td>'
          + '<td class="text-secondary small text-nowrap">' + (a.approvedAt ? fmtDate(a.approvedAt) + (a.approvedBy ? ' · ' + esc(a.approvedBy) : '') : '-') + '</td>'
          + '<td class="text-end text-nowrap">'
          + (store.mode === 'local' ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="reset-pin" data-id="' + esc(a.id) + '" title="PIN 재설정"><i class="ti ti-key"></i></button>' : '')
          + (!self ? '<button type="button" class="btn btn-sm btn-ghost-secondary btn-icon" data-action="toggle-role" data-id="' + esc(a.id) + '" data-role="' + (a.role === 'admin' ? 'member' : 'admin') + '" title="' + (a.role === 'admin' ? '구성원으로' : '관리자로') + '"><i class="ti ti-' + (a.role === 'admin' ? 'user-down' : 'user-up') + '"></i></button>' : '')
          + (!self ? '<button type="button" class="btn btn-sm btn-ghost-' + (a.status === 'active' ? 'danger' : 'secondary') + ' btn-icon" data-action="toggle-status" data-id="' + esc(a.id) + '" data-status="' + (a.status === 'active' ? 'disabled' : 'active') + '" title="' + (a.status === 'active' ? '사용 중지' : '사용 재개') + '"><i class="ti ti-' + (a.status === 'active' ? 'user-off' : 'user-check') + '"></i></button>' : '')
          + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';

    var TYPES = { login_failed: { label: '로그인 실패', cls: 'bg-yellow-lt' }, login_lockout: { label: '로그인 잠금', cls: 'bg-red-lt' }, login_locked_attempt: { label: '잠금 중 시도', cls: 'bg-orange-lt' }, macro_suspect: { label: '매크로 의심', cls: 'bg-red-lt' } };
    var dayAgo = Date.now() - 86400000;
    var recentHigh = state.events.filter(function (e) { return e.severity === 'high' && new Date(e.createdAt) > dayAgo; }).length;
    html += '<div class="card mt-3"><div class="card-header"><h3 class="card-title"><i class="ti ti-shield-lock me-1 text-primary"></i>보안 이벤트 ' + (recentHigh ? '<span class="badge bg-red-lt ms-1">24시간 내 ' + recentHigh + '건</span>' : '')
      + '</h3><div class="card-actions small text-secondary">' + (CFG.security && CFG.security.alertWebhookUrl ? '웹훅 알림 켜짐' : '웹훅 알림 꺼짐 · config.js security.alertWebhookUrl') + '</div></div>';
    if (!state.events.length) html += '<div class="card-body text-secondary small">기록된 보안 이벤트가 없습니다. 로그인 ' + SEC.maxLoginFailures + '회 연속 실패 시 ' + SEC.lockoutMinutes + '분 잠금, 페이지가 뜬 뒤 ' + SEC.macroThresholdMs + 'ms 안의 제출은 매크로 의심으로 기록됩니다.</div>';
    else {
      html += '<div class="table-responsive" style="max-height:360px;overflow:auto"><table class="table table-sm table-vcenter card-table" id="security-table"><thead><tr><th class="w-1">일시</th><th class="w-1">종류</th><th>이름</th><th>내용</th><th>페이지</th></tr></thead><tbody>'
        + state.events.slice(0, 100).map(function (e) {
          var t = TYPES[e.type] || { label: e.type, cls: 'bg-secondary-lt' };
          return '<tr><td class="text-nowrap text-secondary">' + fmtDateTime(e.createdAt) + '</td><td><span class="badge ' + t.cls + '">' + esc(t.label) + '</span></td><td class="text-nowrap">' + esc(e.name || '-') + '</td><td class="small">' + esc(e.detail) + '</td><td class="small text-secondary">' + esc(e.page) + '</td></tr>';
        }).join('') + '</tbody></table></div>';
    }
    html += '</div></div>';
    return html;
  }

  function goNext() {
    if (state.next) { window.location.replace(state.next + '/index.html'); return true; }
    return false;
  }

  function signupDialog() {
    var body = '<div class="mb-3"><label class="form-label required">이름</label><input type="text" class="form-control" name="name" required placeholder="실명" autocomplete="off"></div>'
      + '<div class="row g-2"><div class="col-6"><label class="form-label required">PIN</label><input type="password" class="form-control" name="pin" required inputmode="numeric" autocomplete="new-password" placeholder="숫자 4~8자리"></div>'
      + '<div class="col-6"><label class="form-label required">PIN 확인</label><input type="password" class="form-control" name="pin2" required inputmode="numeric" autocomplete="new-password"></div></div>'
      + '<div class="text-secondary small mt-3">신청 후 관리자가 승인하면 이 이름과 PIN으로 로그인할 수 있습니다.</div>';
    return dialog({ title: '회원가입 신청', bodyHtml: body, okLabel: '신청' }).then(function (v) {
      if (!v) return;
      if (!/^\d{4,8}$/.test(v.pin)) { toast('PIN은 숫자 4~8자리입니다.', true); return; }
      if (v.pin !== v.pin2) { toast('PIN 확인이 일치하지 않습니다.', true); return; }
      return store.signUp({ name: v.name, pin: v.pin }).then(function (a) { toast(a.name + '님의 가입 신청을 접수했습니다. 관리자 승인을 기다려 주세요.'); });
    });
  }

  function handleError(err) { console.error(err); toast(err && err.message ? err.message : String(err), true); }
  function refresh() { return reload().then(render).catch(handleError); }

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id !== 'login-form') return;
    e.preventDefault();
    var v = readForm(form);
    var who = v.name || v.email || '';
    var elapsed = Date.now() - LOAD_AT;
    if (elapsed < SEC.macroThresholdMs) {
      store.securityEvent({ type: 'macro_suspect', severity: 'high', name: who, detail: '페이지가 뜬 뒤 ' + elapsed + 'ms 만에 로그인 제출' });
    }
    var until = lockedUntil(who);
    if (until) {
      var mins = Math.ceil((until - Date.now()) / 60000);
      store.securityEvent({ type: 'login_locked_attempt', severity: 'low', name: who, detail: '잠금 중 로그인 시도 (' + mins + '분 남음)' });
      toast('로그인 실패가 많아 ' + mins + '분 동안 잠겨 있습니다.', true);
      return;
    }
    store.signIn(v).then(function (res) {
      if (res && res.magicLinkSent) { state.magicLinkSent = true; render(); return; }
      clearFailure(who);
      if (goNext()) return;
      toast(res.user.name + '님, 환영합니다.');
      return refresh();
    }).catch(function (err) {
      var f = noteFailure(who);
      if (f.lockedUntil && f.lockedUntil > Date.now()) {
        store.securityEvent({ type: 'login_lockout', severity: 'high', name: who, detail: f.count + '회 연속 실패로 ' + SEC.lockoutMinutes + '분 잠금 (' + (err && err.message ? err.message : '') + ')' });
        toast('로그인 실패가 ' + f.count + '회를 넘어 ' + SEC.lockoutMinutes + '분 동안 잠깁니다.', true);
        return;
      }
      store.securityEvent({ type: 'login_failed', severity: 'low', name: who, detail: (err && err.message ? err.message : '실패') + ' (' + f.count + '/' + SEC.maxLoginFailures + ')' });
      handleError(err);
    });
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    switch (action) {
      case 'signup': signupDialog().catch(handleError); break;
      case 'signout': store.signOut().then(function () { state.magicLinkSent = false; return refresh(); }); break;
      case 'approve': store.approveAccount(id).then(function () { toast('승인했습니다.'); return refresh(); }).catch(handleError); break;
      case 'reject':
        confirmDlg({ title: '가입 거절', message: '이 가입 신청을 거절할까요?', okLabel: '거절', danger: true }).then(function (ok) { if (!ok) return; return store.rejectAccount(id).then(function () { toast('거절했습니다.'); return refresh(); }); }).catch(handleError);
        break;
      case 'toggle-role': store.setAccountRole(id, btn.getAttribute('data-role')).then(function () { toast('권한을 바꿨습니다.'); return refresh(); }).catch(handleError); break;
      case 'toggle-status': store.setAccountStatus(id, btn.getAttribute('data-status')).then(function () { toast('상태를 바꿨습니다.'); return refresh(); }).catch(handleError); break;
      case 'reset-pin':
        promptDlg({ title: 'PIN 재설정', message: '새 PIN을 입력하세요.', input: 'password', placeholder: '숫자 4~8자리', okLabel: '재설정' }).then(function (pin) { if (pin === null) return; return store.resetAccountPin(id, pin).then(function () { toast('PIN을 재설정했습니다.'); }); }).catch(handleError);
        break;
      case 'change-pin': {
        var body = '<div class="mb-3"><label class="form-label required">현재 PIN</label><input type="password" class="form-control" name="oldPin" required inputmode="numeric"></div><div class="mb-0"><label class="form-label required">새 PIN</label><input type="password" class="form-control" name="newPin" required inputmode="numeric" placeholder="숫자 4~8자리"></div>';
        dialog({ title: 'PIN 변경', bodyHtml: body, okLabel: '변경' }).then(function (v) { if (!v) return; return store.changeMyPin(v.oldPin, v.newPin).then(function () { toast('PIN을 변경했습니다.'); }); }).catch(handleError);
        break;
      }
    }
  });

  store.init().then(function () {
    state.ready = true;
    store.onChange(function () { reload().then(render).catch(handleError); });
    return reload();
  }).then(function () {
    if (state.session && state.session.status !== 'pending' && goNext()) return;
    render();
  }).catch(function (err) { state.error = err && err.message ? err.message : String(err); render(); });
})();
