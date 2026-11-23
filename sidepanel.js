import { SERVERS, getAll, fmtDateTime, validNr, effLimit, plain, getQuick } from './shared.js';

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
let aggOpen = false;
let prefs = { hideClosed: false, quickOn: [], collapsed: [], cardsClosed: [], sort: { key: 'recent', dir: 'desc' } };
let confirmNr = null;

async function loadPrefs() {
  const d = await chrome.storage.local.get('panelPrefs');
  prefs = { hideClosed: false, quickOn: [], collapsed: [], cardsClosed: [], sort: { key: 'recent', dir: 'desc' }, ...(d.panelPrefs || {}) };
  if (!Array.isArray(prefs.collapsed)) prefs.collapsed = [];
  if (!Array.isArray(prefs.cardsClosed)) prefs.cardsClosed = [];
  if (!Array.isArray(prefs.quickOn)) prefs.quickOn = [];
}
function savePrefs() { chrome.storage.local.set({ panelPrefs: prefs }); }

function reloadIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  ['M21 12a9 9 0 1 1-3-6.7', 'M21 4v5h-5'].forEach((d) => {
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p);
  });
  return svg;
}

function archiveIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  ['M3 4h18v4H3z', 'M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8', 'M10 12h4'].forEach((d) => {
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p);
  });
  return svg;
}

function trashIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '16'); svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
  ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'].forEach((d) => {
    const p = document.createElementNS(ns, 'path'); p.setAttribute('d', d); svg.append(p);
  });
  return svg;
}

async function load() {
  state = await getAll();
  await loadPrefs();
  render();
}

function statusBadge(d) {
  if (d.found === false) return el('span', { class: 'badge wn' }, 'Não encontrado');
  if (!d.status) return el('span', { class: 'badge gr' }, 'Conferindo…');
  const cls = /arquiv/i.test(d.status) ? 'gr' : /cancel/i.test(d.status) ? 'dg' : 'ok';
  return el('span', { class: 'badge ' + cls }, d.status);
}

function noticeClass(t) {
  return t === 'mudou' ? 'ac' : t === 'arquivado' ? 'dg' : 'wn';
}

function noticeBox(n, inner) {
  return el('div', { class: 'aviso ' + noticeClass(n.type) },
    el('div', {},
      n.text,
      n.action === 'archive'
        ? el('div', {}, el('button', { class: 'bt', onclick: () => send({ type: 'archive', nr: n.nr }) }, 'Mover para arquivados'))
        : null),
    el('button', { class: 'x', 'aria-label': 'Dispensar', onclick: () => send({ type: 'dismissNotice', id: n.id }) }, '✕'));
}

function renderNotices() {
  const box = $('notices');
  box.replaceChildren();
  const list = [...state.notices].sort((a, b) => b.ts - a.ts);
  if (!list.length) return;
  if (list.length <= 4) { list.forEach((n) => box.append(noticeBox(n))); return; }

  const c = { mudou: 0, arquivado: 0, parado: 0, naoachado: 0 };
  list.forEach((n) => { c[n.type] = (c[n.type] || 0) + 1; });
  const parts = [];
  if (c.mudou) parts.push(`${c.mudou} mudaram`);
  if (c.arquivado) parts.push(`${c.arquivado} arquivados/cancelados`);
  if (c.parado) parts.push(`${c.parado} parados`);
  if (c.naoachado) parts.push(`${c.naoachado} não encontrados`);
  const agg = el('div', { class: 'aviso ac sum' },
    el('div', { class: 'row' }, el('b', {}, `${list.length} novidades`),
      el('button', { class: 'x', 'aria-label': 'Limpar todos', onclick: () => send({ type: 'dismissAll' }) }, '✕')),
    el('div', {}, parts.join(' · ')),
    el('div', {}, el('button', { class: 'bt', onclick: () => { aggOpen = !aggOpen; renderNotices(); } }, aggOpen ? 'Ocultar detalhes ▴' : 'Ver detalhes ▾')));
  if (aggOpen) {
    const det = el('div', { class: 'det' });
    list.forEach((n) => det.append(el('div', { class: 'it' },
      n.text,
      n.action === 'archive' ? el('div', {}, el('button', { class: 'bt', onclick: () => send({ type: 'archive', nr: n.nr }) }, 'Mover para arquivados')) : null,
      el('div', {}, el('button', { class: 'bt', onclick: () => send({ type: 'dismissNotice', id: n.id }) }, 'Dispensar')))));
    agg.append(det);
  }
  box.append(agg);
}

function matches(d, q) {
  if (!q) return true;
  const hay = plain([d.nr, d.nome, d.status, d.perfil, d.caixaAtual, d.despachante, d.unidadeAtual, d.found === false ? 'nao encontrado' : ''].join(' '));
  return q.split(/\s+/).every((t) => hay.includes(t));
}

function renderList() {
  const q = plain($('filter').value.trim());
  const quicks = getQuick(state.settings).filter((t) => prefs.quickOn.includes(t)).map((t) => plain(t));
  const sk = prefs.sort.key === 'stalled' ? (d) => (Number.isFinite(d.diasUltMov) ? d.diasUltMov : -1) : (d) => d.addedAt || 0;
  const dirm = prefs.sort.dir === 'asc' ? 1 : -1;
  const docs = Object.values(state.docs).filter((d) => !d.archived).sort((a, b) => (sk(a) - sk(b)) * dirm || (b.addedAt || 0) - (a.addedAt || 0));
  const shown = docs.filter((d) => matches(d, q) && quicks.every((t) => matches(d, t)) && !(prefs.hideClosed && /arquiv|cancel/i.test(d.status || '')));
  $('empty').hidden = docs.length > 0;
  $('empty').textContent = 'Nenhum documento acompanhado ainda.';
  const box = $('list');
  box.replaceChildren();
  if (docs.length && !shown.length) { $('empty').hidden = false; $('empty').textContent = 'Nada encontrado com esse filtro.'; }

  shown.forEach((d) => {
    const lim = effLimit(d, state.settings);
    const stalled = Number.isFinite(d.diasUltMov) && d.diasUltMov >= lim && !/arquiv|cancel/i.test(d.status || '');
    const sub = d.found === false
      ? `Não encontrado na ${state.settings.unitSigla}`
      : [d.perfil || '—', Number.isFinite(d.diasUltMov) ? `parado ${d.diasUltMov} d` : null].filter(Boolean).join(' · ');
    const actions = confirmNr === d.nr
      ? el('div', { class: 'confirm' },
          el('span', {}, 'Tem certeza que deseja apagar?'),
          el('div', { class: 'row' },
            el('button', { class: 'btn sm dgb', onclick: async () => { confirmNr = null; const snap = JSON.parse(JSON.stringify(d)); await send({ type: 'remove', nr: d.nr }); showUndo('del', d.nr, snap); } }, 'Sim, apagar'),
            el('button', { class: 'btn sm', onclick: () => { confirmNr = null; renderList(); } }, 'Cancelar')))
      : el('div', { class: 'bar' },
          el('div', { class: 'acts' },
            el('button', { class: 'btn sm pri abrir', onclick: () => send({ type: 'openInSiloms', nr: d.nr }) }, 'Abrir no SILOMS')),
          el('div', { class: 'acts' },
          el('button', { class: 'ic2' + (state.run && state.run.running ? ' off' : ''), title: 'Recarregar só este cartão', 'aria-label': 'Recarregar só este cartão', disabled: !!(state.run && state.run.running), onclick: () => send({ type: 'checkOne', nr: d.nr }) }, reloadIcon()),
          el('button', { class: 'ic2 arq', title: 'Arquivar', 'aria-label': 'Arquivar', onclick: async () => { await send({ type: 'archive', nr: d.nr }); showUndo('arq', d.nr, null); } }, archiveIcon()),
          el('button', { class: 'ic2', title: 'Apagar da lista', 'aria-label': 'Apagar da lista', onclick: () => { confirmNr = d.nr; renderList(); } }, trashIcon())));
    const closed = prefs.cardsClosed.includes(d.nr) && confirmNr !== d.nr;
    const MAXC = 38;
    const nome = d.nome || (d.checkedAt ? '' : 'Aguardando a primeira conferência…');
    const short = nome.length > MAXC ? nome.slice(0, MAXC).trimEnd() + '...' : nome;
    const arrow = el('button', { class: 'cchev', type: 'button', title: closed ? 'Abrir cartão' : 'Fechar cartão', 'aria-label': closed ? 'Abrir cartão' : 'Fechar cartão', 'aria-expanded': String(!closed),
      onclick: () => { prefs.cardsClosed = closed ? prefs.cardsClosed.filter((x) => x !== d.nr) : [...prefs.cardsClosed, d.nr]; savePrefs(); renderList(); } }, closed ? '▸' : '▾');
    box.append(el('div', { class: 'card' + (closed ? ' closed' : '') },
      el('div', { class: 'top' }, el('span', { class: 'tl' }, el('span', { class: 'nr' }, d.nr), statusBadge(d)), arrow),
      el('div', { class: 'nm' }, closed ? short : nome),
      closed ? null : (d.found === false ? el('div', { class: 'sub' }, sub) : null),
      closed || d.found === false || !(d.despacho || d.despachante) ? null : el('div', { class: 'fs' },
        el('span', { class: 'lg' }, 'Último despacho'),
        d.despachante || d.despachoData ? el('div', { class: 'fv' },
          d.despachante || '',
          d.despachoData ? el('span', { class: 'fs2' }, ' · ' + d.despachoData) : null) : null,
        d.despacho ? el('div', { class: 'ft', title: d.despacho }, d.despacho) : null),
      closed || d.found === false ? null : el('div', { class: 'fs' + (stalled ? ' wn' : '') },
        el('span', { class: 'lg' }, 'Caixa atual'),
        el('div', { class: 'fline' },
          el('span', { class: 'fv' }, d.caixaAtual || d.perfil || '—'),
          Number.isFinite(d.diasUltMov) ? el('span', { class: 'fd' + (stalled ? ' wn' : '') }, `parado ${d.diasUltMov} ${d.diasUltMov === 1 ? 'dia' : 'dias'}`) : null)),
      closed ? null : (d.lastError ? el('div', { class: 'sub' }, 'Erro na última conferência: ' + d.lastError) : null),
      closed ? null : (d.checkedAt ? el('div', { class: 'conf' }, 'Conferido em ' + fmtDateTime(d.checkedAt)) : null),
      closed ? null : actions));
  });
}

function renderRun() {
  const r = state.run || {};
  $('run').textContent = r.running
    ? `Conferindo… ${r.done || 0}/${r.total || 0}${r.current ? ' (' + r.current + ')' : ''}`
    : 'Última conferência geral em: ' + (r.lastFull ? fmtDateTime(r.lastFull) : '—');
  $('all').disabled = !!r.running;
  const s = $('sess');
  s.hidden = !r.sessionExpired;
  if (r.sessionExpired) {
    s.replaceChildren(el('div', {},
      `A sessão do SILOMS (${state.settings.server}) expirou. A conferência está pausada. Faça login e clique em “atualizar todos agora”.`,
      el('div', {}, el('button', { class: 'bt', onclick: () => chrome.tabs.create({ url: SERVERS[state.settings.server] + 'aqs01001w' }) }, 'Abrir o SILOMS'))));
  }
}

function renderQuick() {
  const list = getQuick(state.settings);
  prefs.quickOn = prefs.quickOn.filter((t) => list.includes(t));
  const box = $('qChips');
  box.replaceChildren();
  list.forEach((t) => {
    box.append(el('div', { class: 'qrow' },
      el('label', { class: 'qchip' },
        el('input', { type: 'checkbox', checked: prefs.quickOn.includes(t) ? 'checked' : null, onchange: (e) => {
          prefs.quickOn = e.target.checked ? [...prefs.quickOn, t] : prefs.quickOn.filter((x) => x !== t);
          savePrefs(); renderList();
        } }), ' ', t),
      el('button', { class: 'ic2', title: 'Apagar atalho rápido', 'aria-label': 'Apagar atalho rápido', onclick: () => removeQuick(t) }, '✕')));
  });
  $('sortRecent').classList.toggle('on', prefs.sort.key === 'recent');
  $('sortStalled').classList.toggle('on', prefs.sort.key === 'stalled');
  $('sortRecent').querySelector('.ar').textContent = prefs.sort.key === 'recent' && prefs.sort.dir === 'asc' ? '↑' : '↓';
  $('sortStalled').querySelector('.ar').textContent = prefs.sort.key === 'stalled' && prefs.sort.dir === 'asc' ? '↑' : '↓';
}

function render() {
  const mac2 = state.settings.server === 'mac2';
  $('srv').checked = mac2;
  $('srvName').textContent = state.settings.server;
  $('hideClosed').checked = !!prefs.hideClosed;
  renderQuick();
  applyCollapsed();
  renderRun();
  renderNotices();
  renderList();
}

/* ---------- eventos ---------- */
$('filter').addEventListener('input', () => renderList());
$('hideClosed').addEventListener('change', (e) => { prefs.hideClosed = e.target.checked; savePrefs(); renderList(); });
$('addMany').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('options.html#varios') }));
$('srvInfoBtn').addEventListener('click', () => {
  const open = $('srvInfo').hidden;
  $('srvInfo').hidden = !open;
  $('srvInfoBtn').setAttribute('aria-expanded', String(open));
});
$('qAdd').addEventListener('click', () => {
  const open = $('qForm').hidden;
  $('qForm').hidden = !open;
  if (open) { $('qInput').value = ''; $('qInput').focus(); }
});
async function addQuick(v) {
  if (!v) { $('qForm').hidden = true; return; }
  const { settings } = await getAll();
  const list = getQuick(settings);
  if (!list.includes(v)) list.push(v);
  await chrome.storage.local.set({ settings: { ...settings, quickFilter: '', quickFilters: list } });
  if (!prefs.quickOn.includes(v)) prefs.quickOn.push(v);
  savePrefs();
  $('qInput').value = '';
  $('qForm').hidden = true;
}
async function removeQuick(t) {
  const { settings } = await getAll();
  const list = getQuick(settings).filter((x) => x !== t);
  await chrome.storage.local.set({ settings: { ...settings, quickFilter: '', quickFilters: list } });
  prefs.quickOn = prefs.quickOn.filter((x) => x !== t);
  savePrefs();
}
$('qSave').addEventListener('click', () => addQuick($('qInput').value.trim()));
$('qInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addQuick($('qInput').value.trim()); });
function pickSort(key) {
  prefs.sort = prefs.sort.key === key ? { key, dir: prefs.sort.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' };
  savePrefs(); renderQuick(); renderList();
}
$('sortRecent').addEventListener('click', () => pickSort('recent'));
$('sortStalled').addEventListener('click', () => pickSort('stalled'));
let undoTimer = null;
function showUndo(kind, nr, snap) {
  const box = $('undo');
  box.className = 'undo ' + (kind === 'del' ? 'dg' : 'wn');
  $('undoTx').textContent = `${nr} ${kind === 'del' ? 'apagado' : 'arquivado'}, `;
  box.hidden = false;
  $('undoBtn').onclick = async () => {
    if (kind === 'del') await send({ type: 'putDoc', doc: snap });
    else await send({ type: 'restore', nr });
    box.hidden = true;
  };
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { box.hidden = true; }, 10000);
}

function applyCollapsed() {
  document.querySelectorAll('h3.sec[data-sec]').forEach((h) => {
    const k = h.dataset.sec;
    const closed = prefs.collapsed.includes(k);
    const body = $('sb-' + k);
    if (body) body.hidden = closed;
    const b = h.querySelector('.chev');
    b.setAttribute('aria-expanded', String(!closed));
    b.querySelector('.ar').textContent = closed ? '▸' : '▾';
  });
}
document.querySelectorAll('h3.sec[data-sec]').forEach((h) => {
  h.querySelector('.chev').addEventListener('click', () => {
    const k = h.dataset.sec;
    prefs.collapsed = prefs.collapsed.includes(k) ? prefs.collapsed.filter((x) => x !== k) : [...prefs.collapsed, k];
    savePrefs(); applyCollapsed();
  });
});
$('gear').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('all').addEventListener('click', () => send({ type: 'checkAll' }));

$('srv').addEventListener('change', async (e) => {
  const server = e.target.checked ? 'mac2' : 'mac1';
  const { settings } = await getAll();
  await chrome.storage.local.set({ settings: { ...settings, server } });
});

async function addOne() {
  const v = $('nr').value.trim();
  const msg = $('addMsg');
  if (!validNr(v)) { msg.textContent = 'Digite só números (até 10 dígitos).'; return; }
  const r = await send({ type: 'addDocs', nrs: [v] });
  if (r.error) { msg.textContent = 'Erro: ' + r.error; return; }
  msg.textContent = r.added && r.added.length ? 'Adicionado. Conferindo…' : 'Esse documento já está na lista.';
  $('nr').value = '';
}
$('add').addEventListener('click', addOne);
$('nr').addEventListener('keydown', (e) => { if (e.key === 'Enter') addOne(); });
$('nr').addEventListener('input', () => { $('addMsg').textContent = ''; });

let loadT = null;
chrome.storage.onChanged.addListener(() => { clearTimeout(loadT); loadT = setTimeout(load, 120); });
load();
