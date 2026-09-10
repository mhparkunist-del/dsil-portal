/* =====================================================================
   DSIL Lab Portal – data layer
   ---------------------------------------------------------------------
   Two interchangeable adapters expose the same async interface:

     init()                         -> Promise<void>
     getSession()                   -> { user:{id,name,email}, isAdmin } | null
                                       isAdmin = 관리자 자격 (실제 진입은 PIN 으로 한 번 더 확인)
     signIn(payload) / signOut()    -> Promise
     verifyAdminPin(pin)            -> Promise<boolean>
     listProjects()                 -> Promise<Project[]>
     saveProject(project)           -> Promise<Project>
     deleteProject(id)              -> Promise<void>
     listRequests()                 -> Promise<Request[]>
     createRequest(request)         -> Promise<Request>
     updateRequest(id, patch)       -> Promise<Request>
     deleteRequest(id)              -> Promise<void>
     listReviews({full})            -> Promise<Review[]>   full=true(관리자): 전체·모든 필드, 아니면 본인 것의 상태만
     createReview(review)           -> Promise<Review>     review.pinHash 는 DSILStore.hashPin() 으로 미리 계산
     updateReview(id, patch)        -> Promise<Review>
     deleteReview(id)               -> Promise<void>
     openReview(id, pin)            -> Promise<Review|null> 열람 PIN 이 맞으면 전체 필드
     listExports()                  -> Promise<ExportLog[]> (관리자) 내보내기 이력 – 지우지 않는 아카이브
     createExport(log)              -> Promise<ExportLog>
     onChange(cb)                   -> unsubscribe()
     exportJSON() / importJSON(obj) -> (local only)

   Project { id, code, name, budgets:{<categoryId>: amount}, startDate, endDate, manager, note, active, createdAt }
   Request { id, createdAt, requesterId, requesterName, item, category, link, qty, unitPrice, amount,
             note, status:'pending'|'done'|'rejected', projectId, reviewId, adminNote, processedAt, processedBy }
   Review  { id, createdAt, requesterId, requesterName, title, purpose, vendor, category,
             items:[{name, amount}], amount, note, pinHash,
             status:'pending'|'approved'|'rejected', projectId, approvedAmount, adminNote, processedAt, processedBy }
   ExportLog { id, createdAt, exportedById, exportedBy, purpose, format:'csv'|'print', count, totalAmount,
               filter:{from,to,projectId,includeRequests,includeReviews}, rows:[{kind,date,requester,title,category,project,code,amount,actual,provisional,by,note}] }

   장비 예약 (equipment.js)
     listEquipment()                                  -> Equipment[] (PIN 해시 제외, users:[{id,name,grantedAt,grantedBy}])
     saveEquipment(eq, {managerPin})                  -> 관리자. managerPin 을 주면 담당자 PIN 재설정
     deleteEquipment(id)
     verifyManager(equipmentId, pin)                  -> boolean
     grantUser(equipmentId, managerPin, name, userPin) -> user   (같은 이름이면 PIN 재설정)
     revokeUser(equipmentId, managerPin, userId)
     listReservations() / listUsageLogs()
     createReservation({equipmentId, userPin, start, end, purpose}) -> 권한·PIN·중복·로그 기한 검사 후 생성
     cancelReservation(id, {managerPin})              -> 본인의 예정 예약, 또는 담당자 PIN
     createUsageLog({reservationId, usedStart, usedEnd, condition, content, issues})
     waiveUsageLog(reservationId, managerPin, note)   -> 담당자가 로그 면제 처리
   Equipment   { id, name, location, managerName, description, rules, color, active, createdAt, users }
   Reservation { id, createdAt, equipmentId, userId, userName, start, end, purpose, status:'booked'|'cancelled', logId, cancelledAt, cancelledBy }
   UsageLog    { id, createdAt, reservationId, equipmentId, userId, userName, usedStart, usedEnd, condition:'normal'|'issue', content, issues, waived, waivedBy }
   ===================================================================== */
(function () {
  'use strict';

  /* v2: 예시 데이터 없이 관리자 계정만으로 시작 (이전 키의 브라우저 데이터는 더 이상 읽지 않음) */
  var DATA_KEY = 'dsil-portal-v2';
  var SESSION_KEY = 'dsil-portal-session-v2';
  var DEMO_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'; /* sha256("1234") */
  var SUPER_ADMIN = { id: 'admin-1', name: '관리자', seedPin: '0000' };                          /* 슈퍼계정: 관리자 / 0000 */

  function uid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function nowISO() { return new Date().toISOString(); }

  function daysAgo(n) {
    var d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString();
  }

  function categoryIds(cfg) {
    var cats = (cfg.budgetCategories && cfg.budgetCategories.length) ? cfg.budgetCategories : [{ id: 'other' }];
    return cats.map(function (c) { return c.id; });
  }

  /* 오늘 기준 dayOffset 일 뒤 hour:minute (로컬) → ISO */
  function at(dayOffset, hour, minute) {
    var d = new Date();
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, minute || 0, 0, 0);
    return d.toISOString();
  }
  function nameKey(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function isSameUser(r, user) { return !!user && (r.userId === user.id || nameKey(r.userName) === nameKey(user.name)); }
  var EQ_GRADES = ['training', 'test', 'user', 'super'];
  function normGrade(g) { return EQ_GRADES.indexOf(g) >= 0 ? g : 'training'; }
  function canReserveGrade(g) { return g === 'user' || g === 'super'; }
  function gradeLabel(g) { return { training: '교육', test: '유저 테스트 대기', user: '유저', super: '슈퍼유저' }[g] || g; }
  function publicUser(u) { return { id: u.id, name: u.name, grade: normGrade(u.grade), grantedAt: u.grantedAt, grantedBy: u.grantedBy || '' }; }
  function publicEquipment(eq) {
    return { id: eq.id, name: eq.name, location: eq.location || '', managerName: eq.managerName || '', description: eq.description || '', rules: eq.rules || '',
      color: eq.color || '#004191', active: eq.active !== false, createdAt: eq.createdAt, hasManagerPin: !!eq.managerPinHash, users: (eq.users || []).map(publicUser) };
  }
  function fmtRangeShort(r) {
    var s = new Date(r.start), e = new Date(r.end);
    function p(n) { return String(n).padStart(2, '0'); }
    return s.getMonth() + 1 + '/' + s.getDate() + ' ' + p(s.getHours()) + ':' + p(s.getMinutes()) + '–' + p(e.getHours()) + ':' + p(e.getMinutes());
  }
  function equipmentCfg(cfg) { return Object.assign({ maxHours: 8, logDueDays: 7 }, cfg.equipment || {}); }

  /* ---------- 출석 공통 규칙 ---------- */
  var ATT_KEY = 'dsil-att-session-v1';
  function attendanceCfg(cfg) { return Object.assign({ openAfter: '06:00', lateAfter: '09:00', closeAfter: '11:00', vacationDaysPerHalf: 2, selfRegister: true, holidays: {} }, cfg.attendance || {}); }
  function ymdLocal(d) { function p(n) { return String(n).padStart(2, '0'); } return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); }
  function hmLocal(d) { function p(n) { return String(n).padStart(2, '0'); } return p(d.getHours()) + ':' + p(d.getMinutes()); }
  function isWeekend(dateStr) { var d = new Date(dateStr + 'T00:00:00'); var w = d.getDay(); return w === 0 || w === 6; }
  function halfKey(dateStr) { var m = Number(dateStr.slice(5, 7)); return dateStr.slice(0, 4) + (m <= 6 ? 'H1' : 'H2'); }
  function eachDate(from, to, fn) {
    var d = new Date(from + 'T00:00:00'), end = new Date(to + 'T00:00:00');
    while (d <= end) { fn(ymdLocal(d)); d.setDate(d.getDate() + 1); }
  }
  function workdaysBetween(from, to, holidays) {
    var n = 0; eachDate(from, to, function (s) { if (!isWeekend(s) && !holidays[s]) n++; }); return n;
  }
  function publicMember(m) { return { id: m.id, name: m.name, active: m.active !== false, createdAt: m.createdAt }; }
  function readAttSession() { try { return JSON.parse(sessionStorage.getItem(ATT_KEY) || 'null'); } catch (e) { return null; } }
  function writeAttSession(s) { try { if (s) sessionStorage.setItem(ATT_KEY, JSON.stringify(s)); else sessionStorage.removeItem(ATT_KEY); } catch (e) { /* ignore */ } }

  /* 열람 PIN 해시 (SHA-256 hex). 보안 컨텍스트가 아니면 약한 대체 해시 – 로컬 데모용 */
  function fallbackHash(s) {
    var h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return 'fnv-' + h.toString(16);
  }
  function hashPin(pin) {
    var s = String(pin);
    if (window.crypto && crypto.subtle && window.TextEncoder) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)).then(function (buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
      }).catch(function () { return fallbackHash(s); });
    }
    return Promise.resolve(fallbackHash(s));
  }

  /* 빈 데이터: migrate() 가 관리자 계정(관리자 / 0000)과 공휴일 초기값만 채움 */
  function emptyData() {
    return { accounts: [], projects: [], requests: [], reviews: [], exports: [], equipment: [], reservations: [], usageLogs: [],
      attMembers: [], attRecords: [], attLeaves: [], attHolidays: null, invManagers: [], invItems: [], invMoves: [], security: [], participationImport: null, participationRows: [], meetingLogs: [], dataResetId: null };
  }

  /* ------------------------------------------------------------------ */
  /*  참여과제 시트 ↔ 과제 목록 동기화 (순수 함수, local/supabase 공용)          */
  /*  rows = [{ name, project(약칭), months:{ '2026-09': true } }]           */
  /* ------------------------------------------------------------------ */
  var AUTO_NOTE = '참여과제 시트에서 자동 생성';
  function normName(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function normRows(rows) {
    var out = [], seen = {};
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      var alias = String(r.project || '').trim(), name = String(r.name || '').trim();
      if (!alias || !name) return;
      var k = alias + '|' + name; if (seen[k]) return; seen[k] = 1;
      out.push({ name: name, project: alias, months: (r.months && typeof r.months === 'object') ? r.months : {} });
    });
    return out;
  }
  function sheetAliases(rows) { var out = []; rows.forEach(function (r) { if (out.indexOf(r.project) < 0) out.push(r.project); }); return out; }
  function participantsForAlias(rows, alias) { return rows.filter(function (r) { return normName(r.project) === normName(alias); }).map(function (r) { return { name: r.name, months: r.months }; }); }
  function isPlaceholder(p) { return !!p.autoCreated || (p.note === AUTO_NOTE && !Object.keys(p.budgets || {}).some(function (k) { return Number(p.budgets[k]) > 0; })); }
  /* 약칭에 맞는 기존 과제 찾기: 이름이 같거나, 이름이 약칭을 포함하거나 약칭이 이름을 포함(유일할 때만) */
  function findProjectForAlias(projects, alias, excludeId) {
    var a = normName(alias);
    var pool = projects.filter(function (p) { return p.id !== excludeId && !p.alias && !isPlaceholder(p); });
    var byName = pool.filter(function (p) { return normName(p.name) === a; })[0];
    if (byName) return byName;
    var fuzzy = pool.filter(function (p) { var n = normName(p.name); return n && a && (n.indexOf(a) >= 0 || a.indexOf(n) >= 0); });
    return fuzzy.length === 1 ? fuzzy[0] : null;
  }
  function mergeProjectInto(data, fromId, intoId) {
    if (!fromId || !intoId || fromId === intoId) return;
    (data.requests || []).forEach(function (r) { if (r.projectId === fromId) r.projectId = intoId; if (r.meta && r.meta.suggestedProjectId === fromId) r.meta.suggestedProjectId = intoId; });
    (data.reviews || []).forEach(function (rv) { if (rv.projectId === fromId) rv.projectId = intoId; });
    data.projects = data.projects.filter(function (p) { return p.id !== fromId; });
    (data.merged = data.merged || []).push({ from: fromId, into: intoId });
  }
  /* 과제 하나에 약칭을 붙임. 같은 약칭을 가진 자동 생성 과제가 있으면 이 과제로 병합 */
  function linkAlias(data, projectId, alias) {
    var p = data.projects.filter(function (x) { return x.id === projectId; })[0];
    if (!p) throw new Error('과제를 찾을 수 없습니다.');
    alias = String(alias || '').trim();
    if (alias) {
      data.projects.filter(function (x) { return x.id !== p.id && normName(x.alias) === normName(alias); }).forEach(function (holder) {
        if (isPlaceholder(holder)) mergeProjectInto(data, holder.id, p.id); else holder.alias = '';
      });
      p.alias = alias; p.participants = participantsForAlias(data.participationRows || [], alias);
    } else { p.alias = ''; p.participants = []; }
    delete p.autoCreated;
    return p;
  }
  /* 시트의 모든 약칭이 과제 하나에 연결되고, 과제 목록의 모든 과제가 약칭(없으면 자기 이름)을 갖도록 맞춤 */
  function syncSheet(data) {
    var rows = data.participationRows || [];
    var res = { linked: [], created: [], aliased: [], merged: [], refreshed: 0 };
    sheetAliases(rows).forEach(function (alias) {
      var holders = data.projects.filter(function (p) { return normName(p.alias) === normName(alias); });
      var real = holders.filter(function (p) { return !isPlaceholder(p); })[0];
      var placeholder = holders.filter(function (p) { return isPlaceholder(p); })[0];
      var target = real || null;
      if (!target) {
        var cand = findProjectForAlias(data.projects, alias, placeholder ? placeholder.id : null);
        if (cand) { target = cand; target.alias = alias; res.linked.push(cand.name + ' ← ' + alias); if (placeholder) { mergeProjectInto(data, placeholder.id, cand.id); res.merged.push(alias); } }
        else if (placeholder) target = placeholder;
        else {
          target = { id: uid(), code: '', name: alias, alias: alias, budgets: {}, startDate: '', endDate: '', manager: '', accountManager: '', cardUsers: [], note: AUTO_NOTE, active: true, createdAt: nowISO(), participants: [], autoCreated: true };
          data.projects.push(target); res.created.push(alias);
        }
      } else if (placeholder && placeholder.id !== target.id) { mergeProjectInto(data, placeholder.id, target.id); res.merged.push(alias); }
      target.alias = alias; target.participants = participantsForAlias(rows, alias); res.refreshed++;
    });
    data.projects.forEach(function (p) {
      if (!p.alias) { p.alias = p.name; p.participants = []; res.aliased.push(p.name); }
      else if (!sheetAliases(rows).some(function (a) { return normName(a) === normName(p.alias); })) p.participants = [];
    });
    return res;
  }
  /* 참여과제 시트 → rows 저장 + 과제 목록 동기화. payload = { source, months:[...], rows:[...] } */
  function applyParticipation(data, payload, by) {
    var rows = normRows(payload && payload.rows);
    data.participationRows = rows;
    var res = syncSheet(data);
    data.participationImport = { source: String(payload.source || ''), months: Array.isArray(payload.months) ? payload.months.slice() : [], importedAt: nowISO(), importedBy: by || '', rows: rows.length, projects: sheetAliases(rows).length, created: res.created.length, updated: res.refreshed - res.created.length, linked: res.linked, merged: res.merged };
    return JSON.parse(JSON.stringify(data.participationImport));
  }
  function meetingLogEntry(e, by) {
    return Object.assign({ id: uid(), at: nowISO(), by: by ? by.name : '', byId: by ? by.id : '', type: '', requestId: null, requesterId: null, requesterName: '', project: '', code: '', title: '', amount: 0, count: 0, perHead: 0, attendees: '', detail: '' }, e || {});
  }

  /* ------------------------------------------------------------------ */
  /*  Demo seed (config.js seedDemoData: true 일 때만)                    */
  /* ------------------------------------------------------------------ */
  function seedData() {
    var p1 = uid(), p2 = uid(), p3 = uid();
    var rv1 = uid(), rv2 = uid();
    var e1 = uid(), e2 = uid(), e3 = uid();
    var r1 = uid(), r2 = uid(), r3 = uid(), r4 = uid(), r5 = uid(), r6 = uid();
    var l1 = uid();
    var demoUsers = function () {
      return [['홍길동', 'super'], ['이영희', 'user'], ['박철수', 'user'], ['김신입', 'training']].map(function (u) { return { id: uid(), name: u[0], grade: u[1], grantedAt: daysAgo(60), grantedBy: '관리자' }; });
    };
    return {
      accounts: [
        { id: SUPER_ADMIN.id, name: SUPER_ADMIN.name, pinHash: '', seedPin: SUPER_ADMIN.seedPin, role: 'admin', status: 'active', createdAt: daysAgo(400), approvedAt: daysAgo(400), approvedBy: '시스템' },
        { id: 'demo-1', name: '홍길동', pinHash: DEMO_PIN_HASH, role: 'member', status: 'active', createdAt: daysAgo(300), approvedAt: daysAgo(300), approvedBy: '관리자' },
        { id: 'demo-2', name: '이영희', pinHash: DEMO_PIN_HASH, role: 'member', status: 'active', createdAt: daysAgo(300), approvedAt: daysAgo(300), approvedBy: '관리자' },
        { id: 'demo-3', name: '박철수', pinHash: DEMO_PIN_HASH, role: 'member', status: 'active', createdAt: daysAgo(300), approvedAt: daysAgo(300), approvedBy: '관리자' },
        { id: 'demo-4', name: '김신입', pinHash: DEMO_PIN_HASH, role: 'member', status: 'pending', createdAt: daysAgo(1), approvedAt: null, approvedBy: null }
      ],
      equipment: [
        { id: e1, name: '프로브 스테이션 (Keithley 2636B)', location: 'E3-3 2302호 측정실', managerName: '이영희', managerPinHash: DEMO_PIN_HASH, description: 'DC I-V, 저온 측정. 4개 매니퓰레이터.', rules: '사용 전 챔버 진공 확인\n텅스텐 팁 교체 시 로그에 기재\n1회 최대 4시간', color: '#004191', active: true, createdAt: daysAgo(200), users: demoUsers() },
        { id: e2, name: 'RF 스퍼터 증착기', location: 'E3-3 지하 클린룸', managerName: '박철수', managerPinHash: DEMO_PIN_HASH, description: '3-gun 스퍼터. 타겟 교체는 담당자에게.', rules: '베이킹 후 사용\n타겟 잔량 로그 필수', color: '#f76707', active: true, createdAt: daysAgo(200), users: demoUsers().slice(0, 2) },
        { id: e3, name: '광학 현미경 (Nikon LV150)', location: 'E3-3 2302호', managerName: '홍길동', managerPinHash: DEMO_PIN_HASH, description: '명시야/암시야, 100x까지.', rules: '렌즈 접촉 금지', color: '#2fb344', active: true, createdAt: daysAgo(150), users: demoUsers() }
      ],
      reservations: [
        { id: r1, createdAt: daysAgo(1), equipmentId: e1, userId: 'demo-1', userName: '홍길동', start: at(1, 10, 0), end: at(1, 12, 0), purpose: 'TMD 소자 I-V 측정', status: 'booked', logId: null, cancelledAt: null, cancelledBy: null },
        { id: r2, createdAt: daysAgo(1), equipmentId: e2, userId: 'demo-2', userName: '이영희', start: at(0, 14, 0), end: at(0, 17, 0), purpose: 'HfO2 게이트 증착', status: 'booked', logId: null, cancelledAt: null, cancelledBy: null },
        { id: r3, createdAt: daysAgo(2), equipmentId: e3, userId: 'demo-3', userName: '박철수', start: at(2, 9, 30), end: at(2, 11, 0), purpose: '전사 후 표면 확인', status: 'booked', logId: null, cancelledAt: null, cancelledBy: null },
        { id: r4, createdAt: daysAgo(5), equipmentId: e1, userId: 'demo-3', userName: '박철수', start: at(-3, 13, 0), end: at(-3, 16, 0), purpose: 'Cu 필러 저항 측정', status: 'booked', logId: l1, cancelledAt: null, cancelledBy: null },
        { id: r5, createdAt: daysAgo(12), equipmentId: e2, userId: 'demo-1', userName: '홍길동', start: at(-10, 9, 0), end: at(-10, 12, 0), purpose: 'Ti/Au 전극 증착', status: 'booked', logId: null, cancelledAt: null, cancelledBy: null },
        { id: r6, createdAt: daysAgo(3), equipmentId: e3, userId: 'demo-2', userName: '이영희', start: at(-2, 15, 0), end: at(-2, 16, 0), purpose: 'PDMS 스탬프 검사', status: 'booked', logId: null, cancelledAt: null, cancelledBy: null }
      ],
      usageLogs: [
        { id: l1, createdAt: daysAgo(3), reservationId: r4, equipmentId: e1, userId: 'demo-3', userName: '박철수', usedStart: at(-3, 13, 10), usedEnd: at(-3, 15, 40), condition: 'normal', content: '4-probe, 10 mA 컴플라이언스. 시편 3종.', issues: '', waived: false, waivedBy: null }
      ],
      attMembers: [
        { id: 'att-1', name: '홍길동', pinHash: DEMO_PIN_HASH, active: true, createdAt: daysAgo(100) },
        { id: 'att-2', name: '이영희', pinHash: DEMO_PIN_HASH, active: true, createdAt: daysAgo(100) },
        { id: 'att-3', name: '박철수', pinHash: DEMO_PIN_HASH, active: true, createdAt: daysAgo(100) }
      ],
      attRecords: (function () {
        /* 최근 10 근무일의 예시 출석: 홍길동 정상 위주, 이영희 지각 1회·참작 1회, 박철수 하루 결근(기록 없음) */
        var out = [], d = new Date(), count = 0, i = 1;
        while (count < 10) {
          var day = new Date(d); day.setDate(d.getDate() - i); i++;
          var w = day.getDay(); if (w === 0 || w === 6) continue;
          var ds = ymdLocal(day);
          function rec(id, name, h, m, status, reason) {
            var t = new Date(day); t.setHours(h, m, 0, 0);
            out.push({ id: uid(), memberId: id, name: name, date: ds, status: status, checkInAt: t.toISOString(), reason: reason || '', createdAt: t.toISOString() });
          }
          rec('att-1', '홍길동', 8, 40 + (count % 3) * 5, 'present');
          if (count === 2) rec('att-2', '이영희', 9, 25, 'late'); else if (count === 5) rec('att-2', '이영희', 9, 40, 'excused', '병원 진료'); else rec('att-2', '이영희', 8, 50, 'present');
          if (count !== 4) rec('att-3', '박철수', 8, 55, 'present');
          count++;
        }
        return out;
      })(),
      attLeaves: [
        { id: uid(), memberId: 'att-3', name: '박철수', type: 'trip', startDate: at(3, 0).slice(0, 10), endDate: at(4, 0).slice(0, 10), days: 2, reason: '삼성전자 협력 미팅 (화성)', createdAt: daysAgo(2) },
        { id: uid(), memberId: 'att-1', name: '홍길동', type: 'vacation', startDate: at(8, 0).slice(0, 10), endDate: at(8, 0).slice(0, 10), days: 1, reason: '', createdAt: daysAgo(1) }
      ],
      attHolidays: null,
      invManagers: [
        { id: 'invm-1', name: '이영희', pinHash: DEMO_PIN_HASH, area: '클린룸 케미컬·기판', createdAt: daysAgo(90) },
        { id: 'invm-2', name: '박철수', pinHash: DEMO_PIN_HASH, area: '측정실 소모품', createdAt: daysAgo(90) }
      ],
      invItems: [
        { id: 'inv-1', name: '6인치 SiO2/Si 웨이퍼 (300 nm)', category: '웨이퍼·기판', unit: '매', location: '클린룸 캐비닛 A', qty: 18, unitPrice: 74000, minQty: 10, note: '', active: true, createdAt: daysAgo(60), updatedAt: daysAgo(2) },
        { id: 'inv-2', name: 'IPA (반도체급) 4 L', category: '케미컬·가스', unit: '병', location: '클린룸 케미컬 장', qty: 3, unitPrice: 42000, minQty: 4, note: '환기 후 사용', active: true, createdAt: daysAgo(60), updatedAt: daysAgo(1) },
        { id: 'inv-3', name: 'PR AZ5214E 500 mL', category: '케미컬·가스', unit: '병', location: '클린룸 케미컬 장', qty: 2, unitPrice: 310000, minQty: 1, note: '냉장 보관', active: true, createdAt: daysAgo(60), updatedAt: daysAgo(10) },
        { id: 'inv-4', name: 'Ti 스퍼터 타겟 2인치', category: '전구체·타겟', unit: '개', location: '클린룸 캐비닛 A', qty: 1, unitPrice: 480000, minQty: 1, note: '', active: true, createdAt: daysAgo(60), updatedAt: daysAgo(20) },
        { id: 'inv-5', name: '텅스텐 프로브 팁 (10개입)', category: '소모품·공구', unit: '팩', location: '측정실 서랍 2', qty: 4, unitPrice: 95000, minQty: 2, note: '', active: true, updatedAt: daysAgo(3), createdAt: daysAgo(60) },
        { id: 'inv-6', name: '니트릴 장갑 M (100매)', category: '소모품·공구', unit: '박스', location: '측정실 서랍 2', qty: 7, unitPrice: 12000, minQty: 3, note: '', active: true, updatedAt: daysAgo(1), createdAt: daysAgo(60) }
      ],
      invMoves: [
        { id: uid(), createdAt: daysAgo(60), itemId: 'inv-1', itemName: '6인치 SiO2/Si 웨이퍼 (300 nm)', location: '클린룸 캐비닛 A', type: 'init', qty: 25, unitPrice: 74000, userName: '이영희', note: '초기 보유량', stockAfter: 25 },
        { id: uid(), createdAt: daysAgo(12), itemId: 'inv-1', itemName: '6인치 SiO2/Si 웨이퍼 (300 nm)', location: '클린룸 캐비닛 A', type: 'out', qty: 5, unitPrice: 74000, userName: '홍길동', note: 'TMD 성장 기판', stockAfter: 20 },
        { id: uid(), createdAt: daysAgo(2), itemId: 'inv-1', itemName: '6인치 SiO2/Si 웨이퍼 (300 nm)', location: '클린룸 캐비닛 A', type: 'out', qty: 2, unitPrice: 74000, userName: '박철수', note: '패키징 시편', stockAfter: 18 },
        { id: uid(), createdAt: daysAgo(60), itemId: 'inv-2', itemName: 'IPA (반도체급) 4 L', location: '클린룸 케미컬 장', type: 'init', qty: 6, unitPrice: 42000, userName: '이영희', note: '초기 보유량', stockAfter: 6 },
        { id: uid(), createdAt: daysAgo(1), itemId: 'inv-2', itemName: 'IPA (반도체급) 4 L', location: '클린룸 케미컬 장', type: 'out', qty: 3, unitPrice: 42000, userName: '이영희', note: '세정', stockAfter: 3 },
        { id: uid(), createdAt: daysAgo(60), itemId: 'inv-5', itemName: '텅스텐 프로브 팁 (10개입)', location: '측정실 서랍 2', type: 'init', qty: 6, unitPrice: 95000, userName: '박철수', note: '초기 보유량', stockAfter: 6 },
        { id: uid(), createdAt: daysAgo(3), itemId: 'inv-5', itemName: '텅스텐 프로브 팁 (10개입)', location: '측정실 서랍 2', type: 'out', qty: 2, unitPrice: 95000, userName: '홍길동', note: '', stockAfter: 4 }
      ],
      projects: [
        { id: p1, code: '2026-A01', name: '차세대 AI 반도체 모놀리식 3D 집적 기술', budgets: { material: 25000000, activity: 10000000, equipment: 15000000, meeting: 3000000, other: 0 }, startDate: '2026-03-01', endDate: '2027-02-28', manager: '김교수', note: '재료비 위주 집행', active: true, createdAt: daysAgo(120) },
        { id: p2, code: '2026-B07', name: '산화물 반도체 기반 DRAM 셀 소자 개발', budgets: { material: 18000000, activity: 7000000, equipment: 5000000, meeting: 2000000, other: 0 }, startDate: '2026-01-01', endDate: '2026-12-31', manager: '김교수', note: '', active: true, createdAt: daysAgo(200) },
        { id: p3, code: '2025-C03', name: '이종 집적 첨단 패키징 기초연구', budgets: { material: 8000000, activity: 4000000, equipment: 8000000, meeting: 1000000, other: 0 }, startDate: '2025-09-01', endDate: '2026-08-31', manager: '김교수', note: '종료 임박, 잔액 소진 우선', active: true, createdAt: daysAgo(370) }
      ],
      requests: [
        { id: uid(), createdAt: daysAgo(1), requesterId: 'demo-1', requesterName: '홍길동', item: '6인치 SiO2/Si 웨이퍼 25매', category: 'material', link: 'https://example.com/wafer', qty: 1, unitPrice: 1850000, amount: 1850000, note: 'TMD 성장용 기판', status: 'pending', projectId: null, reviewId: null, adminNote: '', processedAt: null, processedBy: null },
        { id: uid(), createdAt: daysAgo(2), requesterId: 'demo-2', requesterName: '이영희', item: 'PDMS 스탬프 세트 (Gel-Pak)', category: 'material', link: '', qty: 3, unitPrice: 120000, amount: 360000, note: '전사 공정용', status: 'pending', projectId: null, reviewId: null, adminNote: '', processedAt: null, processedBy: null },
        { id: uid(), createdAt: daysAgo(3), requesterId: 'demo-3', requesterName: '박철수', item: '프로브 스테이션 텅스텐 팁 (10개)', category: 'equipment', link: 'https://example.com/tip', qty: 2, unitPrice: 95000, amount: 190000, note: '', status: 'pending', projectId: null, reviewId: null, adminNote: '', processedAt: null, processedBy: null },
        { id: uid(), createdAt: daysAgo(9), requesterId: 'demo-1', requesterName: '홍길동', item: 'HfO2 ALD 전구체 (TDMAH) 25 g', category: 'material', link: '', qty: 1, unitPrice: 2400000, amount: 2400000, note: '', status: 'done', projectId: p2, reviewId: null, adminNote: '', processedAt: daysAgo(8), processedBy: '관리자' },
        { id: uid(), createdAt: daysAgo(14), requesterId: 'demo-2', requesterName: '이영희', item: 'Keithley 2636B 케이블/픽스처', category: 'equipment', link: '', qty: 1, unitPrice: 780000, amount: 780000, note: '심의 승인분 1차 구매', status: 'done', projectId: p1, reviewId: rv1, adminNote: '', processedAt: daysAgo(13), processedBy: '관리자' },
        { id: uid(), createdAt: daysAgo(20), requesterId: 'demo-3', requesterName: '박철수', item: 'Cu 필러 범프 시편 가공 외주', category: 'activity', link: '', qty: 1, unitPrice: 4500000, amount: 4500000, note: '패키징 실험용', status: 'done', projectId: p3, reviewId: null, adminNote: '', processedAt: daysAgo(19), processedBy: '관리자' },
        { id: uid(), createdAt: daysAgo(25), requesterId: 'demo-1', requesterName: '홍길동', item: '노트북 (개인 사용)', category: 'equipment', link: '', qty: 1, unitPrice: 2100000, amount: 2100000, note: '', status: 'rejected', projectId: null, reviewId: null, adminNote: '개인 장비는 과제 예산 집행 불가', processedAt: daysAgo(24), processedBy: '관리자' }
      ],
      reviews: [
        { id: rv1, createdAt: daysAgo(30), requesterId: 'demo-2', requesterName: '이영희', title: '반도체 파라미터 분석기 액세서리 구매', purpose: 'Keithley 2636B 측정 셋업 보강 (프로브 카드, 케이블)', vendor: '텍트로닉스 코리아 견적 2건', category: 'equipment',
          items: [{ name: '케이블/픽스처 세트', amount: 780000 }, { name: '프로브 카드 및 어댑터', amount: 4200000 }], amount: 4980000, note: '', pinHash: DEMO_PIN_HASH,
          status: 'approved', projectId: p1, approvedAmount: 4980000, adminNote: '2026-A01 장비구매비로 가할당', processedAt: daysAgo(28), processedBy: '관리자' },
        { id: rv2, createdAt: daysAgo(2), requesterId: 'demo-3', requesterName: '박철수', title: '플라즈마 에처 소모품 및 챔버 부품', purpose: '패키징 공정 안정화용 전극·실링 교체', vendor: 'A사 견적 1건 (2026-09-04)', category: 'material',
          items: [{ name: '전극 세트', amount: 6500000 }, { name: 'O-ring 및 실링 키트', amount: 1200000 }], amount: 7700000, note: '전극은 납기 6주', pinHash: DEMO_PIN_HASH,
          status: 'pending', projectId: null, approvedAmount: null, adminNote: '', processedAt: null, processedBy: null }
      ],
      exports: [
        { id: uid(), createdAt: daysAgo(5), exportedById: 'demo-admin', exportedBy: '관리자', purpose: '8월 과제 할당 보고', format: 'print', count: 3, totalAmount: 7680000,
          filter: { from: daysAgo(40).slice(0, 10), to: daysAgo(5).slice(0, 10), projectId: 'all', includeRequests: true, includeReviews: false },
          rows: [
            { key: 'req:seed-1', kind: '실집행', date: daysAgo(8).slice(0, 10), requester: '홍길동', title: 'HfO2 ALD 전구체 (TDMAH) 25 g', category: '재료비', project: '산화물 반도체 기반 DRAM 셀 소자 개발', code: '2026-B07', amount: 2400000, actual: 2400000, provisional: 0, by: '관리자', note: '' },
            { key: 'req:seed-2', kind: '실집행', date: daysAgo(13).slice(0, 10), requester: '이영희', title: 'Keithley 2636B 케이블/픽스처', category: '장비구매비', project: '차세대 AI 반도체 모놀리식 3D 집적 기술', code: '2026-A01', amount: 780000, actual: 780000, provisional: 0, by: '관리자', note: '심의 승인분 1차 구매' },
            { key: 'req:seed-3', kind: '실집행', date: daysAgo(19).slice(0, 10), requester: '박철수', title: 'Cu 필러 범프 시편 가공 외주', category: '연구활동비', project: '이종 집적 첨단 패키징 기초연구', code: '2025-C03', amount: 4500000, actual: 4500000, provisional: 0, by: '관리자', note: '패키징 실험용' }
          ] }
      ]
    };
  }

  /* 이전 버전 데이터를 현재 형태로 맞춤 */
  function migrate(data, cfg) {
    var ids = categoryIds(cfg);
    var first = ids[0];
    (data.projects || []).forEach(function (p) {
      if (!p.budgets || typeof p.budgets !== 'object') {
        p.budgets = {};
        p.budgets[first] = Number(p.budget) || 0;
      }
      delete p.budget;
      if (p.accountManager === undefined) p.accountManager = '';
      if (!Array.isArray(p.cardUsers)) p.cardUsers = [];   /* 카드 실사용자(참여연구원) 목록 */
      if (!Array.isArray(p.owners)) p.owners = [];            /* 과제 담당자 이름 목록 — 관리자가 아니어도 이 과제 예산을 봄 */
      if (p.alias === undefined) p.alias = '';               /* 참여과제 시트의 과제 약칭 */
      if (!Array.isArray(p.participants)) p.participants = []; /* [{ name, months:{ '2026-09': true } }] 회의비 참석자 후보 */
    });
    if (data.participationImport === undefined) data.participationImport = null;
    if (!Array.isArray(data.participationRows)) data.participationRows = [];
    if (!Array.isArray(data.meetingLogs)) data.meetingLogs = [];   /* 회의비 처리 로그 (추가만, 삭제 없음) */
    (data.requests || []).forEach(function (r) {
      if (!r.category || ids.indexOf(r.category) < 0) r.category = first;
      if (r.reviewId === undefined) r.reviewId = null;
      if (!r.kind) r.kind = 'purchase';           /* purchase(구매) | meeting(회의비) */
      if (!r.meta || typeof r.meta !== 'object') r.meta = {};
      if (r.report === undefined) r.report = null; /* 구매 보고서 { status:'draft'|'submitted'|'verified', ... } */
    });
    if (!Array.isArray(data.reviews)) data.reviews = [];
    if (!Array.isArray(data.exports)) data.exports = [];
    if (!Array.isArray(data.equipment)) data.equipment = [];
    if (!Array.isArray(data.reservations)) data.reservations = [];
    if (!Array.isArray(data.usageLogs)) data.usageLogs = [];
    data.equipment.forEach(function (eq) {
      if (!Array.isArray(eq.users)) eq.users = [];
      eq.users.forEach(function (u) { if (!u.grade) u.grade = 'user'; delete u.pinHash; }); /* 이전 버전: 사용자 PIN → 등급 */
    });
    if (!Array.isArray(data.attMembers)) data.attMembers = [];
    if (!Array.isArray(data.attRecords)) data.attRecords = [];
    if (!Array.isArray(data.attLeaves)) data.attLeaves = [];
    if (!data.attHolidays || typeof data.attHolidays !== 'object') data.attHolidays = Object.assign({}, attendanceCfg(cfg).holidays);
    if (!Array.isArray(data.invManagers)) data.invManagers = [];
    if (!Array.isArray(data.invItems)) data.invItems = [];
    if (!Array.isArray(data.invMoves)) data.invMoves = [];
    if (!Array.isArray(data.security)) data.security = [];
    if (!Array.isArray(data.accounts)) data.accounts = [];
    if (!data.accounts.some(function (a) { return a.role === 'admin'; })) {
      data.accounts.unshift({ id: SUPER_ADMIN.id, name: SUPER_ADMIN.name, pinHash: '', seedPin: SUPER_ADMIN.seedPin, role: 'admin', status: 'active', createdAt: nowISO(), approvedAt: nowISO(), approvedBy: '시스템' });
    }
    /* config.dataReset: 같은 id 로는 한 번만 실행. 과제·참여연구원·장비·소모품 품목은 그대로 두고 기록만 지움 */
    var reset = cfg.dataReset;
    if (reset && reset.id && data.dataResetId !== reset.id) {
      if (reset.clearLogs) {
        data.requests = []; data.reviews = []; data.exports = [];
        data.reservations = []; data.usageLogs = [];
        data.meetingLogs = []; data.invMoves = []; data.security = [];
        data.attRecords = []; data.attLeaves = [];
        /* 소모품 품목은 남기되 이력이 사라졌으므로 재고 기준을 현재 값으로 둠 */
      }
      if (reset.pruneAccounts) {
        var keep = (cfg.defaultAccounts || []).map(function (d) { return nameKey(d.name); });
        data.accounts = data.accounts.filter(function (a) { return a.role === 'admin' || keep.indexOf(nameKey(a.name)) >= 0; });
      }
      data.dataResetId = reset.id;
    }
    /* config.defaultAccounts / defaultEquipment: 이름 기준으로 없을 때만 만들어 둠 (PIN 은 ensureSeedHashes 가 해시) */
    (cfg.defaultAccounts || []).forEach(function (d) {
      if (!d || !d.name) return;
      if (data.accounts.some(function (a) { return nameKey(a.name) === nameKey(d.name); })) return;
      data.accounts.push({ id: uid(), name: String(d.name).trim(), pinHash: '', seedPin: String(d.pin || '0000'), role: d.role === 'admin' ? 'admin' : 'member', status: 'active', createdAt: nowISO(), approvedAt: nowISO(), approvedBy: '시스템 (기본 계정)' });
    });
    (cfg.defaultEquipment || []).forEach(function (d) {
      if (!d || !d.name) return;
      if (data.equipment.some(function (e) { return nameKey(e.name) === nameKey(d.name); })) return;
      data.equipment.push({
        id: uid(), name: String(d.name).trim(), location: d.location || '', managerName: d.managerName || '', managerPinHash: '', seedManagerPin: d.managerPin ? String(d.managerPin) : '',
        description: d.description || '', rules: d.rules || '', color: d.color || '#004191', active: true, createdAt: nowISO(),
        users: (d.users || []).map(function (u) { return { id: uid(), name: String(u.name || '').trim(), grade: u.grade || 'user', grantedAt: nowISO(), grantedBy: '시스템 (기본 설정)' }; }).filter(function (u) { return u.name; })
      });
    });
    return data;
  }

  function publicInvManager(m) { return { id: m.id, name: m.name, area: m.area || '', createdAt: m.createdAt }; }
  function publicAccount(a) { return { id: a.id, name: a.name, role: a.role || 'member', status: a.status || 'pending', createdAt: a.createdAt, approvedAt: a.approvedAt || null, approvedBy: a.approvedBy || null, signatureKey: a.signatureKey || null }; }

  /* ---------- 사진 저장소 (IndexedDB) – localStorage 용량 한계를 피하기 위해 사진은 따로 보관 ---------- */
  var IDB_NAME = 'dsil-portal-photos', IDB_STORE = 'photos';
  function idb() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('이 브라우저는 사진 저장을 지원하지 않습니다.')); return; }
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB 열기 실패')); };
    });
  }
  function idbPut(key, value) {
    return idb().then(function (db) { return new Promise(function (resolve, reject) { var tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).put(value, key); tx.oncomplete = function () { resolve(key); }; tx.onerror = function () { reject(tx.error); }; }); });
  }
  function idbGet(key) {
    return idb().then(function (db) { return new Promise(function (resolve, reject) { var tx = db.transaction(IDB_STORE, 'readonly'); var rq = tx.objectStore(IDB_STORE).get(key); rq.onsuccess = function () { resolve(rq.result || null); }; rq.onerror = function () { reject(rq.error); }; }); });
  }
  function idbDelete(key) {
    return idb().then(function (db) { return new Promise(function (resolve, reject) { var tx = db.transaction(IDB_STORE, 'readwrite'); tx.objectStore(IDB_STORE).delete(key); tx.oncomplete = function () { resolve(); }; tx.onerror = function () { reject(tx.error); }; }); });
  }

  /* 보안 이벤트 알림 (Discord/Slack incoming webhook). 실패해도 앱 흐름은 막지 않음 */
  function sendWebhook(url, text) {
    if (!url || !window.fetch) return;
    try {
      fetch(url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: text, text: text }) }).catch(function () { /* ignore */ });
    } catch (e) { /* ignore */ }
  }
  function buildSecurityEvent(ev) {
    return {
      id: uid(), createdAt: nowISO(), type: String(ev.type || 'other'), severity: ev.severity === 'high' ? 'high' : 'low',
      name: String(ev.name || '').trim(), detail: String(ev.detail || ''), page: (window.location.pathname || '').split('/').slice(-2).join('/'),
      userAgent: (navigator.userAgent || '').slice(0, 160)
    };
  }
  function alertText(rec) {
    return '[DSIL Portal 보안] ' + { login_failed: '로그인 실패', login_lockout: '로그인 잠금', login_locked_attempt: '잠금 중 시도', macro_suspect: '매크로 의심' }[rec.type] + ' · ' + (rec.name || '(이름 없음)') + ' · ' + rec.detail + ' · ' + rec.page + ' · ' + new Date(rec.createdAt).toLocaleString('ko-KR');
  }

  function limitedReview(rv) {
    return { id: rv.id, createdAt: rv.createdAt, requesterId: rv.requesterId, requesterName: rv.requesterName, title: rv.title, status: rv.status, processedAt: rv.processedAt, limited: true };
  }

  /* ------------------------------------------------------------------ */
  /*  Local adapter (localStorage)                                       */
  /* ------------------------------------------------------------------ */
  function LocalStore(cfg) {
    var data = null;
    var session = null;
    var listeners = [];

    function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) { console.error(e); } }); }

    function read() {
      try { data = JSON.parse(localStorage.getItem(DATA_KEY) || 'null'); } catch (e) { data = null; }
      if (!data || !Array.isArray(data.projects) || !Array.isArray(data.requests)) {
        data = cfg.seedDemoData ? seedData() : emptyData();
        migrate(data, cfg);
        write();
      } else {
        var prevReset = data.dataResetId;
        migrate(data, cfg);
        if (data.dataResetId !== prevReset) write();   /* 일회성 초기화는 바로 저장해 다시 돌지 않게 */
      }
    }

    function write() {
      try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) { console.warn('localStorage write failed', e); }
    }

    function accountById(id) { return data.accounts.filter(function (a) { return a.id === id; })[0] || null; }

    /* 시드 계정의 평문 PIN 을 해시로 바꿔 저장 (관리자 / 0000) */
    function ensureSeedHashes() {
      var todo = data.accounts.filter(function (a) { return !a.pinHash && a.seedPin; });
      var todoEq = data.equipment.filter(function (e) { return !e.managerPinHash && e.seedManagerPin; });
      if (!todo.length && !todoEq.length) return Promise.resolve();
      return Promise.all(
        todo.map(function (a) { return hashPin(a.seedPin).then(function (h) { a.pinHash = h; delete a.seedPin; }); })
          .concat(todoEq.map(function (e) { return hashPin(e.seedManagerPin).then(function (h) { e.managerPinHash = h; delete e.seedManagerPin; }); }))
      ).then(function () { write(); });
    }

    function readSession() {
      try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
      if (!session || !session.user) { session = null; return; }
      var acc = accountById(session.user.id);
      if (!acc || acc.status !== 'active') { session = null; writeSession(); return; } /* 이름만으로 만든 옛 세션·미승인 계정은 무효 */
      session = { user: { id: acc.id, name: acc.name, email: '' }, isAdmin: acc.role === 'admin', status: 'active' };
    }

    function writeSession() {
      try {
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
      } catch (e) { /* ignore */ }
    }

    function clone(x) { return JSON.parse(JSON.stringify(x)); }
    function needSession() { return session ? null : new Error('로그인이 필요합니다.'); }

    /* 장비 담당자 권한: 로그인한 사람이 그 장비의 담당자로 지정돼 있어야 함 (포털 관리자는 모든 장비) */
    function isDesignatedManager(eq) {
      if (!session || !eq) return false;
      if (session.isAdmin) return true;
      return !!eq.managerName && nameKey(eq.managerName) === nameKey(session.user.name);
    }
    function managerDeniedMsg(eq) {
      return '이 장비의 담당자로 지정된 계정이 아닙니다. 담당자는 ' + ((eq && eq.managerName) ? eq.managerName : '미지정') + ' 입니다. 관리자에게 담당자 변경을 요청하세요.';
    }
    /* 소모품 중간 관리자: 등록된 담당자 이름과 로그인 이름이 같아야 함 (포털 관리자는 전체) */
    function isInvManager(m) {
      if (!session || !m) return false;
      if (session.isAdmin) return true;
      return nameKey(m.name) === nameKey(session.user.name);
    }
    function invDeniedMsg(m) {
      return '소모품 담당자로 등록된 계정이 아닙니다. 이 항목의 담당자는 ' + ((m && m.name) ? m.name : '미지정') + ' 입니다. 관리자에게 담당자 등록을 요청하세요.';
    }
    /* 담당자 확인 + PIN. creds = { managerId, pin } */
    function checkInvManager(creds) {
      var err = needSession(); if (err) return Promise.reject(err);
      var m = data.invManagers.filter(function (x) { return x.id === (creds && creds.managerId); })[0];
      if (!m) return Promise.reject(new Error('중간 관리자 확인이 필요합니다.'));
      if (!isInvManager(m)) return Promise.reject(new Error(invDeniedMsg(m)));
      return hashPin(creds.pin).then(function (h) {
        if (h !== m.pinHash) throw new Error('담당자 PIN이 올바르지 않습니다.');
        return m;
      });
    }

    /* managerPin === null 이면 포털 관리자 경로, 아니면 담당자 이름 + PIN 을 함께 확인 */
    function checkManager(eq, managerPin) {
      var err = needSession(); if (err) return Promise.reject(err);
      if (!eq) return Promise.reject(new Error('장비를 찾을 수 없습니다.'));
      if (managerPin === null) return Promise.resolve(!!(session && session.isAdmin));
      if (!isDesignatedManager(eq)) return Promise.reject(new Error(managerDeniedMsg(eq)));
      return hashPin(managerPin).then(function (h) { return h === eq.managerPinHash; });
    }

    window.addEventListener('storage', function (e) {
      if (e.key === DATA_KEY) { read(); emit(); }
    });

    return {
      mode: 'local',

      init: function () {
        read();
        return ensureSeedHashes().then(function () {
          readSession();
          /* 저장소에 담긴 참여과제 시트(assets/data/participation.js)가 새 파일이면 그대로 가져옴 */
          var P = window.DSIL_PARTICIPATION;
          if (P && P.source && (!data.participationImport || data.participationImport.source !== P.source || !data.participationRows.length)) { applyParticipation(data, P, '시트 파일'); delete data.merged; write(); }
        });
      },

      getSession: function () { return session ? clone(session) : null; },

      /* 포털 로그인: 이름 + PIN. 승인된(active) 계정만 통과 */
      signIn: function (payload) {
        var name = (payload && payload.name || '').trim();
        var pin = String(payload && payload.pin || '');
        if (!name) return Promise.reject(new Error('이름을 입력하세요.'));
        var acc = data.accounts.filter(function (a) { return nameKey(a.name) === nameKey(name); })[0];
        if (!acc) return Promise.reject(new Error('등록되지 않은 이름입니다. 회원가입을 신청하세요.'));
        if (acc.status === 'pending') return Promise.reject(new Error('관리자 승인 대기 중입니다. 승인 후 로그인할 수 있습니다.'));
        if (acc.status === 'rejected') return Promise.reject(new Error('가입 신청이 거절되었습니다. 관리자에게 문의하세요.'));
        if (acc.status === 'disabled') return Promise.reject(new Error('사용이 중지된 계정입니다.'));
        return hashPin(pin).then(function (h) {
          if (h !== acc.pinHash) throw new Error('PIN이 올바르지 않습니다.');
          session = { user: { id: acc.id, name: acc.name, email: '' }, isAdmin: acc.role === 'admin', status: 'active' };
          writeSession(); emit();
          return clone(session);
        });
      },

      /* 회원가입 신청: 관리자가 승인해야 로그인 가능 */
      signUp: function (payload) {
        var name = (payload && payload.name || '').trim();
        var pin = String(payload && payload.pin || '');
        if (!name) return Promise.reject(new Error('이름을 입력하세요.'));
        if (!/^\d{4,8}$/.test(pin)) return Promise.reject(new Error('PIN은 숫자 4~8자리입니다.'));
        var dup = data.accounts.filter(function (a) { return nameKey(a.name) === nameKey(name); })[0];
        if (dup) return Promise.reject(new Error(dup.status === 'pending' ? '이미 승인 대기 중인 이름입니다.' : '이미 등록된 이름입니다. 로그인하세요.'));
        return hashPin(pin).then(function (h) {
          var acc = { id: uid(), name: name, pinHash: h, role: 'member', status: 'pending', createdAt: nowISO(), approvedAt: null, approvedBy: null };
          data.accounts.push(acc); write(); emit();
          return publicAccount(acc);
        });
      },

      signOut: function () { session = null; writeSession(); emit(); return Promise.resolve(); },

      /* ---------- 보안 이벤트 ---------- */
      securityEvent: function (ev) {
        var rec = buildSecurityEvent(ev);
        data.security.unshift(rec);
        if (data.security.length > 500) data.security.length = 500;
        write(); emit();
        if (rec.severity === 'high' && cfg.security && cfg.security.alertWebhookUrl) sendWebhook(cfg.security.alertWebhookUrl, alertText(rec));
        return Promise.resolve(clone(rec));
      },
      listSecurityEvents: function () { return Promise.resolve(clone(data.security)); },

      /* ---------- 계정 관리 (관리자) ---------- */
      listAccounts: function () { return Promise.resolve(data.accounts.map(publicAccount)); },

      approveAccount: function (id) {
        var a = accountById(id); if (!a) return Promise.reject(new Error('계정을 찾을 수 없습니다.'));
        a.status = 'active'; a.approvedAt = nowISO(); a.approvedBy = session ? session.user.name : '관리자';
        write(); emit(); return Promise.resolve(publicAccount(a));
      },

      rejectAccount: function (id) {
        var a = accountById(id); if (!a) return Promise.reject(new Error('계정을 찾을 수 없습니다.'));
        if (a.status === 'pending') data.accounts = data.accounts.filter(function (x) { return x.id !== id; });
        else a.status = 'rejected';
        write(); emit(); return Promise.resolve();
      },

      setAccountStatus: function (id, status) {
        var a = accountById(id); if (!a) return Promise.reject(new Error('계정을 찾을 수 없습니다.'));
        if (a.role === 'admin' && status !== 'active' && data.accounts.filter(function (x) { return x.role === 'admin' && x.status === 'active'; }).length <= 1) return Promise.reject(new Error('마지막 관리자 계정은 중지할 수 없습니다.'));
        a.status = status; write(); emit(); return Promise.resolve(publicAccount(a));
      },

      setAccountRole: function (id, role) {
        var a = accountById(id); if (!a) return Promise.reject(new Error('계정을 찾을 수 없습니다.'));
        if (a.role === 'admin' && role !== 'admin' && data.accounts.filter(function (x) { return x.role === 'admin' && x.status === 'active'; }).length <= 1) return Promise.reject(new Error('마지막 관리자 계정의 권한은 내릴 수 없습니다.'));
        a.role = role === 'admin' ? 'admin' : 'member'; write(); emit();
        if (session && session.user.id === id) { session.isAdmin = a.role === 'admin'; writeSession(); }
        return Promise.resolve(publicAccount(a));
      },

      resetAccountPin: function (id, pin) {
        var a = accountById(id); if (!a) return Promise.reject(new Error('계정을 찾을 수 없습니다.'));
        if (!/^\d{4,8}$/.test(String(pin || ''))) return Promise.reject(new Error('PIN은 숫자 4~8자리입니다.'));
        return hashPin(pin).then(function (h) { a.pinHash = h; write(); emit(); return publicAccount(a); });
      },

      changeMyPin: function (oldPin, newPin) {
        if (!session) return Promise.reject(new Error('로그인이 필요합니다.'));
        var a = accountById(session.user.id); if (!a) return Promise.reject(new Error('계정을 찾을 수 없습니다.'));
        if (!/^\d{4,8}$/.test(String(newPin || ''))) return Promise.reject(new Error('새 PIN은 숫자 4~8자리입니다.'));
        return Promise.all([hashPin(oldPin), hashPin(newPin)]).then(function (hs) {
          if (hs[0] !== a.pinHash) throw new Error('현재 PIN이 올바르지 않습니다.');
          a.pinHash = hs[1]; write(); emit();
        });
      },

      verifyAdminPin: function (pin) { return Promise.resolve(String(pin) === String(cfg.adminPin)); },

      listProjects: function () { return Promise.resolve(clone(data.projects)); },

      saveProject: function (p) {
        var idx = data.projects.findIndex(function (x) { return x.id === p.id; });
        var rec = Object.assign({}, idx >= 0 ? data.projects[idx] : { id: uid(), createdAt: nowISO() }, p);
        if (!rec.id) rec.id = uid();
        if (!rec.budgets || typeof rec.budgets !== 'object') rec.budgets = {};
        if (!Array.isArray(rec.cardUsers)) rec.cardUsers = [];
        if (!Array.isArray(rec.owners)) rec.owners = [];
        if (idx >= 0) data.projects[idx] = rec; else data.projects.push(rec);
        write(); emit();
        return Promise.resolve(clone(rec));
      },

      /* ---------- 참여과제 시트 ---------- */
      importParticipation: function (payload) {
        var err = needSession(); if (err) return Promise.reject(err);
        var info = applyParticipation(data, payload, session.user.name);
        delete data.merged; write(); emit();
        return Promise.resolve(info);
      },
      getParticipationInfo: function () { return Promise.resolve(data.participationImport ? clone(data.participationImport) : null); },
      getParticipationRows: function () { return Promise.resolve(clone(data.participationRows || [])); },
      /* 과제에 시트 약칭 연결(같은 약칭의 자동 생성 과제는 병합) */
      linkProjectAlias: function (projectId, alias) {
        var err = needSession(); if (err) return Promise.reject(err);
        var p = linkAlias(data, projectId, alias);
        delete data.merged; write(); emit();
        return Promise.resolve(clone(p));
      },
      /* 과제 목록 전체를 시트와 맞춤 (약칭 자동 매칭·병합·없는 과제는 자기 이름을 약칭으로) */
      syncProjectsWithSheet: function () {
        var err = needSession(); if (err) return Promise.reject(err);
        var res = syncSheet(data);
        delete data.merged; write(); emit();
        return Promise.resolve(res);
      },

      /* ---------- 회의비 처리 로그 (추가만 가능) ---------- */
      addMeetingLog: function (entry) {
        var err = needSession(); if (err) return Promise.reject(err);
        var rec = meetingLogEntry(entry, session.user);
        data.meetingLogs.unshift(rec);
        write(); emit();
        return Promise.resolve(clone(rec));
      },
      listMeetingLogs: function () { return Promise.resolve(clone(data.meetingLogs || [])); },

      /* ---------- 구매 보고서 · 사진 ---------- */
      savePhoto: function (dataUrl) { var key = 'ph-' + uid(); return idbPut(key, dataUrl).then(function () { return key; }); },
      loadPhoto: function (key) { return key ? idbGet(key) : Promise.resolve(null); },
      deletePhoto: function (key) { return key ? idbDelete(key).catch(function () {}) : Promise.resolve(); },

      saveReport: function (requestId, report) {
        var err = needSession(); if (err) return Promise.reject(err);
        var idx = data.requests.findIndex(function (x) { return x.id === requestId; });
        if (idx < 0) return Promise.reject(new Error('요청을 찾을 수 없습니다.'));
        var r = data.requests[idx];
        if (r.status !== 'done') return Promise.reject(new Error('관리자가 과제를 배정(승인)한 뒤에 보고서를 작성할 수 있습니다.'));
        var prev = r.report || {};
        var rec = Object.assign({}, prev, report, { updatedAt: nowISO(), updatedBy: session.user.name });
        if (!rec.createdAt) rec.createdAt = nowISO();
        if (rec.status === 'submitted' && prev.status !== 'submitted') { rec.submittedAt = nowISO(); rec.submittedBy = session.user.name; }
        if (rec.status !== 'verified') { delete rec.verifiedAt; delete rec.verifiedBy; }
        r.report = rec;
        write(); emit();
        return Promise.resolve(clone(rec));
      },

      verifyReport: function (requestId, ok, note) {
        var err = needSession(); if (err) return Promise.reject(err);
        var r = data.requests.filter(function (x) { return x.id === requestId; })[0];
        if (!r || !r.report) return Promise.reject(new Error('제출된 보고서가 없습니다.'));
        if (ok) { r.report.status = 'verified'; r.report.verifiedAt = nowISO(); r.report.verifiedBy = session.user.name; r.report.adminNote = String(note || '').trim(); }
        else { r.report.status = 'draft'; r.report.adminNote = String(note || '').trim(); delete r.report.verifiedAt; delete r.report.verifiedBy; }
        write(); emit();
        return Promise.resolve(clone(r.report));
      },

      setMySignature: function (key) {
        var err = needSession(); if (err) return Promise.reject(err);
        var a = accountById(session.user.id); if (!a) return Promise.reject(new Error('계정을 찾을 수 없습니다.'));
        a.signatureKey = key || null; write(); emit();
        return Promise.resolve(publicAccount(a));
      },
      getAccount: function (id) { var a = accountById(id); return Promise.resolve(a ? publicAccount(a) : null); },
      signatureByName: function (name) {
        var a = data.accounts.filter(function (x) { return nameKey(x.name) === nameKey(name); })[0];
        return Promise.resolve(a && a.signatureKey ? a.signatureKey : null);
      },

      deleteProject: function (id) {
        var used = data.requests.some(function (r) { return r.projectId === id; }) || data.reviews.some(function (r) { return r.projectId === id; });
        if (used) return Promise.reject(new Error('배정된 구매건이나 심의가 있는 과제는 삭제할 수 없습니다. 종료 처리하세요.'));
        data.projects = data.projects.filter(function (x) { return x.id !== id; });
        write(); emit();
        return Promise.resolve();
      },

      listRequests: function () { return Promise.resolve(clone(data.requests)); },

      createRequest: function (r) {
        var err = needSession(); if (err) return Promise.reject(err);
        var rec = Object.assign({
          id: uid(), createdAt: nowISO(),
          requesterId: session.user.id, requesterName: session.user.name,
          kind: 'purchase', meta: {},
          status: 'pending', projectId: null, reviewId: null, adminNote: '', processedAt: null, processedBy: null
        }, r);
        if (rec.kind !== 'meeting') rec.kind = 'purchase';
        data.requests.unshift(rec);
        write(); emit();
        return Promise.resolve(clone(rec));
      },

      updateRequest: function (id, patch) {
        var idx = data.requests.findIndex(function (x) { return x.id === id; });
        if (idx < 0) return Promise.reject(new Error('요청을 찾을 수 없습니다.'));
        data.requests[idx] = Object.assign({}, data.requests[idx], patch);
        write(); emit();
        return Promise.resolve(clone(data.requests[idx]));
      },

      deleteRequest: function (id) {
        data.requests = data.requests.filter(function (x) { return x.id !== id; });
        write(); emit();
        return Promise.resolve();
      },

      listReviews: function (opts) {
        var full = !!(opts && opts.full);
        var list = data.reviews.slice();
        if (!full) {
          var me = session ? session.user.id : null;
          list = list.filter(function (rv) { return rv.requesterId === me; }).map(limitedReview);
        }
        return Promise.resolve(clone(list));
      },

      createReview: function (rv) {
        var err = needSession(); if (err) return Promise.reject(err);
        if (!rv.pinHash) return Promise.reject(new Error('열람 PIN이 필요합니다.'));
        var rec = Object.assign({
          id: uid(), createdAt: nowISO(),
          requesterId: session.user.id, requesterName: session.user.name,
          status: 'pending', projectId: null, approvedAmount: null, adminNote: '', processedAt: null, processedBy: null
        }, rv);
        data.reviews.unshift(rec);
        write(); emit();
        return Promise.resolve(limitedReview(rec));
      },

      updateReview: function (id, patch) {
        var idx = data.reviews.findIndex(function (x) { return x.id === id; });
        if (idx < 0) return Promise.reject(new Error('심의를 찾을 수 없습니다.'));
        data.reviews[idx] = Object.assign({}, data.reviews[idx], patch);
        write(); emit();
        return Promise.resolve(clone(data.reviews[idx]));
      },

      deleteReview: function (id) {
        if (data.requests.some(function (r) { return r.reviewId === id; })) return Promise.reject(new Error('이 심의에 연결된 구매 요청이 있어 삭제할 수 없습니다.'));
        data.reviews = data.reviews.filter(function (x) { return x.id !== id; });
        write(); emit();
        return Promise.resolve();
      },

      openReview: function (id, pin) {
        var rv = data.reviews.filter(function (x) { return x.id === id; })[0];
        if (!rv) return Promise.resolve(null);
        return hashPin(pin).then(function (h) { return h === rv.pinHash ? clone(rv) : null; });
      },

      listExports: function () { return Promise.resolve(clone(data.exports)); },

      /* 이력은 추가만 가능 (삭제 API 없음) */
      createExport: function (log) {
        var err = needSession(); if (err) return Promise.reject(err);
        var rec = Object.assign({ id: uid(), createdAt: nowISO(), exportedById: session.user.id, exportedBy: session.user.name }, log);
        data.exports.unshift(rec);
        write(); emit();
        return Promise.resolve(clone(rec));
      },

      /* ---------- 장비 예약 ---------- */
      listEquipment: function () { return Promise.resolve(data.equipment.map(publicEquipment)); },

      saveEquipment: function (eq, opts) {
        var idx = data.equipment.findIndex(function (x) { return x.id === eq.id; });
        var base = idx >= 0 ? data.equipment[idx] : { id: uid(), createdAt: nowISO(), users: [], managerPinHash: '' };
        var rec = Object.assign({}, base, { name: eq.name, location: eq.location || '', managerName: eq.managerName || '', description: eq.description || '', rules: eq.rules || '', color: eq.color || '#004191', active: eq.active !== false });
        var p = (opts && opts.managerPin) ? hashPin(opts.managerPin).then(function (h) { rec.managerPinHash = h; }) : Promise.resolve();
        return p.then(function () {
          if (idx >= 0) data.equipment[idx] = rec; else data.equipment.push(rec);
          write(); emit();
          return publicEquipment(rec);
        });
      },

      deleteEquipment: function (id) {
        if (data.reservations.some(function (r) { return r.equipmentId === id; })) return Promise.reject(new Error('예약 기록이 있는 장비는 삭제할 수 없습니다. 비활성으로 바꾸세요.'));
        data.equipment = data.equipment.filter(function (x) { return x.id !== id; });
        write(); emit();
        return Promise.resolve();
      },

      verifyManager: function (equipmentId, pin) {
        var eq = data.equipment.filter(function (x) { return x.id === equipmentId; })[0];
        if (!eq || !eq.managerPinHash) return Promise.resolve(false);
        if (!isDesignatedManager(eq)) return Promise.reject(new Error(managerDeniedMsg(eq)));
        return hashPin(pin).then(function (h) { return h === eq.managerPinHash; });
      },

      /* 사용자 등록: 이름 + 등급(교육/유저 테스트 대기/유저/슈퍼유저). 같은 이름이면 등급 변경.
         managerPin 이 null 이면 포털 관리자 세션(관리자 PIN 확인 후)만 허용 — 담당자 PIN 이 없거나 잊었을 때의 경로 */
      grantUser: function (equipmentId, managerPin, name, grade) {
        var eq = data.equipment.filter(function (x) { return x.id === equipmentId; })[0];
        if (!eq) return Promise.reject(new Error('장비를 찾을 수 없습니다.'));
        var nm = String(name || '').trim();
        if (!nm) return Promise.reject(new Error('이름을 입력하세요.'));
        return checkManager(eq, managerPin).then(function (ok) {
          if (!ok) throw new Error(managerPin === null ? '관리자만 담당자 PIN 없이 등록할 수 있습니다.' : '장비 담당자 PIN이 올바르지 않습니다.');
          var key = nameKey(nm);
          var u = eq.users.filter(function (x) { return nameKey(x.name) === key; })[0];
          var by = session ? session.user.name : '';
          if (u) { u.grade = normGrade(grade); u.name = nm; u.grantedAt = nowISO(); u.grantedBy = by; }
          else { u = { id: uid(), name: nm, grade: normGrade(grade), grantedAt: nowISO(), grantedBy: by }; eq.users.push(u); }
          write(); emit();
          return publicUser(u);
        });
      },

      setUserGrade: function (equipmentId, managerPin, userId, grade) {
        var eq = data.equipment.filter(function (x) { return x.id === equipmentId; })[0];
        if (!eq) return Promise.reject(new Error('장비를 찾을 수 없습니다.'));
        return checkManager(eq, managerPin).then(function (ok) {
          if (!ok) throw new Error('장비 담당자 PIN이 올바르지 않습니다.');
          var u = eq.users.filter(function (x) { return x.id === userId; })[0];
          if (!u) throw new Error('사용자를 찾을 수 없습니다.');
          u.grade = normGrade(grade); u.grantedAt = nowISO(); u.grantedBy = session ? session.user.name : '';
          write(); emit();
          return publicUser(u);
        });
      },

      revokeUser: function (equipmentId, managerPin, userId) {
        var eq = data.equipment.filter(function (x) { return x.id === equipmentId; })[0];
        if (!eq) return Promise.reject(new Error('장비를 찾을 수 없습니다.'));
        return checkManager(eq, managerPin).then(function (ok) {
          if (!ok) throw new Error('장비 담당자 PIN이 올바르지 않습니다.');
          eq.users = eq.users.filter(function (x) { return x.id !== userId; });
          write(); emit();
        });
      },

      listReservations: function () { return Promise.resolve(clone(data.reservations)); },
      listUsageLogs: function () { return Promise.resolve(clone(data.usageLogs)); },

      /* 예약: 담당자가 유저/슈퍼유저 등급으로 등록한 사람만. PIN 없음 */
      createReservation: function (r) {
        var err = needSession(); if (err) return Promise.reject(err);
        var ecfg = equipmentCfg(cfg);
        var eq = data.equipment.filter(function (x) { return x.id === r.equipmentId; })[0];
        if (!eq || eq.active === false) return Promise.reject(new Error('예약할 수 없는 장비입니다.'));
        var me = session.user;
        var u = eq.users.filter(function (x) { return nameKey(x.name) === nameKey(me.name); })[0];
        /* 포털 관리자 계정은 담당자 등록 없이도 모든 장비를 예약할 수 있음 */
        if (!session.isAdmin) {
          if (!u) return Promise.reject(new Error('이 장비의 사용자로 등록되어 있지 않습니다. 장비 담당자(' + (eq.managerName || '미지정') + ')에게 등록을 요청하세요.'));
          if (!canReserveGrade(normGrade(u.grade))) return Promise.reject(new Error('현재 등급이 "' + gradeLabel(normGrade(u.grade)) + '"라 예약할 수 없습니다. 담당자에게 유저 승급을 요청하세요.'));
        }
        try {
          var start = new Date(r.start), end = new Date(r.end), now = new Date();
          if (isNaN(start) || isNaN(end) || end <= start) throw new Error('시작·종료 시각을 확인하세요.');
          if (end <= now) throw new Error('이미 지난 시간은 예약할 수 없습니다.');
          if ((end - start) / 3600000 > ecfg.maxHours) throw new Error('1회 예약은 최대 ' + ecfg.maxHours + '시간입니다.');
          var dueMs = ecfg.logDueDays * 86400000;
          var overdue = data.reservations.filter(function (x) { return x.status === 'booked' && !x.logId && isSameUser(x, me) && (now - new Date(x.end)) > dueMs; });
          if (overdue.length) throw new Error('사용 로그를 ' + ecfg.logDueDays + '일 넘게 작성하지 않은 예약이 ' + overdue.length + '건 있습니다. 로그를 먼저 작성하세요.');
          var clash = data.reservations.filter(function (x) { return x.status === 'booked' && x.equipmentId === eq.id && new Date(x.start) < end && new Date(x.end) > start; })[0];
          if (clash) throw new Error('같은 시간에 ' + clash.userName + '님의 예약이 있습니다 (' + fmtRangeShort(clash) + ').');
          var rec = { id: uid(), createdAt: nowISO(), equipmentId: eq.id, userId: me.id, userName: me.name, start: start.toISOString(), end: end.toISOString(),
            purpose: String(r.purpose || '').trim(), status: 'booked', logId: null, cancelledAt: null, cancelledBy: null };
          data.reservations.push(rec);
          write(); emit();
          return Promise.resolve(clone(rec));
        } catch (e) { return Promise.reject(e); }
      },

      /* 예약 일정 변경: 본인의 예정 예약, 또는 담당자 PIN */
      updateReservation: function (id, patch, opts) {
        var r = data.reservations.filter(function (x) { return x.id === id; })[0];
        if (!r) return Promise.reject(new Error('예약을 찾을 수 없습니다.'));
        if (r.status !== 'booked') return Promise.reject(new Error('취소된 예약은 변경할 수 없습니다.'));
        var me = session ? session.user : null;
        var ecfg = equipmentCfg(cfg);
        var p;
        if (me && isSameUser(r, me) && new Date(r.start) > new Date()) p = Promise.resolve(true);
        else if (opts && opts.managerPin) { var eq = data.equipment.filter(function (x) { return x.id === r.equipmentId; })[0]; p = checkManager(eq, opts.managerPin); }
        else p = Promise.resolve(false);
        return p.then(function (ok) {
          if (!ok) throw new Error('본인의 예정된 예약만 변경할 수 있습니다. 시작된 예약은 장비 담당자가 처리합니다.');
          var start = new Date(patch.start || r.start), end = new Date(patch.end || r.end), now = new Date();
          if (isNaN(start) || isNaN(end) || end <= start) throw new Error('시작·종료 시각을 확인하세요.');
          if (end <= now) throw new Error('이미 지난 시간으로는 바꿀 수 없습니다.');
          if ((end - start) / 3600000 > ecfg.maxHours) throw new Error('1회 예약은 최대 ' + ecfg.maxHours + '시간입니다.');
          var clash = data.reservations.filter(function (x) { return x.id !== r.id && x.status === 'booked' && x.equipmentId === r.equipmentId && new Date(x.start) < end && new Date(x.end) > start; })[0];
          if (clash) throw new Error('같은 시간에 ' + clash.userName + '님의 예약이 있습니다 (' + fmtRangeShort(clash) + ').');
          r.start = start.toISOString(); r.end = end.toISOString();
          if (patch.purpose !== undefined) r.purpose = String(patch.purpose || '').trim();
          write(); emit();
          return clone(r);
        });
      },

      cancelReservation: function (id, opts) {
        var r = data.reservations.filter(function (x) { return x.id === id; })[0];
        if (!r) return Promise.reject(new Error('예약을 찾을 수 없습니다.'));
        if (r.status !== 'booked') return Promise.reject(new Error('이미 취소된 예약입니다.'));
        var me = session ? session.user : null;
        var p;
        if (me && isSameUser(r, me) && new Date(r.start) > new Date()) p = Promise.resolve(true);
        else if (opts && opts.managerPin) {
          var eq = data.equipment.filter(function (x) { return x.id === r.equipmentId; })[0];
          p = checkManager(eq, opts.managerPin);
        } else p = Promise.resolve(false);
        return p.then(function (ok) {
          if (!ok) throw new Error('본인의 예정된 예약만 취소할 수 있습니다. 지난 예약은 장비 담당자가 처리합니다.');
          r.status = 'cancelled'; r.cancelledAt = nowISO(); r.cancelledBy = me ? me.name : '';
          write(); emit();
          return clone(r);
        });
      },

      createUsageLog: function (log) {
        var err = needSession(); if (err) return Promise.reject(err);
        var r = data.reservations.filter(function (x) { return x.id === log.reservationId; })[0];
        if (!r || r.status !== 'booked') return Promise.reject(new Error('로그를 쓸 예약을 찾을 수 없습니다.'));
        if (r.logId) return Promise.reject(new Error('이미 로그가 작성된 예약입니다.'));
        if (!isSameUser(r, session.user)) return Promise.reject(new Error('본인 예약의 로그만 작성할 수 있습니다.'));
        var rec = { id: uid(), createdAt: nowISO(), reservationId: r.id, equipmentId: r.equipmentId, userId: session.user.id, userName: session.user.name,
          usedStart: log.usedStart || r.start, usedEnd: log.usedEnd || r.end, condition: log.condition === 'issue' ? 'issue' : 'normal',
          content: String(log.content || '').trim(), issues: String(log.issues || '').trim(), waived: false, waivedBy: null };
        data.usageLogs.push(rec);
        r.logId = rec.id;
        write(); emit();
        return Promise.resolve(clone(rec));
      },

      waiveUsageLog: function (reservationId, managerPin, note) {
        var r = data.reservations.filter(function (x) { return x.id === reservationId; })[0];
        if (!r || r.status !== 'booked') return Promise.reject(new Error('예약을 찾을 수 없습니다.'));
        if (r.logId) return Promise.reject(new Error('이미 로그가 있는 예약입니다.'));
        var eq = data.equipment.filter(function (x) { return x.id === r.equipmentId; })[0];
        return checkManager(eq, managerPin).then(function (ok) {
          if (!ok) throw new Error('장비 담당자 PIN이 올바르지 않습니다.');
          var rec = { id: uid(), createdAt: nowISO(), reservationId: r.id, equipmentId: r.equipmentId, userId: r.userId, userName: r.userName,
            usedStart: r.start, usedEnd: r.end, condition: 'normal', content: String(note || '').trim(), issues: '', waived: true, waivedBy: session ? session.user.name : '' };
          data.usageLogs.push(rec);
          r.logId = rec.id;
          write(); emit();
          return clone(rec);
        });
      },

      /* ---------- 출석 ---------- */
      attSession: function () { return readAttSession(); },
      attLogout: function () { writeAttSession(null); return Promise.resolve(); },

      /* 포털 로그인 계정으로 출석 구성원 자동 연결 (이름 기준, 없으면 생성) */
      attLoginFromPortal: function () {
        var err = needSession(); if (err) return Promise.reject(err);
        var key = nameKey(session.user.name);
        var m = data.attMembers.filter(function (x) { return nameKey(x.name) === key; })[0];
        if (!m) { m = { id: uid(), name: session.user.name, pinHash: '', active: true, createdAt: nowISO() }; data.attMembers.push(m); write(); emit(); }
        if (m.active === false) return Promise.reject(new Error('출석 사용이 중지된 구성원입니다. 관리자에게 문의하세요.'));
        writeAttSession({ memberId: m.id, name: m.name, pin: '', ts: Date.now() });
        return Promise.resolve(publicMember(m));
      },

      attLogin: function (name, pin) {
        var acfg = attendanceCfg(cfg);
        var nm = String(name || '').trim();
        if (!nm) return Promise.reject(new Error('아이디(이름)를 입력하세요.'));
        if (!/^\d{4,8}$/.test(String(pin || ''))) return Promise.reject(new Error('PIN은 숫자 4~8자리입니다.'));
        var key = nameKey(nm);
        var m = data.attMembers.filter(function (x) { return nameKey(x.name) === key; })[0];
        return hashPin(pin).then(function (h) {
          if (!m) {
            if (!acfg.selfRegister) throw new Error('등록되지 않은 아이디입니다. 관리자에게 등록을 요청하세요.');
            m = { id: uid(), name: nm, pinHash: h, active: true, createdAt: nowISO() };
            data.attMembers.push(m); write(); emit();
          } else {
            if (m.active === false) throw new Error('사용이 중지된 아이디입니다. 관리자에게 문의하세요.');
            if (m.pinHash !== h) throw new Error('PIN이 올바르지 않습니다.');
          }
          var s = { memberId: m.id, name: m.name, pin: String(pin), ts: Date.now() };
          writeAttSession(s);
          return publicMember(m);
        });
      },

      attChangePin: function (oldPin, newPin) {
        var s = readAttSession(); if (!s) return Promise.reject(new Error('로그인이 필요합니다.'));
        var m = data.attMembers.filter(function (x) { return x.id === s.memberId; })[0];
        if (!m) return Promise.reject(new Error('구성원을 찾을 수 없습니다.'));
        if (!/^\d{4,8}$/.test(String(newPin || ''))) return Promise.reject(new Error('새 PIN은 숫자 4~8자리입니다.'));
        return Promise.all([hashPin(oldPin), hashPin(newPin)]).then(function (hs) {
          if (hs[0] !== m.pinHash) throw new Error('현재 PIN이 올바르지 않습니다.');
          m.pinHash = hs[1]; write(); emit();
          writeAttSession(Object.assign({}, s, { pin: String(newPin) }));
        });
      },

      attListMembers: function () { return Promise.resolve(data.attMembers.map(publicMember)); },

      attSaveMember: function (m, opts) {
        var nm = String(m.name || '').trim();
        if (!nm) return Promise.reject(new Error('이름을 입력하세요.'));
        var idx = data.attMembers.findIndex(function (x) { return x.id === m.id; });
        var dup = data.attMembers.filter(function (x, i) { return i !== idx && nameKey(x.name) === nameKey(nm); })[0];
        if (dup) return Promise.reject(new Error('같은 이름의 구성원이 이미 있습니다.'));
        var base = idx >= 0 ? data.attMembers[idx] : { id: uid(), createdAt: nowISO(), pinHash: '' };
        var rec = Object.assign({}, base, { name: nm, active: m.active !== false });
        var p = (opts && opts.pin) ? hashPin(opts.pin).then(function (h) { rec.pinHash = h; }) : Promise.resolve();
        return p.then(function () {
          if (!rec.pinHash) throw new Error('초기 PIN을 정해 주세요.');
          if (idx >= 0) data.attMembers[idx] = rec; else data.attMembers.push(rec);
          write(); emit();
          return publicMember(rec);
        });
      },

      attDeleteMember: function (id) {
        if (data.attRecords.some(function (r) { return r.memberId === id; }) || data.attLeaves.some(function (l) { return l.memberId === id; })) {
          return Promise.reject(new Error('출석 기록이 있는 구성원은 삭제할 수 없습니다. 사용 중지로 바꾸세요.'));
        }
        data.attMembers = data.attMembers.filter(function (x) { return x.id !== id; });
        write(); emit(); return Promise.resolve();
      },

      attListRecords: function () { return Promise.resolve(clone(data.attRecords)); },
      attListLeaves: function () { return Promise.resolve(clone(data.attLeaves)); },
      attListHolidays: function () { return Promise.resolve(clone(data.attHolidays)); },
      attSaveHolidays: function (obj) { data.attHolidays = clone(obj || {}); write(); emit(); return Promise.resolve(); },

      attCheckIn: function (reason) {
        var s = readAttSession(); if (!s) return Promise.reject(new Error('로그인이 필요합니다.'));
        var m = data.attMembers.filter(function (x) { return x.id === s.memberId; })[0];
        if (!m || m.active === false) return Promise.reject(new Error('사용할 수 없는 아이디입니다.'));
        var acfg = attendanceCfg(cfg);
        var now = new Date(), today = ymdLocal(now), hm = hmLocal(now);
        if (isWeekend(today)) return Promise.reject(new Error('주말에는 출석 체크가 없습니다.'));
        if (data.attHolidays[today]) return Promise.reject(new Error('공휴일(' + data.attHolidays[today] + ')에는 출석 체크가 없습니다.'));
        var leave = data.attLeaves.filter(function (l) { return l.memberId === m.id && l.startDate <= today && today <= l.endDate; })[0];
        if (leave) return Promise.reject(new Error('오늘은 ' + (leave.type === 'trip' ? '출장' : '휴가') + '으로 등록되어 있어 출석 체크를 하지 않습니다.'));
        if (data.attRecords.some(function (r) { return r.memberId === m.id && r.date === today; })) return Promise.reject(new Error('오늘은 이미 출석 체크를 했습니다.'));
        if (hm < acfg.openAfter) return Promise.reject(new Error('출석 가능 시간은 ' + acfg.openAfter + ' ~ ' + acfg.closeAfter + ' 입니다.'));
        if (hm >= acfg.closeAfter) return Promise.reject(new Error(acfg.closeAfter + ' 이후에는 출석 체크를 할 수 없습니다. 오늘은 미기입(결근)으로 처리됩니다.'));
        var status = hm < acfg.lateAfter ? 'present' : (String(reason || '').trim() ? 'excused' : 'late');
        var rec = { id: uid(), memberId: m.id, name: m.name, date: today, status: status, checkInAt: now.toISOString(), reason: status === 'present' ? '' : String(reason || '').trim(), createdAt: now.toISOString() };
        data.attRecords.push(rec); write(); emit();
        return Promise.resolve(clone(rec));
      },

      attUpdateRecord: function (id, patch) {
        var idx = data.attRecords.findIndex(function (x) { return x.id === id; });
        if (idx < 0) return Promise.reject(new Error('기록을 찾을 수 없습니다.'));
        data.attRecords[idx] = Object.assign({}, data.attRecords[idx], patch);
        write(); emit(); return Promise.resolve(clone(data.attRecords[idx]));
      },

      attAdminSetDay: function (memberId, date, status, reason) {
        /* 관리자가 특정 날짜의 상태를 직접 지정 (기록 생성/수정/삭제) */
        var m = data.attMembers.filter(function (x) { return x.id === memberId; })[0];
        if (!m) return Promise.reject(new Error('구성원을 찾을 수 없습니다.'));
        data.attRecords = data.attRecords.filter(function (r) { return !(r.memberId === memberId && r.date === date); });
        if (status && status !== 'absent') {
          var t = new Date(date + 'T09:00:00');
          data.attRecords.push({ id: uid(), memberId: m.id, name: m.name, date: date, status: status, checkInAt: t.toISOString(), reason: String(reason || '').trim(), createdAt: nowISO(), editedBy: session ? session.user.name : '관리자' });
        }
        write(); emit(); return Promise.resolve();
      },

      attRequestLeave: function (req) {
        var s = readAttSession(); if (!s) return Promise.reject(new Error('로그인이 필요합니다.'));
        var m = data.attMembers.filter(function (x) { return x.id === s.memberId; })[0];
        if (!m) return Promise.reject(new Error('구성원을 찾을 수 없습니다.'));
        var acfg = attendanceCfg(cfg);
        var type = req.type === 'trip' ? 'trip' : 'vacation';
        var from = String(req.startDate || ''), to = String(req.endDate || from);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || to < from) return Promise.reject(new Error('날짜를 확인하세요.'));
        var reason = String(req.reason || '').trim();
        if (type === 'trip' && !reason) return Promise.reject(new Error('출장 사유를 입력하세요.'));
        var days = workdaysBetween(from, to, data.attHolidays);
        if (days <= 0) return Promise.reject(new Error('선택한 기간에 근무일이 없습니다.'));
        var overlap = data.attLeaves.filter(function (l) { return l.memberId === m.id && l.startDate <= to && from <= l.endDate; })[0];
        if (overlap) return Promise.reject(new Error('이미 ' + overlap.startDate + ' ~ ' + overlap.endDate + ' 에 ' + (overlap.type === 'trip' ? '출장' : '휴가') + '이 등록되어 있습니다.'));
        var checked = data.attRecords.filter(function (r) { return r.memberId === m.id && from <= r.date && r.date <= to; })[0];
        if (checked) return Promise.reject(new Error(checked.date + ' 에 이미 출석 기록이 있습니다.'));
        if (type === 'vacation') {
          var perHalf = {};
          eachDate(from, to, function (d) { if (!isWeekend(d) && !data.attHolidays[d]) { var k = halfKey(d); perHalf[k] = (perHalf[k] || 0) + 1; } });
          var used = {};
          data.attLeaves.forEach(function (l) { if (l.memberId !== m.id || l.type !== 'vacation') return; eachDate(l.startDate, l.endDate, function (d) { if (!isWeekend(d) && !data.attHolidays[d]) { var k = halfKey(d); used[k] = (used[k] || 0) + 1; } }); });
          for (var k in perHalf) {
            if ((used[k] || 0) + perHalf[k] > acfg.vacationDaysPerHalf) {
              return Promise.reject(new Error(k.slice(0, 4) + '년 ' + (k.slice(4) === 'H1' ? '상반기' : '하반기') + ' 휴가는 ' + acfg.vacationDaysPerHalf + '일까지입니다. (사용 ' + (used[k] || 0) + '일, 신청 ' + perHalf[k] + '일)'));
            }
          }
        }
        var rec = { id: uid(), memberId: m.id, name: m.name, type: type, startDate: from, endDate: to, days: days, reason: reason, createdAt: nowISO() };
        data.attLeaves.push(rec); write(); emit();
        return Promise.resolve(clone(rec));
      },

      attDeleteLeave: function (id, opts) {
        var l = data.attLeaves.filter(function (x) { return x.id === id; })[0];
        if (!l) return Promise.reject(new Error('신청을 찾을 수 없습니다.'));
        var s = readAttSession();
        var own = s && s.memberId === l.memberId;
        var admin = !!(opts && opts.admin);
        if (!admin && !(own && l.startDate >= ymdLocal(new Date()))) return Promise.reject(new Error('본인의 시작 전 신청만 취소할 수 있습니다.'));
        data.attLeaves = data.attLeaves.filter(function (x) { return x.id !== id; });
        write(); emit(); return Promise.resolve();
      },

      /* ---------- 소모품 재고 ---------- */
      invListManagers: function () { return Promise.resolve(data.invManagers.map(publicInvManager)); },

      invSaveManager: function (m, opts) {
        var nm = String(m.name || '').trim();
        if (!nm) return Promise.reject(new Error('이름을 입력하세요.'));
        var idx = data.invManagers.findIndex(function (x) { return x.id === m.id; });
        var base = idx >= 0 ? data.invManagers[idx] : { id: uid(), createdAt: nowISO(), pinHash: '' };
        var rec = Object.assign({}, base, { name: nm, area: String(m.area || '').trim() });
        var p = (opts && opts.pin) ? hashPin(opts.pin).then(function (h) { rec.pinHash = h; }) : Promise.resolve();
        return p.then(function () {
          if (!rec.pinHash) throw new Error('담당자 PIN을 정해 주세요.');
          if (idx >= 0) data.invManagers[idx] = rec; else data.invManagers.push(rec);
          write(); emit();
          return publicInvManager(rec);
        });
      },

      invDeleteManager: function (id) {
        data.invManagers = data.invManagers.filter(function (x) { return x.id !== id; });
        write(); emit(); return Promise.resolve();
      },

      invVerifyManager: function (managerId, pin) {
        var m = data.invManagers.filter(function (x) { return x.id === managerId; })[0];
        if (!m) return Promise.resolve(false);
        if (!isInvManager(m)) return Promise.reject(new Error(invDeniedMsg(m)));
        return hashPin(pin).then(function (h) { return h === m.pinHash; });
      },

      invListItems: function () { return Promise.resolve(clone(data.invItems)); },
      invListMoves: function () { return Promise.resolve(clone(data.invMoves)); },

      invSaveItem: function (item, creds) {
        return checkInvManager(creds).then(function (m) {
          var nm = String(item.name || '').trim();
          if (!nm) throw new Error('품목명을 입력하세요.');
          var qty = Math.max(0, Number(item.qty) || 0);
          var price = Math.max(0, Math.round(Number(item.unitPrice) || 0));
          var idx = data.invItems.findIndex(function (x) { return x.id === item.id; });
          var now = nowISO();
          if (idx < 0) {
            var rec = { id: uid(), name: nm, category: item.category || '', unit: item.unit || '개', location: String(item.location || '').trim(), qty: qty, unitPrice: price,
              minQty: Math.max(0, Number(item.minQty) || 0), note: String(item.note || '').trim(), active: item.active !== false, createdAt: now, updatedAt: now };
            data.invItems.push(rec);
            data.invMoves.unshift({ id: uid(), createdAt: now, itemId: rec.id, itemName: rec.name, location: rec.location, type: 'init', qty: qty, unitPrice: price, userName: m.name, note: '초기 보유량', stockAfter: qty });
            write(); emit();
            return clone(rec);
          }
          var cur = data.invItems[idx];
          var delta = qty - cur.qty;
          var upd = Object.assign({}, cur, { name: nm, category: item.category || '', unit: item.unit || cur.unit, location: String(item.location || '').trim(), qty: qty, unitPrice: price,
            minQty: Math.max(0, Number(item.minQty) || 0), note: String(item.note || '').trim(), active: item.active !== false, updatedAt: now });
          data.invItems[idx] = upd;
          if (delta !== 0) data.invMoves.unshift({ id: uid(), createdAt: now, itemId: upd.id, itemName: upd.name, location: upd.location, type: 'adjust', qty: delta, unitPrice: price, userName: m.name, note: String(item.adjustNote || '재고 조정').trim(), stockAfter: qty });
          write(); emit();
          return clone(upd);
        });
      },

      invDeleteItem: function (id, creds) {
        return checkInvManager(creds).then(function () {
          if (data.invMoves.some(function (mv) { return mv.itemId === id && mv.type === 'out'; })) throw new Error('소모 기록이 있는 품목은 삭제할 수 없습니다. 사용 중지로 바꾸세요.');
          data.invItems = data.invItems.filter(function (x) { return x.id !== id; });
          data.invMoves = data.invMoves.filter(function (x) { return x.itemId !== id; });
          write(); emit();
        });
      },

      invRestock: function (itemId, qty, unitPrice, note, creds) {
        return checkInvManager(creds).then(function (m) {
          var it = data.invItems.filter(function (x) { return x.id === itemId; })[0];
          if (!it) throw new Error('품목을 찾을 수 없습니다.');
          var q = Number(qty) || 0;
          if (q <= 0) throw new Error('입고 수량은 0보다 커야 합니다.');
          var price = Math.max(0, Math.round(Number(unitPrice) || it.unitPrice || 0));
          it.qty += q; it.unitPrice = price; it.updatedAt = nowISO();
          data.invMoves.unshift({ id: uid(), createdAt: nowISO(), itemId: it.id, itemName: it.name, location: it.location, type: 'in', qty: q, unitPrice: price, userName: m.name, note: String(note || '').trim(), stockAfter: it.qty });
          write(); emit();
          return clone(it);
        });
      },

      invConsume: function (itemId, qty, note) {
        var err = needSession(); if (err) return Promise.reject(err);
        var it = data.invItems.filter(function (x) { return x.id === itemId; })[0];
        if (!it || it.active === false) return Promise.reject(new Error('소모 처리할 수 없는 품목입니다.'));
        var q = Number(qty) || 0;
        if (q <= 0) return Promise.reject(new Error('수량은 0보다 커야 합니다.'));
        if (q > it.qty) return Promise.reject(new Error('재고(' + it.qty + it.unit + ')보다 많습니다. 담당자에게 알려주세요.'));
        it.qty -= q; it.updatedAt = nowISO();
        var mv = { id: uid(), createdAt: nowISO(), itemId: it.id, itemName: it.name, location: it.location, type: 'out', qty: q, unitPrice: it.unitPrice, userName: session.user.name, note: String(note || '').trim(), stockAfter: it.qty };
        data.invMoves.unshift(mv);
        write(); emit();
        return Promise.resolve(clone(mv));
      },

      onChange: function (cb) {
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
      },

      exportJSON: function () { return clone(data); },

      importJSON: function (obj) {
        if (!obj || !Array.isArray(obj.projects) || !Array.isArray(obj.requests)) throw new Error('형식이 올바르지 않습니다.');
        data = migrate(clone(obj), cfg); write(); emit();
      },

      /* 초기화: seedDemoData 가 켜져 있으면 예시 데이터로, 아니면 관리자 계정만 남기고 비움 */
      resetDemo: function () { data = migrate(cfg.seedDemoData ? seedData() : emptyData(), cfg); write(); return ensureSeedHashes().then(function () { readSession(); emit(); }); }
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Supabase adapter                                                   */
  /* ------------------------------------------------------------------ */
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve; s.onerror = function () { reject(new Error('스크립트 로드 실패: ' + src)); };
      document.head.appendChild(s);
    });
  }

  function toProject(row) {
    return {
      id: row.id, code: row.code || '', name: row.name,
      budgets: (row.budgets && typeof row.budgets === 'object') ? row.budgets : {},
      startDate: row.start_date || '', endDate: row.end_date || '', manager: row.manager || '',
      accountManager: row.account_manager || '', cardUsers: Array.isArray(row.card_users) ? row.card_users : [],
      owners: Array.isArray(row.owners) ? row.owners : [],
      alias: row.alias || '', participants: Array.isArray(row.participants) ? row.participants : [],
      note: row.note || '', active: row.active !== false, createdAt: row.created_at
    };
  }

  function fromProject(p) {
    var budgets = {};
    Object.keys(p.budgets || {}).forEach(function (k) { budgets[k] = Math.round(Number(p.budgets[k]) || 0); });
    var out = {
      code: p.code || '', name: p.name, budgets: budgets,
      start_date: p.startDate || null, end_date: p.endDate || null, manager: p.manager || '',
      account_manager: p.accountManager || '', card_users: Array.isArray(p.cardUsers) ? p.cardUsers : [],
      owners: Array.isArray(p.owners) ? p.owners : [],
      alias: p.alias || '', participants: Array.isArray(p.participants) ? p.participants : [],
      note: p.note || '', active: p.active !== false
    };
    if (p.id) out.id = p.id;
    return out;
  }

  function toRequest(row) {
    return {
      id: row.id, createdAt: row.created_at, requesterId: row.requester_id, requesterName: row.requester_name || '',
      kind: row.kind === 'meeting' ? 'meeting' : 'purchase', meta: (row.meta && typeof row.meta === 'object') ? row.meta : {},
      report: (row.report && typeof row.report === 'object') ? row.report : null,
      item: row.item, category: row.category || '', link: row.link || '', qty: Number(row.qty) || 1, unitPrice: Number(row.unit_price) || 0,
      amount: Number(row.amount) || 0, note: row.note || '', status: row.status, projectId: row.project_id || null, reviewId: row.review_id || null,
      adminNote: row.admin_note || '', processedAt: row.processed_at || null, processedBy: row.processed_by_name || null
    };
  }

  function fromRequestPatch(patch) {
    var map = {
      item: 'item', category: 'category', link: 'link', qty: 'qty', unitPrice: 'unit_price', amount: 'amount', note: 'note', kind: 'kind', meta: 'meta', report: 'report',
      status: 'status', projectId: 'project_id', reviewId: 'review_id', adminNote: 'admin_note', processedAt: 'processed_at',
      processedBy: 'processed_by_name', requesterName: 'requester_name'
    };
    var out = {};
    Object.keys(patch).forEach(function (k) { if (map[k]) out[map[k]] = patch[k]; });
    return out;
  }

  function toReview(row) {
    return {
      id: row.id, createdAt: row.created_at, requesterId: row.requester_id, requesterName: row.requester_name || '',
      title: row.title, purpose: row.purpose || '', vendor: row.vendor || '', category: row.category || '',
      items: Array.isArray(row.items) ? row.items : [], amount: Number(row.amount) || 0, note: row.note || '', pinHash: row.pin_hash || '',
      status: row.status, projectId: row.project_id || null, approvedAmount: row.approved_amount === null || row.approved_amount === undefined ? null : Number(row.approved_amount),
      adminNote: row.admin_note || '', processedAt: row.processed_at || null, processedBy: row.processed_by_name || null
    };
  }

  function toReviewLimited(row) {
    return { id: row.id, createdAt: row.created_at, requesterId: row.requester_id, requesterName: row.requester_name || '', title: row.title, status: row.status, processedAt: row.processed_at || null, limited: true };
  }

  function toExport(row) {
    return {
      id: row.id, createdAt: row.created_at, exportedById: row.exported_by, exportedBy: row.exported_by_name || '',
      purpose: row.purpose || '', format: row.format || 'csv', count: Number(row.count) || 0, totalAmount: Number(row.total_amount) || 0,
      filter: row.filter || {}, rows: Array.isArray(row.rows) ? row.rows : []
    };
  }

  function toEquipment(row, users) {
    return { id: row.id, name: row.name, location: row.location || '', managerName: row.manager_name || '', description: row.description || '', rules: row.rules || '',
      color: row.color || '#004191', active: row.active !== false, createdAt: row.created_at, hasManagerPin: true, users: users || [] };
  }
  function fromEquipment(eq) {
    var out = { name: eq.name, location: eq.location || '', manager_name: eq.managerName || '', description: eq.description || '', rules: eq.rules || '', color: eq.color || '#004191', active: eq.active !== false };
    if (eq.id) out.id = eq.id;
    return out;
  }
  function toEqUser(row) { return { id: row.id, name: row.name, grade: normGrade(row.grade), grantedAt: row.granted_at, grantedBy: row.granted_by || '' }; }
  function toReservation(row) {
    return { id: row.id, createdAt: row.created_at, equipmentId: row.equipment_id, userId: row.user_id, userName: row.user_name || '', start: row.start_at, end: row.end_at,
      purpose: row.purpose || '', status: row.status, logId: row.log_id || null, cancelledAt: row.cancelled_at || null, cancelledBy: row.cancelled_by || null };
  }
  function toUsageLog(row) {
    return { id: row.id, createdAt: row.created_at, reservationId: row.reservation_id, equipmentId: row.equipment_id, userId: row.user_id, userName: row.user_name || '',
      usedStart: row.used_start, usedEnd: row.used_end, condition: row.condition || 'normal', content: row.content || '', issues: row.issues || '', waived: !!row.waived, waivedBy: row.waived_by || null };
  }

  function toInvItem(r) {
    return { id: r.id, name: r.name, category: r.category || '', unit: r.unit || '개', location: r.location || '', qty: Number(r.qty) || 0, unitPrice: Number(r.unit_price) || 0,
      minQty: Number(r.min_qty) || 0, note: r.note || '', active: r.active !== false, createdAt: r.created_at, updatedAt: r.updated_at };
  }
  function toInvMove(r) {
    return { id: r.id, createdAt: r.created_at, itemId: r.item_id, itemName: r.item_name || '', location: r.location || '', type: r.type, qty: Number(r.qty) || 0,
      unitPrice: Number(r.unit_price) || 0, userName: r.user_name || '', note: r.note || '', stockAfter: Number(r.stock_after) || 0 };
  }

  function fromReviewPatch(patch) {
    var map = {
      title: 'title', purpose: 'purpose', vendor: 'vendor', category: 'category', items: 'items', amount: 'amount', note: 'note', pinHash: 'pin_hash',
      status: 'status', projectId: 'project_id', approvedAmount: 'approved_amount', adminNote: 'admin_note', processedAt: 'processed_at', processedBy: 'processed_by_name'
    };
    var out = {};
    Object.keys(patch).forEach(function (k) { if (map[k]) out[map[k]] = patch[k]; });
    return out;
  }

  function SupabaseStore(cfg) {
    var client = null;
    var session = null;
    var profile = null;
    var listeners = [];

    function emit() { listeners.forEach(function (cb) { try { cb(); } catch (e) { console.error(e); } }); }

    function loadProfile() {
      if (!session) { profile = null; return Promise.resolve(); }
      return client.from('profiles').select('*').eq('id', session.user.id).maybeSingle().then(function (res) {
        profile = res.data || null;
      });
    }

    function currentUser() {
      if (!session) return null;
      var name = (profile && profile.name) || (session.user.user_metadata && session.user.user_metadata.name) || session.user.email;
      return { id: session.user.id, name: name, email: session.user.email };
    }

    function unwrap(res) {
      if (res.error) throw new Error(res.error.message || String(res.error));
      return res.data;
    }

    return {
      mode: 'supabase',

      init: function () {
        if (!cfg.supabaseUrl || !cfg.supabaseAnonKey) {
          return Promise.reject(new Error('config.js 에 supabaseUrl / supabaseAnonKey 를 설정하세요.'));
        }
        return loadScript('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js').then(function () {
          client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
          return client.auth.getSession();
        }).then(function (res) {
          session = res.data.session;
          return loadProfile();
        }).then(function () {
          client.auth.onAuthStateChange(function (_event, s) {
            session = s;
            loadProfile().then(emit);
          });
          client.channel('budget-live')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'requests' }, emit)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, emit)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'reviews' }, emit)
            .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations' }, emit)
            .subscribe();
        });
      },

      getSession: function () {
        if (!session) return null;
        return { user: currentUser(), isAdmin: !!(profile && profile.is_admin), status: profile ? (profile.status || 'pending') : 'pending' };
      },

      /* 공용 DB 모드: 이메일 magic link. 처음 로그인한 계정은 승인 대기(pending) 상태 */
      signIn: function (payload) {
        var email = (payload && payload.email || '').trim();
        if (!email) return Promise.reject(new Error('이메일을 입력하세요.'));
        return client.auth.signInWithOtp({
          email: email,
          options: { emailRedirectTo: window.location.href.split('#')[0], data: { name: (payload.name || '').trim() } }
        }).then(unwrap).then(function () { return { magicLinkSent: true }; });
      },
      signUp: function (payload) { return this.signIn(payload); },

      signOut: function () { return client.auth.signOut().then(function () { session = null; profile = null; emit(); }); },

      securityEvent: function (ev) {
        var rec = buildSecurityEvent(ev);
        if (rec.severity === 'high' && cfg.security && cfg.security.alertWebhookUrl) sendWebhook(cfg.security.alertWebhookUrl, alertText(rec));
        return client.rpc('log_security_event', { p_type: rec.type, p_severity: rec.severity, p_name: rec.name, p_detail: rec.detail, p_page: rec.page, p_user_agent: rec.userAgent })
          .then(unwrap).then(function () { return rec; }).catch(function () { return rec; });
      },
      listSecurityEvents: function () {
        return client.from('security_events').select('*').order('created_at', { ascending: false }).limit(200).then(unwrap).then(function (rows) {
          return rows.map(function (r) { return { id: r.id, createdAt: r.created_at, type: r.type, severity: r.severity, name: r.name || '', detail: r.detail || '', page: r.page || '', userAgent: r.user_agent || '' }; });
        });
      },

      listAccounts: function () {
        return client.from('profiles').select('*').order('created_at').then(unwrap).then(function (rows) {
          return rows.map(function (p) { return { id: p.id, name: p.name || p.email, email: p.email, role: p.is_admin ? 'admin' : 'member', status: p.status || 'pending', createdAt: p.created_at, approvedAt: p.approved_at || null, approvedBy: p.approved_by || null }; });
        });
      },
      approveAccount: function (id) { var u = currentUser(); return client.from('profiles').update({ status: 'active', approved_at: new Date().toISOString(), approved_by: u ? u.name : '' }).eq('id', id).then(unwrap).then(function () {}); },
      rejectAccount: function (id) { return client.from('profiles').update({ status: 'rejected' }).eq('id', id).then(unwrap).then(function () {}); },
      setAccountStatus: function (id, status) { return client.from('profiles').update({ status: status }).eq('id', id).then(unwrap).then(function () {}); },
      setAccountRole: function (id, role) { return client.from('profiles').update({ is_admin: role === 'admin' }).eq('id', id).then(unwrap).then(function () {}); },
      resetAccountPin: function () { return Promise.reject(new Error('공용 DB 모드는 이메일 링크로 로그인하므로 PIN이 없습니다.')); },
      changeMyPin: function () { return Promise.reject(new Error('공용 DB 모드는 이메일 링크로 로그인하므로 PIN이 없습니다.')); },

      /* 진입 PIN 은 UX 게이트이며, 실제 권한은 profiles.is_admin + RLS 가 강제합니다. */
      verifyAdminPin: function (pin) {
        return Promise.resolve(!!(profile && profile.is_admin) && String(pin) === String(cfg.adminPin));
      },

      /* 관리자는 예산이 포함된 projects, 구성원은 예산이 빠진 projects_public 뷰 */
      listProjects: function () {
        var src = (profile && profile.is_admin) ? 'projects' : 'projects_public';
        return client.from(src).select('*').order('created_at', { ascending: true }).then(unwrap).then(function (rows) { return rows.map(toProject); });
      },

      saveProject: function (p) {
        return client.from('projects').upsert(fromProject(p)).select().single().then(unwrap).then(toProject);
      },

      /* 참여과제 시트: 관리자가 올리면 app_settings 에 rows 를 두고 projects(alias, participants)를 동기화 */
      importParticipation: function (payload) {
        if (!(profile && profile.is_admin)) return Promise.reject(new Error('관리자만 참여과제 시트를 가져올 수 있습니다.'));
        var self = this;
        return self._loadSheetData().then(function (tmp) {
          var info = applyParticipation(tmp, payload, profile.name || profile.email || '');
          return self._saveSheetData(tmp, { rows: tmp.participationRows, import: tmp.participationImport }).then(function () { return info; });
        });
      },
      _loadSheetData: function () {
        return Promise.all([client.from('projects').select('*').then(unwrap), client.from('requests').select('id, project_id, meta').then(unwrap), client.from('app_settings').select('key, value').in('key', ['participation_rows', 'participation_import']).then(unwrap)]).then(function (res) {
          var settings = {}; res[2].forEach(function (s) { settings[s.key] = s.value; });
          return { projects: res[0].map(toProject), requests: res[1].map(function (r) { return { id: r.id, projectId: r.project_id, meta: r.meta || {} }; }), reviews: [], participationRows: Array.isArray(settings.participation_rows) ? settings.participation_rows : [], participationImport: settings.participation_import || null, _origProjects: res[0].map(toProject) };
        });
      },
      _saveSheetData: function (tmp, settings) {
        var origIds = tmp._origProjects.map(function (p) { return p.id; });
        var current = {}; tmp.projects.forEach(function (p) { current[p.id] = p; });
        var upserts = tmp.projects.map(fromProject);
        var deleted = origIds.filter(function (id) { return !current[id]; });
        var moved = (tmp.merged || []);
        var chain = upserts.length ? client.from('projects').upsert(upserts).then(unwrap) : Promise.resolve();
        moved.forEach(function (m) { chain = chain.then(function () { return client.from('requests').update({ project_id: m.into }).eq('project_id', m.from).then(unwrap); }).then(function () { return client.from('reviews').update({ project_id: m.into }).eq('project_id', m.from).then(unwrap); }); });
        if (deleted.length) chain = chain.then(function () { return client.from('projects').delete().in('id', deleted).then(unwrap); });
        if (settings) {
          var rows = [];
          if (settings.rows) rows.push({ key: 'participation_rows', value: settings.rows, updated_at: new Date().toISOString() });
          if (settings.import) rows.push({ key: 'participation_import', value: settings.import, updated_at: new Date().toISOString() });
          if (rows.length) chain = chain.then(function () { return client.from('app_settings').upsert(rows).then(unwrap); });
        }
        return chain;
      },
      getParticipationInfo: function () {
        return client.from('app_settings').select('value').eq('key', 'participation_import').maybeSingle().then(unwrap).then(function (row) { return row ? row.value : null; }).catch(function () { return null; });
      },
      getParticipationRows: function () {
        return client.from('app_settings').select('value').eq('key', 'participation_rows').maybeSingle().then(unwrap).then(function (row) { return row && Array.isArray(row.value) ? row.value : []; }).catch(function () { return []; });
      },
      linkProjectAlias: function (projectId, alias) {
        if (!(profile && profile.is_admin)) return Promise.reject(new Error('관리자만 과제 연결을 바꿀 수 있습니다.'));
        var self = this;
        return self._loadSheetData().then(function (tmp) { var p = linkAlias(tmp, projectId, alias); return self._saveSheetData(tmp, null).then(function () { return p; }); });
      },
      syncProjectsWithSheet: function () {
        if (!(profile && profile.is_admin)) return Promise.reject(new Error('관리자만 동기화할 수 있습니다.'));
        var self = this;
        return self._loadSheetData().then(function (tmp) { var res = syncSheet(tmp); return self._saveSheetData(tmp, null).then(function () { return res; }); });
      },

      /* 회의비 처리 로그 */
      addMeetingLog: function (entry) {
        var u = currentUser(); if (!u) return Promise.reject(new Error('로그인이 필요합니다.'));
        var rec = meetingLogEntry(entry, u);
        return client.from('meeting_logs').insert({ id: rec.id, at: rec.at, by_id: u.id, by_name: rec.by, type: rec.type, request_id: rec.requestId, requester_id: rec.requesterId, requester_name: rec.requesterName, project: rec.project, code: rec.code, title: rec.title, amount: rec.amount, count: rec.count, per_head: rec.perHead, attendees: rec.attendees, detail: rec.detail }).then(unwrap).then(function () { return rec; });
      },
      listMeetingLogs: function () {
        return client.from('meeting_logs').select('*').order('at', { ascending: false }).limit(2000).then(unwrap).then(function (rows) {
          return rows.map(function (r) { return { id: r.id, at: r.at, by: r.by_name, byId: r.by_id, type: r.type, requestId: r.request_id, requesterId: r.requester_id, requesterName: r.requester_name, project: r.project, code: r.code, title: r.title, amount: Number(r.amount) || 0, count: Number(r.count) || 0, perHead: Number(r.per_head) || 0, attendees: r.attendees || '', detail: r.detail || '' }; });
        });
      },

      /* 구매 보고서 · 사진 (Supabase Storage 버킷 'report-photos', public) */
      savePhoto: function (dataUrl) {
        var m = /^data:(image\/[a-z]+);base64,(.*)$/i.exec(dataUrl || '');
        if (!m) return Promise.reject(new Error('사진 형식을 읽을 수 없습니다.'));
        var bin = atob(m[2]); var arr = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        var key = 'ph-' + (window.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)) + (m[1] === 'image/png' ? '.png' : '.jpg');
        return client.storage.from('report-photos').upload(key, arr, { contentType: m[1], upsert: false }).then(unwrap).then(function () { return key; });
      },
      loadPhoto: function (key) {
        if (!key) return Promise.resolve(null);
        var res = client.storage.from('report-photos').getPublicUrl(key);
        return Promise.resolve(res && res.data ? res.data.publicUrl : null);
      },
      deletePhoto: function (key) { return key ? client.storage.from('report-photos').remove([key]).then(function () {}).catch(function () {}) : Promise.resolve(); },
      saveReport: function (requestId, report) {
        return client.from('requests').select('report, status').eq('id', requestId).single().then(unwrap).then(function (row) {
          if (row.status !== 'done') throw new Error('관리자가 과제를 배정(승인)한 뒤에 보고서를 작성할 수 있습니다.');
          var u = currentUser(); var prev = row.report || {};
          var rec = Object.assign({}, prev, report, { updatedAt: new Date().toISOString(), updatedBy: u ? u.name : '' });
          if (!rec.createdAt) rec.createdAt = rec.updatedAt;
          if (rec.status === 'submitted' && prev.status !== 'submitted') { rec.submittedAt = rec.updatedAt; rec.submittedBy = u ? u.name : ''; }
          return client.from('requests').update({ report: rec }).eq('id', requestId).select().single().then(unwrap).then(function (r) { return r.report; });
        });
      },
      verifyReport: function (requestId, ok, note) {
        return client.from('requests').select('report').eq('id', requestId).single().then(unwrap).then(function (row) {
          var rec = row.report; if (!rec) throw new Error('제출된 보고서가 없습니다.');
          var u = currentUser();
          if (ok) { rec.status = 'verified'; rec.verifiedAt = new Date().toISOString(); rec.verifiedBy = u ? u.name : ''; rec.adminNote = String(note || '').trim(); }
          else { rec.status = 'draft'; rec.adminNote = String(note || '').trim(); delete rec.verifiedAt; delete rec.verifiedBy; }
          return client.from('requests').update({ report: rec }).eq('id', requestId).then(unwrap).then(function () { return rec; });
        });
      },
      setMySignature: function (key) { var u = currentUser(); if (!u) return Promise.reject(new Error('로그인이 필요합니다.')); return client.from('profiles').update({ signature_key: key || null }).eq('id', u.id).then(unwrap).then(function () {}); },
      getAccount: function (id) { return client.from('profiles').select('id, name, email, is_admin, status, created_at, signature_key').eq('id', id).maybeSingle().then(unwrap).then(function (p) { return p ? { id: p.id, name: p.name || p.email, role: p.is_admin ? 'admin' : 'member', status: p.status, createdAt: p.created_at, signatureKey: p.signature_key || null } : null; }); },
      signatureByName: function (name) {
        return client.from('profiles').select('signature_key').eq('name', String(name || '').trim()).limit(1).then(unwrap).then(function (rows) { return rows && rows.length ? (rows[0].signature_key || null) : null; });
      },

      deleteProject: function (id) {
        return client.from('projects').delete().eq('id', id).then(unwrap).then(function () {});
      },

      listRequests: function () {
        return client.from('requests').select('*').order('created_at', { ascending: false }).then(unwrap).then(function (rows) { return rows.map(toRequest); });
      },

      createRequest: function (r) {
        var u = currentUser();
        if (!u) return Promise.reject(new Error('로그인이 필요합니다.'));
        var row = Object.assign({ requester_id: u.id, requester_name: u.name, status: 'pending' }, fromRequestPatch(r));
        return client.from('requests').insert(row).select().single().then(unwrap).then(toRequest);
      },

      updateRequest: function (id, patch) {
        return client.from('requests').update(fromRequestPatch(patch)).eq('id', id).select().single().then(unwrap).then(toRequest);
      },

      deleteRequest: function (id) {
        return client.from('requests').delete().eq('id', id).then(unwrap).then(function () {});
      },

      listReviews: function (opts) {
        var full = !!(opts && opts.full) && !!(profile && profile.is_admin);
        if (full) {
          return client.from('reviews').select('*').order('created_at', { ascending: false }).then(unwrap).then(function (rows) { return rows.map(toReview); });
        }
        return client.from('reviews_status').select('*').order('created_at', { ascending: false }).then(unwrap).then(function (rows) { return rows.map(toReviewLimited); });
      },

      createReview: function (rv) {
        var u = currentUser();
        if (!u) return Promise.reject(new Error('로그인이 필요합니다.'));
        var row = Object.assign({ requester_id: u.id, requester_name: u.name, status: 'pending' }, fromReviewPatch(rv));
        return client.from('reviews').insert(row).select('id, created_at, requester_id, requester_name, title, status, processed_at').single().then(unwrap).then(toReviewLimited);
      },

      updateReview: function (id, patch) {
        return client.from('reviews').update(fromReviewPatch(patch)).eq('id', id).select().single().then(unwrap).then(toReview);
      },

      deleteReview: function (id) {
        return client.from('reviews').delete().eq('id', id).then(unwrap).then(function () {});
      },

      openReview: function (id, pin) {
        return client.rpc('open_review', { review_id: id, pin: String(pin) }).then(unwrap).then(function (rows) {
          return rows && rows.length ? toReview(rows[0]) : null;
        });
      },

      listExports: function () {
        return client.from('export_logs').select('*').order('created_at', { ascending: false }).then(unwrap).then(function (rows) { return rows.map(toExport); });
      },

      createExport: function (log) {
        var u = currentUser();
        if (!u) return Promise.reject(new Error('로그인이 필요합니다.'));
        var row = { exported_by: u.id, exported_by_name: u.name, purpose: log.purpose || '', format: log.format || 'csv', count: log.count || 0, total_amount: Math.round(Number(log.totalAmount) || 0), filter: log.filter || {}, rows: log.rows || [] };
        return client.from('export_logs').insert(row).select().single().then(unwrap).then(toExport);
      },

      /* ---------- 장비 예약 (검증은 모두 서버 함수에서) ---------- */
      listEquipment: function () {
        var admin = !!(profile && profile.is_admin);
        var cols = 'id, created_at, name, location, manager_name, description, rules, color, active';
        return Promise.all([
          client.from(admin ? 'equipment' : 'equipment_public').select(cols).order('created_at', { ascending: true }).then(unwrap),
          client.from('equipment_users_public').select('*').order('granted_at', { ascending: true }).then(unwrap)
        ]).then(function (res) {
          var users = {};
          res[1].forEach(function (u) { (users[u.equipment_id] = users[u.equipment_id] || []).push(toEqUser(u)); });
          return res[0].map(function (row) { return toEquipment(row, users[row.id] || []); });
        });
      },

      saveEquipment: function (eq, opts) {
        var row = fromEquipment(eq);
        var p = (opts && opts.managerPin) ? hashPin(opts.managerPin).then(function (h) { row.manager_pin_hash = h; }) : Promise.resolve();
        return p.then(function () {
          return client.from('equipment').upsert(row).select('id, created_at, name, location, manager_name, description, rules, color, active').single().then(unwrap)
            .then(function (r) { return toEquipment(r, eq.users || []); });
        });
      },

      deleteEquipment: function (id) {
        return client.from('equipment').delete().eq('id', id).then(unwrap).then(function () {});
      },

      verifyManager: function (equipmentId, pin) {
        return client.rpc('verify_equipment_manager', { p_equipment_id: equipmentId, p_pin: String(pin) }).then(unwrap).then(function (v) { return v === true; });
      },

      /* managerPin 이 null 이면 관리자 경로: RLS(equipment_users: admin all)로 직접 씀 */
      grantUser: function (equipmentId, managerPin, name, grade) {
        var nm = String(name || '').trim();
        if (managerPin === null) {
          if (!(profile && profile.is_admin)) return Promise.reject(new Error('관리자만 담당자 PIN 없이 등록할 수 있습니다.'));
          var key = nm.replace(/\s+/g, '').toLowerCase();
          return client.from('equipment_users').select('id').eq('equipment_id', equipmentId).eq('name_key', key).maybeSingle().then(unwrap).then(function (ex) {
            var by = profile.name || profile.email || '';
            var q = ex ? client.from('equipment_users').update({ name: nm, grade: normGrade(grade), granted_at: new Date().toISOString(), granted_by: by }).eq('id', ex.id)
                       : client.from('equipment_users').insert({ equipment_id: equipmentId, name: nm, name_key: key, grade: normGrade(grade), granted_by: by });
            return q.select('id, equipment_id, name, grade, granted_at, granted_by').single().then(unwrap).then(toEqUser);
          });
        }
        return client.rpc('grant_equipment_user', { p_equipment_id: equipmentId, p_manager_pin: String(managerPin), p_name: nm, p_grade: normGrade(grade) })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toEqUser(rows[0]) : null; });
      },

      setUserGrade: function (equipmentId, managerPin, userId, grade) {
        if (managerPin === null) {
          if (!(profile && profile.is_admin)) return Promise.reject(new Error('관리자만 바꿀 수 있습니다.'));
          return client.from('equipment_users').update({ grade: normGrade(grade), granted_at: new Date().toISOString(), granted_by: profile.name || profile.email || '' }).eq('id', userId).eq('equipment_id', equipmentId).select('id, equipment_id, name, grade, granted_at, granted_by').single().then(unwrap).then(toEqUser);
        }
        return client.rpc('set_equipment_user_grade', { p_equipment_id: equipmentId, p_manager_pin: String(managerPin), p_user_id: userId, p_grade: normGrade(grade) })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toEqUser(rows[0]) : null; });
      },

      updateReservation: function (id, patch, opts) {
        return client.rpc('update_reservation', { p_reservation_id: id, p_start: patch.start || null, p_end: patch.end || null, p_purpose: patch.purpose === undefined ? null : String(patch.purpose || '').trim(), p_manager_pin: opts && opts.managerPin ? String(opts.managerPin) : null })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toReservation(rows[0]) : null; });
      },

      revokeUser: function (equipmentId, managerPin, userId) {
        if (managerPin === null) {
          if (!(profile && profile.is_admin)) return Promise.reject(new Error('관리자만 해제할 수 있습니다.'));
          return client.from('equipment_users').delete().eq('id', userId).eq('equipment_id', equipmentId).then(unwrap).then(function () {});
        }
        return client.rpc('revoke_equipment_user', { p_equipment_id: equipmentId, p_manager_pin: String(managerPin), p_user_id: userId }).then(unwrap).then(function () {});
      },

      listReservations: function () {
        return client.from('reservations').select('*').order('start_at', { ascending: false }).then(unwrap).then(function (rows) { return rows.map(toReservation); });
      },

      listUsageLogs: function () {
        return client.from('usage_logs').select('*').order('created_at', { ascending: false }).then(unwrap).then(function (rows) { return rows.map(toUsageLog); });
      },

      createReservation: function (r) {
        return client.rpc('create_reservation', { p_equipment_id: r.equipmentId, p_start: r.start, p_end: r.end, p_purpose: String(r.purpose || '').trim() })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toReservation(rows[0]) : null; });
      },

      cancelReservation: function (id, opts) {
        return client.rpc('cancel_reservation', { p_reservation_id: id, p_manager_pin: opts && opts.managerPin ? String(opts.managerPin) : null })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toReservation(rows[0]) : null; });
      },

      createUsageLog: function (log) {
        return client.rpc('create_usage_log', { p_reservation_id: log.reservationId, p_used_start: log.usedStart || null, p_used_end: log.usedEnd || null,
          p_condition: log.condition === 'issue' ? 'issue' : 'normal', p_content: String(log.content || '').trim(), p_issues: String(log.issues || '').trim() })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toUsageLog(rows[0]) : null; });
      },

      waiveUsageLog: function (reservationId, managerPin, note) {
        return client.rpc('waive_usage_log', { p_reservation_id: reservationId, p_manager_pin: String(managerPin), p_note: String(note || '').trim() })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toUsageLog(rows[0]) : null; });
      },

      /* ---------- 출석 (검증은 서버 함수, 관리자 편집은 RLS) ---------- */
      attSession: function () { return readAttSession(); },
      attLogout: function () { writeAttSession(null); return Promise.resolve(); },

      /* 포털(auth) 계정으로 출석 구성원 자동 연결 */
      attLoginFromPortal: function () {
        return client.rpc('att_login_portal').then(unwrap).then(function (rows) {
          var m = rows && rows.length ? rows[0] : null;
          if (!m) throw new Error('출석 구성원 연결에 실패했습니다.');
          writeAttSession({ memberId: m.id, name: m.name, pin: '', ts: Date.now() });
          return { id: m.id, name: m.name, active: m.active !== false, createdAt: m.created_at };
        });
      },
      attLogin: function () { return this.attLoginFromPortal(); },
      attChangePin: function () { return Promise.reject(new Error('공용 DB 모드에서는 포털 계정으로 자동 연결되어 별도 PIN이 없습니다.')); },

      attListMembers: function () {
        return client.from('attendance_members_public').select('*').order('name').then(unwrap).then(function (rows) {
          return rows.map(function (r) { return { id: r.id, name: r.name, active: r.active !== false, createdAt: r.created_at }; });
        });
      },

      attSaveMember: function (m, opts) {
        var row = { name: String(m.name || '').trim(), name_key: nameKey(m.name), active: m.active !== false };
        if (m.id) row.id = m.id;
        var p = (opts && opts.pin) ? hashPin(opts.pin).then(function (h) { row.pin_hash = h; }) : Promise.resolve();
        return p.then(function () {
          if (!m.id && !row.pin_hash) throw new Error('초기 PIN을 정해 주세요.');
          return client.from('attendance_members').upsert(row).select('id, name, active, created_at').single().then(unwrap);
        }).then(function (r) { return { id: r.id, name: r.name, active: r.active !== false, createdAt: r.created_at }; });
      },

      attDeleteMember: function (id) { return client.from('attendance_members').delete().eq('id', id).then(unwrap).then(function () {}); },

      attListRecords: function () {
        return client.from('attendance_records').select('*').order('date', { ascending: false }).then(unwrap).then(function (rows) {
          return rows.map(function (r) { return { id: r.id, memberId: r.member_id, name: r.name, date: r.date, status: r.status, checkInAt: r.check_in_at, reason: r.reason || '', createdAt: r.created_at, editedBy: r.edited_by || null }; });
        });
      },

      attListLeaves: function () {
        return client.from('attendance_leaves').select('*').order('start_date', { ascending: false }).then(unwrap).then(function (rows) {
          return rows.map(function (l) { return { id: l.id, memberId: l.member_id, name: l.name, type: l.type, startDate: l.start_date, endDate: l.end_date, days: Number(l.days) || 0, reason: l.reason || '', createdAt: l.created_at }; });
        });
      },

      attListHolidays: function () {
        return client.from('attendance_holidays').select('*').then(unwrap).then(function (rows) {
          var out = {}; rows.forEach(function (h) { out[h.date] = h.label; }); return out;
        });
      },

      attSaveHolidays: function (obj) {
        var rows = Object.keys(obj || {}).map(function (d) { return { date: d, label: obj[d] }; });
        return client.rpc('att_set_holidays', { p_holidays: rows }).then(unwrap).then(function () {});
      },

      attCheckIn: function (reason) {
        var s = readAttSession(); if (!s) return Promise.reject(new Error('로그인이 필요합니다.'));
        return client.rpc('att_check_in', { p_reason: String(reason || '').trim() }).then(unwrap).then(function (rows) {
          var r = rows && rows.length ? rows[0] : null;
          if (!r) throw new Error('출석 체크에 실패했습니다.');
          return { id: r.id, memberId: r.member_id, name: r.name, date: r.date, status: r.status, checkInAt: r.check_in_at, reason: r.reason || '', createdAt: r.created_at };
        });
      },

      attUpdateRecord: function (id, patch) {
        var row = {}; if (patch.status) row.status = patch.status; if (patch.reason !== undefined) row.reason = patch.reason;
        return client.from('attendance_records').update(row).eq('id', id).select().single().then(unwrap);
      },

      attAdminSetDay: function (memberId, date, status, reason) {
        return client.from('attendance_records').delete().eq('member_id', memberId).eq('date', date).then(unwrap).then(function () {
          if (!status || status === 'absent') return;
          return client.from('attendance_members_public').select('name').eq('id', memberId).single().then(unwrap).then(function (m) {
            var u = currentUser();
            return client.from('attendance_records').insert({ member_id: memberId, name: m.name, date: date, status: status, check_in_at: date + 'T09:00:00+09:00', reason: String(reason || '').trim(), edited_by: u ? u.name : '관리자' }).then(unwrap);
          });
        });
      },

      attRequestLeave: function (req) {
        var s = readAttSession(); if (!s) return Promise.reject(new Error('로그인이 필요합니다.'));
        return client.rpc('att_request_leave', { p_type: req.type === 'trip' ? 'trip' : 'vacation', p_start: req.startDate, p_end: req.endDate || req.startDate, p_reason: String(req.reason || '').trim() })
          .then(unwrap).then(function (rows) {
            var l = rows && rows.length ? rows[0] : null;
            if (!l) throw new Error('신청에 실패했습니다.');
            return { id: l.id, memberId: l.member_id, name: l.name, type: l.type, startDate: l.start_date, endDate: l.end_date, days: Number(l.days) || 0, reason: l.reason || '', createdAt: l.created_at };
          });
      },

      attDeleteLeave: function (id, opts) {
        if (opts && opts.admin) return client.from('attendance_leaves').delete().eq('id', id).then(unwrap).then(function () {});
        var s = readAttSession(); if (!s) return Promise.reject(new Error('로그인이 필요합니다.'));
        return client.rpc('att_delete_leave', { p_id: id }).then(unwrap).then(function () {});
      },

      /* ---------- 소모품 재고 ---------- */
      invListManagers: function () {
        return client.from('inventory_managers_public').select('*').order('name').then(unwrap).then(function (rows) {
          return rows.map(function (r) { return { id: r.id, name: r.name, area: r.area || '', createdAt: r.created_at }; });
        });
      },
      invSaveManager: function (m, opts) {
        var row = { name: String(m.name || '').trim(), area: String(m.area || '').trim() };
        if (m.id) row.id = m.id;
        var p = (opts && opts.pin) ? hashPin(opts.pin).then(function (h) { row.pin_hash = h; }) : Promise.resolve();
        return p.then(function () {
          if (!m.id && !row.pin_hash) throw new Error('담당자 PIN을 정해 주세요.');
          return client.from('inventory_managers').upsert(row).select('id, name, area, created_at').single().then(unwrap);
        }).then(function (r) { return { id: r.id, name: r.name, area: r.area || '', createdAt: r.created_at }; });
      },
      invDeleteManager: function (id) { return client.from('inventory_managers').delete().eq('id', id).then(unwrap).then(function () {}); },
      invVerifyManager: function (managerId, pin) {
        return client.rpc('inv_verify_manager', { p_manager_id: managerId, p_pin: String(pin) }).then(unwrap).then(function (v) { return v === true; });
      },
      invListItems: function () {
        return client.from('inventory_items').select('*').order('location').order('name').then(unwrap).then(function (rows) { return rows.map(toInvItem); });
      },
      invListMoves: function () {
        return client.from('inventory_moves').select('*').order('created_at', { ascending: false }).then(unwrap).then(function (rows) { return rows.map(toInvMove); });
      },
      invSaveItem: function (item, creds) {
        return client.rpc('inv_save_item', { p_manager_id: creds.managerId, p_pin: String(creds.pin), p_item: {
          id: item.id || null, name: item.name, category: item.category || '', unit: item.unit || '개', location: item.location || '', qty: Number(item.qty) || 0,
          unit_price: Math.round(Number(item.unitPrice) || 0), min_qty: Number(item.minQty) || 0, note: item.note || '', active: item.active !== false, adjust_note: item.adjustNote || ''
        } }).then(unwrap).then(function (rows) { return rows && rows.length ? toInvItem(rows[0]) : null; });
      },
      invDeleteItem: function (id, creds) {
        return client.rpc('inv_delete_item', { p_manager_id: creds.managerId, p_pin: String(creds.pin), p_item_id: id }).then(unwrap).then(function () {});
      },
      invRestock: function (itemId, qty, unitPrice, note, creds) {
        return client.rpc('inv_restock', { p_manager_id: creds.managerId, p_pin: String(creds.pin), p_item_id: itemId, p_qty: Number(qty) || 0, p_unit_price: Math.round(Number(unitPrice) || 0), p_note: String(note || '').trim() })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toInvItem(rows[0]) : null; });
      },
      invConsume: function (itemId, qty, note) {
        return client.rpc('inv_consume', { p_item_id: itemId, p_qty: Number(qty) || 0, p_note: String(note || '').trim() })
          .then(unwrap).then(function (rows) { return rows && rows.length ? toInvMove(rows[0]) : null; });
      },

      onChange: function (cb) {
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
      },

      exportJSON: null,
      importJSON: null,
      resetDemo: null
    };
  }

  window.DSILStore = {
    create: function (cfg) {
      cfg = cfg || {};
      return cfg.backend === 'supabase' ? SupabaseStore(cfg) : LocalStore(cfg);
    },
    hashPin: hashPin
  };
})();
