"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const sdk_1 = __importDefault(require("@anthropic-ai/sdk"));
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("./database");
const scraper_1 = require("./scraper");
const app = (0, express_1.default)();
// ── Konstanten ────────────────────────────────────────────────────
const MAX_MESSAGE_LENGTH = 500;
const MAX_CONTEXT_LENGTH = 25000;
const CACHE_TTL_HOURS = 24;
const ALLOWED_LANGUAGES = new Set(['DE', 'FR', 'IT', 'EN', 'CH', 'AUTO']);
const ADMIN_KEY = process.env.ADMIN_KEY || '';
// ── Rate Limiting ─────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_CHAT = 30;
const RATE_LIMIT_SCRAPE = 5;
const RATE_LIMIT_ADMIN = 10;
function rateLimit(maxRequests) {
    return (req, res, next) => {
        const ip = req.ip || req.socket.remoteAddress || 'unknown';
        const key = `${ip}:${req.path}`;
        const now = Date.now();
        const entry = rateLimitMap.get(key);
        if (!entry || now > entry.resetAt) {
            rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
            next();
            return;
        }
        if (entry.count >= maxRequests) {
            res.status(429).json({ error: 'Too many requests. Please try again later.' });
            return;
        }
        entry.count++;
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
        if (now > entry.resetAt)
            rateLimitMap.delete(key);
    }
}, 5 * 60 * 1000);
// ── CORS ──────────────────────────────────────────────────────────
// Für Admin-Endpoints: nur bekannte Origins
const ADMIN_ALLOWED_ORIGINS = new Set([
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
]);
// Für Chat/Scrape: dynamisch aus DB (allowedDomains des Kunden)
// Widget-Requests kommen von Kunden-Websites — Origin wird pro Request geprüft
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        // Server-zu-Server oder Admin-Tools
        if (!origin) {
            callback(null, true);
            return;
        }
        // Immer erlauben — feingranulare Prüfung passiert in den Endpoints selbst
        callback(null, true);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-admin-key'],
    credentials: true,
}));
app.options('*', (0, cors_1.default)());
// ── Body-Parser ───────────────────────────────────────────────────
app.use(express_1.default.json({ limit: '500kb' }));
// ── Security Headers ──────────────────────────────────────────────
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.removeHeader('X-Powered-By');
    next();
});
const client = new sdk_1.default({ apiKey: process.env.ANTHROPIC_API_KEY });
// ── Hilfsfunktionen ───────────────────────────────────────────────
function sanitizeString(str, maxLength) {
    if (typeof str !== 'string')
        return '';
    return str.slice(0, maxLength).trim();
}
function validateAdminKey(key) {
    if (!ADMIN_KEY || !key)
        return false;
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
    }
    catch {
        return false;
    }
}
function buildSystemPrompt(languageRule, botName) {
    return `You are a precise and friendly website assistant called "${botName}". You answer visitor questions exclusively based on the provided website content and guaranteed information.

LANGUAGE: ${languageRule}

RESPONSE RULES:
- Answer immediately and directly — no preamble, no repetition of the question
- Maximum 1-3 sentences. Be concise.
- Friendly, professional tone
- Never mention that you are a bot, AI, or that you are using a knowledge base or context
- Never use filler phrases: "Gerne", "Natürlich", "Selbstverständlich", "Sicher", "Of course", "Certainly"
- Never start with introductory phrases like "Based on the context", "The website says", "According to the information"

TYPO & LANGUAGE TOLERANCE:
- Understand misspellings and typos in all languages
- Always infer intent from imperfect input

CONTENT RULES:
- Use ONLY information from the provided context and guaranteed info
- Never guess, speculate, or use external knowledge
- If you truly cannot answer: respond with the equivalent of "Dazu habe ich leider keine Information. Bitte kontaktieren Sie uns direkt." in the response language

FORMAT:
- No bullet points unless listing 3+ items
- No bold, no headers, no markdown
- Times and numbers exactly as on the website

LINKS:
- Only use URLs from the VERIFIED LINKS section — never invent or modify URLs
- Only include a link if the user would clearly benefit from visiting that page`;
}
// ── Origin-basierte Kunden-Authentifizierung ──────────────────────
function getCustomerByOrigin(siteId, origin) {
    if (!siteId)
        return { customer: null, error: 'siteId is required.' };
    if (!origin)
        return { customer: null, error: 'Origin header is required.' };
    // Localhost immer erlauben für Entwicklung
    let isLocalhost = false;
    try {
        const h = new URL(origin).hostname;
        isLocalhost = h === 'localhost' || h === '127.0.0.1' || h === '::1';
    }
    catch { }
    const customer = (0, database_1.getCustomerById)(siteId);
    if (!customer)
        return { customer: null, error: 'Unknown siteId.' };
    if (!isLocalhost && !(0, database_1.isOriginAllowed)(siteId, origin)) {
        return { customer: null, error: 'Origin not allowed.' };
    }
    return { customer };
}
// ── Health Check ──────────────────────────────────────────────────
app.get('/api', (_req, res) => {
    res.json({ status: 'ok', service: 'Askly Backend' });
});
// ── Widget.js ausliefern ──────────────────────────────────────────
app.get('/widget.js', rateLimit(60), (req, res) => {
    const siteId = sanitizeString(req.query.siteId, 50).toLowerCase();
    if (!siteId) {
        res.status(400).type('js').send('console.error("Askly: siteId parameter is required.");');
        return;
    }
    const customer = (0, database_1.getCustomerById)(siteId);
    if (!customer) {
        res.status(404).type('js').send(`console.error("Askly: Unknown siteId '${siteId}'.");`);
        return;
    }
    const config = {
        siteId: customer.siteId,
        botName: customer.botName,
        primaryColor: customer.primaryColor,
        language: customer.language,
        backendUrl: `${req.protocol}://${req.get('host')}`,
    };
    // Widget-JS mit eingebetteter Konfiguration ausliefern
    res.type('js');
    res.setHeader('Cache-Control', 'public, max-age=300'); // 5 Minuten cachen
    res.send(generateWidgetJs(config));
});
function generateWidgetJs(config) {
    return `(function() {
  'use strict';

  var ASKLY_CONFIG = ${JSON.stringify(config)};
  var BACKEND = ASKLY_CONFIG.backendUrl;
  var SITE_ID = ASKLY_CONFIG.siteId;
  var BOT_NAME = ASKLY_CONFIG.botName;
  var PRIMARY_COLOR = ASKLY_CONFIG.primaryColor;
  var DEFAULT_LANGUAGE = ASKLY_CONFIG.language;

  var CLIENT_CACHE_TTL = 6 * 60 * 60 * 1000;
  var MAX_MESSAGE_LENGTH = 500;
  var ALLOWED_LANGUAGES = ['AUTO', 'DE', 'FR', 'IT', 'EN', 'CH'];

  var UI_STRINGS = {
    AUTO: { welcome: 'Hallo! Wie kann ich Ihnen helfen?', placeholder: 'Ihre Frage...', error: 'Verbindungsfehler. Bitte erneut versuchen.', noAnswer: 'Keine Antwort erhalten.' },
    DE:   { welcome: 'Hallo! Wie kann ich Ihnen helfen?', placeholder: 'Ihre Frage...', error: 'Verbindungsfehler. Bitte erneut versuchen.', noAnswer: 'Keine Antwort erhalten.' },
    FR:   { welcome: 'Bonjour! Comment puis-je vous aider?', placeholder: 'Votre question...', error: 'Erreur de connexion. Veuillez réessayer.', noAnswer: 'Aucune réponse reçue.' },
    IT:   { welcome: 'Salve! Come posso aiutarla?', placeholder: 'La sua domanda...', error: 'Errore di connessione. Riprovare.', noAnswer: 'Nessuna risposta ricevuta.' },
    EN:   { welcome: 'Hello! How can I help you?', placeholder: 'Your question...', error: 'Connection error. Please try again.', noAnswer: 'No answer received.' },
    CH:   { welcome: 'Hoi! Wie chani Ihne hälfe?', placeholder: 'Iri Frag...', error: 'Verbindigsfehler. Bitte nomol versuche.', noAnswer: 'Kei Antwort erhalte.' },
  };

  var TTS_LANG_CODES = { AUTO: 'de-CH', DE: 'de-DE', FR: 'fr-FR', IT: 'it-IT', EN: 'en-GB', CH: 'de-CH' };
  var MIC_LANG_CODES = { AUTO: 'de-CH', DE: 'de-CH', FR: 'fr-CH', IT: 'it-CH', EN: 'en-GB', CH: 'de-CH' };

  var context = '';
  var selectedLanguage = DEFAULT_LANGUAGE || 'AUTO';
  var currentSpeech = null;
  var currentSpeakBtn = null;
  var currentSpeakText = '';
  var clientCache = null;
  var clientCacheTime = 0;
  var isSending = false;

  // ── Styles ────────────────────────────────────────────────────
  var style = document.createElement('style');
  style.textContent = \`
    #askly-btn {
      position: fixed; bottom: 24px; right: 24px; width: 56px; height: 56px;
      border-radius: 50%; background: \${PRIMARY_COLOR}; color: white; border: none;
      cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,0.25); z-index: 2147483646;
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #askly-btn:hover { transform: scale(1.07); }
    #askly-box {
      position: fixed; bottom: 90px; right: 24px; width: 420px; height: 620px;
      background: #fff; border-radius: 18px; box-shadow: 0 8px 40px rgba(0,0,0,0.13);
      display: none; flex-direction: column; z-index: 2147483645; overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    #askly-box.open { display: flex; }
    #askly-header {
      background: \${PRIMARY_COLOR}; color: #fff; padding: 14px 16px;
      display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-shrink: 0;
    }
    #askly-header-left { display: flex; align-items: center; gap: 10px; }
    #askly-logo { width: 28px; height: 28px; flex-shrink: 0; object-fit: contain; }
    #askly-title { font-weight: 600; font-size: 15px; }
    #askly-header-right { display: flex; align-items: center; gap: 6px; }
    #askly-lang-btn, #askly-close {
      background: rgba(255,255,255,0.15); border: none; color: white; cursor: pointer;
      width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center;
      justify-content: center; transition: background 0.2s;
    }
    #askly-lang-btn:hover, #askly-close:hover { background: rgba(255,255,255,0.28); }
    #askly-lang-dropdown {
      display: none; position: fixed; background: #fff; border-radius: 10px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18); z-index: 2147483647; min-width: 170px; overflow: hidden;
    }
    #askly-lang-dropdown.open { display: block; }
    .askly-lang-opt {
      padding: 10px 14px; font-size: 13px; color: #000; cursor: pointer;
      display: flex; align-items: center; gap: 8px; transition: background 0.15s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .askly-lang-opt:hover { background: #f0f1ff; }
    .askly-lang-opt.active { background: #f0f1ff; color: \${PRIMARY_COLOR}; font-weight: 600; }
    .askly-lang-code {
      font-weight: 700; font-size: 11px; color: \${PRIMARY_COLOR}; background: #e8eaff;
      padding: 1px 6px; border-radius: 4px; min-width: 28px; text-align: center;
    }
    .askly-lang-opt.active .askly-lang-code { background: \${PRIMARY_COLOR}; color: white; }
    #askly-messages {
      flex: 1; overflow-y: auto; padding: 18px; display: flex; flex-direction: column;
      gap: 4px; background: #f7f8fc; -webkit-overflow-scrolling: touch;
    }
    .askly-msg-wrap { display: flex; flex-direction: column; gap: 3px; margin-bottom: 8px; }
    .askly-msg-wrap.user { align-items: flex-end; }
    .askly-msg-wrap.bot { align-items: flex-start; }
    .askly-msg {
      max-width: 82%; padding: 11px 15px; border-radius: 16px; font-size: 14px;
      line-height: 1.6; word-break: break-word;
    }
    .askly-msg.bot { background: #fff; border: 1px solid #e8eaf0; border-bottom-left-radius: 4px; color: #000; }
    .askly-msg.user { background: \${PRIMARY_COLOR}; color: #fff; border-bottom-right-radius: 4px; }
    .askly-msg a { color: \${PRIMARY_COLOR}; text-decoration: underline; }
    .askly-msg-time { font-size: 10px; color: #b0b3c6; padding: 0 4px; }
    .askly-msg-actions { display: flex; align-items: center; gap: 8px; padding: 2px 4px; }
    .askly-thumb, .askly-speak {
      background: none; border: none; cursor: pointer; padding: 2px;
      display: flex; align-items: center; transition: transform 0.15s;
    }
    .askly-thumb svg, .askly-speak svg {
      width: 17px; height: 17px; fill: none; stroke: #c0c3d0;
      stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; transition: stroke 0.2s;
    }
    .askly-thumb:hover svg, .askly-speak:hover svg { stroke: #000; }
    .askly-thumb:hover, .askly-speak:hover { transform: scale(1.15); }
    .askly-thumb.active svg { stroke: #000; fill: #000; }
    .askly-speak.speaking svg { stroke: \${PRIMARY_COLOR}; }
    .askly-speak.speaking { animation: askly-pulse 1s infinite; }
    @keyframes askly-pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.2)} }
    #askly-footer { background: #fff; border-top: 1px solid #e8eaf0; flex-shrink: 0; position: relative; }
    #askly-input-row { display: flex; gap: 8px; padding: 12px; align-items: center; }
    #askly-input {
      flex: 1; padding: 10px 14px; border: 1.5px solid #e8eaf0; border-radius: 10px;
      font-size: 14px; outline: none; background: #f7f8fc; transition: border 0.2s; color: #000;
    }
    #askly-input:focus { border-color: \${PRIMARY_COLOR}; background: #fff; }
    #askly-send, #askly-mic {
      background: \${PRIMARY_COLOR}; color: white; border: none; border-radius: 50%;
      width: 38px; height: 38px; cursor: pointer; display: flex; align-items: center;
      justify-content: center; flex-shrink: 0; transition: background 0.2s;
    }
    #askly-send:disabled { opacity: 0.45; cursor: not-allowed; }
    #askly-mic.recording { background: #e53935; animation: askly-mic-pulse 1s infinite; }
    @keyframes askly-mic-pulse {
      0%,100%{box-shadow:0 0 0 0 rgba(229,57,53,0.45)} 50%{box-shadow:0 0 0 6px rgba(229,57,53,0)}
    }
    #askly-voice-recorder {
      display: none; position: absolute; bottom: 0; left: 0; right: 0;
      background: #fff; border-top: 1px solid #e8eaf0; padding: 16px; z-index: 100;
      flex-direction: column; gap: 12px; box-shadow: 0 -4px 20px rgba(0,0,0,0.08);
    }
    #askly-voice-recorder.active { display: flex; }
    #askly-waveform {
      display: flex; align-items: center; gap: 10px; background: #f7f8fc;
      border-radius: 12px; padding: 10px 14px; border: 1.5px solid #e8eaf0;
    }
    #askly-waveform-bars { flex: 1; display: flex; align-items: center; gap: 3px; height: 32px; }
    .askly-bar { flex: 1; background: \${PRIMARY_COLOR}; border-radius: 3px; height: 4px; transition: height 0.08s ease; }
    #askly-vtimer { font-size: 13px; font-weight: 600; color: #000; min-width: 36px; text-align: right; }
    #askly-vactions { display: flex; align-items: center; justify-content: space-between; }
    #askly-vcancel {
      background: none; border: 1.5px solid #e0e0e0; border-radius: 50%; width: 40px; height: 40px;
      cursor: pointer; display: flex; align-items: center; justify-content: center; transition: border-color 0.2s;
    }
    #askly-vcancel:hover { border-color: #e53935; background: #fff0f0; }
    #askly-vstatus { font-size: 12px; color: #b0b3c6; text-align: center; flex: 1; padding: 0 8px; }
    #askly-vconfirm {
      background: \${PRIMARY_COLOR}; border: none; border-radius: 50%; width: 40px; height: 40px;
      cursor: pointer; display: flex; align-items: center; justify-content: center;
    }
    #askly-branding { text-align: center; padding: 4px 0 8px; font-size: 11px; color: #b0b3c6; }
    #askly-branding a { color: \${PRIMARY_COLOR}; font-weight: 600; text-decoration: none; }
    .askly-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #b0b3c6; margin: 0 2px; animation: askly-bounce 1.2s infinite ease-in-out; }
    .askly-dot:nth-child(2){animation-delay:0.2s} .askly-dot:nth-child(3){animation-delay:0.4s}
    @keyframes askly-bounce { 0%,60%,100%{transform:translateY(0);opacity:0.4} 30%{transform:translateY(-6px);opacity:1} }
    @media(max-width:480px){
      #askly-box{width:100vw;height:88vh;bottom:0;right:0;left:0;border-radius:20px 20px 0 0;}
      #askly-btn{bottom:16px;right:16px;width:52px;height:52px;}
      .askly-msg{max-width:88%;font-size:15px;}
    }
  \`;
  document.head.appendChild(style);

  // ── HTML ──────────────────────────────────────────────────────
  var container = document.createElement('div');
  container.id = 'askly-root';
  container.innerHTML = \`
    <button id="askly-btn" aria-label="Chat öffnen">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="white"><path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z"/></svg>
    </button>
    <div id="askly-box" role="dialog" aria-modal="true">
      <div id="askly-header">
        <div id="askly-header-left">
          <img id="askly-logo" src="https://asklyteam-beep.github.io/chatbot-backend/logo%20.png" alt="Askly"/>
          <span id="askly-title">\${BOT_NAME}</span>
        </div>
        <div id="askly-header-right">
          <button id="askly-lang-btn" aria-label="Sprache">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </button>
          <button id="askly-close" aria-label="Schliessen">✕</button>
        </div>
      </div>
      <div id="askly-messages" role="log" aria-live="polite">
        <div class="askly-msg-wrap bot">
          <div class="askly-msg bot" id="askly-welcome"></div>
          <span class="askly-msg-time" id="askly-welcome-time"></span>
        </div>
      </div>
      <div id="askly-footer">
        <div id="askly-voice-recorder">
          <div id="askly-waveform">
            <div id="askly-waveform-bars">
              \${'<div class="askly-bar"></div>'.repeat(12)}
            </div>
            <span id="askly-vtimer">0:00</span>
          </div>
          <div id="askly-vactions">
            <button id="askly-vcancel">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#666" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
            <span id="askly-vstatus">Aufnahme läuft...</span>
            <button id="askly-vconfirm">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            </button>
          </div>
        </div>
        <div id="askly-input-row">
          <input id="askly-input" type="text" autocomplete="off" maxlength="500" aria-label="Nachricht"/>
          <button id="askly-mic" aria-label="Spracheingabe">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="9" y1="22" x2="15" y2="22"/></svg>
          </button>
          <button id="askly-send" aria-label="Senden">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M22 2L11 13" stroke="white" stroke-width="2.5" stroke-linecap="round"/><path d="M22 2L15 22L11 13L2 9L22 2Z" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
        <div id="askly-branding">Powered by <a href="https://askly.ch" target="_blank" rel="noopener">Askly</a></div>
      </div>
    </div>
    <div id="askly-lang-dropdown" role="listbox">
      <div class="askly-lang-opt active" data-lang="AUTO"><span class="askly-lang-code">AUTO</span> Automatisch</div>
      <div class="askly-lang-opt" data-lang="DE"><span class="askly-lang-code">DE</span> Deutsch</div>
      <div class="askly-lang-opt" data-lang="FR"><span class="askly-lang-code">FR</span> Français</div>
      <div class="askly-lang-opt" data-lang="IT"><span class="askly-lang-code">IT</span> Italiano</div>
      <div class="askly-lang-opt" data-lang="EN"><span class="askly-lang-code">EN</span> English</div>
      <div class="askly-lang-opt" data-lang="CH"><span class="askly-lang-code">CH</span> Schweizerdeutsch</div>
    </div>
  \`;
  document.body.appendChild(container);

  // ── Refs ──────────────────────────────────────────────────────
  var btn         = document.getElementById('askly-btn');
  var box         = document.getElementById('askly-box');
  var closeBtn    = document.getElementById('askly-close');
  var messages    = document.getElementById('askly-messages');
  var input       = document.getElementById('askly-input');
  var sendBtn     = document.getElementById('askly-send');
  var micBtn      = document.getElementById('askly-mic');
  var langBtn     = document.getElementById('askly-lang-btn');
  var langDrop    = document.getElementById('askly-lang-dropdown');
  var vRecorder   = document.getElementById('askly-voice-recorder');
  var vTimer      = document.getElementById('askly-vtimer');
  var vCancel     = document.getElementById('askly-vcancel');
  var vConfirm    = document.getElementById('askly-vconfirm');
  var vStatus     = document.getElementById('askly-vstatus');
  var wBars       = document.querySelectorAll('.askly-bar');

  // ── Utilities ─────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function isSafeUrl(url) {
    try { var p = new URL(url); return p.protocol==='https:'||p.protocol==='http:'; } catch{return false;}
  }
  function getTs() {
    var n = new Date();
    return n.toLocaleDateString('de-CH',{weekday:'short',day:'2-digit',month:'2-digit'})+', '+n.toLocaleTimeString('de-CH',{hour:'2-digit',minute:'2-digit'});
  }

  // ── Sprache ───────────────────────────────────────────────────
  function applyLang(lang) {
    if (ALLOWED_LANGUAGES.indexOf(lang) < 0) lang = 'AUTO';
    var s = UI_STRINGS[lang] || UI_STRINGS.DE;
    document.getElementById('askly-welcome').textContent = s.welcome;
    input.placeholder = s.placeholder;
    document.getElementById('askly-welcome-time').textContent = getTs();
  }
  applyLang(selectedLanguage);

  langBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    var r = langBtn.getBoundingClientRect();
    langDrop.style.top = (r.bottom + 8) + 'px';
    langDrop.style.right = (window.innerWidth - r.right) + 'px';
    langDrop.classList.toggle('open');
  });

  document.querySelectorAll('.askly-lang-opt').forEach(function(opt) {
    opt.addEventListener('click', function(e) {
      e.stopPropagation();
      var lang = opt.getAttribute('data-lang');
      if (ALLOWED_LANGUAGES.indexOf(lang) < 0) return;
      selectedLanguage = lang;
      document.querySelectorAll('.askly-lang-opt').forEach(function(o){ o.classList.remove('active'); });
      opt.classList.add('active');
      langDrop.classList.remove('open');
      applyLang(lang);
    });
  });

  document.addEventListener('click', function(){ langDrop.classList.remove('open'); });

  // ── Context laden ─────────────────────────────────────────────
  async function loadContext() {
    if (clientCache && (Date.now() - clientCacheTime) < CLIENT_CACHE_TTL) {
      context = clientCache.text || '';
      return;
    }
    try {
      var url = BACKEND + '/api/scrape?siteId=' + encodeURIComponent(SITE_ID);
      var res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('Scrape failed');
      var data = await res.json();
      context = typeof data.text === 'string' ? data.text : '';
      clientCache = data;
      clientCacheTime = Date.now();
    } catch(e) { context = ''; }
  }

  // ── Nachrichten ───────────────────────────────────────────────
  function addMsg(html, type, withActions) {
    var wrap = document.createElement('div');
    wrap.className = 'askly-msg-wrap ' + (type === 'user' ? 'user' : 'bot');

    var bubble = document.createElement('div');
    bubble.className = 'askly-msg ' + (type === 'user' ? 'user' : 'bot');
    bubble.innerHTML = html;
    wrap.appendChild(bubble);

    var time = document.createElement('span');
    time.className = 'askly-msg-time';
    time.textContent = getTs();
    wrap.appendChild(time);

    if (type === 'bot' && withActions) {
      var actions = document.createElement('div');
      actions.className = 'askly-msg-actions';

      var thumbUp = document.createElement('button');
      thumbUp.className = 'askly-thumb';
      thumbUp.innerHTML = '<svg viewBox="0 0 24 24"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z"/><path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/></svg>';

      var thumbDown = document.createElement('button');
      thumbDown.className = 'askly-thumb';
      thumbDown.innerHTML = '<svg viewBox="0 0 24 24"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z"/><path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/></svg>';

      thumbUp.onclick = function(){ thumbUp.classList.toggle('active',!thumbUp.classList.contains('active')); thumbDown.classList.remove('active'); };
      thumbDown.onclick = function(){ thumbDown.classList.toggle('active',!thumbDown.classList.contains('active')); thumbUp.classList.remove('active'); };

      var speakBtn = document.createElement('button');
      speakBtn.className = 'askly-speak';
      speakBtn.innerHTML = '<svg viewBox="0 0 24 24"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      speakBtn.onclick = function(){ speakText(bubble.innerHTML, speakBtn); };

      actions.appendChild(thumbUp);
      actions.appendChild(thumbDown);
      actions.appendChild(speakBtn);
      wrap.appendChild(actions);
    }

    messages.appendChild(wrap);
    messages.scrollTop = messages.scrollHeight;
    return bubble;
  }

  function cleanReply(text) {
    if (typeof text !== 'string') return '';
    text = text.replace(/\\*\\*(.*?)\\*\\*/g,'$1').replace(/\\*(.*?)\\*/g,'$1').replace(/#{1,3} /g,'');
    return text.split('\\n').map(function(line){
      return line.replace(/(https?:\\/\\/[^\\s<>"']+)/g, function(url){
        if (!isSafeUrl(url)) return escHtml(url);
        try {
          var p = new URL(url);
          var segs = p.pathname.split('/').filter(Boolean);
          var label = segs.length > 0 ? decodeURIComponent(segs[segs.length-1]).replace(/-/g,' ') : p.hostname;
          return '<a href="'+escHtml(url)+'" target="_blank" rel="noopener">'+escHtml(label)+'</a>';
        } catch { return escHtml(url); }
      });
    }).join('<br>');
  }

  // ── Senden ────────────────────────────────────────────────────
  async function send() {
    if (isSending) return;
    var raw = input.value.trim();
    if (!raw || raw.length > MAX_MESSAGE_LENGTH) return;
    var strings = UI_STRINGS[selectedLanguage] || UI_STRINGS.DE;
    isSending = true;
    input.value = '';
    sendBtn.disabled = true;
    addMsg(escHtml(raw), 'user');
    var loading = addMsg('<span class="askly-dot"></span><span class="askly-dot"></span><span class="askly-dot"></span>', 'bot');
    try {
      var res = await fetch(BACKEND + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: raw, context: context, siteId: SITE_ID, language: selectedLanguage }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (typeof data.reply !== 'string') throw new Error('Invalid response');
      loading.parentElement.remove();
      addMsg(cleanReply(data.reply || strings.noAnswer), 'bot', true);
    } catch(e) {
      loading.innerHTML = escHtml(strings.error);
    } finally {
      sendBtn.disabled = false;
      isSending = false;
    }
  }

  // ── TTS ───────────────────────────────────────────────────────
  function speakText(text, btn) {
    if (!window.speechSynthesis) return;
    if (currentSpeakBtn === btn) {
      if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); btn.classList.remove('speaking'); currentSpeakBtn = null; }
      return;
    }
    if (window.speechSynthesis.speaking) { window.speechSynthesis.cancel(); if(currentSpeakBtn){currentSpeakBtn.classList.remove('speaking');} }
    var clean = text.replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim().slice(0,2000);
    if (!clean) return;
    var utt = new SpeechSynthesisUtterance(clean);
    utt.lang = TTS_LANG_CODES[selectedLanguage] || 'de-DE';
    utt.onstart = function(){ btn.classList.add('speaking'); currentSpeakBtn = btn; };
    utt.onend = utt.onerror = function(){ btn.classList.remove('speaking'); currentSpeakBtn = null; currentSpeech = null; };
    currentSpeech = utt;
    window.speechSynthesis.speak(utt);
  }

  // ── Voice ─────────────────────────────────────────────────────
  var recognition = null, listening = false, voiceTranscript = '', timerInterval = null, voiceSecs = 0, confirmPending = false;
  var audioCtx = null, analyser = null, micStream = null, animFrame = null;

  function fmtTime(s){ return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); }

  function startWave(stream) {
    try {
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 256; analyser.smoothingTimeConstant = 0.5;
      var src = audioCtx.createMediaStreamSource(stream); src.connect(analyser);
      var arr = new Uint8Array(analyser.frequencyBinCount);
      function draw(){ animFrame = requestAnimationFrame(draw); analyser.getByteFrequencyData(arr);
        var avg = arr.slice(0,60).reduce(function(a,b){return a+b;},0)/60;
        wBars.forEach(function(b,i){ var n=Math.sin(Date.now()/180+i*0.8)*0.4+0.6; b.style.height=Math.max(4,Math.min(30,(avg/128)*32*n))+'px'; }); }
      draw();
    } catch(e){}
  }

  function stopWave() {
    if(animFrame){cancelAnimationFrame(animFrame);animFrame=null;}
    if(audioCtx){try{audioCtx.close();}catch(e){}audioCtx=null;}
    if(micStream){micStream.getTracks().forEach(function(t){t.stop();});micStream=null;}
    wBars.forEach(function(b){b.style.height='4px';});
  }

  function showRec() {
    vRecorder.classList.add('active'); micBtn.classList.add('recording');
    vStatus.textContent='Aufnahme läuft...'; voiceTranscript=''; confirmPending=false;
    voiceSecs=0; vTimer.textContent='0:00';
    timerInterval=setInterval(function(){voiceSecs++;vTimer.textContent=fmtTime(voiceSecs);},1000);
  }
  function hideRec() {
    vRecorder.classList.remove('active'); micBtn.classList.remove('recording');
    clearInterval(timerInterval); stopWave(); voiceSecs=0; vTimer.textContent='0:00'; voiceTranscript=''; confirmPending=false;
  }

  async function startVoice() {
    if(!('webkitSpeechRecognition' in window||'SpeechRecognition' in window)){alert('Spracheingabe nur in Chrome/Edge.');return;}
    try { micStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false}); startWave(micStream); } catch(e){}
    var SR = window.SpeechRecognition||window.webkitSpeechRecognition;
    recognition=new SR(); recognition.lang=MIC_LANG_CODES[selectedLanguage]||'de-CH';
    recognition.interimResults=true; recognition.continuous=true; recognition.maxAlternatives=1;
    recognition.onstart=function(){listening=true;showRec();};
    recognition.onresult=function(e){
      var interim='';
      for(var i=e.resultIndex;i<e.results.length;i++){
        if(e.results[i].isFinal){voiceTranscript+=e.results[i][0].transcript+' ';}
        else{interim+=e.results[i][0].transcript;}
      }
      voiceTranscript=voiceTranscript.slice(0,MAX_MESSAGE_LENGTH);
      vStatus.textContent=(voiceTranscript+interim).trim().slice(0,100)||'Aufnahme läuft...';
    };
    recognition.onerror=function(){listening=false;hideRec();};
    recognition.onend=function(){
      listening=false;
      if(confirmPending){var t=voiceTranscript.trim().slice(0,MAX_MESSAGE_LENGTH);hideRec();if(t){input.value=t;send();}}
    };
    recognition.start();
  }

  micBtn.onclick=function(){if(listening){confirmPending=false;if(recognition)try{recognition.stop();}catch(e){}listening=false;hideRec();}else{startVoice();}};
  vCancel.onclick=function(){confirmPending=false;if(recognition)try{recognition.stop();}catch(e){}listening=false;hideRec();};
  vConfirm.onclick=function(){
    confirmPending=true; clearInterval(timerInterval); stopWave();
    vRecorder.classList.remove('active'); micBtn.classList.remove('recording');
    if(recognition)try{recognition.stop();}catch(e){hideRec();}else{hideRec();}
  };

  // ── Events ────────────────────────────────────────────────────
  btn.onclick = function() {
    var opening = !box.classList.contains('open');
    box.classList.toggle('open');
    if (opening) { if (!context) loadContext(); setTimeout(function(){ input.focus(); }, 300); }
  };
  closeBtn.onclick = function() {
    box.classList.remove('open'); langDrop.classList.remove('open');
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (listening) { confirmPending=false; if(recognition)try{recognition.stop();}catch(e){} listening=false; hideRec(); }
  };
  sendBtn.onclick = send;
  input.addEventListener('keydown', function(e){ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} });
  document.addEventListener('keydown', function(e){
    if(e.key==='Escape'){ box.classList.remove('open'); langDrop.classList.remove('open'); if(window.speechSynthesis)window.speechSynthesis.cancel(); }
  });

})();`;
}
// ── Chat Endpoint ─────────────────────────────────────────────────
app.post('/api/chat', rateLimit(RATE_LIMIT_CHAT), async (req, res) => {
    const message = sanitizeString(req.body.message, MAX_MESSAGE_LENGTH);
    const context = sanitizeString(req.body.context, MAX_CONTEXT_LENGTH);
    const siteId = sanitizeString(req.body.siteId, 50).toLowerCase();
    const rawLang = sanitizeString(req.body.language, 10).toUpperCase();
    const language = ALLOWED_LANGUAGES.has(rawLang) ? rawLang : 'AUTO';
    const origin = req.headers.origin;
    if (!message) {
        res.status(400).json({ error: 'message is required.' });
        return;
    }
    const { customer, error } = getCustomerByOrigin(siteId, origin);
    if (!customer) {
        res.status(401).json({ error: error || 'Unauthorized.' });
        return;
    }
    const languageInstructions = {
        DE: 'Always respond in standard German (Hochdeutsch).',
        FR: 'Always respond in French.',
        IT: 'Always respond in Italian.',
        EN: 'Always respond in English.',
        CH: 'Always respond in Swiss German dialect (Schweizerdeutsch).',
        AUTO: `Detect the language of the user's question and respond in that exact same language. Never mix languages.`,
    };
    const fixedInfo = customer.fixedInfo ? `\nGARANTIERTE INFORMATIONEN:\n${customer.fixedInfo}\n` : '';
    try {
        const response = await client.messages.create({
            model: 'claude-opus-4-5',
            max_tokens: 1024,
            system: buildSystemPrompt(languageInstructions[language], customer.botName),
            messages: [{ role: 'user', content: `Website-Kontext:\n${fixedInfo}\n${context}\n\nFrage: ${message}` }],
        });
        const reply = response.content[0].type === 'text' ? response.content[0].text : '';
        res.json({ reply });
    }
    catch (err) {
        console.error('[Chat] Anthropic API error:', err);
        res.status(502).json({ error: 'AI service temporarily unavailable.' });
    }
});
// ── Scrape Endpoint ───────────────────────────────────────────────
app.get('/api/scrape', rateLimit(RATE_LIMIT_SCRAPE), async (req, res) => {
    const siteId = sanitizeString(req.query.siteId, 50).toLowerCase();
    const origin = req.headers.origin;
    const { customer, error } = getCustomerByOrigin(siteId, origin);
    if (!customer) {
        res.status(401).json({ error: error || 'Unauthorized.' });
        return;
    }
    const cacheAge = (0, database_1.getCacheAge)(siteId);
    if (cacheAge !== null && cacheAge < CACHE_TTL_HOURS) {
        const cached = (0, database_1.getCache)(siteId);
        if (cached) {
            console.log(`[Cache HIT] ${siteId}`);
            res.json({ text: cached.scrapedText, links: cached.links, cached: true });
            return;
        }
    }
    const { valid, parsed } = (0, scraper_1.isValidUrl)(customer.websiteUrl);
    if (!valid || !parsed) {
        res.status(400).json({ error: 'Invalid website URL.' });
        return;
    }
    try {
        console.log(`[Cache MISS] Scraping ${customer.websiteUrl} for ${siteId}...`);
        const { text, links } = await (0, scraper_1.buildFullContext)(customer.websiteUrl, parsed);
        (0, database_1.saveCache)(siteId, text, links);
        res.json({ text, links, cached: false });
    }
    catch (err) {
        console.error('[Scrape] error:', err);
        res.status(502).json({ error: 'Could not reach the website.' });
    }
});
// ── Admin: Neuen Kunden hinzufügen ────────────────────────────────
app.post('/api/admin/customers', rateLimit(RATE_LIMIT_ADMIN), (req, res) => {
    const adminKey = sanitizeString(req.headers['x-admin-key'], 200);
    if (!validateAdminKey(adminKey)) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    const result = (0, database_1.addCustomer)({
        siteId: sanitizeString(req.body.siteId, 50).toLowerCase(),
        apiKey: sanitizeString(req.body.apiKey, 200),
        websiteUrl: sanitizeString(req.body.websiteUrl, 500),
        allowedDomains: Array.isArray(req.body.allowedDomains) ? req.body.allowedDomains : [],
        botName: sanitizeString(req.body.botName, 100),
        primaryColor: sanitizeString(req.body.primaryColor, 7),
        language: sanitizeString(req.body.language, 10).toUpperCase(),
        fixedInfo: sanitizeString(req.body.fixedInfo, 5000),
        plan: sanitizeString(req.body.plan, 20).toLowerCase(),
    });
    if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
    }
    res.status(201).json({ message: 'Customer created successfully.' });
});
// ── Admin: Alle Kunden auflisten ──────────────────────────────────
app.get('/api/admin/customers', rateLimit(RATE_LIMIT_ADMIN), (req, res) => {
    const adminKey = sanitizeString(req.headers['x-admin-key'], 200);
    if (!validateAdminKey(adminKey)) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    const customers = (0, database_1.listCustomers)();
    res.json({ count: customers.length, customers });
});
// ── Admin: Kunden aktualisieren ───────────────────────────────────
app.patch('/api/admin/customers/:siteId', rateLimit(RATE_LIMIT_ADMIN), (req, res) => {
    const adminKey = sanitizeString(req.headers['x-admin-key'], 200);
    if (!validateAdminKey(adminKey)) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    const siteId = sanitizeString(req.params.siteId, 50).toLowerCase();
    const result = (0, database_1.updateCustomer)(siteId, req.body);
    if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
    }
    res.json({ message: 'Customer updated successfully.' });
});
// ── Admin: Cache löschen ──────────────────────────────────────────
app.delete('/api/admin/cache/:siteId', rateLimit(RATE_LIMIT_ADMIN), (req, res) => {
    const adminKey = sanitizeString(req.headers['x-admin-key'], 200);
    if (!validateAdminKey(adminKey)) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    const siteId = sanitizeString(req.params.siteId, 50).toLowerCase();
    (0, database_1.deleteCache)(siteId);
    res.json({ message: `Cache for ${siteId} cleared.` });
});
// ── Admin: Cache Status ───────────────────────────────────────────
app.get('/api/admin/cache', rateLimit(RATE_LIMIT_ADMIN), (req, res) => {
    const adminKey = sanitizeString(req.headers['x-admin-key'], 200);
    if (!validateAdminKey(adminKey)) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    const customers = (0, database_1.listCustomers)();
    const cacheInfo = customers.map(c => {
        const age = (0, database_1.getCacheAge)(c.siteId);
        return { siteId: c.siteId, cached: age !== null, ageHours: age, expiresIn: age !== null ? Math.max(0, CACHE_TTL_HOURS - age).toFixed(1) + 'h' : 'not cached' };
    });
    res.json({ cacheInfo });
});
// ── 404 ───────────────────────────────────────────────────────────
app.use((_req, res) => { res.status(404).json({ error: 'Not found.' }); });
// ── Error Handler ─────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('[Server] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
});
// ── Server starten ────────────────────────────────────────────────
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => { console.log(`Askly Backend läuft auf Port ${port}`); });
