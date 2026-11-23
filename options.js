import {
  getAll, mergeSettings, getQuick, fmtDateTime, validNr, normNr, effLimit, idbGet, idbSet, writeBackupFile
} from './shared.js';

const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r || {})));

function el(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

let state = null;
const selected = new Set();

async function saveSettings(patch) {
  const { settings } = await getAll();
  const next = mergeSettings({ ...settings, ...patch, auto: { ...settings.auto, ...(patch.auto || {}) } });
  await chrome.storage.local.set({ settings: next });
  state.settings = next;
}

/* ---------- navegação ---------- */
function showSection() {
  const id = (location.hash || '#servidor').slice(1);
  const valid = document.getElementById(id) ? id : 'servidor';
  document.querySelectorAll('section.pg').forEach((s) => s.classList.toggle('on', s.id === valid));
  document.querySelectorAll('.menu a').forEach((a) => a.classList.toggle('on', a.dataset.s === valid));
}
window.addEventListener('hashchange', showSection);

/* ---------- controles de configuração ---------- */
const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];

function buildControls() {
  const s = state.settings;
  $('srv').checked = s.server === 'mac2';
  $('unitSigla').value = s.unitSigla;

  $('autoOn').checked = s.auto.enabled;
  $('autoOnTx').textContent = s.auto.enabled ? 'Ligada' : 'Desligada';
  const std = ['15', '30', '45', '60', '90', '120'];
  const iv = String(s.auto.intervalMin);
  $('interval').value = std.includes(iv) ? iv : 'custom';
  $('intervalCustom').hidden = $('interval').value !== 'custom';
  $('intervalCustom').value = std.includes(iv) ? '' : iv;
  $('tStart').value = s.auto.start;
  $('tEnd').value = s.auto.end;
  $('pause').value = s.pauseSec;

  const days = $('days');
  days.replaceChildren();
  [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
    days.append(el('span', {
      class: 'chip' + (s.auto.days.includes(d) ? ' on' : ''),
      onclick: async (e) => {
        const cur = new Set(state.settings.auto.days);
        cur.has(d) ? cur.delete(d) : cur.add(d);
        await saveSettings({ auto: { days: [...cur].sort() } });
        e.currentTarget.classList.toggle('on', cur.has(d));
      }
    }, DAYS[d]));
  });

  const th = $('theme');
  th.replaceChildren();
  [['light', 'Modo claro'], ['dark', 'Modo escuro'], ['auto', 'Automático (sistema)']].forEach(([v, label]) => {
    th.append(el('span', { class: 'chip' + ((s.theme || 'auto') === v ? ' on' : ''), onclick: async () => { await saveSettings({ theme: v }); buildControls(); } }, label));
  });
  const ql = $('quickList');
  ql.replaceChildren();
  getQuick(s).forEach((t) => ql.append(el('div', { class: 'qrow' }, el('span', {}, t),
    el('button', { class: 'ic2', title: 'Apagar atalho rápido', onclick: async () => { await saveSettings({ quickFilter: '', quickFilters: getQuick(state.settings).filter((x) => x !== t) }); buildControls(); } }, '✕'))));

  const stall = $('stall');
  stall.replaceChildren();
  const opts = [3, 5, 7];
  const isCustom = !opts.includes(s.stalledDays);
  const mk = (label, active, fn) => el('span', { class: 'chip' + (active ? ' on' : ''), onclick: fn }, label);
  const redraw = () => buildControls();
  opts.forEach((n) => stall.append(mk(`${n} dias`, s.stalledDays === n, async () => { await saveSettings({ stalledDays: n }); redraw(); })));
  stall.append(mk('Outro', isCustom, () => { $('stallCustom').hidden = false; $('stallCustom').focus(); }));
  $('stallCustom').hidden = !isCustom;
  $('stallCustom').value = isCustom ? s.stalledDays : '';
}

$('srv').addEventListener('change', (e) => saveSettings({ server: e.target.checked ? 'mac2' : 'mac1' }));
$('unitSigla').addEventListener('change', (e) => { const v = e.target.value.trim().toUpperCase(); if (v) saveSettings({ unitSigla: v }); });
$('autoOn').addEventListener('change', (e) => { $('autoOnTx').textContent = e.target.checked ? 'Ligada' : 'Desligada'; saveSettings({ auto: { enabled: e.target.checked } }); });
$('interval').addEventListener('change', (e) => {
  const v = e.target.value;
  $('intervalCustom').hidden = v !== 'custom';
  if (v !== 'custom') saveSettings({ auto: { intervalMin: Number(v) } });
});
$('intervalCustom').addEventListener('change', (e) => {
  const n = Math.max(5, Math.min(720, parseInt(e.target.value, 10) || 30));
  e.target.value = n;
  saveSettings({ auto: { intervalMin: n } });
});
$('tStart').addEventListener('change', (e) => e.target.value && saveSettings({ auto: { start: e.target.value } }));
$('tEnd').addEventListener('change', (e) => e.target.value && saveSettings({ auto: { end: e.target.value } }));
$('pause').addEventListener('change', (e) => {
  const n = Math.max(0, Math.min(60, parseInt(e.target.value, 10) || 0));
  e.target.value = n;
  saveSettings({ pauseSec: n });
});
async function addQuickOpt() {
  const v = $('quickFilter').value.trim();
  if (!v) return;
  const list = getQuick(state.settings);
  if (!list.includes(v)) list.push(v);
  await saveSettings({ quickFilter: '', quickFilters: list });
  $('quickFilter').value = '';
  buildControls();
}
$('quickAddBtn').addEventListener('click', addQuickOpt);
$('quickFilter').addEventListener('keydown', (e) => { if (e.key === 'Enter') addQuickOpt(); });
$('stallCustom').addEventListener('change', async (e) => {
  const n = Math.max(1, Math.min(365, parseInt(e.target.value, 10) || 3));
  e.target.value = n;
  await saveSettings({ stalledDays: n });
  buildControls();
});

/* ---------- adicionar vários ---------- */
function parseBulk() {
  const lines = $('bulk').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const seen = new Set();
  return lines.map((line) => {
    if (!validNr(line)) return { line, kind: 'r', text: `${line} (inválido)` };
    const key = normNr(line);
    if (seen.has(key) || state.docs[key]) return { line, key, kind: 'o', text: `${line} (repetido)` };
    seen.add(key);
    return { line, key, kind: 'g', text: line };
  });
}
function renderPills() {
  const items = parseBulk();
  $('pills').replaceChildren(...items.map((i) => el('span', { class: 'pill ' + i.kind }, i.text)));
  return items;
}
$('bulk').addEventListener('input', () => { $('bulkMsg').textContent = ''; renderPills(); });
$('bulkAdd').addEventListener('click', async () => {
  const items = renderPills();
  const ok = items.filter((i) => i.kind === 'g').map((i) => i.key);
  if (!ok.length) { $('bulkMsg').textContent = 'Nenhum número novo para adicionar.'; return; }
  let added = 0; let err = null;
  for (let i = 0; i < ok.length && !err; i += 500) {
    const r = await send({ type: 'addDocs', nrs: ok.slice(i, i + 500) });
    if (r.error) err = r.error; else added += (r.added || []).length;
  }
  $('bulkMsg').textContent = err ? 'Erro: ' + err : `${added} documento(s) adicionados. Conferindo…`;
  $('bulk').value = '';
  $('pills').replaceChildren();
});

/* ---------- documentos e arquivados ---------- */
function statusBadge(d) {
  if (d.found === false) return el('span', { class: 'badge wn' }, 'Não encontrado');
  if (!d.status) return el('span', { class: 'badge gr' }, '—');
  const cls = /arquiv/i.test(d.status) ? 'gr' : /cancel/i.test(d.status) ? 'dg' : 'ok';
  return el('span', { class: 'badge ' + cls }, d.status);
}

function renderDocs() {
  const all = Object.values(state.docs);
  const act = all.filter((d) => !d.archived).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  const arq = all.filter((d) => d.archived).sort((a, b) => (b.archivedAt || 0) - (a.archivedAt || 0));

  $('docsEmpty').hidden = act.length > 0;
  $('docsBody').replaceChildren(...act.map((d) => {
    const own = Number.isFinite(d.limit) && d.limit > 0;
    return el('tr', {},
      el('td', {}, el('input', { type: 'checkbox', checked: selected.has(d.nr) ? 'checked' : false, 'aria-label': 'Selecionar ' + d.nr, onchange: (e) => { e.target.checked ? selected.add(d.nr) : selected.delete(d.nr); syncBulk(); } })),
      el('td', {}, d.nr),
      el('td', {}, d.nome || '—'),
      el('td', {}, statusBadge(d)),
      el('td', {}, own ? `${d.limit} dias` : `padrão (${state.settings.stalledDays})`),
      el('td', {},
        el('button', { class: 'ic', title: 'Editar limite de dias parado', onclick: async () => {
          const v = prompt(`Limite de dias parado para o documento ${d.nr}.\nDeixe vazio para usar o limite geral (${state.settings.stalledDays}).`, own ? String(d.limit) : '');
          if (v === null) return;
          const n = parseInt(v, 10);
          await send({ type: 'setLimit', nr: d.nr, limit: Number.isFinite(n) && n > 0 ? n : 0 });
        } }, '✎'),
        el('button', { class: 'ic', title: 'Conferir só este', onclick: () => send({ type: 'checkOne', nr: d.nr }) }, '↻'),
        el('button', { class: 'ic', title: 'Mover para arquivados', onclick: () => send({ type: 'archive', nr: d.nr }) }, '▣'),
        el('button', { class: 'ic', title: 'Remover da lista', onclick: async () => {
          if (confirm(`Parar de acompanhar o documento ${d.nr}?`)) await send({ type: 'remove', nr: d.nr });
        } }, '⌫')));
  }));

  for (const n of [...selected]) if (!state.docs[n] || state.docs[n].archived) selected.delete(n);
  syncBulk();

  $('arqEmpty').hidden = arq.length > 0;
  $('arqBody').replaceChildren(...arq.map((d) => el('tr', {},
    el('td', {}, d.nr), el('td', {}, d.nome || '—'), el('td', {}, statusBadge(d)),
    el('td', {},
      el('button', { class: 'ic', onclick: () => send({ type: 'restore', nr: d.nr }) }, 'Restaurar'),
      el('button', { class: 'ic', title: 'Remover de vez', onclick: async () => {
        if (confirm(`Remover o documento ${d.nr} definitivamente da extensão?`)) await send({ type: 'remove', nr: d.nr });
      } }, '⌫')))));
  renderPills();
}

function syncBulk() {
  const act = Object.values(state.docs).filter((d) => !d.archived);
  $('delSel').disabled = selected.size === 0;
  $('delSel').textContent = selected.size ? `Apagar selecionados (${selected.size})` : 'Apagar selecionados';
  $('selAll').checked = act.length > 0 && selected.size === act.length;
  if (!selected.size) $('delConfirm').hidden = true;
}
$('selAll').addEventListener('change', (e) => {
  const act = Object.values(state.docs).filter((d) => !d.archived);
  selected.clear();
  if (e.target.checked) act.forEach((d) => selected.add(d.nr));
  renderDocs();
});
$('delSel').addEventListener('click', () => {
  if (!selected.size) return;
  $('delConfirmTx').textContent = `Tem certeza que deseja apagar ${selected.size === 1 ? 'este documento' : 'estes ' + selected.size + ' documentos'}?`;
  $('delConfirm').hidden = false;
});
$('delNo').addEventListener('click', () => { $('delConfirm').hidden = true; });
$('delYes').addEventListener('click', async () => {
  const nrs = [...selected];
  selected.clear();
  $('delConfirm').hidden = true;
  await send({ type: 'removeMany', nrs });
});

/* ---------- backup ---------- */
const FILE_TYPES = [{ description: 'Backup do TRAMITAR (JSON)', accept: { 'application/json': ['.json'] } }];

async function renderBackup() {
  const { backup } = await getAll();
  const handle = await idbGet('backupHandle').catch(() => null);
  $('bkFile').textContent = handle ? 'Arquivo vinculado: ' + handle.name : 'Nenhum arquivo vinculado.';
  const parts = [];
  if (backup.lastSaved) parts.push('Último salvamento: ' + fmtDateTime(backup.lastSaved));
  if (handle && backup.needsAuth) parts.push('O navegador precisa de autorização para continuar gravando. Clique em “Salvar agora”.');
  $('bkInfo').textContent = parts.join(' · ');
}

$('bkLink').addEventListener('click', async () => {
  try {
    const handle = await showSaveFilePicker({ suggestedName: 'SILOMS ACOMPANHAMENTO EXTENSÃO.json', startIn: 'documents', types: FILE_TYPES });
    await idbSet('backupHandle', handle);
    await writeBackupFile(handle);
    $('bkMsg').textContent = 'Arquivo vinculado e salvo.';
  } catch (e) {
    if (e.name !== 'AbortError') $('bkMsg').textContent = 'Não foi possível vincular: ' + e.message;
  }
  renderBackup();
});

$('bkNow').addEventListener('click', async () => {
  try {
    const handle = await idbGet('backupHandle');
    if (!handle) { $('bkMsg').textContent = 'Vincule um arquivo primeiro.'; return; }
    const perm = await handle.requestPermission({ mode: 'readwrite' });
    if (perm !== 'granted') { $('bkMsg').textContent = 'Permissão negada pelo navegador.'; return; }
    await writeBackupFile(handle);
    $('bkMsg').textContent = 'Backup salvo.';
  } catch (e) { $('bkMsg').textContent = 'Erro ao salvar: ' + e.message; }
  renderBackup();
});

$('bkRestore').addEventListener('click', async () => {
  try {
    const [h] = await showOpenFilePicker({ types: FILE_TYPES, startIn: 'documents' });
    const data = JSON.parse(await (await h.getFile()).text());
    if (data.app !== 'TRAMITAR' || typeof data.docs !== 'object') throw new Error('arquivo não é um backup do TRAMITAR');
    const n = Object.keys(data.docs).length;
    if (!confirm(`Restaurar ${n} documento(s) e as configurações deste backup? A lista atual será substituída.`)) return;
    if (data.settings) await chrome.storage.local.set({ settings: mergeSettings(data.settings) });
    await send({ type: 'restoreBackup', docs: data.docs });
    state = await getAll();
    buildControls();
    $('bkMsg').textContent = 'Backup restaurado.';
  } catch (e) {
    if (e.name !== 'AbortError') $('bkMsg').textContent = 'Não foi possível restaurar: ' + e.message;
  }
});

/* ---------- início ---------- */
async function init() {
  state = await getAll();
  buildControls();
  renderDocs();
  renderBackup();
  showSection();
}
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.settings) {
    const { settings } = await getAll();
    state.settings = settings;
    $('srv').checked = settings.server === 'mac2';
  }
  if (changes.docs || changes.backup || changes.notices) {
    state = await getAll();
    renderDocs();
    renderBackup();
  }
});
init();
