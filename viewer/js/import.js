'use strict';
/* ── import.js  ▸  FAB + 上傳 Sheet（wf-007）+ URL 匯入 Sheet（wf-008）── */

import { state } from './state.js';

// ── FAB ──────────────────────────────────────────────────────────────────
export function toggleFabMenu() {
  const menu = document.getElementById('fab-menu');
  if (!menu) return;
  const open = menu.classList.toggle('open');
  document.getElementById('import-fab')?.classList.toggle('active', open);
  if (open) {
    const off = () => { closeFabMenu(); document.removeEventListener('click', off); };
    setTimeout(() => document.addEventListener('click', off), 0);
  }
}

export function closeFabMenu() {
  document.getElementById('fab-menu')?.classList.remove('open');
  document.getElementById('import-fab')?.classList.remove('active');
}

// ── Upload Sheet (wf-007) ─────────────────────────────────────────────────
export function openUploadSheet() {
  closeFabMenu();
  const input = document.getElementById('upload-file-input');
  if (input) input.value = '';
  document.getElementById('upload-name').value    = '';
  document.getElementById('upload-file-label').textContent = '';
  document.getElementById('upload-status').textContent     = '';
  document.getElementById('upload-btn').disabled           = false;
  // 監聽 file input 變化以更新標籤
  input?.addEventListener('change', _onUploadFileChange, { once: false });
  document.getElementById('upload-sheet')?.classList.add('open');
  document.getElementById('upload-bd')?.classList.add('open');
}

export function closeUploadSheet() {
  document.getElementById('upload-sheet')?.classList.remove('open');
  document.getElementById('upload-bd')?.classList.remove('open');
}

function _onUploadFileChange() {
  const input = document.getElementById('upload-file-input');
  const label = document.getElementById('upload-file-label');
  if (!input || !label) return;
  const files = input.files;
  if (!files || !files.length) { label.textContent = ''; return; }
  label.textContent = files.length === 1
    ? `已選：${files[0].name}`
    : `已選 ${files.length} 個檔案`;
}

export async function submitUpload() {
  const input = document.getElementById('upload-file-input');
  const files = input?.files;
  if (!files || !files.length) { _setUploadStatus('請先選擇檔案', true); return; }
  const nameVal = document.getElementById('upload-name')?.value?.trim() || '';
  const btn = document.getElementById('upload-btn');
  if (btn) btn.disabled = true;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    _setUploadStatus(`上傳中 ${i + 1}/${files.length}：${file.name}…`);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('lib',  state.activeLib);
    // 單檔時才帶自訂名稱
    if (nameVal && files.length === 1) fd.append('name', nameVal);
    try {
      const res = await fetch('/api/import/upload', { method: 'POST', body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
      if (!d.ok)  throw new Error(d.error || 'upload failed');
    } catch (e) {
      _setUploadStatus(`上傳失敗：${e.message}`, true);
      if (btn) btn.disabled = false;
      return;
    }
  }
  _setUploadStatus(`✓ 已上傳 ${files.length} 個檔案`);
  if (btn) btn.disabled = false;
  setTimeout(() => closeUploadSheet(), 1500);
}

function _setUploadStatus(msg, isErr = false) {
  const el = document.getElementById('upload-status');
  if (el) { el.textContent = msg; el.style.color = isErr ? 'var(--accent-r)' : 'var(--text2)'; }
}

// ── URL Import Sheet (wf-008) ─────────────────────────────────────────────
let _urlImportTimer = null;

export function openUrlSheet() {
  closeFabMenu();
  document.getElementById('url-name').value  = '';
  document.getElementById('url-input').value = '';
  _setUrlStatus('');
  _setUrlProgress(0, false);
  document.getElementById('url-import-btn').disabled = false;
  document.getElementById('url-sheet')?.classList.add('open');
  document.getElementById('url-bd')?.classList.add('open');
  setTimeout(() => document.getElementById('url-input')?.focus(), 200);
}

export function closeUrlSheet() {
  if (_urlImportTimer) { clearInterval(_urlImportTimer); _urlImportTimer = null; }
  document.getElementById('url-sheet')?.classList.remove('open');
  document.getElementById('url-bd')?.classList.remove('open');
}

/** 從 URL 推斷一個可讀名稱（hostname + pathname 末段） */
function _guessNameFromUrl(urlStr) {
  try {
    const u    = new URL(urlStr);
    const slug = u.pathname.split('/').filter(Boolean).pop() || '';
    return slug ? decodeURIComponent(slug) : u.hostname;
  } catch { return ''; }
}

export async function submitUrlImport() {
  const urlVal  = document.getElementById('url-input')?.value?.trim();
  if (!urlVal) { _setUrlStatus('請輸入網址', true); return; }
  const nameVal = document.getElementById('url-name')?.value?.trim() || _guessNameFromUrl(urlVal);
  const btn = document.getElementById('url-import-btn');
  if (btn) btn.disabled = true;
  _setUrlStatus('送出中…');
  _setUrlProgress(5, true);

  try {
    const res = await fetch('/api/import/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: urlVal, name: nameVal, lib: state.activeLib }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    if (!d.ok) throw new Error(d.error || 'enqueue failed');
    _pollImportStatus(d.task_id, btn);
  } catch (e) {
    _setUrlStatus(`失敗：${e.message}`, true);
    _setUrlProgress(0, false);
    if (btn) btn.disabled = false;
  }
}

function _pollImportStatus(taskId, btn) {
  let lastProgress = 5;
  _urlImportTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/import/status/${taskId}`);
      if (!res.ok) return;
      const d = await res.json();
      const status = d.status;
      const prog   = d.progress ?? lastProgress;
      lastProgress = prog;
      _setUrlProgress(prog, true);

      if (status === 'running') {
        _setUrlStatus(`下載中… ${prog}%`);
      } else if (status === 'completed') {
        clearInterval(_urlImportTimer); _urlImportTimer = null;
        _setUrlProgress(100, false);
        _setUrlStatus(`✓ 匯入完成：${d.result?.name ?? ''}`);
        if (btn) btn.disabled = false;
        setTimeout(() => closeUrlSheet(), 2000);
      } else if (status === 'failed') {
        clearInterval(_urlImportTimer); _urlImportTimer = null;
        _setUrlProgress(0, false);
        _setUrlStatus(`失敗：${d.error ?? 'unknown error'}`, true);
        if (btn) btn.disabled = false;
      }
    } catch (_) { /* retry on next tick */ }
  }, 2000);
}

function _setUrlStatus(msg, isErr = false) {
  const el = document.getElementById('url-status');
  if (el) { el.textContent = msg; el.style.color = isErr ? 'var(--accent-r)' : 'var(--text2)'; }
}

function _setUrlProgress(pct, visible) {
  const wrap = document.getElementById('url-progress-wrap');
  const bar  = document.getElementById('url-progress-bar');
  if (wrap) wrap.style.display = visible ? 'block' : 'none';
  if (bar)  bar.style.width = `${pct}%`;
}
