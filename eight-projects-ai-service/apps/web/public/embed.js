/*
 * 欧态在线客服 · 官网嵌入脚本（无依赖）
 * 用法：<script src="https://<你的域名>/embed.js" data-title="在线客服" data-color="#2563eb" data-site="official-site"></script>
 * 以 iframe 加载同源的 /visitor?embed=1&channel=web&site=<site>，会话记在 iframe 的本地存储，刷新不丢。
 * 对外：window.EightChat.open() / close() / toggle()
 */
(function () {
  if (window.EightChat) return;
  var script = document.currentScript || (function () { var s = document.getElementsByTagName('script'); return s[s.length - 1]; })();
  var origin = (function () { try { return new URL(script.src, location.href).origin; } catch (e) { return location.origin; } })();
  var title = script.getAttribute('data-title') || '在线客服';
  var color = script.getAttribute('data-color') || '#2563eb';
  var site = script.getAttribute('data-site') || location.hostname || 'site';
  var channel = script.getAttribute('data-channel') || 'web';
  var src = origin + '/visitor?embed=1&channel=' + encodeURIComponent(channel) + '&site=' + encodeURIComponent(site);

  var css = document.createElement('style');
  css.textContent = [
    '.eight-chat-btn{position:fixed;right:24px;bottom:24px;width:56px;height:56px;border-radius:50%;border:0;cursor:pointer;color:#fff;background:' + color + ';box-shadow:0 10px 30px rgba(15,31,61,.25);z-index:2147483000;display:flex;align-items:center;justify-content:center;font:600 13px/1 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}',
    '.eight-chat-btn:hover{filter:brightness(1.08)}',
    '.eight-chat-frame{position:fixed;right:24px;bottom:92px;width:380px;height:600px;max-height:calc(100vh - 110px);max-width:calc(100vw - 32px);border:0;border-radius:16px;box-shadow:0 20px 60px rgba(15,31,61,.28);background:#fff;z-index:2147483000;display:none}',
    '.eight-chat-frame.open{display:block}',
    '@media (max-width:480px){.eight-chat-frame{right:8px;bottom:80px;width:calc(100vw - 16px);height:calc(100vh - 96px)}}',
  ].join('');
  document.head.appendChild(css);

  var frame = document.createElement('iframe');
  frame.className = 'eight-chat-frame';
  frame.title = title;
  frame.setAttribute('allow', 'clipboard-write');
  var loaded = false;

  var btn = document.createElement('button');
  btn.className = 'eight-chat-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', title);
  btn.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

  function open() {
    if (!loaded) { frame.src = src; loaded = true; }
    frame.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
  }
  function close() {
    frame.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
  }
  function toggle() { frame.classList.contains('open') ? close() : open(); }
  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });

  function mount() { document.body.appendChild(frame); document.body.appendChild(btn); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  window.EightChat = { open: open, close: close, toggle: toggle, src: src };
})();
