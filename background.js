import {
  SERVERS, STATUS_ORDER, getAll, mergeSettings, sanitizeDoc, sanitizeDocs, normNr, validNr, effLimit, toMin,
  idbGet, writeBackupFile
} from './shared.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- armazenamento (escritor único) ---------------- */
let dbq = Promise.resolve();
function mutate(fn) {
  const p = dbq.then(async () => {
    const d = await chrome.storage.local.get(['docs', 'notices', 'settings']);
    const state = { docs: d.docs || {}, notices: d.notices || [], settings: mergeSettings(d.settings) };
    const out = await fn(state);
    await chrome.storage.local.set({ docs: state.docs, notices: state.notices });
    updateBadge(state.notices);
    return out;
  });
  dbq = p.catch(() => {});
  return p;
}

function updateBadge(notices) {
  const n = (notices || []).length;
  chrome.action.setBadgeText({ text: n ? String(n) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#A32D2D' });
}

let runq = Promise.resolve();
function setRun(patch) {
  const p = runq.then(async () => {
    const { run } = await chrome.storage.local.get('run');
    await chrome.storage.local.set({ run: { ...(run || {}), ...patch, hb: Date.now() } });
  });
  runq = p.catch(() => {});
  return p;
}

/* ---------------- fila: uma operação no SILOMS por vez ---------------- */
let queue = Promise.resolve();
function enqueue(fn) {
  const p = queue.then(() => fn());
  queue = p.catch(() => {});
  return p;
}

/* ---------------- drivers: página invisível (offscreen) ou janela minimizada ---------------- */
const NAV_ERR = /navigated|closed|port closed|Receiving end|noresp|Extension context|No tab|Cannot access/i;

async function hasOffscreen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctx.length > 0;
  } catch (e) { return false; }
}

async function sendOff(msg) {
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', ...msg });
  if (!r) throw new Error('noresp');
  if (!r.ok) throw new Error(r.error || 'erro');
  return r.result;
}

async function makeOff(url) {
  if (!(await hasOffscreen())) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['IFRAME_SCRIPTING'],
      justification: 'Consultar o SILOMS em segundo plano, sem abrir abas.'
    });
  }
  await sendOff({ cmd: 'open', url });
  return {
    kind: 'off',
    call: (fn, args = [], timeout = 50000) => sendOff({ cmd: 'call', fn, args, timeout }),
    navigate: (u) => sendOff({ cmd: 'open', url: u }),
    close: async () => { try { await chrome.offscreen.closeDocument(); } catch (e) {} }
  };
}

async function makeWin(url) {
  let windowId = null;
  let tabId;
  try {
    const win = await chrome.windows.create({ url, type: 'popup', width: 520, height: 380, focused: false });
    windowId = win.id;
    tabId = win.tabs[0].id;
    try { await chrome.windows.update(win.id, { state: 'minimized' }); } catch (e) {}
  } catch (e) {
    const tab = await chrome.tabs.create({ url, active: false });
    tabId = tab.id;
  }
  return {
    kind: 'win',
    call: async (fn, args = []) => {
      const r = await chrome.tabs.sendMessage(tabId, { __trmReq: { fn, args } }, { frameId: 0 });
      if (!r) throw new Error('noresp');
      if (!r.ok) throw new Error(r.error || 'erro');
      return r.result;
    },
    navigate: (u) => chrome.tabs.update(tabId, { url: u }),
    close: async () => {
      try { if (windowId) await chrome.windows.remove(windowId); else await chrome.tabs.remove(tabId); } catch (e) {}
    }
  };
}

async function waitForm(drv, timeout = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    try { if (await drv.call('formReady', [], 5000)) return true; } catch (e) { /* carregando */ }
    await sleep(700);
  }
  return false;
}

async function openDriver(settings) {
  const url = SERVERS[settings.server] + 'aqs01104w?S';
  const { driverMode } = await chrome.storage.local.get('driverMode');
  const preferWin = driverMode && driverMode.mode === 'window' && Date.now() - driverMode.ts < 12 * 3600 * 1000;
  const order = preferWin ? ['win', 'off'] : ['off', 'win'];
  for (const kind of order) {
    let d = null;
    try {
      d = kind === 'off' ? await makeOff(url) : await makeWin(url);
      if (await waitForm(d, kind === 'off' ? 20000 : 25000)) {
        if (kind === 'win' && !preferWin) await chrome.storage.local.set({ driverMode: { mode: 'window', ts: Date.now() } });
        if (kind === 'off' && driverMode) await chrome.storage.local.remove('driverMode');
        return d;
      }
    } catch (e) { /* tenta o próximo */ }
    if (d) await d.close();
  }
  return null;
}

/* ---------------- uma pesquisa (um status) ---------------- */
async function searchRows(drv, nr, code, sigla) {
  try {
    return await drv.call('searchAndWait', [nr, code, sigla], 55000);
  } catch (e) {
    if (NAV_ERR.test(String(e.message))) {
      if (await waitForm(drv, 25000)) { await sleep(500); return await drv.call('readRows'); }
      const x = new Error('Formulário ausente'); x.code = 'NOFORM'; throw x;
    }
    throw e;
  }
}

async function queryDoc(drv, nr, settings, hint) {
  const key = normNr(nr);
  const hintCode = (STATUS_ORDER.find(([, name]) => hint && new RegExp(name.slice(0, 5), 'i').test(hint)) || [])[0];
  const order = hintCode ? [...STATUS_ORDER].sort((a, b) => (b[0] === hintCode) - (a[0] === hintCode)) : STATUS_ORDER;
  for (const [code] of order) {
    let ready = false;
    try { ready = await drv.call('formReady'); } catch (e) {}
    if (!ready && !(await waitForm(drv, 15000))) { const e = new Error('Formulário ausente'); e.code = 'NOFORM'; throw e; }
    const rows = await searchRows(drv, nr, code, settings.unitSigla);
    const hit = rows.find((r) => r.nr === key);
    if (hit) return { found: true, row: hit };
  }
  return { found: false };
}

/* ---------------- aplicar resultado, detectar mudanças ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

function pushNotice(state, nr, type, text, extra = {}) {
  state.notices = state.notices.filter((n) => !(n.nr === nr && n.type === type));
  const n = { id: uid(), nr, type, text, ts: Date.now(), ...extra };
  state.notices.push(n);
  return n;
}

function applyResult(state, nr, res, fresh) {
  const d = state.docs[nr];
  if (!d) return;
  const now = Date.now();
  const prev = { ...d };
  const out = [];
  const label = `Doc ${nr}`;

  if (res.found) {
    const r = res.row;
    Object.assign(d, {
      nome: r.nome, pag: r.pag, status: r.status, unidadeAtual: r.unidadeAtual, unidadeOrigem: r.unidadeOrigem,
      perfil: r.perfil, diasUltMov: r.diasUltMov, diasUnidade: r.diasUnidade, diasTotais: r.diasTotais,
      fluxo: r.fluxo, tipo: r.tipo, responsavel: r.responsavel, dataAbertura: r.dataAbertura,
      found: true, checkedAt: now, lastError: null
    });
    const isClosed = /arquiv|cancel/i.test(r.status);

    if (prev.baseline) {
      const parts = [];
      if (prev.found === false) parts.push('voltou a ser encontrado');
      if (prev.status && prev.status !== r.status) parts.push(`status ${prev.status} → ${r.status}`);
      if (prev.perfil !== undefined && prev.perfil !== r.perfil) parts.push(`${prev.perfil || '—'} → ${r.perfil || '—'}`);
      if (prev.unidadeAtual !== undefined && prev.unidadeAtual !== r.unidadeAtual) parts.push(`unidade ${prev.unidadeAtual} → ${r.unidadeAtual}`);
      if (prev.fluxo !== undefined && prev.fluxo !== r.fluxo) parts.push(`fluxo: ${r.fluxo}`);
      if (parts.length && !(isClosed && prev.status !== r.status && !d.archived)) {
        out.push(pushNotice(state, nr, 'mudou', `${label}: ${parts.join('; ')}`));
      }
    }
    d.baseline = true;

    if (isClosed && !d.archived && !d.archivedNoticed) {
      d.archivedNoticed = true;
      out.push(pushNotice(state, nr, 'arquivado', `${label} ficou ${r.status} no SILOMS`, { action: 'archive' }));
    }
    if (!isClosed) d.archivedNoticed = false;

    const lim = effLimit(d, state.settings);
    if (!isClosed && Number.isFinite(r.diasUltMov) && r.diasUltMov >= lim) {
      if (!d.stalledNotified) {
        d.stalledNotified = true;
        out.push(pushNotice(state, nr, 'parado', `${label}: parado há ${r.diasUltMov} dias (limite ${lim})`));
      } else {
        const n = state.notices.find((x) => x.nr === nr && x.type === 'parado');
        if (n) n.text = `${label}: parado há ${r.diasUltMov} dias (limite ${lim})`;
      }
    } else {
      d.stalledNotified = false;
      state.notices = state.notices.filter((n) => !(n.nr === nr && n.type === 'parado'));
    }
    state.notices = state.notices.filter((n) => !(n.nr === nr && n.type === 'naoachado'));
  } else {
    d.found = false;
    d.checkedAt = now;
    d.lastError = null;
    if (prev.found !== false) {
      out.push(pushNotice(state, nr, 'naoachado', `${label}: não encontrado na ${state.settings.unitSigla}`));
    }
  }
  return out;
}

/* ---------------- notificação única ---------------- */
function notify(id, title, message) {
  try {
    chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 1 });
  } catch (e) {}
}

function notifyBatch(list) {
  if (!list.length) return;
  if (list.length === 1) { notify('tramitar-' + Date.now(), 'TRAMITAR', list[0].text); return; }
  const lines = list.slice(0, 4).map((n) => n.text).join('\n');
  const more = list.length > 4 ? `\n… e mais ${list.length - 4}` : '';
  notify('tramitar-' + Date.now(), `TRAMITAR: ${list.length} novidades`, lines + more);
}

/* ---------------- conferência ---------------- */
async function checkDocs(nrs, trigger) {
  return enqueue(async () => {
    const all = await getAll();
    const { settings } = all;
    const full = !nrs;
    const list = (nrs || Object.values(all.docs).filter((d) => !d.archived).map((d) => d.nr))
      .filter((n) => all.docs[n]);
    if (!list.length) return { checked: 0 };

    await setRun({ running: true, total: list.length, done: 0, current: null, msg: 'Conferindo…', trigger });
    let drv = null;
    let expired = false;
    const news = [];
    let done = 0;

    try {
      drv = await openDriver(settings);
      if (!drv) {
        expired = true;
      } else {
        for (const nr of list) {
          let res = null;
          let err = null;
          for (let attempt = 0; attempt < 2 && !res; attempt++) {
            try {
              res = await queryDoc(drv, nr, settings, all.docs[nr] && all.docs[nr].status);
            } catch (e) {
              err = e;
              if (e.code === 'NOFORM') {
                try { await drv.navigate(SERVERS[settings.server] + 'aqs01104w?S'); } catch (x) {}
                if (!(await waitForm(drv, 20000))) { expired = true; break; }
              }
            }
          }
          if (expired) break;
          if (res) {
            const cur = (await chrome.storage.local.get('docs')).docs[nr] || {};
            const needDetail = res.found && (cur.detailAt == null || (trigger === 'manual' && !full) ||
              cur.perfil !== res.row.perfil || cur.fluxo !== res.row.fluxo || cur.diasUltMov !== res.row.diasUltMov);
            const out = await mutate((s) => applyResult(s, nr, res));
            news.push(...out);
            if (needDetail) {
              try {
                const h = await readDetail(drv, res.row.idx);
                if (h) await mutate((s) => { if (s.docs[nr]) applyDetail(s.docs[nr], h); });
              } catch (e) { /* detalhe é opcional */ }
              try { await drv.navigate(SERVERS[settings.server] + 'aqs01104w?S'); } catch (x) {}
              await waitForm(drv, 20000);
            }
          } else {
            await mutate((s) => { if (s.docs[nr]) s.docs[nr].lastError = (err && err.message) || 'Erro'; });
          }
          done++;
          await setRun({ done, current: nr });
          await sleep(Math.max(0, settings.pauseSec) * 1000);
        }
      }
    } catch (e) {
      await setRun({ msg: 'Erro: ' + e.message });
    } finally {
      if (drv) await drv.close();
    }

    const { run } = await chrome.storage.local.get('run');
    if (expired) {
      const wasExpired = run && run.sessionExpired;
      await setRun({ running: false, sessionExpired: true, msg: 'Sessão do SILOMS expirada', finishedAt: Date.now() });
      if (!wasExpired) notify('tramitar-sessao', 'TRAMITAR: conferência pausada', `A sessão do SILOMS (${settings.server}) expirou. Faça login para retomar.`);
    } else {
      const patch = { running: false, sessionExpired: false, msg: '', finishedAt: Date.now(), done };
      if (full) patch.lastFull = Date.now();
      await setRun(patch);
      notifyBatch(news);
      await autoBackup();
    }
    return { checked: done };
  });
}

/* ---------------- detalhe: último despacho e quem despachou ---------------- */
async function readDetail(drv, idx) {
  await drv.call('openRow', [idx]);
  const t0 = Date.now();
  await sleep(1200);
  while (Date.now() - t0 < 30000) {
    try {
      if (await drv.call('subReady', [], 5000)) {
        await sleep(400);
        return await drv.call('readSubprocess');
      }
    } catch (e) { /* navegando */ }
    await sleep(600);
  }
  return null;
}

function applyDetail(d, h) {
  const f = h.fluxo || [];
  const i = f.findIndex((x) => x.atual);
  let prev = null;
  if (i > 0) prev = f[i - 1];
  else if (i < 0) prev = [...f].reverse().find((x) => x.usuario || x.data) || null;
  d.despacho = String(h.despacho || '').slice(0, 2000);
  d.despachante = prev ? String(prev.usuario || '').slice(0, 80) : '';
  d.despachanteSetor = prev ? prev.perfil || '' : '';
  d.despachoData = prev ? prev.data || '' : '';
  d.caixaAtual = i >= 0 ? f[i].perfil || '' : '';
  d.detailAt = Date.now();
}

/* ---------------- "Ver mais" (fluxo e despacho) ---------------- */
async function fetchHistory(nr) {
  return enqueue(async () => {
    const { settings } = await getAll();
    let drv = null;
    try {
      drv = await openDriver(settings);
      if (!drv) return { error: 'Sessão do SILOMS expirada. Faça login e tente de novo.' };
      let hit = null;
      const key = normNr(nr);
      for (const [code] of STATUS_ORDER) {
        const rows = await searchRows(drv, nr, code, settings.unitSigla);
        hit = rows.find((r) => r.nr === key);
        if (hit) break;
      }
      if (!hit) return { error: `Documento ${nr} não encontrado na ${settings.unitSigla}.` };
      await drv.call('openRow', [hit.idx]);
      const t0 = Date.now();
      await sleep(1200);
      while (Date.now() - t0 < 35000) {
        try {
          if (await drv.call('subReady', [], 5000)) {
            await sleep(400);
            const data = await drv.call('readSubprocess');
            return { data };
          }
        } catch (e) { /* navegando */ }
        await sleep(600);
      }
      return { error: 'A tela do documento não abriu a tempo.' };
    } catch (e) {
      return { error: e.message || 'Erro ao consultar o documento.' };
    } finally {
      if (drv) await drv.close();
    }
  });
}

/* ---------------- backup automático ---------------- */
async function autoBackup() {
  try {
    const handle = await idbGet('backupHandle');
    if (!handle) return;
    let perm = 'prompt';
    try { perm = await handle.queryPermission({ mode: 'readwrite' }); } catch (e) {}
    if (perm !== 'granted') {
      const { backup } = await chrome.storage.local.get('backup');
      await chrome.storage.local.set({ backup: { ...(backup || {}), needsAuth: true } });
      return;
    }
    await writeBackupFile(handle);
  } catch (e) {
    const { backup } = await chrome.storage.local.get('backup');
    await chrome.storage.local.set({ backup: { ...(backup || {}), needsAuth: true } });
  }
}

/* ---------------- alarme periódico ---------------- */
async function tick() {
  const { settings, run } = await getAll();
  if (run.running && Date.now() - (run.hb || 0) > 4 * 60000) await setRun({ running: false, msg: '' });
  else if (run.running) return;
  const au = settings.auto;
  if (!au.enabled) return;
  const now = new Date();
  if (!au.days.includes(now.getDay())) return;
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < toMin(au.start) || mins > toMin(au.end)) return;
  const { lastAuto } = await chrome.storage.local.get('lastAuto');
  if (lastAuto && Date.now() - lastAuto < au.intervalMin * 60000 - 30000) return;
  await chrome.storage.local.set({ lastAuto: Date.now() });
  checkDocs(null, 'auto');
}

function ensureAlarm() {
  chrome.alarms.get('tick', (a) => { if (!a) chrome.alarms.create('tick', { periodInMinutes: 1 }); });
}
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tick') tick(); });

/* ---------------- painel lateral ---------------- */
const HAS_PANEL = !!(chrome.sidePanel && chrome.sidePanel.setPanelBehavior);

function setupPanel() {
  if (HAS_PANEL) chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}

chrome.action.onClicked.addListener(async () => {
  if (HAS_PANEL) return;
  const url = chrome.runtime.getURL('sidepanel.html');
  const wins = await chrome.windows.getAll({ populate: true, windowTypes: ['popup'] });
  const ex = wins.find((w) => w.tabs && w.tabs.some((t) => t.url === url));
  if (ex) { chrome.windows.update(ex.id, { focused: true }); return; }
  const opts = { url, type: 'popup', width: 400, height: 760 };
  try {
    const cur = await chrome.windows.getLastFocused();
    if (cur && cur.width) { opts.left = Math.max(0, cur.left + cur.width - 400); opts.top = cur.top; opts.height = Math.max(500, cur.height); }
  } catch (e) {}
  chrome.windows.create(opts);
});

chrome.notifications.onClicked.addListener(async () => {
  try {
    if (HAS_PANEL) {
      const w = await chrome.windows.getLastFocused();
      await chrome.sidePanel.open({ windowId: w.id });
    }
  } catch (e) {}
});

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); setupPanel(); chrome.storage.local.get('settings').then((d) => { if (!d.settings) chrome.storage.local.set({ settings: mergeSettings() }); }); });
chrome.runtime.onStartup.addListener(async () => {
  ensureAlarm(); setupPanel();
  await setRun({ running: false });
  const { notices } = await getAll();
  updateBadge(notices);
});
ensureAlarm();
setupPanel();

/* permite carregar o SILOMS dentro da página invisível da extensão (somente nela) */
async function setupFrameRule() {
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1],
      addRules: [{
        id: 1,
        priority: 1,
        action: { type: 'modifyHeaders', responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' }
        ] },
        condition: {
          requestDomains: ['mac1.siloms.intraer', 'mac2.siloms.intraer'],
          resourceTypes: ['sub_frame'],
          initiatorDomains: [chrome.runtime.id, 'mac1.siloms.intraer', 'mac2.siloms.intraer']
        }
      }]
    });
  } catch (e) {}
}
setupFrameRule();
chrome.runtime.onInstalled.addListener(setupFrameRule);

/* ---------------- mensagens da interface ---------------- */
const FROM_PAGE_OK = new Set(['addDocs']);
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.target === 'offscreen') return;
  if (sender.id !== chrome.runtime.id) return;
  const fromContentScript = !!(sender.tab && sender.url && !sender.url.startsWith('chrome-extension://'));
  if (fromContentScript && !FROM_PAGE_OK.has(msg.type)) { sendResponse({ error: 'não permitido' }); return; }
  const nrOk = (v) => validNr(v);
  (async () => {
    switch (msg.type) {
      case 'addDocs': {
        const added = [];
        const existing = [];
        if (!Array.isArray(msg.nrs) || msg.nrs.length > 500) return { error: 'lista inválida' };
        await mutate((s) => {
          for (const raw of msg.nrs) {
            if (!validNr(raw)) continue;
            const nr = normNr(raw);
            if (s.docs[nr]) { existing.push(nr); continue; }
            s.docs[nr] = { nr, addedAt: Date.now(), limit: null, archived: false };
            added.push(nr);
          }
        });
        if (added.length) checkDocs(added, 'add');
        return { added, existing };
      }
      case 'checkAll': checkDocs(null, 'manual'); return { ok: true };
      case 'checkOne': if (!nrOk(msg.nr)) return { error: 'número inválido' }; checkDocs([normNr(msg.nr)], 'manual'); return { ok: true };
      case 'history': if (!nrOk(msg.nr)) return { error: 'número inválido' }; return await fetchHistory(msg.nr);
      case 'openInSiloms': {
        if (!nrOk(msg.nr)) return { error: 'número inválido' };
        const { settings } = await getAll();
        await chrome.tabs.create({ url: SERVERS[settings.server] + 'aqs01104w?S#tramitar=' + normNr(msg.nr) });
        return { ok: true };
      }
      case 'archive':
        await mutate((s) => { const d = s.docs[msg.nr]; if (d) { d.archived = true; d.archivedAt = Date.now(); } s.notices = s.notices.filter((n) => n.nr !== msg.nr); });
        return { ok: true };
      case 'restore':
        await mutate((s) => { const d = s.docs[msg.nr]; if (d) { d.archived = false; d.archivedNoticed = true; } });
        return { ok: true };
      case 'putDoc':
        await mutate((s) => { const dd = sanitizeDoc(msg.doc); if (dd && !s.docs[dd.nr]) s.docs[dd.nr] = dd; });
        return { ok: true };
      case 'remove':
        await mutate((s) => { delete s.docs[msg.nr]; s.notices = s.notices.filter((n) => n.nr !== msg.nr); });
        return { ok: true };
      case 'removeMany':
        await mutate((s) => { const set = new Set(msg.nrs || []); set.forEach((n) => delete s.docs[n]); s.notices = s.notices.filter((n) => !set.has(n.nr)); });
        return { ok: true };
      case 'setLimit':
        await mutate((s) => { const d = s.docs[msg.nr]; const L = Math.round(Number(msg.limit)); if (d) d.limit = L > 0 && L <= 365 ? L : null; });
        return { ok: true };
      case 'dismissNotice':
        await mutate((s) => { s.notices = s.notices.filter((n) => n.id !== msg.id); });
        return { ok: true };
      case 'dismissAll':
        await mutate((s) => { s.notices = []; });
        return { ok: true };
      case 'restoreBackup':
        await mutate((s) => { s.docs = sanitizeDocs(msg.docs); s.notices = []; });
        return { ok: true };
      case 'backupNow':
        await autoBackup();
        return { ok: true };
      default: return { error: 'tipo desconhecido' };
    }
  })().then(sendResponse, (e) => sendResponse({ error: String(e && e.message || e) }));
  return true;
});
