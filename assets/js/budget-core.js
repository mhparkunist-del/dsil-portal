/* =====================================================================
   DSIL Lab Portal – 과제 예산 계산 (budget.js · meeting.js 공용)
   ---------------------------------------------------------------------
   세목(pool): budgetCategories 중 pool 이 없는 비목 = 연구시설·장비비 / 연구재료비 / 연구활동비.
               회의비처럼 pool 이 지정된 비목은 그 세목에서 차감.
   기준 잔액:  행정 연구비 현황 엑셀을 올리면 project.budgets 에 그 날짜의 잔액이,
               project.budgetBase 에 기준일·종료 구분·메모가 들어감.
               잔액 = 기준 잔액 − 기준일 이후 처리된 집행 − 가할당(승인된 구매 심의 중 미집행)
               기준일 이전 처리 건은 행정 잔액에 이미 반영된 것으로 봄.
   통합 잔액:  세목 구분 없는 과제(budgetBase.unified 가 숫자)는 모든 비목이 한 잔액에서 차감.
   ===================================================================== */
(function () {
  'use strict';

  function pad2(n) { return String(n).padStart(2, '0'); }
  function localDate(iso) {
    if (!iso) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
    var d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 10);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function dayDiff(fromYmd, toYmd) {
    var a = new Date(fromYmd + 'T00:00:00'), b = new Date(toYmd + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }
  function nameKey(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }

  function create(cfg) {
    cfg = cfg || {};
    var CATS = (cfg.budgetCategories && cfg.budgetCategories.length) ? cfg.budgetCategories : [{ id: 'other', label: '기타' }];
    var CAT_IDS = CATS.map(function (c) { return c.id; });
    var POOLS = CATS.filter(function (c) { return !c.pool; });
    var POOL_IDS = POOLS.map(function (c) { return c.id; });
    var BC = Object.assign({ refreshDays: 14, excludeAliases: [], mustSpendDays: 120 }, cfg.budget || {});
    var EXCLUDE = (BC.excludeAliases || []).map(nameKey);

    function normCat(id) { return CAT_IDS.indexOf(id) >= 0 ? id : CAT_IDS[0]; }
    function poolOf(cat) {
      var c = CATS.filter(function (x) { return x.id === normCat(cat); })[0];
      var p = c && c.pool ? c.pool : normCat(cat);
      return POOL_IDS.indexOf(p) >= 0 ? p : POOL_IDS[0];
    }
    function catLabel(id) { var c = CATS.filter(function (x) { return x.id === id; })[0]; return c ? c.label : (id || '-'); }
    function base(p) { return (p && p.budgetBase && typeof p.budgetBase === 'object' && p.budgetBase.date) ? p.budgetBase : null; }
    function isUnified(p) { var b = base(p); return !!b && typeof b.unified === 'number'; }
    /* 예산 관리 대상: 진행 중이고 제외 과제(개인과제 등)가 아닌 과제 */
    function excludedName(s) { var k = nameKey(s); return !!k && EXCLUDE.some(function (e) { return e && k.indexOf(e) >= 0; }); }
    function isExcluded(p) { return !!p && (excludedName(p.alias) || excludedName(p.name)); }
    function isManaged(p) { return !!p && p.active !== false && !isExcluded(p); }

    /* 기준일 이후 처리된 건만 실집행으로 차감 (기준일이 없는 과제는 전부) */
    function afterBase(p, when) { var b = base(p); return !b || localDate(when) > b.date; }

    function reviewApproved(rv) { return Number(rv.approvedAmount !== null && rv.approvedAmount !== undefined ? rv.approvedAmount : rv.amount) || 0; }

    /* ctx = { requests, reviews(관리자 전체) } */
    function stats(p, ctx) {
      ctx = ctx || {};
      var pools = {};
      POOL_IDS.forEach(function (id) { pools[id] = { budget: 0, actual: 0, provisional: 0, count: 0 }; });
      CAT_IDS.forEach(function (c) { pools[poolOf(c)].budget += Number(p.budgets && p.budgets[c]) || 0; });   /* 예전 회의비·기타 예산은 해당 세목에 합산 */
      var unified = isUnified(p);
      var u = { budget: unified ? base(p).unified : 0, actual: 0, provisional: 0, count: 0 };
      function bucket(cat) { return unified ? u : pools[poolOf(cat)]; }
      var reqs = ctx.requests || [];
      reqs.forEach(function (r) {
        if (r.status !== 'done' || r.projectId !== p.id || !afterBase(p, r.processedAt || r.createdAt)) return;
        var b = bucket(r.category); b.actual += Number(r.amount) || 0; b.count++;
      });
      (ctx.reviews || []).forEach(function (rv) {
        if (rv.status !== 'approved' || rv.projectId !== p.id) return;
        var used = reqs.reduce(function (s, r) { return s + (r.status === 'done' && r.reviewId === rv.id ? Number(r.amount) || 0 : 0); }, 0);
        bucket(rv.category).provisional += Math.max(0, reviewApproved(rv) - used);
      });
      var out = { unified: unified, pools: {}, budget: 0, actual: 0, provisional: 0, remain: 0 };
      var list = unified ? { unified: u } : pools;
      Object.keys(list).forEach(function (k) {
        var b = list[k];
        b.remain = b.budget - b.actual - b.provisional;
        b.ratio = b.budget > 0 ? (b.actual + b.provisional) / b.budget : (b.actual + b.provisional > 0 ? 1 : 0);
        out.pools[k] = b;
        out.budget += b.budget; out.actual += b.actual; out.provisional += b.provisional;
      });
      out.remain = out.budget - out.actual - out.provisional;
      return out;
    }
    /* 이 비목으로 배정할 때 쓸 수 있는 잔액 */
    function remainFor(p, cat, ctx) {
      var s = stats(p, ctx);
      return s.unified ? s.pools.unified.remain : s.pools[poolOf(cat)].remain;
    }

    /* 긴급도: must(이월불가·종료로 올해 소진 필요) > soon(종료 임박) > later > check(오픈 전 등 집행 전 확인).
       check 플래그는 소진 필요 과제에도 붙을 수 있음 (예: 과제종료 + 추가 집행 전 확인) → 순위는 유지하고 배정 때 확인 */
    function urgency(p, todayYmd) {
      var b = base(p) || {};
      var today = todayYmd || localDate(new Date().toISOString());
      var days = p.endDate ? dayDiff(today, p.endDate) : null;
      var check = !!b.checkFirst || b.open === false;
      var level = 'later';
      if (b.mustSpend) level = 'must';
      else if (check) level = 'check';
      else if (days !== null && days <= BC.mustSpendDays) level = 'soon';
      if (days !== null && days < 0) level = 'ended';
      return { level: level, check: check, days: days, rank: { must: 0, soon: 1, later: 2, check: 3, ended: 4 }[level] };
    }

    /* 기준 현황이 얼마나 지났는지 */
    function freshness(projects) {
      var latest = null;
      (projects || []).forEach(function (p) { var b = base(p); if (b && (!latest || b.date > latest.date)) latest = b; });
      if (!latest) return null;
      var age = dayDiff(latest.date, localDate(new Date().toISOString()));
      return { date: latest.date, source: latest.source || '', importedAt: latest.importedAt || '', importedBy: latest.importedBy || '', age: age, stale: age > BC.refreshDays, refreshDays: BC.refreshDays };
    }

    /* 배정 추천: 잔액 충분 → 올해 소진 필요 → 종료일 → 요청자 참여 과제. 확인 필요 과제는 뒤로 */
    function suggest(amount, cat, requesterName, projects, ctx, limit) {
      amount = Number(amount) || 0;
      var who = nameKey(requesterName);
      var list = (projects || []).filter(function (p) { return isManaged(p) && (base(p) || Object.keys(p.budgets || {}).some(function (k) { return Number(p.budgets[k]) > 0; })); }).map(function (p) {
        var remain = remainFor(p, cat, ctx);
        var u = urgency(p);
        var member = !!who && (p.participants || []).some(function (x) { return nameKey(x.name || x) === who; });
        return { project: p, remain: remain, after: remain - amount, enough: remain >= amount && remain > 0, urgency: u, member: member };
      }).filter(function (x) { return x.urgency.level !== 'ended' && x.remain > 0; });
      list.sort(function (a, b) {
        if (a.enough !== b.enough) return a.enough ? -1 : 1;
        var ca = a.urgency.level === 'check', cb = b.urgency.level === 'check';
        if (ca !== cb) return ca ? 1 : -1;
        if (a.urgency.rank !== b.urgency.rank) return a.urgency.rank - b.urgency.rank;
        var da = a.urgency.days === null ? 99999 : a.urgency.days, db = b.urgency.days === null ? 99999 : b.urgency.days;
        if (da !== db) return da - db;
        if (a.member !== b.member) return a.member ? -1 : 1;
        return b.remain - a.remain;
      });
      return list.slice(0, limit || 3);
    }

    return {
      CATS: CATS, CAT_IDS: CAT_IDS, POOLS: POOLS, POOL_IDS: POOL_IDS, cfg: BC,
      normCat: normCat, poolOf: poolOf, catLabel: catLabel, base: base, isUnified: isUnified, isExcluded: isExcluded, excludedName: excludedName, isManaged: isManaged,
      stats: stats, remainFor: remainFor, urgency: urgency, freshness: freshness, suggest: suggest, localDate: localDate, dayDiff: dayDiff
    };
  }

  window.DSILBudget = { create: create };
})();
