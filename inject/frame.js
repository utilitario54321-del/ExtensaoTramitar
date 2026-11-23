(() => {
  if (window.__trmLoaded) return;
  window.__trmLoaded = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const txt = (id) => {
    const e = $(id);
    return e ? (e.textContent || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim() : '';
  };
  const num = (s) => {
    const n = parseInt(String(s || '').replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const fire = (el, type) => el.dispatchEvent(new Event(type, { bubbles: true }));

  const mut = { changed: false, t: 0 };
  let observer = null;
  function armObserver() {
    if (observer) observer.disconnect();
    mut.changed = false;
    mut.t = Date.now();
    observer = new MutationObserver(() => { mut.changed = true; mut.t = Date.now(); });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  function xhrNow() {
    const p = (document.documentElement.dataset.trmX || '0,0,0').split(',').map(Number);
    return { s: p[0] || 0, d: p[1] || 0, l: p[2] || 0 };
  }

  const ROW = [
    ['nr', 'span_CTLID_PAG_VOLUME_'],
    ['nome', 'span_CTLNM_PAG_VOLUME_'],
    ['pag', 'span_CTLNR_PROCESSO_'],
    ['dataAbertura', 'span_CTLDT_ENTRADA_'],
    ['diasTotais', 'span_CTLNR_DIASTOTAIS_', true],
    ['fluxo', 'span_CTLNM_FLUXO_'],
    ['unidadeOrigem', 'span_CTLSG_UG_CRED_'],
    ['unidadeEpag', 'span_CTLSG_UNIDADE_EXEC_'],
    ['unidadeAtual', 'span_CTLSG_UNIDADE_ATUAL_'],
    ['diasUnidade', 'span_CTLNR_DIASUGEXEC_', true],
    ['perfil', 'span_CTLNM_PERFIL_'],
    ['diasUltMov', 'span_CTLNR_DIASULTMOV_', true],
    ['responsavel', 'span_CTLNM_PESSOA_RESPONSAVEL_'],
    ['tipo', 'span_CTLTP_PAG_VOLUME_'],
    ['status', 'span_CTLST_PAG_VOLUME_']
  ];

  const api = {
    formReady() {
      return !!($('vFID_PAG_VOLUME') && $('vFST_PAG_VOLUME') && $('IMAGE1'));
    },

    search(nr, statusCode, sigla) {
      const out = { ok: false };
      const meus = $('vCHECKSOMENTEMEUS');
      if (meus && meus.checked) meus.click();
      out.meusPerfil = meus ? meus.checked : null;

      const fsg = $('vFSG_UNIDADE_ATUAL_PV');
      out.unidade = fsg ? fsg.value : null;
      if (fsg && sigla && fsg.value.trim().toUpperCase() !== String(sigla).toUpperCase()) {
        fsg.value = sigla;
        fire(fsg, 'change');
        out.unidadeAjustada = true;
      }
      const id = $('vFID_PAG_VOLUME');
      id.value = String(nr);
      fire(id, 'change');
      const st = $('vFST_PAG_VOLUME');
      st.value = statusCode;
      fire(st, 'change');

      const b = xhrNow();
      window.__trmBase = { s: b.s, d: b.d };
      window.__trmArmed = true;
      armObserver();
      $('IMAGE1').click();
      out.ok = true;
      return out;
    },

    state() {
      const x = xhrNow();
      const b = window.__trmBase || { s: 0, d: 0 };
      return {
        armed: !!window.__trmArmed,
        began: mut.changed || x.s > b.s,
        pending: (x.s - b.s) - (x.d - b.d),
        quiet: Date.now() - Math.max(mut.t, x.l || 0),
        formReady: api.formReady()
      };
    },

    async searchAndWait(nr, statusCode, sigla) {
      api.search(nr, statusCode, sigla);
      const t0 = Date.now();
      let retried = false;
      while (Date.now() - t0 < 40000) {
        await sleep(400);
        const st = api.state();
        const el = Date.now() - t0;
        if (st.began && st.pending <= 0 && st.quiet > 700) break;
        if (!st.began && el > 4500 && !retried) { retried = true; $('IMAGE1').click(); }
        if (!st.began && el > 14000) throw new Error('Sem resposta do SILOMS');
      }
      return api.readRows();
    },

    readRows() {
      const rows = [];
      document.querySelectorAll('[id^="Grid1ContainerRow_"]').forEach((tr) => {
        const idx = tr.id.replace('Grid1ContainerRow_', '');
        const r = { idx };
        ROW.forEach(([key, prefix, isNum]) => {
          const t = txt(prefix + idx);
          r[key] = isNum ? num(t) : t;
        });
        r.nr = String(num(r.nr) === null ? '' : num(r.nr));
        rows.push(r);
      });
      return rows;
    },

    openRow(idx) {
      const btn = $('vIMGSHOW_' + idx);
      if (!btn) return false;
      window.__trmArmed = false;
      setTimeout(() => btn.click(), 50);
      return true;
    },

    subReady() {
      return !!($('span_vID_PAG_VOLUME') && txt('span_vID_PAG_VOLUME'));
    },

    readSubprocess() {
      const out = {
        nr: String(num(txt('span_vID_PAG_VOLUME')) ?? ''),
        pag: txt('span_vNR_PROCESSO'),
        nome: txt('span_vNM_PAG_VOLUME'),
        status: txt('span_vST_PAG_VOLUME'),
        tipo: txt('span_vTP_PAG_VOLUME'),
        unidadeOrigem: txt('span_vUNIDADE_ORIGEM'),
        unidadeAtual: txt('span_vUNIDADE_ATUAL'),
        despacho: '',
        fluxo: []
      };
      const d = $('vMENSAGEMRETORNOACOMP');
      if (d) out.despacho = (d.value || d.textContent || '').trim();
      document.querySelectorAll('[id^="Grid1ContainerRow_"]').forEach((tr) => {
        const i = tr.id.replace('Grid1ContainerRow_', '');
        out.fluxo.push({
          perfil: txt('span_vNM_PERFIL_FLUXO_' + i),
          data: txt('span_vCDT_MOVIMENTACAO_' + i),
          usuario: txt('span_vNM_LOGIN_FLUXO_' + i),
          mensagem: txt('span_TX_MENSAGEM_FVPP_' + i),
          atual: txt('span_IN_ESTAGIO_ATUAL_FVPP_' + i).toUpperCase() === 'S'
        });
      });
      return out;
    }
  };
  window.__trm = api;

  /* ---- ponte: iframe da página invisível da extensão e abas de trabalho ---- */
  const EXT = 'chrome-extension://' + chrome.runtime.id;
  const parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  const insideExtension = parentOrigin === EXT;
  const isTop = window.top === window;

  async function dispatch(fn, args) {
    if (typeof api[fn] !== 'function') throw new Error('função desconhecida: ' + fn);
    return await api[fn](...(args || []));
  }

  if (insideExtension) {
    window.addEventListener('message', async (e) => {
      if (e.origin !== EXT || !e.data || !e.data.__trmReq) return;
      const { id, fn, args } = e.data.__trmReq;
      try {
        const result = await dispatch(fn, args);
        e.source.postMessage({ __trmRes: { id, ok: true, result } }, e.origin);
      } catch (err) {
        e.source.postMessage({ __trmRes: { id, ok: false, error: String((err && err.message) || err) } }, e.origin);
      }
    });
  }

  if (isTop) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || !msg.__trmReq || sender.id !== chrome.runtime.id) return;
      dispatch(msg.__trmReq.fn, msg.__trmReq.args).then(
        (r) => sendResponse({ ok: true, result: r }),
        (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true;
    });
  }

  /* ---- "Abrir no SILOMS": #tramitar=NUMERO abre o documento nesta aba ---- */
  function banner(text, bad) {
    let b = document.getElementById('tramitar-banner');
    if (!b) {
      b = document.createElement('div');
      b.id = 'tramitar-banner';
      b.style.cssText = 'position:fixed;top:8px;left:8px;z-index:2147483647;padding:6px 12px;font:600 12px Arial,sans-serif;color:#fff;border-radius:6px;box-shadow:0 1px 4px rgba(0,0,0,.35)';
      document.body.appendChild(b);
    }
    b.style.background = bad ? '#A32D2D' : '#185FA5';
    b.textContent = text;
    return b;
  }

  const AUTO_KEY = 'tramitar_auto';
  const getAuto = () => { try { return JSON.parse(sessionStorage.getItem(AUTO_KEY) || 'null'); } catch (e) { return null; } };
  const setAuto = (v) => { try { sessionStorage.setItem(AUTO_KEY, JSON.stringify(v)); } catch (e) {} };
  const CODES = ['A', 'B', 'C'];

  async function autoStep() {
    let st = getAuto();
    if (!st || st.done) return;
    let sigla = 'BASM';
    try {
      const d = await chrome.storage.local.get('settings');
      if (d.settings && d.settings.unitSigla) sigla = d.settings.unitSigla;
    } catch (e) {}
    banner('TRAMITAR: abrindo o documento ' + st.nr + '…');
    for (let i = 0; i < 40 && !api.formReady(); i++) await sleep(500);
    if (!api.formReady()) { banner('TRAMITAR: faça login no SILOMS e use “Abrir no SILOMS” de novo.', true); return; }
    const key = String(parseInt(st.nr, 10));

    if (st.pending) {
      st.pending = false;
      const hit = api.readRows().find((r) => r.nr === key);
      if (hit) { st.done = true; setAuto(st); api.openRow(hit.idx); return; }
      st.i++;
      setAuto(st);
    }
    for (; st.i < CODES.length; st.i++) {
      st.pending = true;
      setAuto(st);
      let rows;
      try { rows = await api.searchAndWait(st.nr, CODES[st.i], sigla); } catch (e) { banner('TRAMITAR: o SILOMS não respondeu.', true); return; }
      st.pending = false;
      setAuto(st);
      const hit = rows.find((r) => r.nr === key);
      if (hit) { st.done = true; setAuto(st); api.openRow(hit.idx); return; }
    }
    st.done = true;
    setAuto(st);
    banner('TRAMITAR: documento ' + st.nr + ' não encontrado na ' + sigla + '.', true);
  }

  if (isTop && /aqs01104w/i.test(location.pathname)) {
    const m = /[#&]tramitar=(\d{1,10})/.exec(location.hash || '');
    const cur = getAuto();
    if (m && (!cur || cur.nr !== m[1] || cur.done)) {
      if (!cur || cur.nr !== m[1]) setAuto({ nr: m[1], i: 0, pending: false, done: false });
    }
    autoStep();
  }
})();
