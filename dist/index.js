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
// Rate-Limit-Map periodisch bereinigen
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of rateLimitMap.entries()) {
        if (now > entry.resetAt)
            rateLimitMap.delete(key);
    }
}, 5 * 60 * 1000);
// ── CORS ──────────────────────────────────────────────────────────
// Erlaubte Origins — hier neue Kunden hinzufügen
const ALLOWED_ORIGINS = new Set([
    'https://asklyteam-beep.github.io',
    'https://www.meggen.ch',
    'https://meggen.ch',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
]);
const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) {
            callback(null, true);
            return;
        } // Server-zu-Server
        if (ALLOWED_ORIGINS.has(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error(`CORS: Origin ${origin} not allowed`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    credentials: true,
};
app.use((0, cors_1.default)(corsOptions));
app.options('*', (0, cors_1.default)(corsOptions));
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
    // Timing-sicherer Vergleich verhindert Timing-Attacks
    try {
        return crypto_1.default.timingSafeEqual(Buffer.from(key), Buffer.from(ADMIN_KEY));
    }
    catch {
        return false;
    }
}
// ── System-Prompt für einen Kunden generieren ─────────────────────
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
- Understand misspellings and typos in all languages. Examples:
  "öffnugnszeiten / offnungszeiten / opening hour / heures ouverture / orari apertura" → Öffnungszeiten
  "addresse / adrese / où se trouve / dove si trova / where is" → Adresse
  "anmeldng / register / s'inscrire / registrazione" → Anmeldung
- Always infer intent from imperfect input

MULTILINGUAL CONTENT MAPPING (website content may be in German):
- opening hours / heures d'ouverture / orari di apertura / Öffnigsziite → Öffnungszeiten
- address / contact / adresse / indirizzo / adrässe → Adresse / Kontakt
- tax / impôts / tasse / stüüre → Steuern
- building permit / permis construire / permesso costruzione / baue → Baubewilligung
- register / move / s'inscrire / registrazione / amälde → Anmeldung / Umzug
- waste / déchets / rifiuti / müll → Abfall / Entsorgung
- town hall / mairie / municipio / gmeind → Gemeinde / Verwaltung
- passport / ID / passeport / passaporto / uswis → Pass / Ausweis
- school / école / scuola / schuel → Schule
- health / social / santé / salute / gsundheit → Gesundheit / Soziales

CONTENT RULES:
- Use ONLY information from the provided context and guaranteed info
- Never guess, speculate, or use external knowledge
- If you can partially answer: give the partial answer and stop
- If you truly cannot answer: respond with the equivalent of "Dazu habe ich leider keine Information. Bitte kontaktieren Sie uns direkt." in the response language
- Contact info is ALWAYS available if provided — never say you don't have it

FORMAT:
- No bullet points unless listing 3+ items
- No bold, no headers, no markdown
- Times and numbers exactly as on the website

LINKS:
- Only use URLs from the VERIFIED LINKS section — never invent or modify URLs
- Only include a link if the user would clearly benefit from visiting that page
- If appropriate, add on a new line:
  DE: "Mehr Informationen: https://..."
  FR: "Plus d'informations: https://..."
  IT: "Ulteriori informazioni: https://..."
  EN: "More information: https://..."
  CH: "Meh Informatione: https://..."
- If no exact verified link exists: omit entirely`;
}
// ── Health Check ──────────────────────────────────────────────────
app.get('/api', (_req, res) => {
    res.json({ status: 'ok', service: 'Askly Backend' });
});
// ── Chat Endpoint ─────────────────────────────────────────────────
app.post('/api/chat', rateLimit(RATE_LIMIT_CHAT), async (req, res) => {
    const message = sanitizeString(req.body.message, MAX_MESSAGE_LENGTH);
    const context = sanitizeString(req.body.context, MAX_CONTEXT_LENGTH);
    const siteId = sanitizeString(req.body.siteId, 50).toLowerCase();
    const apiKey = sanitizeString(req.body.apiKey, 200);
    const rawLang = sanitizeString(req.body.language, 10).toUpperCase();
    const language = ALLOWED_LANGUAGES.has(rawLang) ? rawLang : 'AUTO';
    // Pflichtfelder prüfen
    if (!message) {
        res.status(400).json({ error: 'message is required.' });
        return;
    }
    if (!siteId || !apiKey) {
        res.status(400).json({ error: 'siteId and apiKey are required.' });
        return;
    }
    // Kunde authentifizieren
    const customer = (0, database_1.getCustomer)(siteId, apiKey);
    if (!customer) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    const languageInstructions = {
        DE: 'Always respond in standard German (Hochdeutsch).',
        FR: 'Always respond in French.',
        IT: 'Always respond in Italian.',
        EN: 'Always respond in English.',
        CH: 'Always respond in Swiss German dialect (Schweizerdeutsch).',
        AUTO: `Detect the language of the user's question and respond in that exact same language.
- French → French, Italian → Italian, English → English
- Swiss German dialect → Swiss German dialect
- German → German, Unclear → German
Never mix languages.`,
    };
    const languageRule = languageInstructions[language];
    const fixedInfo = customer.fixedInfo ? `\nGARANTIERTE INFORMATIONEN:\n${customer.fixedInfo}\n` : '';
    try {
        const response = await client.messages.create({
            model: 'claude-opus-4-5',
            max_tokens: 1024,
            system: buildSystemPrompt(languageRule, customer.botName),
            messages: [{
                    role: 'user',
                    content: `Website-Kontext:\n${fixedInfo}\n${context}\n\nFrage: ${message}`,
                }],
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
    const apiKey = sanitizeString(req.query.apiKey, 200);
    if (!siteId || !apiKey) {
        res.status(400).json({ error: 'siteId and apiKey are required.' });
        return;
    }
    // Kunde authentifizieren
    const customer = (0, database_1.getCustomer)(siteId, apiKey);
    if (!customer) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    // Cache prüfen (24h)
    const cacheAge = (0, database_1.getCacheAge)(siteId);
    if (cacheAge !== null && cacheAge < CACHE_TTL_HOURS) {
        const cached = (0, database_1.getCache)(siteId);
        if (cached) {
            console.log(`[Cache HIT] ${siteId}`);
            res.json({ text: cached.scrapedText, links: cached.links, cached: true });
            return;
        }
    }
    // URL validieren
    const { valid, parsed } = (0, scraper_1.isValidUrl)(customer.websiteUrl);
    if (!valid || !parsed) {
        res.status(400).json({ error: 'Invalid website URL for this customer.' });
        return;
    }
    try {
        console.log(`[Cache MISS] Scraping ${customer.websiteUrl} for ${siteId}...`);
        const { text, links } = await (0, scraper_1.buildFullContext)(customer.websiteUrl, parsed);
        // In DB cachen
        (0, database_1.saveCache)(siteId, text, links);
        res.json({ text, links, cached: false });
    }
    catch (err) {
        console.error('[Scrape] error:', err);
        res.status(502).json({ error: 'Could not reach the website.' });
    }
});
// ── Admin: Kunden-Konfiguration laden (für widget.js) ─────────────
app.get('/api/config/:siteId', rateLimit(RATE_LIMIT_ADMIN), (req, res) => {
    const siteId = sanitizeString(req.params.siteId, 50).toLowerCase();
    const apiKey = sanitizeString(req.query.apiKey, 200);
    if (!siteId || !apiKey) {
        res.status(400).json({ error: 'siteId and apiKey are required.' });
        return;
    }
    const customer = (0, database_1.getCustomer)(siteId, apiKey);
    if (!customer) {
        res.status(401).json({ error: 'Unauthorized.' });
        return;
    }
    // Nur öffentliche Kunden-Daten zurückgeben (kein apiKeyHash!)
    res.json({
        botName: customer.botName,
        primaryColor: customer.primaryColor,
        language: customer.language,
        websiteUrl: customer.websiteUrl,
    });
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
        return {
            siteId: c.siteId,
            cached: age !== null,
            ageHours: age,
            expiresIn: age !== null ? Math.max(0, CACHE_TTL_HOURS - age).toFixed(1) + 'h' : 'not cached',
        };
    });
    res.json({ cacheInfo });
});
// ── 404 Handler ───────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found.' });
});
// ── Global Error Handler ──────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error('[Server] Unhandled error:', err.message);
    res.status(500).json({ error: 'Internal server error.' });
});
// ── Server starten ────────────────────────────────────────────────
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
    console.log(`Askly Backend läuft auf Port ${port}`);
});
