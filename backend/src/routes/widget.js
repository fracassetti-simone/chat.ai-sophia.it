/**
 * GET /widget.js  — script pubblico del widget chat da incorporare nei siti esterni.
 * Nota: questa rotta è fuori da /api e va registrata direttamente sull'app Express.
 *
 * GET /widget-embed/:publicId  — iframe HTML del widget (alternativa all'iframe manuale)
 */

import { Router } from 'express';
import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/http.js';

const router = Router();

// ── GET /widget.js ─────────────────────────────────────────────────────────
// Serve lo script JavaScript che inserisce il widget nel sito del cliente.
// Il cliente incolla questo snippet:
//   <script>
//     window.SophiaConfig = { id: "xxx", api: "https://api.ai-sophia.it" };
//     var s = document.createElement('script');
//     s.src = "https://api.ai-sophia.it/widget.js";
//     s.async = true;
//     document.head.appendChild(s);
//   </script>

router.get('/widget.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300'); // 5 minuti
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const script = buildWidgetScript();
  res.send(script);
});

// ── GET /widget-chat/:publicId ──────────────────────────────────────────────
// Endpoint CORS-safe per chiamate API dal widget su siti esterni
router.get('/widget-chat/:publicId/config', asyncHandler(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const embed = await prisma.embedWidget.findFirst({
    where: { publicId: req.params.publicId, enabled: true },
  });
  if (!embed) return res.status(404).json({ error: 'Widget non trovato o disabilitato' });

  res.json({
    id: embed.publicId,
    title: embed.title,
    primaryColor: embed.primaryColor,
    logoUrl: embed.logoUrl,
    iconUrl: embed.iconUrl,
    welcomeMessage: embed.welcomeMessage,
    width: embed.width,
    height: embed.height,
    enabledFeatures: embed.enabledFeatures,
  });
}));

// ── POST /widget-chat/:publicId/messages ───────────────────────────────────
// Riceve messaggi dall'utente del widget e risponde in streaming.
router.post('/widget-chat/:publicId/messages', asyncHandler(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

  const embed = await prisma.embedWidget.findFirst({
    where: { publicId: req.params.publicId, enabled: true },
  });
  if (!embed) return res.status(404).json({ error: 'Widget non trovato' });

  const { message, sessionId } = req.body || {};
  if (!message?.trim()) return res.status(400).json({ error: 'Messaggio vuoto' });

  // Trova o crea una conversazione per questa sessione widget
  let conversation = sessionId
    ? await prisma.conversation.findFirst({ where: { id: sessionId, tenantId: embed.tenantId } })
    : null;

  if (!conversation) {
    // Trova il primo admin del tenant come "utente" della conversazione widget
    const tenantUser = await prisma.user.findFirst({
      where: { tenantId: embed.tenantId, isActive: true, role: { in: ['ADMIN', 'MEMBER'] } },
      orderBy: { createdAt: 'asc' },
    });
    if (!tenantUser) return res.status(500).json({ error: 'Tenant non configurato' });

    conversation = await prisma.conversation.create({
      data: {
        tenantId: embed.tenantId,
        userId: tenantUser.id,
        title: `Widget: ${message.slice(0, 40)}`,
      },
    });
  }

  // Salva messaggio utente
  await prisma.message.create({
    data: { conversationId: conversation.id, role: 'user', content: message },
  });

  // Storia conversazione
  const history = await prisma.message.findMany({
    where: { conversationId: conversation.id, role: { not: 'system' } },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
  });

  // Allow-list features del widget
  const allow = embed.enabledFeatures || null;

  // Risposta AI in streaming SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    const { runChat } = await import('../ai/engine.js');
    const { content: answer } = await runChat({
      tenantId: embed.tenantId,
      conversationId: conversation.id,
      source: 'WIDGET',
      history: history.map((m) => ({ role: m.role, content: m.content })),
      allow,
      onToken: (delta) => send('token', { delta }),
    });

    await prisma.message.create({
      data: { conversationId: conversation.id, role: 'assistant', content: answer },
    });

    // Notifica anche sulla chat esterna (opzionale: crea ExternalChat per il widget)
    try {
      const { upsertExternalMessage } = await import('./external-chats.js');
      const { emitToTenant } = await import('../realtime/io.js');
      const { runFlows } = await import('./flows.js');

      const { chat, message: extMsg } = await upsertExternalMessage({
        tenantId: embed.tenantId,
        source: 'WIDGET',
        externalId: sessionId || conversation.id,
        role: 'customer',
        content: message,
      });
      emitToTenant(embed.tenantId, 'external-chat:message', { chatId: chat.id, message: extMsg });

      const aiExtMsg = await prisma.externalMessage.create({
        data: { chatId: chat.id, role: 'ai', content: answer },
      });
      emitToTenant(embed.tenantId, 'external-chat:message', { chatId: chat.id, message: aiExtMsg });

      await runFlows(embed.tenantId, 'WIDGET_MESSAGE_RECEIVED', {
        'contenuto': message,
        'sessione': sessionId || conversation.id,
      });
    } catch { /* non blocca lo streaming */ }

    send('done', { ok: true, conversationId: conversation.id });
  } catch (err) {
    send('error', { message: err.message });
  } finally {
    res.end();
  }
}));

// OPTIONS preflight per CORS
router.options('/widget-chat/:publicId/messages', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

export default router;

// ── Lo script JS del widget ────────────────────────────────────────────────

function buildWidgetScript() {
  return `(function() {
  'use strict';

  var cfg = window.SophiaConfig || {};
  var widgetId = cfg.id;
  var apiBase  = cfg.api || 'https://api.ai-sophia.it';

  if (!widgetId) { console.warn('[Sophia] SophiaConfig.id mancante'); return; }
  if (document.getElementById('sophia-widget-root')) return; // già montato

  // ── Carica config dal server ─────────────────────────────────────────────
  fetch(apiBase + '/widget-chat/' + widgetId + '/config')
    .then(function(r) { return r.json(); })
    .then(function(c) { mountWidget(c, apiBase, widgetId); })
    .catch(function(e) { console.warn('[Sophia] Impossibile caricare config widget:', e); });

  function mountWidget(config, api, id) {
    var color   = config.primaryColor || '#2563eb';
    var title   = config.title || 'Assistente';
    var welcome = config.welcomeMessage || 'Ciao! Come posso aiutarti?';
    var w       = Math.min(config.width  || 380, window.innerWidth - 20);
    var h       = Math.min(config.height || 560, window.innerHeight - 100);

    // ── CSS ──────────────────────────────────────────────────────────────────
    var style = document.createElement('style');
    style.textContent = [
      '#sophia-widget-root { position:fixed; bottom:0; right:0; z-index:2147483647; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; pointer-events:none; }',
      '#sophia-widget-btn { position:fixed; bottom:20px; right:20px; width:56px; height:56px; border-radius:50%; background:' + color + '; border:none; cursor:pointer; box-shadow:0 4px 16px rgba(0,0,0,.2); display:flex; align-items:center; justify-content:center; transition:transform .15s; pointer-events:all; z-index:2147483647; }',
      '#sophia-widget-btn:hover { transform:scale(1.08); }',
      '#sophia-widget-btn img { width:28px; height:28px; border-radius:4px; object-fit:contain; }',
      '#sophia-widget-btn svg { width:26px; height:26px; fill:none; stroke:#fff; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }',
      '#sophia-widget-box { display:none; flex-direction:column; width:' + w + 'px; height:' + h + 'px; background:#fff; border-radius:16px; box-shadow:0 8px 40px rgba(0,0,0,.18); overflow:hidden; position:fixed; bottom:88px; right:20px; pointer-events:all; z-index:2147483646; }',
      '#sophia-widget-box.open { display:flex; }',
      '#sophia-widget-head { background:' + color + '; color:#fff; padding:14px 16px; display:flex; align-items:center; justify-content:space-between; flex-shrink:0; }',
      '#sophia-widget-head-left { display:flex; align-items:center; gap:10px; }',
      '#sophia-widget-head-logo { width:26px; height:26px; border-radius:5px; object-fit:contain; }',
      '#sophia-widget-head-title { font-weight:600; font-size:15px; }',
      '#sophia-widget-close { background:none; border:none; color:rgba(255,255,255,.8); cursor:pointer; font-size:20px; line-height:1; padding:0 4px; }',
      '#sophia-widget-close:hover { color:#fff; }',
      '#sophia-widget-msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:10px; scroll-behavior:smooth; }',
      '.sw-msg { max-width:82%; padding:10px 13px; border-radius:14px; font-size:14px; line-height:1.55; word-break:break-word; }',
      '.sw-msg-ai { background:#f1f5f9; color:#0f172a; border-bottom-left-radius:4px; align-self:flex-start; }',
      '.sw-msg-user { background:' + color + '; color:#fff; border-bottom-right-radius:4px; align-self:flex-end; }',
      '.sw-msg-typing { display:flex; gap:5px; align-items:center; padding:12px 16px; }',
      '.sw-dot { width:7px; height:7px; border-radius:50%; background:#94a3b8; animation:sw-bounce 1.2s infinite; }',
      '.sw-dot:nth-child(2){animation-delay:.15s} .sw-dot:nth-child(3){animation-delay:.3s}',
      '@keyframes sw-bounce{0%,60%,100%{transform:translateY(0);opacity:.5}30%{transform:translateY(-5px);opacity:1}}',
      '#sophia-widget-foot { border-top:1px solid #e2e8f0; padding:10px 12px; display:flex; gap:8px; flex-shrink:0; }',
      '#sophia-widget-input { flex:1; border:1px solid #e2e8f0; border-radius:10px; padding:9px 13px; font-size:14px; font-family:inherit; outline:none; resize:none; max-height:100px; line-height:1.5; }',
      '#sophia-widget-input:focus { border-color:' + color + '; box-shadow:0 0 0 3px ' + color + '22; }',
      '#sophia-widget-send { width:38px; height:38px; border-radius:10px; background:' + color + '; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; align-self:flex-end; }',
      '#sophia-widget-send:disabled { opacity:.45; cursor:not-allowed; }',
      '#sophia-widget-send svg { width:18px; height:18px; fill:none; stroke:#fff; stroke-width:2; stroke-linecap:round; stroke-linejoin:round; }',
      '#sophia-widget-powered { text-align:center; padding:6px 12px; font-size:11px; color:#94a3b8; border-top:1px solid #f1f5f9; flex-shrink:0; }',
      '#sophia-widget-powered a { color:#94a3b8; text-decoration:none; }',
      '#sophia-widget-powered a:hover { color:#64748b; }',
    ].join('');
    document.head.appendChild(style);

    // ── HTML ─────────────────────────────────────────────────────────────────
    var logoHtml = config.logoUrl
      ? '<img src="' + esc(config.logoUrl) + '" id="sophia-widget-head-logo" alt="logo">'
      : '';
    var btnLogoHtml = config.logoUrl
      ? '<img src="' + esc(config.logoUrl) + '" alt="logo">'
      : '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';

    var root = document.createElement('div');
    root.id = 'sophia-widget-root';
    root.innerHTML = [
      '<div id="sophia-widget-box">',
        '<div id="sophia-widget-head">',
          '<div id="sophia-widget-head-left">',
            logoHtml,
            '<span id="sophia-widget-head-title">' + esc(title) + '</span>',
          '</div>',
          '<button id="sophia-widget-close" aria-label="Chiudi">&#x2715;</button>',
        '</div>',
        '<div id="sophia-widget-msgs"></div>',
        '<div id="sophia-widget-foot">',
          '<textarea id="sophia-widget-input" rows="1" placeholder="Scrivi un messaggio\u2026"></textarea>',
          '<button id="sophia-widget-send" aria-label="Invia">',
            '<svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
          '</button>',
        '</div>',
        '<div id="sophia-widget-powered">Powered by <a href="https://ai-sophia.it" target="_blank" rel="noopener">PHI Informatica Sophia</a></div>',
      '</div>',
      '<button id="sophia-widget-btn" aria-label="Apri chat">' + btnLogoHtml + '</button>',
    ].join('');
    document.body.appendChild(root);

    // ── Refs ─────────────────────────────────────────────────────────────────
    var box    = document.getElementById('sophia-widget-box');
    var btn    = document.getElementById('sophia-widget-btn');
    var msgs   = document.getElementById('sophia-widget-msgs');
    var input  = document.getElementById('sophia-widget-input');
    var sendBtn = document.getElementById('sophia-widget-send');
    var closeBtn = document.getElementById('sophia-widget-close');

    var sessionId = null;
    var busy = false;
    var opened = false;

    // ── Messaggio di benvenuto ────────────────────────────────────────────────
    addMsg('ai', welcome);

    // ── Toggle ───────────────────────────────────────────────────────────────
    btn.addEventListener('click', function() {
      opened = !opened;
      box.classList.toggle('open', opened);
      if (opened) { input.focus(); scrollBottom(); }
    });
    closeBtn.addEventListener('click', function() {
      opened = false;
      box.classList.remove('open');
    });

    // ── Invia ────────────────────────────────────────────────────────────────
    sendBtn.addEventListener('click', doSend);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
    });
    input.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });

    function doSend() {
      var text = input.value.trim();
      if (!text || busy) return;
      addMsg('user', text);
      input.value = '';
      input.style.height = 'auto';
      sendBtn.disabled = true;
      busy = true;

      var typing = addTyping();

      var url = api + '/widget-chat/' + id + '/messages';
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: sessionId }),
      }).then(function(res) {
        if (!res.ok || !res.body) throw new Error('Errore server');
        typing.remove();
        var aiDiv = addMsg('ai', '');
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = '';
        var acc = '';

        function read() {
          reader.read().then(function(result) {
            if (result.done) { done(); return; }
            buffer += decoder.decode(result.value, { stream: true });
            var parts = buffer.split('\\n\\n');
            buffer = parts.pop() || '';
            parts.forEach(function(block) {
              var lines = block.split('\\n');
              var event = '';
              var data  = '';
              lines.forEach(function(l) {
                if (l.startsWith('event:')) event = l.slice(6).trim();
                if (l.startsWith('data:')) data = l.slice(5).trim();
              });
              if (!data) return;
              try {
                var payload = JSON.parse(data);
                if (event === 'token') { acc += payload.delta; aiDiv.innerHTML = mdToHtml(acc); scrollBottom(); }
                if (event === 'done' && payload.conversationId) sessionId = payload.conversationId;
                if (event === 'error') { aiDiv.textContent = 'Errore: ' + payload.message; }
              } catch(e) {}
            });
            read();
          }).catch(done);
        }

        function done() {
          busy = false;
          sendBtn.disabled = false;
          input.focus();
        }

        read();
      }).catch(function(e) {
        typing.remove();
        addMsg('ai', 'Errore di connessione. Riprova.');
        busy = false;
        sendBtn.disabled = false;
      });
    }

    function addMsg(role, text) {
      var d = document.createElement('div');
      d.className = 'sw-msg sw-msg-' + role;
      d.innerHTML = role === 'ai' ? mdToHtml(text) : esc(text);
      msgs.appendChild(d);
      scrollBottom();
      return d;
    }

    function addTyping() {
      var d = document.createElement('div');
      d.className = 'sw-msg sw-msg-ai sw-msg-typing';
      d.innerHTML = '<div class="sw-dot"></div><div class="sw-dot"></div><div class="sw-dot"></div>';
      msgs.appendChild(d);
      scrollBottom();
      return d;
    }

    function scrollBottom() { msgs.scrollTop = msgs.scrollHeight; }

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // Markdown minimo: grassetto, corsivo, codice inline, link, newline
    function mdToHtml(s) {
      return esc(s)
        .replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*(.+?)\\*/g, '<em>$1</em>')
        .replace(/\`(.+?)\`/g, '<code style="background:#f1f5f9;padding:1px 5px;border-radius:4px;font-size:.9em">$1</code>')
        .replace(/\\[(.+?)\\]\\((.+?)\\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:' + color + '">$1</a>')
        .replace(/\\n/g, '<br>');
    }
  }
})();`;
}
