(() => {
  if (window.__trmXhrHooked) return;
  window.__trmXhrHooked = true;
  const st = { s: 0, d: 0, l: 0 };
  const publish = () => {
    try { document.documentElement.dataset.trmX = st.s + ',' + st.d + ',' + st.l; } catch (e) {}
  };
  publish();
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    st.s++; st.l = Date.now(); publish();
    this.addEventListener('loadend', () => { st.d++; st.l = Date.now(); publish(); });
    return origSend.apply(this, arguments);
  };
})();
