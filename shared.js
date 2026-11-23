export const SERVERS = {
  mac1: 'https://mac1.siloms.intraer/siloms_mac/servlet/',
  mac2: 'https://mac2.siloms.intraer/siloms_mac/servlet/'
};

export const STATUS_ORDER = [['A', 'Ativo'], ['B', 'Arquivado'], ['C', 'Cancelado']];

export const DEFAULT_SETTINGS = {
  server: 'mac1',
  unitCode: '694',
  unitSigla: 'BASM',
  auto: { enabled: true, intervalMin: 30, start: '07:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  pauseSec: 2,
  stalledDays: 3,
  theme: 'auto',
  quickFilter: '',
  quickFilters: []
};

const clampInt = (v, min, max, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const hhmm = (v, def) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : def);

/* valida e limita todos os valores (também usada ao restaurar backups) */
export function mergeSettings(s) {
  const d = DEFAULT_SETTINGS;
  s = s && typeof s === 'object' ? s : {};
  const a = s.auto && typeof s.auto === 'object' ? s.auto : {};
  const days = Array.isArray(a.days) ? [...new Set(a.days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))] : d.auto.days;
  const qf = Array.isArray(s.quickFilters)
    ? [...new Set(s.quickFilters.filter((x) => typeof x === 'string').map((x) => x.trim().slice(0, 60)).filter(Boolean))].slice(0, 30)
    : [];
  return {
    server: Object.prototype.hasOwnProperty.call(SERVERS, s.server) ? s.server : d.server,
    unitCode: /^\d{1,6}$/.test(String(s.unitCode)) ? String(s.unitCode) : d.unitCode,
    unitSigla: str(s.unitSigla, 20).trim() || d.unitSigla,
    auto: {
      enabled: typeof a.enabled === 'boolean' ? a.enabled : d.auto.enabled,
      intervalMin: clampInt(a.intervalMin, 5, 720, d.auto.intervalMin),
      start: hhmm(a.start, d.auto.start),
      end: hhmm(a.end, d.auto.end),
      days
    },
    pauseSec: clampInt(s.pauseSec, 0, 60, d.pauseSec),
    stalledDays: clampInt(s.stalledDays, 1, 365, d.stalledDays),
    theme: ['auto', 'light', 'dark'].includes(s.theme) ? s.theme : d.theme,
    quickFilter: str(s.quickFilter, 60),
    quickFilters: qf
  };
}

/* valida documentos vindos de backup ou de desfazer: só campos conhecidos, tipos e tamanhos limitados */
export function sanitizeDoc(x) {
  if (!x || typeof x !== 'object' || !validNr(x.nr)) return null;
  const nr = normNr(x.nr);
  const t = (v, n) => str(v, n);
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const doc = {
    nr, addedAt: num(x.addedAt) ?? Date.now(), archived: x.archived === true,
    limit: Number.isFinite(x.limit) && x.limit > 0 && x.limit <= 365 ? Math.round(x.limit) : null,
    nome: t(x.nome, 400), pag: t(x.pag, 60), status: t(x.status, 40), unidadeAtual: t(x.unidadeAtual, 40), unidadeOrigem: t(x.unidadeOrigem, 40),
    perfil: t(x.perfil, 200), fluxo: t(x.fluxo, 400), tipo: t(x.tipo, 80), responsavel: t(x.responsavel, 200), dataAbertura: t(x.dataAbertura, 20),
    despacho: t(x.despacho, 2000), despachante: t(x.despachante, 80), despachanteSetor: t(x.despachanteSetor, 200), despachoData: t(x.despachoData, 30), caixaAtual: t(x.caixaAtual, 200),
    diasUltMov: num(x.diasUltMov), diasUnidade: num(x.diasUnidade), diasTotais: num(x.diasTotais),
    checkedAt: num(x.checkedAt), archivedAt: num(x.archivedAt), detailAt: num(x.detailAt),
    found: typeof x.found === 'boolean' ? x.found : undefined, baseline: x.baseline === true,
    archivedNoticed: x.archivedNoticed === true, stalledNotified: x.stalledNotified === true
  };
  Object.keys(doc).forEach((k) => doc[k] === undefined && delete doc[k]);
  return doc;
}

export function sanitizeDocs(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  let n = 0;
  for (const v of Object.values(obj)) {
    const d = sanitizeDoc(v);
    if (d && !Object.prototype.hasOwnProperty.call(out, d.nr)) { out[d.nr] = d; if (++n >= 5000) break; }
  }
  return out;
}

export async function getAll() {
  const d = await chrome.storage.local.get(['settings', 'docs', 'notices', 'run', 'backup']);
  return {
    settings: mergeSettings(d.settings),
    docs: d.docs || {},
    notices: d.notices || [],
    run: d.run || { running: false },
    backup: d.backup || {}
  };
}

const pad = (n) => String(n).padStart(2, '0');

export function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function validNr(s) {
  return /^\d{1,10}$/.test(String(s));
}

export function normNr(s) {
  return String(parseInt(String(s).trim(), 10));
}

export function effLimit(doc, settings) {
  return Number.isFinite(doc.limit) && doc.limit > 0 ? doc.limit : settings.stalledDays;
}

export function toMin(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

export function plain(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/* --- IndexedDB (guarda o vínculo com o arquivo de backup) --- */
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('tramitar-db', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
export async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const q = db.transaction('kv').objectStore('kv').get(key);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
export async function idbSet(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('kv', 'readwrite');
    t.objectStore('kv').put(val, key);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

export async function buildBackup() {
  const { settings, docs } = await getAll();
  return { app: 'TRAMITAR', version: '1.0', savedAt: Date.now(), settings, docs };
}

export async function writeBackupFile(handle) {
  const data = await buildBackup();
  const w = await handle.createWritable();
  await w.write(JSON.stringify(data, null, 2));
  await w.close();
  const stamp = Date.now();
  const { backup } = await chrome.storage.local.get('backup');
  await chrome.storage.local.set({ backup: { ...(backup || {}), lastSaved: stamp, needsAuth: false, fileName: handle.name } });
  return stamp;
}

export function getQuick(settings) {
  const a = Array.isArray(settings.quickFilters) ? settings.quickFilters.slice() : [];
  const old = (settings.quickFilter || '').trim();
  if (old && !a.includes(old)) a.push(old);
  return a;
}
