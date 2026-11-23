(() => {
  const read = () => {
    const e = document.getElementById('span_vID_PAG_VOLUME');
    const t = e && (e.textContent || '').replace(/\D/g, '');
    return t || '';
  };

  let tries = 0;
  const timer = setInterval(() => {
    tries++;
    const nr = read();
    if (nr) { clearInterval(timer); mount(nr); }
    else if (tries > 20) clearInterval(timer);
  }, 500);

  function mount(nr) {
    if (document.getElementById('tramitar-btn')) return;
    const b = document.createElement('button');
    b.id = 'tramitar-btn';
    b.type = 'button';
    b.textContent = 'Acompanhar esse subprocesso';
    b.style.cssText = 'position:fixed;top:8px;right:90px;z-index:2147483647;padding:6px 12px;font:600 12px Arial,sans-serif;color:#fff;background:#185FA5;border:0;border-radius:6px;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.35)';
    b.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        chrome.runtime.sendMessage({ type: 'addDocs', nrs: [nr] }, (r) => {
          if (chrome.runtime.lastError || !r || r.error) {
            b.textContent = 'Não foi possível adicionar';
            b.style.background = '#A32D2D';
            return;
          }
          if (r.added && r.added.length) { b.textContent = 'Acompanhando ✓'; b.style.background = '#3B6D11'; }
          else { b.textContent = 'Já está na lista ✓'; b.style.background = '#5F5E5A'; }
        });
      } catch (e) {
        b.textContent = 'Recarregue a página';
        b.style.background = '#A32D2D';
      }
    });
    document.body.appendChild(b);
  }
})();
