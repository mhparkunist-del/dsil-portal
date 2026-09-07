/* =====================================================================
   DSIL Lab Portal – data layer
   ---------------------------------------------------------------------
   Two interchangeable adapters expose the same async interface:

     init()                         -> Promise<void>
     getSession()                   -> { user:{id,name,email}, isAdmin } | null
     signIn(payload) / signOut()    -> Promise
     becomeAdmin(pin)               -> Promise<boolean>   (local only)
     listProjects()                 -> Promise<Project[]>
     saveProject(project)           -> Promise<Project>
     deleteProject(id)              -> Promise<void>
     listRequests()                 -> Promise<Request[]>
     createRequest(request)         -> Promise<Request>
     updateRequest(id, patch)       -> Promise<Request>
     onChange(cb)                   -> unsubscribe()
     exportJSON() / importJSON(obj) -> (local only)

   Project { id, code, name, budget, startDate, endDate, manager, note, active, createdAt }
   Request { id, createdAt, requesterId, requesterName, item, link, qty, unitPrice, amount,
             note, status:'pending'|'done'|'rejected', projectId, adminNote, processedAt, processedBy }
   ===================================================================== */
(function () {
  'use strict';

  var DATA_KEY = 'dsil-budget-v1';
  var SESSION_KEY = 'dsil-budget-session-v1';

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

  /* ------------------------------------------------------------------ */
  /*  Demo seed                                                          */
  /* ------------------------------------------------------------------ */
  function seedData() {
    var p1 = uid(), p2 = uid(), p3 = uid();
    return {
      projects: [
        { id: p1, code: '2026-A01', name: '차세대 AI 반도체 모놀리식 3D 집적 기술', budget: 50000000, startDate: '2026-03-01', endDate: '2027-02-28', manager: '김교수', note: '재료비 위주 집행', active: true, createdAt: daysAgo(120) },
        { id: p2, code: '2026-B07', name: '산화물 반도체 기반 DRAM 셀 소자 개발', budget: 30000000, startDate: '2026-01-01', endDate: '2026-12-31', manager: '김교수', note: '', active: true, createdAt: daysAgo(200) },
        { id: p3, code: '2025-C03', name: '이종 집적 첨단 패키징 기초연구', budget: 20000000, startDate: '2025-09-01', endDate: '2026-08-31', manager: '김교수', note: '종료 임박, 잔액 소진 우선', active: true, createdAt: daysAgo(370) }
      ],
      requests: [
        { id: uid(), createdAt: daysAgo(1), requesterId: 'demo-1', requesterName: '홍길동', item: '6인치 SiO2/Si 웨이퍼 25매', link: 'https://example.com/wafer', qty: 1, unitPrice: 1850000, amount: 1850000, note: 'TMD 성장용 기판', status: 'pending', projectId: null, adminNote: '', processedAt: null, processedBy: null },
        { id: uid(), createdAt: daysAgo(2), requesterId: 'demo-2', requesterName: '이영희', item: 'PDMS 스탬프 세트 (Gel-Pak)', link: '', qty: 3, unitPrice: 120000, amount: 360000, note: '전사 공정용', status: 'pending', projectId: null, adminNote: '', processedAt: null, processedBy: null },
        { id: uid(), createdAt: daysAgo(3), requesterId: 'demo-3', requesterName: '박철수', item: '프로브 스테이션 텅스텐 팁 (10개)', link: 'https://example.com/tip', qty: 2, unitPrice: 95000, amount: 190000, note: '', status: 'pending', projectId: null, adminNote: '', processedAt: null, processedBy: null },
        { id: uid(), createdAt: daysAgo(9), requesterId: 'demo-1', requesterName: '홍길동', item: 'HfO2 ALD 전구체 (TDMAH) 25 g', link: '', qty: 1, unitPrice: 2400000, amount: 2400000, note: '', status: 'done', projectId: p2, adminNote: '', processedAt: daysAgo(8), processedBy: '관리자' },
        { id: uid(), createdAt: daysAgo(14), requesterId: 'demo-2', requesterName: '이영희', item: 'Keithley 2636B 케이블/픽스처', link: '', qty: 1, unitPrice: 780000, amount: 780000, note: '', status: 'done', projectId: p1, adminNote: '', processedAt: daysAgo(13), processedBy: '관리자' },
        { id: uid(), createdAt: daysAgo(20), requesterId: 'demo-3', requesterName: '박철수', item: 'Cu 필러 범프 시편 가공 외주', link: '', qty: 1, unitPrice: 4500000, amount: 4500000, note: '패키징 실험용', status: 'done', projectId: p3, adminNote: '', processedAt: daysAgo(19), processedBy: '관리자' },
        { id: uid(), createdAt: daysAgo(25), requesterId: 'demo-1', requesterName: '홍길동', item: '노트북 (개인 사용)', link: '', qty: 1, unitPrice: 2100000, amount: 2100000, note: '', status: 'rejected', projectId: null, adminNote: '개인 장비는 과제 예산 집행 불가', processedAt: daysAgo(24), processedBy: '관리자' }
      ]
    };
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
        data = cfg.seedDemoData ? seedData() : { projects: [], requests: [] };
        write();
      }
    }

    function write() {
      try { localStorage.setItem(DATA_KEY, JSON.stringify(data)); } catch (e) { console.warn('localStorage write failed', e); }
    }

    function readSession() {
      try { session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (e) { session = null; }
    }

    function writeSession() {
      try {
        if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
        else localStorage.removeItem(SESSION_KEY);
      } catch (e) { /* ignore */ }
    }

    function clone(x) { return JSON.parse(JSON.stringify(x)); }

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
        var isAdmin = !!(payload.pin && payload.pin === cfg.adminPin);
        session = { user: { id: 'local-' + name, name: name, email: '' }, isAdmin: isAdmin };
        writeSession();
        emit();
        return Promise.resolve(clone(session));
      },

      signOut: function () { session = null; writeSession(); emit(); return Promise.resolve(); },

      becomeAdmin: function (pin) {
        if (!session) return Promise.resolve(false);
        if (pin !== cfg.adminPin) return Promise.resolve(false);
        session.isAdmin = true; writeSession(); emit();
        return Promise.resolve(true);
      },

      listProjects: function () { return Promise.resolve(clone(data.projects)); },

      saveProject: function (p) {
        var idx = data.projects.findIndex(function (x) { return x.id === p.id; });
        var rec = Object.assign({}, idx >= 0 ? data.projects[idx] : { id: uid(), createdAt: nowISO() }, p);
        if (!rec.id) rec.id = uid();
        if (idx >= 0) data.projects[idx] = rec; else data.projects.push(rec);
        write(); emit();
        return Promise.resolve(clone(rec));
      },

      deleteProject: function (id) {
        var used = data.requests.some(function (r) { return r.projectId === id; });
        if (used) return Promise.reject(new Error('이미 배정된 구매건이 있는 과제는 삭제할 수 없습니다. 비활성으로 바꾸세요.'));
        data.projects = data.projects.filter(function (x) { return x.id !== id; });
        write(); emit();
        return Promise.resolve();
      },

      listRequests: function () { return Promise.resolve(clone(data.requests)); },

      createRequest: function (r) {
        if (!session) return Promise.reject(new Error('로그인이 필요합니다.'));
        var rec = Object.assign({
          id: uid(), createdAt: nowISO(),
          requesterId: session.user.id, requesterName: session.user.name,
          status: 'pending', projectId: null, adminNote: '', processedAt: null, processedBy: null
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

      onChange: function (cb) {
        listeners.push(cb);
        return function () { listeners = listeners.filter(function (x) { return x !== cb; }); };
      },

      exportJSON: function () { return clone(data); },

      importJSON: function (obj) {
        if (!obj || !Array.isArray(obj.projects) || !Array.isArray(obj.requests)) throw new Error('형식이 올바르지 않습니다.');
        data = clone(obj); write(); emit();
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
      id: row.id, code: row.code || '', name: row.name, budget: Number(row.budget) || 0,
      startDate: row.start_date || '', endDate: row.end_date || '', manager: row.manager || '',
      note: row.note || '', active: row.active !== false, createdAt: row.created_at
    };
  }

  function fromProject(p) {
    var out = {
      code: p.code || '', name: p.name, budget: Math.round(Number(p.budget) || 0),
      start_date: p.startDate || null, end_date: p.endDate || null, manager: p.manager || '',
      note: p.note || '', active: p.active !== false
    };
    if (p.id) out.id = p.id;
    return out;
  }

  function toRequest(row) {
    return {
      id: row.id, createdAt: row.created_at, requesterId: row.requester_id, requesterName: row.requester_name || '',
      item: row.item, link: row.link || '', qty: Number(row.qty) || 1, unitPrice: Number(row.unit_price) || 0,
      amount: Number(row.amount) || 0, note: row.note || '', status: row.status, projectId: row.project_id || null,
      adminNote: row.admin_note || '', processedAt: row.processed_at || null, processedBy: row.processed_by_name || null
    };
  }

  function fromRequestPatch(patch) {
    var map = {
      item: 'item', link: 'link', qty: 'qty', unitPrice: 'unit_price', amount: 'amount', note: 'note',
      status: 'status', projectId: 'project_id', adminNote: 'admin_note', processedAt: 'processed_at',
      processedBy: 'processed_by_name', requesterName: 'requester_name'
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

      becomeAdmin: function () { return Promise.resolve(false); },

      listProjects: function () {
        return client.from('projects').select('*').order('created_at', { ascending: true }).then(unwrap).then(function (rows) { return rows.map(toProject); });
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
    }
  };
})();
