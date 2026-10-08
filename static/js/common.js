// js/common.js - utilitas bersama semua halaman (harus dimuat paling awal)
//
// Isi: escapeHTML, toast, dialog (pengganti alert/confirm), salin teks, tombol "sibuk",
//      pemuat script lazy, deteksi perangkat, dan pesan singkat antar-halaman (flash).
(function () {
  'use strict';

  // ---------- Teks aman untuk innerHTML ----------
  function escapeHTML(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>'"]/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]
    ));
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------- Toast: pesan singkat yang hilang sendiri (tidak memblokir layar seperti alert) ----------
  function toast(message, type = 'info', duration = 3800) {
    let container = document.querySelector('.ui-toast-container');
    if (!container) {
      container = el('div', 'ui-toast-container');
      document.body.appendChild(container);
    }
    const node = el('div', `ui-toast ui-toast-${type}`, message);
    node.setAttribute('role', type === 'error' ? 'alert' : 'status');
    container.appendChild(node);
    const remove = () => { if (node.parentNode) node.parentNode.removeChild(node); };
    setTimeout(remove, duration);
    return node;
  }

  // ---------- Dialog: pengganti alert() dan confirm() ----------
  // alert()/confirm() bawaan sering diblokir browser HP (mis. di dalam aplikasi lain atau setelah
  // "cegah dialog tambahan"), dan menghentikan seluruh halaman selama terbuka.
  let dialogDepth = 0;
  const openDialogs = new Set(); // fungsi finish() tiap dialog yang sedang terbuka
  function dialog({ title = '', message = '', confirmText = 'OK', cancelText = null, danger = false } = {}) {
    return new Promise((resolve) => {
      const previouslyFocused = document.activeElement;
      const backdrop = el('div', 'ui-modal-backdrop');
      backdrop.style.zIndex = String(900 + (++dialogDepth));
      const box = el('div', 'ui-modal');
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      if (title) {
        const heading = el('h3', 'ui-modal-title', title);
        heading.id = `ui-dialog-title-${dialogDepth}`;
        box.setAttribute('aria-labelledby', heading.id);
        box.appendChild(heading);
      }
      box.appendChild(el('p', 'ui-modal-message', message));

      const actions = el('div', 'ui-modal-actions');
      let cancelBtn = null;
      if (cancelText) {
        cancelBtn = el('button', 'btn btn-secondary', cancelText);
        cancelBtn.type = 'button';
        actions.appendChild(cancelBtn);
      }
      const okBtn = el('button', `btn ${danger ? 'btn-danger' : 'btn-primary'}`, confirmText);
      okBtn.type = 'button';
      actions.appendChild(okBtn);
      box.appendChild(actions);
      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      document.body.classList.add('modal-open');
      okBtn.focus();

      function finish(result) {
        if (!openDialogs.has(finish)) return;
        openDialogs.delete(finish);
        document.removeEventListener('keydown', onKey, true);
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        dialogDepth = Math.max(0, dialogDepth - 1);
        if (!document.querySelector('.ui-modal-backdrop') && !document.querySelector('.modal-backdrop:not(.hidden)')) {
          document.body.classList.remove('modal-open');
        }
        if (previouslyFocused && previouslyFocused.focus) {
          try { previouslyFocused.focus(); } catch (e) { /* abaikan */ }
        }
        resolve(result);
      }
      function onKey(event) {
        if (event.key === 'Escape') { event.stopPropagation(); finish(false); }
      }
      openDialogs.add(finish);
      document.addEventListener('keydown', onKey, true);
      okBtn.addEventListener('click', () => finish(true));
      if (cancelBtn) cancelBtn.addEventListener('click', () => finish(false));
      backdrop.addEventListener('click', (event) => {
        if (event.target === backdrop && cancelText) finish(false);
      });
    });
  }

  // Tutup semua dialog yang terbuka (dianggap "batal"), mis. saat waktu kuis habis di tengah konfirmasi
  function closeAllDialogs() {
    Array.from(openDialogs).forEach((finish) => finish(false));
  }

  const alertDialog = (message, title = '') => dialog({ title, message, confirmText: 'OK' });
  const confirmDialog = (options) => dialog(Object.assign({ confirmText: 'Ya', cancelText: 'Batal' }, options));

  // ---------- Salin teks (navigator.clipboard hanya ada di HTTPS; di http://IP-LAN perlu cara lain) ----------
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* lanjut ke cara lama */ }

    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px;';
    document.body.appendChild(area);
    area.focus();
    area.select();
    try { area.setSelectionRange(0, text.length); } catch (e) { /* abaikan */ }
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  // ---------- Tombol "sedang memproses" (mencegah klik ganda di HP yang lambat) ----------
  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      if (button.dataset.idleLabel === undefined) button.dataset.idleLabel = button.textContent;
      if (busyText) button.textContent = busyText;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      if (button.dataset.idleLabel !== undefined) {
        button.textContent = button.dataset.idleLabel;
        delete button.dataset.idleLabel;
      }
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  }

  // ---------- Pemuat script lazy (mis. html2pdf hanya dimuat saat tombol PDF ditekan) ----------
  const scriptPromises = {};
  function loadScript(src, isReady) {
    if (isReady && isReady()) return Promise.resolve();
    if (scriptPromises[src]) return scriptPromises[src];
    scriptPromises[src] = new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = src;
      tag.async = true;
      tag.onload = () => resolve();
      tag.onerror = () => {
        delete scriptPromises[src];
        reject(new Error('Gagal memuat modul. Periksa koneksi internet lalu coba lagi.'));
      };
      document.head.appendChild(tag);
    });
    return scriptPromises[src];
  }

  // ---------- Perangkat ----------
  const isTouchDevice = () => ('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0;
  const isMobile = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    (isTouchDevice() && Math.min(window.innerWidth, window.innerHeight) < 700);

  function isLoopbackHost(hostname) {
    const host = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
    return host === '' || host === 'localhost' || host === '::1' || host.endsWith('.localhost') || /^127\./.test(host);
  }

  // ---------- Format waktu (server mengirim ISO UTC berakhiran Z -> tampil di zona waktu perangkat) ----------
  function formatTime(iso) {
    if (!iso) return '-';
    const date = new Date(iso);
    return isNaN(date) ? '-' : date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function formatDate(iso, withTime = false) {
    if (!iso) return '-';
    const date = new Date(iso);
    if (isNaN(date)) return '-';
    const options = { day: 'numeric', month: 'long', year: 'numeric' };
    if (withTime) { options.hour = '2-digit'; options.minute = '2-digit'; }
    return date.toLocaleString('id-ID', options);
  }
  function formatDuration(totalSeconds) {
    const safe = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(safe / 3600);
    const m = Math.floor((safe % 3600) / 60);
    const s = safe % 60;
    const mm = String(m).padStart(2, '0');
    const ss = String(s).padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // ---------- Pesan singkat antar-halaman (menggantikan alert() sebelum redirect) ----------
  function flash(message) {
    try { sessionStorage.setItem('flash_message', message); } catch (e) { /* mode privat */ }
  }
  function showFlash() {
    let message = null;
    try {
      message = sessionStorage.getItem('flash_message');
      if (message) sessionStorage.removeItem('flash_message');
    } catch (e) { /* abaikan */ }
    if (message) toast(message, 'info', 6000);
  }
  document.addEventListener('DOMContentLoaded', showFlash);

  window.UI = {
    escapeHTML, toast, dialog, closeAllDialogs,
    alert: alertDialog, confirm: confirmDialog,
    copyText, setBusy, loadScript,
    isTouchDevice, isMobile, isLoopbackHost,
    formatTime, formatDate, formatDuration,
    flash,
  };
  window.escapeHTML = escapeHTML; // kompatibel dengan kode lama
})();
