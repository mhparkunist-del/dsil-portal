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
     onChange(cb)                   -> unsubscribe()
     exportJSON() / importJSON(obj) -> (local only)

   Project { id, code, name, budgets:{<categoryId>: amount}, startDate, endDate, manager, note, active, createdAt }
   Request { id, createdAt, requesterId, requesterName, item, category, link, qty, unitPrice, amount,
             note, status:'pending'|'done'|'rejected', projectId, reviewId, adminNote, processedAt, processedBy }
   Review  { id, createdAt, requesterId, requesterName, title, purpose, vendor, category,
             items:[{name, amount}], amount, note, pinHash,
             status:'pending'|'approved'|'rejected', projectId, approvedAmount, adminNote, processedAt, processedBy }
   ===================================================================== */
(function () {
  'use strict';

  var DATA_KEY = 'dsil-budget-v1';
  var SESSION_KEY = 'dsil-budget-session-v1';
  var DEMO_PIN_HASH = '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4'; /* sha256("1234") */

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

  /* ------------------------------------------------------------------ */
  /*  Demo seed                                                          */
  /* ------------------------------------------------------------------ */
  function seedData() {
    var p1 = uid(), p2 = uid(), p3 = uid();
    var rv1 = uid(), rv2 = uid();
    return {
      projects: [
        { id: p1, code: '2026-A01', name: '차세대 AI 반도체 모놀리식 3D 집적 기술', budgets: { material: 25000000, activity: 10000000, equipment: 15000000, other: 0 }, startDate: '2026-03-01', endDate: '2027-02-28', manager: '김교수', note: '재료비 위주 집행', active: true, createdAt: daysAgo(120) },
        { id: p2, code: '2026-B07', name: '산화물 반도체 기반 DRAM 셀 소자 개발', budgets: { material: 18000000, activity: 7000000, equipment: 5000000, other: 0 }, startDate: '2026-01-01', endDate: '2026-12-31', manager: '김교수', note: '', active: true, createdAt: daysAgo(200) },
        { id: p3, code: '2025-C03', name: '이종 집적 첨단 패키징 기초연구', budgets: { material: 8000000, activity: 4000000, equipment: 8000000, other: 0 }, startDate: '2025-09-01', endDate: '2026-08-31', manager: '김교수', note: '종료 임박, 잔액 소진 우선', active: true, createdAt: daysAgo(370) }
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
    });
    (data.requests || []).forEach(function (r) {
      if (!r.category || ids.indexOf(r.category) < 0) r.category = first;
      if (r.reviewId === undefined) r.reviewId = null;
    });
    if (!Array.isArray(data.reviews)) data.reviews = [];
    return data;
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
        data = cfg.seedDemoData ? seedData() : { projects: [], requests: [], reviews: [] };
        write();
      } else {
        migrate(data, cfg);
      }
    }

    function write() {
      try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) { console.warn('localStorage write failed', e); }
    }

    function readSession() {
      try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
      if (session && session.user) session.isAdmin = true; /* local 모드: PIN 이 관리자 게이트 */
    }

    function writeSession() {
      try {
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
      } catch (e) { /* ignore */ }
    }

    function clone(x) { return JSON.parse(JSON.stringify(x)); }
    function needSession() { return session ? null : new Error('로그인이 필요합니다.'); }

    window.addEventListener('storage', function (e) {
      if (e.key === DATA_KEY) { read(); emit(); }
    });

    return {
      mode: 'local',

      init: function () { read(); readSession(); return Promise.resolve(); },

      getSession: function () { return session ? clone(session) : null; },

      signIn: function (payload) {
        var name = (payload && payload.name || '').trim();
        if (!name) return Promise.reject(new Error('이름을 입력하세요.'));
        session = { user: { id: 'local-' + name, name: name, email: '' }, isAdmin: true };
        writeSession();
        emit();
        return Promise.resolve(clone(session));
      },

      signOut: function () { session = null; writeSession(); emit(); return Promise.resolve(); },

      verifyAdminPin: function (pin) { return Promise.resolve(String(pin) === String(cfg.adminPin)); },

      listProjects: function () { return Promise.resolve(clone(data.projects)); },

      saveProject: function (p) {
        var idx = data.projects.findIndex(function (x) { return x.id === p.id; });
        var rec = Object.assign({}, idx >= 0 ? data.projects[idx] : { id: uid(), createdAt: nowISO() }, p);
        if (!rec.id) rec.id = uid();
        if (!rec.budgets || typeof rec.budgets !== 'object') rec.budgets = {};
        if (idx >= 0) data.projects[idx] = rec; else data.projects.push(rec);
        write(); emit();
        return Promise.resolve(clone(rec));
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
          status: 'pending', projectId: null, reviewId: null, adminNote: '', processedAt: null, processedBy: null
        }, r);
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

      onChange: function (cb) {
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
      },

      exportJSON: function () { return clone(data); },

      importJSON: function (obj) {
        if (!obj || !Array.isArray(obj.projects) || !Array.isArray(obj.requests)) throw new Error('형식이 올바르지 않습니다.');
        data = migrate(clone(obj), cfg); write(); emit();
      },

      resetDemo: function () { data = seedData(); write(); emit(); }
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
      note: row.note || '', active: row.active !== false, createdAt: row.created_at
    };
  }

  function fromProject(p) {
    var budgets = {};
    Object.keys(p.budgets || {}).forEach(function (k) { budgets[k] = Math.round(Number(p.budgets[k]) || 0); });
    var out = {
      code: p.code || '', name: p.name, budgets: budgets,
      start_date: p.startDate || null, end_date: p.endDate || null, manager: p.manager || '',
      note: p.note || '', active: p.active !== false
    };
    if (p.id) out.id = p.id;
    return out;
  }

  function toRequest(row) {
    return {
      id: row.id, createdAt: row.created_at, requesterId: row.requester_id, requesterName: row.requester_name || '',
      item: row.item, category: row.category || '', link: row.link || '', qty: Number(row.qty) || 1, unitPrice: Number(row.unit_price) || 0,
      amount: Number(row.amount) || 0, note: row.note || '', status: row.status, projectId: row.project_id || null, reviewId: row.review_id || null,
      adminNote: row.admin_note || '', processedAt: row.processed_at || null, processedBy: row.processed_by_name || null
    };
  }

  function fromRequestPatch(patch) {
    var map = {
      item: 'item', category: 'category', link: 'link', qty: 'qty', unitPrice: 'unit_price', amount: 'amount', note: 'note',
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
            .subscribe();
        });
      },

      getSession: function () {
        if (!session) return null;
        return { user: currentUser(), isAdmin: !!(profile && profile.is_admin) };
      },

      signIn: function (payload) {
        var email = (payload && payload.email || '').trim();
        if (!email) return Promise.reject(new Error('이메일을 입력하세요.'));
        return client.auth.signInWithOtp({
          email: email,
          options: { emailRedirectTo: window.location.href.split('#')[0], data: { name: (payload.name || '').trim() } }
        }).then(unwrap).then(function () { return { magicLinkSent: true }; });
      },

      signOut: function () { return client.auth.signOut().then(function () { session = null; profile = null; emit(); }); },

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
