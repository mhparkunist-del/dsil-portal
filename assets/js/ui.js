/* =====================================================================
   DSIL Lab Portal – shared UI helpers (Tabler markup)
   Used by budget.js and equipment.js. Exposes window.DSILUI.
   ===================================================================== */
(function () {
  'use strict';

  var nf = new Intl.NumberFormat('ko-KR');
  function won(n) { return nf.format(Math.round(Number(n) || 0)) + '원'; }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function localDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return String(iso).slice(0, 10);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtDate(iso) { var s = localDate(iso); return s ? s.replace(/-/g, '.') : ''; }
  function fmtTime(iso) { var d = new Date(iso); return isNaN(d) ? '' : pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fmtDateTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return esc(iso);
    return fmtDate(iso) + ' ' + fmtTime(iso);
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var toastTimer = null;
  function toast(msg, isError) {
    var el = $('#toast');
    if (!el) return;
    el.textContent = msg;
    el.className = 'portal-toast alert ' + (isError ? 'alert-danger' : 'alert-success') + ' is-visible';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('is-visible'); }, 3000);
  }

  function readForm(form) {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name) return;
      if (el.type === 'checkbox') out[el.name] = el.checked;
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; else if (!(el.name in out)) out[el.name] = ''; }
      else out[el.name] = el.value;
    });
    return out;
  }

  var openDialogs = [];
  function closeAll() { openDialogs.slice().forEach(function (c) { c(null); }); }

  /* Tabler 마크업의 모달. opts.bodyHtml → 폼 값 객체, opts.html → 읽기 전용, opts.input → 문자열, 그 외 → true */
  function dialog(opts) {
    return new Promise(function (resolve) {
      var wrap = document.createElement('div');
      var inner = '';
      if (opts.bodyHtml) inner = '<form id="modal-form">' + opts.bodyHtml + '</form>';
      else if (opts.html) inner = opts.html;
      else if (opts.input === 'textarea') inner = '<textarea class="form-control modal-input" rows="3" placeholder="' + esc(opts.placeholder || '') + '"></textarea>';
      else if (opts.input) inner = '<input class="form-control modal-input" type="' + (opts.input === 'password' ? 'password' : 'text') + '" placeholder="' + esc(opts.placeholder || '') + '" autocomplete="off" inputmode="' + (opts.input === 'password' ? 'numeric' : 'text') + '">';
      wrap.innerHTML = '<div class="modal modal-blur fade show is-open" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="modal-title">'
        + '<div class="modal-dialog ' + (opts.size === 'lg' ? 'modal-lg' : 'modal-sm') + ' modal-dialog-centered modal-dialog-scrollable" role="document"><div class="modal-content">'
        + '<div class="modal-header"><h5 class="modal-title" id="modal-title">' + esc(opts.title || '') + '</h5><button type="button" class="btn-close" data-modal="cancel" aria-label="닫기"></button></div>'
        + '<div class="modal-body">' + (opts.message ? '<p class="mb-' + (inner ? '2' : '0') + '">' + esc(opts.message) + '</p>' : '') + inner + '</div>'
        + '<div class="modal-footer">' + (opts.hideCancel ? '' : '<button type="button" class="btn btn-link link-secondary" data-modal="cancel">취소</button>')
        + '<button type="button" class="btn ' + (opts.danger ? 'btn-danger' : 'btn-primary') + ' ms-auto" data-modal="ok">' + esc(opts.okLabel || '확인') + '</button></div>'
        + '</div></div></div><div class="modal-backdrop fade show"></div>';
      document.body.appendChild(wrap);
      var input = wrap.querySelector('.modal-input');
      var form = wrap.querySelector('#modal-form');
      var first = input || (form && form.querySelector('input,select,textarea')) || wrap.querySelector('[data-modal="ok"]');
      first.focus();
      function close(val) {
        document.removeEventListener('keydown', onKey);
        openDialogs = openDialogs.filter(function (c) { return c !== close; });
        wrap.remove();
        resolve(val);
      }
      openDialogs.push(close);
      function ok() {
        if (form) { if (!form.reportValidity()) return; close(readForm(form)); return; }
        close(input ? input.value : true);
      }
      function onKey(e) {
        if (e.key === 'Escape') close(null);
        if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && (input || form)) { e.preventDefault(); ok(); }
      }
      document.addEventListener('keydown', onKey);
      wrap.addEventListener('click', function (e) {
        var b = e.target.closest('[data-modal]');
        if (b) { if (b.getAttribute('data-modal') === 'ok') ok(); else close(null); return; }
        if (e.target.classList.contains('modal')) close(null);
      });
      if (form) form.addEventListener('submit', function (e) { e.preventDefault(); ok(); });
    });
  }
  function confirmDlg(opts) { return dialog(opts).then(function (v) { return v === true; }); }
  function promptDlg(opts) { return dialog(opts); }

  function download(name, text, type) {
    var blob = new Blob([text], { type: type || 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }
  function csvCell(v) {
    var s = String(v === null || v === undefined ? '' : v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function empty(icon, title, sub) {
    return '<div class="empty py-4"><div class="empty-icon"><i class="ti ti-' + icon + '"></i></div><p class="empty-title">' + esc(title) + '</p>'
      + (sub ? '<p class="empty-subtitle text-secondary">' + esc(sub) + '</p>' : '') + '</div>';
  }
  function dg(title, content) { return '<div class="datagrid-item"><div class="datagrid-title">' + esc(title) + '</div><div class="datagrid-content">' + content + '</div></div>'; }
  function stat(label, value, sub, cls, col) {
    return '<div class="' + (col || 'col-6 col-lg-3') + '"><div class="card card-sm"><div class="card-body">'
      + '<div class="subheader">' + esc(label) + '</div>'
      + '<div class="h1 mb-1 tnum ' + (cls || '') + '">' + esc(value) + '</div>'
      + (sub ? '<div class="text-secondary small">' + esc(sub) + '</div>' : '') + '</div></div></div>';
  }

  window.DSILUI = {
    nf: nf, won: won, esc: esc, pad2: pad2, localDate: localDate, fmtDate: fmtDate, fmtTime: fmtTime, fmtDateTime: fmtDateTime,
    $: $, $all: $all, toast: toast, readForm: readForm, dialog: dialog, confirmDlg: confirmDlg, promptDlg: promptDlg, closeAll: closeAll,
    download: download, csvCell: csvCell, empty: empty, dg: dg, stat: stat
  };
})();
