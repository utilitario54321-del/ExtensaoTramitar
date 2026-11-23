let frame = null;
let frameOrigin = null;
let seq = 0;
const pending = new Map();

function failAll(msg) {
  for (const [, p] of pending) { clearTimeout(p.t); p.fail(new Error(msg)); }
  pending.clear();
}

window.addEventListener('message', (e) => {
  const r = e.data && e.data.__trmRes;
  if (!r || !frame || e.source !== frame.contentWindow || e.origin !== frameOrigin) return;
  const p = pending.get(r.id);
  if (!p) return;
  pending.delete(r.id);
  clearTimeout(p.t);
  r.ok ? p.done(r.result) : p.fail(new Error(r.error));
});

function openFrame(url) {
  failAll('navigated');
  if (frame) frame.remove();
  frame = document.createElement('iframe');
  frame.addEventListener('load', () => failAll('navigated'));
  try { frameOrigin = new URL(url).origin; } catch (x) { frameOrigin = null; return; }
  frame.src = url;
  document.body.append(frame);
}

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (!msg || msg.target !== 'offscreen' || sender.id !== chrome.runtime.id) return;
  if (msg.cmd === 'open' && !/^https:\/\/mac[12]\.siloms\.intraer\//.test(String(msg.url))) { send({ ok: false, error: 'url não permitida' }); return; }
  if (msg.cmd === 'open') { openFrame(msg.url); send({ ok: true }); return; }
  if (msg.cmd === 'close') { failAll('closed'); if (frame) { frame.remove(); frame = null; } send({ ok: true }); return; }
  if (msg.cmd === 'call') {
    if (!frame || !frame.contentWindow) { send({ ok: false, error: 'noframe' }); return; }
    const id = ++seq;
    const t = setTimeout(() => { pending.delete(id); send({ ok: false, error: 'timeout' }); }, msg.timeout || 50000);
    pending.set(id, {
      t,
      done: (result) => send({ ok: true, result }),
      fail: (err) => send({ ok: false, error: err.message })
    });
    frame.contentWindow.postMessage({ __trmReq: { id, fn: msg.fn, args: msg.args || [] } }, frameOrigin);
    return true;
  }
});
