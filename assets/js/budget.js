/* =====================================================================
   DSIL Lab Portal – 과제별 예산 관리 (UI)
   ===================================================================== */
(function () {
  'use strict';

  var CFG = window.DSIL_CONFIG || {};
  var store = window.DSILStore.create(CFG);

  var STATUS = {
    pending: { label: '미처리', cls: 'badge-pending' },
    done: { label: '처리', cls: 'badge-done' },
    rejected: { label: '반려', cls: 'badge-rejected' }
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
    magicLinkSent: false
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
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('is-error', !!isError);
    el.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 2600);
  }

  function projectById(id) {
    for (var i = 0; i < state.projects.length; i++) if (state.projects[i].id === id) return state.projects[i];
    return null;
  }

  /* 과제별 집계: 처리(done)된 구매건 합계만 예산에서 차감 */
  function projectStats(p) {
    var used = 0, count = 0;
    state.requests.forEach(function (r) {
      if (r.status === 'done' && r.projectId === p.id) { used += Number(r.amount) || 0; count++; }
    });
    var remain = (Number(p.budget) || 0) - used;
    var ratio = p.budget > 0 ? used / p.budget : (used > 0 ? 1 : 0);
    return { used: used, remain: remain, ratio: ratio, count: count };
  }

  function summary() {
    var s = { pendingCount: 0, pendingAmount: 0, doneCount: 0, doneAmount: 0, activeProjects: 0, totalBudget: 0, totalRemain: 0 };
    state.requests.forEach(function (r) {
      if (r.status === 'pending') { s.pendingCount++; s.pendingAmount += Number(r.amount) || 0; }
      if (r.status === 'done') { s.doneCount++; s.doneAmount += Number(r.amount) || 0; }
    });
    state.projects.forEach(function (p) {
      if (p.active === false) return;
      s.activeProjects++;
      s.totalBudget += Number(p.budget) || 0;
      s.totalRemain += projectStats(p).remain;
    });
    return s;
  }

  /* ---------- data ---------- */
  function reload() {
    return Promise.all([store.listProjects(), store.listRequests()]).then(function (res) {
      state.projects = res[0];
      state.requests = res[1].slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
      state.session = store.getSession();
      if (state.tab === 'admin' && !(state.session && state.session.isAdmin)) state.tab = 'requests';
    });
  }

  /* ---------- render ---------- */
  function render() {
    renderUserChip();
    var app = $('#app');
    if (!app) return;

    if (state.error) {
      app.innerHTML = '<div class="notice is-danger"><strong>초기화 오류</strong><br>' + esc(state.error) + '</div>';
      return;
    }
    if (!state.ready) { app.innerHTML = '<div class="empty">불러오는 중…</div>'; return; }
    if (!state.session) { app.innerHTML = renderLogin(); return; }

    var sum = summary();
    var isAdmin = state.session.isAdmin;
    var html = '';

    html += '<div class="page-head">'
      + '<div><h1>과제별 예산 관리</h1>'
      + '<p class="lead">구매 요청을 올리면 관리자가 과제를 배정하고, 배정된 금액은 해당 과제 예산에서 자동으로 차감됩니다.</p></div>'
      + '<div class="page-actions">'
      + (store.mode === 'local' ? '<span class="badge badge-muted" title="브라우저 저장 모드: 이 브라우저에만 저장됩니다">로컬 저장 모드</span>' : '<span class="badge badge-done">공용 DB 연결됨</span>')
      + '<button class="btn btn-sm" data-action="refresh"><span class="material-icons">refresh</span>새로고침</button>'
      + '</div></div>';

    html += '<div class="tiles">'
      + tile('미처리 구매건', sum.pendingCount + '건', won(sum.pendingAmount) + ' 대기 중', 'is-pending')
      + tile('처리 완료', sum.doneCount + '건', won(sum.doneAmount) + ' 집행', 'is-done')
      + tile('진행 중 과제', sum.activeProjects + '개', '총 예산 ' + won(sum.totalBudget))
      + tile('잔여 예산 합계', won(sum.totalRemain), sum.totalBudget > 0 ? '사용률 ' + Math.round((1 - sum.totalRemain / sum.totalBudget) * 100) + '%' : '')
      + '</div>';

    html += '<div class="tabs" role="tablist">'
      + tabBtn('requests', 'shopping_cart', '구매 요청')
      + tabBtn('budget', 'account_balance_wallet', '과제 예산')
      + (isAdmin ? tabBtn('admin', 'admin_panel_settings', '관리자', sum.pendingCount) : '')
      + '</div>';

    if (state.tab === 'requests') html += renderRequestsTab();
    else if (state.tab === 'budget') html += renderBudgetTab();
    else if (state.tab === 'admin') html += renderAdminTab();

    app.innerHTML = html;
    if (window.history && history.replaceState) history.replaceState(null, '', '#' + state.tab);
  }

  function tile(label, value, sub, cls) {
    return '<div class="tile ' + (cls || '') + '"><p class="tile-label">' + esc(label) + '</p><p class="tile-value">' + esc(value) + '</p>'
      + (sub ? '<p class="tile-sub">' + esc(sub) + '</p>' : '') + '</div>';
  }

  function tabBtn(id, icon, label, count) {
    return '<button class="tab-btn' + (state.tab === id ? ' is-active' : '') + '" role="tab" data-action="tab" data-tab="' + id + '">'
      + '<span class="material-icons" style="font-size:18px">' + icon + '</span>' + esc(label)
      + (count ? '<span class="count">' + count + '</span>' : '') + '</button>';
  }

  function renderUserChip() {
    var slot = $('#user-slot');
    if (!slot) return;
    if (!state.session) { slot.innerHTML = ''; return; }
    var s = state.session;
    slot.innerHTML = '<span class="user-chip"><span class="material-icons">person</span>'
      + '<span class="user-chip-name">' + esc(s.user.name) + '</span>'
      + '<span class="user-chip-role' + (s.isAdmin ? '' : ' is-member') + '">' + (s.isAdmin ? '관리자' : '구성원') + '</span>'
      + (!s.isAdmin && store.mode === 'local' ? '<button type="button" data-action="become-admin" title="관리자 PIN 입력">관리자</button>' : '')
      + '<button type="button" data-action="signout">로그아웃</button></span>';
  }

  function renderLogin() {
    if (store.mode === 'supabase') {
      if (state.magicLinkSent) {
        return '<div class="card login-card"><h2>메일을 확인하세요</h2><p class="muted">입력한 주소로 로그인 링크를 보냈습니다. 링크를 누르면 이 페이지로 돌아옵니다.</p></div>';
      }
      return '<div class="card login-card"><h2>로그인</h2>'
        + '<p class="muted small">이메일로 로그인 링크를 보내드립니다. 관리자 권한은 관리자가 profiles 테이블에서 지정합니다.</p>'
        + '<form id="login-form"><div class="form-grid">'
        + '<div class="field field-full"><label>이메일</label><input type="email" name="email" required placeholder="name@kaist.ac.kr"></div>'
        + '<div class="field field-full"><label>이름 (처음 로그인 시)</label><input type="text" name="name" placeholder="홍길동"></div>'
        + '</div><div class="form-actions"><button class="btn btn-primary" type="submit">로그인 링크 보내기</button></div></form></div>';
    }
    return '<div class="card login-card"><h2>시작하기</h2>'
      + '<p class="muted small">로컬 저장 모드입니다. 이름을 입력하면 이 브라우저에 요청이 저장됩니다. 관리자 화면을 보려면 PIN을 함께 입력하세요.</p>'
      + '<form id="login-form"><div class="form-grid">'
      + '<div class="field field-full"><label>이름</label><input type="text" name="name" required placeholder="홍길동" autocomplete="name"></div>'
      + '<div class="field field-full"><label>관리자 PIN (선택)</label><input type="password" name="pin" placeholder="관리자만 입력" autocomplete="off"><span class="hint">config.js 의 adminPin 값</span></div>'
      + '</div><div class="form-actions"><button class="btn btn-primary" type="submit">시작</button></div></form></div>';
  }

  /* ---------- 구매 요청 탭 ---------- */
  function renderRequestsTab() {
    var html = '<div class="grid-2">';

    html += '<div class="card"><h3 class="card-title"><span><span class="material-icons">add_shopping_cart</span>구매 요청 올리기</span></h3>'
      + '<form id="request-form"><div class="form-grid">'
      + '<div class="field field-full"><label>품명 *</label><input type="text" name="item" required placeholder="예: 6인치 SiO2/Si 웨이퍼 25매"></div>'
      + '<div class="field field-full"><label>구매처 / 링크</label><input type="url" name="link" placeholder="https://"></div>'
      + '<div class="field"><label>수량 *</label><input type="number" name="qty" min="1" step="1" value="1" required></div>'
      + '<div class="field"><label>단가 (원) *</label><input type="number" name="unitPrice" min="0" step="1" required placeholder="0"></div>'
      + '<div class="field field-full"><label>합계 (원)</label><input type="text" name="amountView" readonly value="0원"></div>'
      + '<div class="field field-full"><label>용도 / 메모</label><textarea name="note" placeholder="어떤 실험에 쓰는지, 급한지 등"></textarea></div>'
      + '</div><div class="form-actions"><button class="btn btn-primary" type="submit"><span class="material-icons">send</span>요청 제출</button></div></form></div>';

    html += '<div class="card"><h3 class="card-title"><span><span class="material-icons">info</span>처리 흐름</span></h3>'
      + '<ol class="small" style="margin:0;padding-left:18px;line-height:1.9">'
      + '<li>구성원이 품명·수량·단가를 적어 <strong>요청 제출</strong></li>'
      + '<li>요청은 <span class="badge badge-pending">미처리</span> 상태로 관리자 화면에 모임</li>'
      + '<li>관리자가 <strong>과제를 배정</strong>하면 <span class="badge badge-done">처리</span>로 바뀌고 해당 과제 잔액에서 차감</li>'
      + '<li>집행이 어려우면 사유와 함께 <span class="badge badge-rejected">반려</span></li>'
      + '</ol>'
      + '<p class="small muted" style="margin:10px 0 0">현재 로그인: <strong>' + esc(state.session.user.name) + '</strong> · ' + (state.session.isAdmin ? '관리자' : '구성원') + '</p>'
      + '</div>';

    html += '</div>';

    var list = state.requests.filter(function (r) {
      if (state.filter !== 'all' && r.status !== state.filter) return false;
      if (state.onlyMine && r.requesterId !== state.session.user.id) return false;
      return true;
    });

    html += '<div class="card"><h3 class="card-title"><span><span class="material-icons">list_alt</span>요청 현황</span>'
      + '<span class="toolbar" style="margin:0">'
      + '<span class="chip-group">'
      + chip('all', '전체') + chip('pending', '미처리') + chip('done', '처리') + chip('rejected', '반려')
      + '</span>'
      + '<label class="checkbox small"><input type="checkbox" data-action="toggle-mine"' + (state.onlyMine ? ' checked' : '') + '> 내 요청만</label>'
      + '</span></h3>';

    if (!list.length) {
      html += '<div class="empty">표시할 요청이 없습니다.</div>';
    } else {
      html += '<div class="table-wrap"><table class="data"><thead><tr>'
        + '<th>날짜</th><th>신청자</th><th>품명</th><th class="num">수량</th><th class="num">단가</th><th class="num">합계</th><th>상태</th><th>배정 과제</th>'
        + (state.session.isAdmin ? '<th></th>' : '')
        + '</tr></thead><tbody>';
      list.forEach(function (r) { html += requestRow(r, false); });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    return html;
  }

  function chip(val, label) {
    return '<button type="button" data-action="filter" data-filter="' + val + '"' + (state.filter === val ? ' class="is-active"' : '') + '>' + label + '</button>';
  }

  function requestRow(r, adminInbox) {
    var st = STATUS[r.status] || { label: r.status, cls: 'badge-muted' };
    var p = r.projectId ? projectById(r.projectId) : null;
    var itemCell = esc(r.item)
      + (r.link ? ' <a href="' + esc(r.link) + '" target="_blank" rel="noopener" title="링크 열기"><span class="material-icons" style="font-size:14px;vertical-align:middle">open_in_new</span></a>' : '')
      + (r.note ? '<span class="sub">' + esc(r.note) + '</span>' : '')
      + (r.status === 'rejected' && r.adminNote ? '<span class="sub" style="color:var(--rejected)">반려 사유: ' + esc(r.adminNote) + '</span>' : '');
    var html = '<tr data-id="' + esc(r.id) + '">'
      + '<td class="nowrap">' + fmtDate(r.createdAt) + '</td>'
      + '<td class="nowrap">' + esc(r.requesterName) + '</td>'
      + '<td>' + itemCell + '</td>'
      + '<td class="num">' + esc(r.qty) + '</td>'
      + '<td class="num">' + won(r.unitPrice) + '</td>'
      + '<td class="num"><strong>' + won(r.amount) + '</strong></td>';

    if (adminInbox) {
      html += '<td><select data-role="assign-project">' + projectOptions(r.amount) + '</select></td>'
        + '<td class="actions">'
        + '<button class="btn btn-sm btn-primary" data-action="assign">처리</button>'
        + '<button class="btn btn-sm btn-danger" data-action="reject">반려</button>'
        + '</td>';
    } else {
      html += '<td><span class="badge ' + st.cls + '">' + st.label + '</span>'
        + (r.processedAt ? '<span class="sub">' + fmtDate(r.processedAt) + (r.processedBy ? ' · ' + esc(r.processedBy) : '') + '</span>' : '') + '</td>'
        + '<td>' + (p ? esc(p.name) + '<span class="sub">' + esc(p.code) + '</span>' : '<span class="muted">-</span>') + '</td>';
      if (state.session.isAdmin) {
        html += '<td class="actions">'
          + (r.status !== 'pending' ? '<button class="btn btn-sm" data-action="reopen" title="미처리로 되돌리기">되돌리기</button>' : '')
          + '<button class="btn btn-sm btn-ghost" data-action="delete-request" title="삭제"><span class="material-icons" style="font-size:16px">delete</span></button>'
          + '</td>';
      }
    }
    return html + '</tr>';
  }

  function projectOptions(amount) {
    var opts = '<option value="">과제 선택…</option>';
    state.projects.filter(function (p) { return p.active !== false; }).forEach(function (p) {
      var s = projectStats(p);
      var short = (Number(amount) || 0) > s.remain;
      opts += '<option value="' + esc(p.id) + '"' + (short ? ' data-short="1"' : '') + '>'
        + esc((p.code ? '[' + p.code + '] ' : '') + p.name) + ' · 잔액 ' + won(s.remain) + (short ? ' (부족)' : '') + '</option>';
    });
    return opts;
  }

  /* ---------- 과제 예산 탭 ---------- */
  function renderBudgetTab() {
    if (!state.projects.length) return '<div class="empty">등록된 과제가 없습니다. 관리자 탭에서 과제를 추가하세요.</div>';
    var html = '<div class="project-grid">';
    state.projects.slice().sort(function (a, b) { return (a.active === false) - (b.active === false); }).forEach(function (p) {
      var s = projectStats(p);
      var pct = Math.min(100, Math.round(s.ratio * 100));
      var barCls = s.ratio >= 1 ? ' is-over' : (s.ratio >= (CFG.warnRatio || 0.8) ? ' is-warn' : '');
      var items = state.requests.filter(function (r) { return r.status === 'done' && r.projectId === p.id; });
      html += '<div class="project-card' + (p.active === false ? ' is-inactive' : '') + '">'
        + '<div class="project-card-head"><div><h3 class="project-card-name">' + esc(p.name) + '</h3>'
        + '<span class="project-card-code">' + esc(p.code) + (p.manager ? ' · ' + esc(p.manager) : '') + '</span></div>'
        + (p.active === false ? '<span class="badge badge-muted">종료</span>' : '<span class="badge badge-done">진행</span>') + '</div>'
        + '<dl class="project-meta">'
        + '<dt>기간</dt><dd>' + esc(p.startDate || '-') + ' ~ ' + esc(p.endDate || '-') + '</dd>'
        + '<dt>총 예산</dt><dd>' + won(p.budget) + '</dd>'
        + (p.note ? '<dt>비고</dt><dd>' + esc(p.note) + '</dd>' : '')
        + '</dl>'
        + '<div class="progress"><div class="progress-bar' + barCls + '" style="width:' + pct + '%"></div></div>'
        + '<div class="project-nums"><span>사용 <strong>' + won(s.used) + '</strong> <span class="muted">(' + Math.round(s.ratio * 100) + '%)</span></span>'
        + '<span class="remain' + (s.remain < 0 ? ' is-over' : '') + '">잔액 <strong>' + won(s.remain) + '</strong></span></div>'
        + '<details><summary>배정된 구매건 ' + items.length + '건</summary>'
        + (items.length ? '<ul>' + items.map(function (r) { return '<li><span>' + fmtDate(r.processedAt || r.createdAt) + ' ' + esc(r.item) + ' <span class="muted">(' + esc(r.requesterName) + ')</span></span><span>' + won(r.amount) + '</span></li>'; }).join('') + '</ul>' : '<p class="muted small" style="margin:6px 0 0">아직 없음</p>')
        + '</details>'
        + '</div>';
    });
    return html + '</div>';
  }

  /* ---------- 관리자 탭 ---------- */
  function renderAdminTab() {
    var pending = state.requests.filter(function (r) { return r.status === 'pending'; });
    var html = '';

    html += '<div class="card"><h3 class="card-title"><span><span class="material-icons">inbox</span>미처리 구매건 <span class="badge badge-pending">' + pending.length + '건</span></span>'
      + '<span class="small muted">과제를 고르고 처리를 누르면 해당 과제 잔액에서 차감됩니다.</span></h3>';
    if (!pending.length) {
      html += '<div class="empty">미처리 요청이 없습니다.</div>';
    } else {
      html += '<div class="table-wrap"><table class="data"><thead><tr>'
        + '<th>날짜</th><th>신청자</th><th>품명</th><th class="num">수량</th><th class="num">단가</th><th class="num">합계</th><th>배정 과제</th><th></th>'
        + '</tr></thead><tbody>';
      pending.forEach(function (r) { html += requestRow(r, true); });
      html += '</tbody></table></div>';
    }
    html += '</div>';

    var editing = state.editingProjectId ? projectById(state.editingProjectId) : null;
    html += '<div class="grid-2">';
    html += '<div class="card"><h3 class="card-title"><span><span class="material-icons">' + (editing ? 'edit' : 'add_circle') + '</span>' + (editing ? '과제 수정' : '과제 추가') + '</span>'
      + (editing ? '<button class="btn btn-sm btn-ghost" data-action="cancel-edit">취소</button>' : '') + '</h3>'
      + '<form id="project-form" data-id="' + esc(editing ? editing.id : '') + '"><div class="form-grid">'
      + '<div class="field"><label>과제번호</label><input type="text" name="code" value="' + esc(editing ? editing.code : '') + '" placeholder="2026-A01"></div>'
      + '<div class="field"><label>연구책임자</label><input type="text" name="manager" value="' + esc(editing ? editing.manager : '') + '" placeholder="김교수"></div>'
      + '<div class="field field-full"><label>과제명 *</label><input type="text" name="name" required value="' + esc(editing ? editing.name : '') + '" placeholder="과제명"></div>'
      + '<div class="field field-full"><label>총 예산 (원) *</label><input type="number" name="budget" min="0" step="1" required value="' + esc(editing ? editing.budget : '') + '" placeholder="50000000"></div>'
      + '<div class="field"><label>시작일</label><input type="date" name="startDate" value="' + esc(editing ? editing.startDate : '') + '"></div>'
      + '<div class="field"><label>종료일</label><input type="date" name="endDate" value="' + esc(editing ? editing.endDate : '') + '"></div>'
      + '<div class="field field-full"><label>비고</label><input type="text" name="note" value="' + esc(editing ? editing.note : '') + '" placeholder="비목, 집행 주의사항 등"></div>'
      + '<div class="field field-full"><label class="checkbox"><input type="checkbox" name="active"' + (!editing || editing.active !== false ? ' checked' : '') + '> 진행 중 (배정 가능)</label></div>'
      + '</div><div class="form-actions"><button class="btn btn-primary" type="submit"><span class="material-icons">save</span>' + (editing ? '저장' : '과제 추가') + '</button></div></form></div>';

    html += '<div class="card"><h3 class="card-title"><span><span class="material-icons">folder</span>과제 목록</span></h3>';
    if (!state.projects.length) {
      html += '<div class="empty">아직 과제가 없습니다.</div>';
    } else {
      html += '<div class="table-wrap"><table class="data"><thead><tr><th>과제</th><th class="num">예산</th><th class="num">잔액</th><th></th></tr></thead><tbody>';
      state.projects.forEach(function (p) {
        var s = projectStats(p);
        html += '<tr data-id="' + esc(p.id) + '"><td>' + esc(p.name) + '<span class="sub">' + esc(p.code) + (p.active === false ? ' · 종료' : '') + '</span></td>'
          + '<td class="num">' + won(p.budget) + '</td>'
          + '<td class="num' + (s.remain < 0 ? '" style="color:var(--rejected)' : '') + '">' + won(s.remain) + '</td>'
          + '<td class="actions"><button class="btn btn-sm" data-action="edit-project">수정</button>'
          + '<button class="btn btn-sm btn-ghost" data-action="delete-project" title="삭제"><span class="material-icons" style="font-size:16px">delete</span></button></td></tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div></div>';

    if (store.mode === 'local') {
      html += '<div class="card"><h3 class="card-title"><span><span class="material-icons">backup</span>데이터 백업 (로컬 모드)</span></h3>'
        + '<p class="small muted" style="margin:0 0 10px">로컬 모드 데이터는 이 브라우저에만 있습니다. JSON으로 내보내 공유하거나, 다른 PC에서 가져올 수 있습니다.</p>'
        + '<div class="toolbar"><button class="btn btn-sm" data-action="export"><span class="material-icons">download</span>JSON 내보내기</button>'
        + '<label class="btn btn-sm"><span class="material-icons">upload</span>JSON 가져오기<input type="file" accept="application/json" data-action="import" class="hidden"></label>'
        + '<span class="spacer"></span>'
        + '<button class="btn btn-sm btn-danger" data-action="reset-demo">예시 데이터로 초기화</button></div></div>';
    }
    return html;
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

  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.id === 'login-form') {
      e.preventDefault();
      var v = readForm(form);
      store.signIn(v).then(function (res) {
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
      store.createRequest({ item: r.item.trim(), link: r.link.trim(), qty: qty, unitPrice: unit, amount: qty * unit, note: r.note.trim() })
        .then(function () { toast('요청을 제출했습니다. 관리자 처리 후 상태가 바뀝니다.'); state.filter = 'all'; return refresh(); })
        .catch(handleError);
    }
    if (form.id === 'project-form') {
      e.preventDefault();
      var p = readForm(form);
      var id = form.getAttribute('data-id') || null;
      if (!p.name.trim()) { toast('과제명을 입력하세요.', true); return; }
      var rec = { code: p.code.trim(), name: p.name.trim(), budget: Math.max(0, Math.round(Number(p.budget) || 0)), startDate: p.startDate, endDate: p.endDate, manager: p.manager.trim(), note: p.note.trim(), active: !!p.active };
      if (id) rec.id = id;
      store.saveProject(rec).then(function () { toast(id ? '과제를 수정했습니다.' : '과제를 추가했습니다.'); state.editingProjectId = null; return refresh(); }).catch(handleError);
    }
  });

  document.addEventListener('input', function (e) {
    var form = e.target.closest('#request-form');
    if (!form) return;
    var qty = Math.max(1, parseInt(form.qty.value, 10) || 0);
    var unit = Math.max(0, Number(form.unitPrice.value) || 0);
    form.amountView.value = won(qty * unit);
  });

  document.addEventListener('change', function (e) {
    var el = e.target;
    var action = el.getAttribute('data-action');
    if (action === 'toggle-mine') { state.onlyMine = el.checked; render(); }
    if (action === 'import' && el.files && el.files[0]) {
      var reader = new FileReader();
      reader.onload = function () {
        try { store.importJSON(JSON.parse(reader.result)); toast('가져오기 완료'); refresh(); }
        catch (err) { handleError(err); }
      };
      reader.readAsText(el.files[0]);
    }
  });

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    var action = btn.getAttribute('data-action');
    var row = btn.closest('tr[data-id]');
    var id = row ? row.getAttribute('data-id') : null;

    switch (action) {
      case 'tab':
        state.tab = btn.getAttribute('data-tab'); render(); break;
      case 'filter':
        state.filter = btn.getAttribute('data-filter'); render(); break;
      case 'refresh':
        refresh().then(function () { toast('새로고침 완료'); }); break;
      case 'signout':
        store.signOut().then(function () { state.magicLinkSent = false; return refresh(); }); break;
      case 'become-admin': {
        var pin = window.prompt('관리자 PIN을 입력하세요');
        if (pin === null) return;
        store.becomeAdmin(pin).then(function (ok) { if (ok) { toast('관리자 모드로 전환했습니다.'); state.tab = 'admin'; return refresh(); } toast('PIN이 올바르지 않습니다.', true); });
        break;
      }
      case 'assign': {
        var sel = row.querySelector('select[data-role="assign-project"]');
        var pid = sel && sel.value;
        if (!pid) { toast('배정할 과제를 선택하세요.', true); return; }
        var req = state.requests.filter(function (r) { return r.id === id; })[0];
        var proj = projectById(pid);
        var stats = projectStats(proj);
        if ((Number(req.amount) || 0) > stats.remain) {
          if (!window.confirm('이 과제 잔액(' + won(stats.remain) + ')보다 큰 금액입니다. 그래도 배정할까요?')) return;
        }
        store.updateRequest(id, { status: 'done', projectId: pid, processedAt: new Date().toISOString(), processedBy: state.session.user.name, adminNote: '' })
          .then(function () { toast('처리 완료: ' + proj.name); return refresh(); }).catch(handleError);
        break;
      }
      case 'reject': {
        var reason = window.prompt('반려 사유를 입력하세요 (신청자에게 표시됩니다)');
        if (reason === null) return;
        store.updateRequest(id, { status: 'rejected', projectId: null, processedAt: new Date().toISOString(), processedBy: state.session.user.name, adminNote: reason.trim() })
          .then(function () { toast('반려했습니다.'); return refresh(); }).catch(handleError);
        break;
      }
      case 'reopen':
        store.updateRequest(id, { status: 'pending', projectId: null, processedAt: null, processedBy: null, adminNote: '' })
          .then(function () { toast('미처리로 되돌렸습니다.'); return refresh(); }).catch(handleError);
        break;
      case 'delete-request':
        if (!window.confirm('이 요청을 삭제할까요? 되돌릴 수 없습니다.')) return;
        store.deleteRequest(id).then(function () { toast('삭제했습니다.'); return refresh(); }).catch(handleError);
        break;
      case 'edit-project':
        state.editingProjectId = id; render();
        var f = $('#project-form'); if (f) f.scrollIntoView({ behavior: 'smooth', block: 'start' });
        break;
      case 'cancel-edit':
        state.editingProjectId = null; render(); break;
      case 'delete-project':
        if (!window.confirm('이 과제를 삭제할까요?')) return;
        store.deleteProject(id).then(function () { toast('과제를 삭제했습니다.'); return refresh(); }).catch(handleError);
        break;
      case 'export':
        download('dsil-budget-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify(store.exportJSON(), null, 2));
        break;
      case 'reset-demo':
        if (!window.confirm('모든 데이터를 지우고 예시 데이터로 되돌릴까요?')) return;
        store.resetDemo(); toast('예시 데이터로 초기화했습니다.'); refresh();
        break;
    }
  });

  /* ---------- boot ---------- */
  var TABS = ['requests', 'budget', 'admin'];
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
