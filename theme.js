(() => {
  const apply = (t) => {
    const r = document.documentElement;
    if (t === 'light' || t === 'dark') r.dataset.theme = t; else delete r.dataset.theme;
  };
  try {
    chrome.storage.local.get('settings').then((d) => apply(d.settings && d.settings.theme));
    chrome.storage.onChanged.addListener((c) => { if (c.settings) apply(c.settings.newValue && c.settings.newValue.theme); });
  } catch (e) {}
})();
