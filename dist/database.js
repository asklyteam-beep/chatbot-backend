"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getCustomer = getCustomer;
exports.getCustomerById = getCustomerById;
exports.isOriginAllowed = isOriginAllowed;
exports.addCustomer = addCustomer;
exports.updateCustomer = updateCustomer;
exports.listCustomers = listCustomers;
exports.saveCache = saveCache;
exports.getCache = getCache;
exports.getCacheAge = getCacheAge;
exports.deleteCache = deleteCache;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const crypto_1 = __importDefault(require("crypto"));
// ── Konstanten ────────────────────────────────────────────────────
const MAX_FIELD_LENGTH = 500;
const SITE_ID_REGEX = /^[a-z0-9-]{1,50}$/;
// ── Datenbank-Pfad ────────────────────────────────────────────────
const DATA_DIR = path_1.default.join(process.cwd(), 'data');
if (!fs_1.default.existsSync(DATA_DIR))
    fs_1.default.mkdirSync(DATA_DIR, { recursive: true });
const db = new better_sqlite3_1.default(path_1.default.join(DATA_DIR, 'askly.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
// ── Tabellen erstellen ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    siteId        TEXT PRIMARY KEY,
    apiKeyHash    TEXT NOT NULL,
    websiteUrl    TEXT NOT NULL,
    allowedDomains TEXT NOT NULL DEFAULT '[]',
    botName       TEXT NOT NULL DEFAULT 'Assistent',
    primaryColor  TEXT NOT NULL DEFAULT '#1B17FF',
    language      TEXT NOT NULL DEFAULT 'AUTO',
    fixedInfo     TEXT NOT NULL DEFAULT '',
    plan          TEXT NOT NULL DEFAULT 'basic',
    active        INTEGER NOT NULL DEFAULT 1,
    createdAt     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sites_cache (
    siteId        TEXT PRIMARY KEY,
    scrapedText   TEXT NOT NULL DEFAULT '',
    links         TEXT NOT NULL DEFAULT '[]',
    scrapedAt     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (siteId) REFERENCES customers(siteId) ON DELETE CASCADE
  );
`);
// Migration: allowedDomains Spalte hinzufügen falls nicht vorhanden (für bestehende DBs)
try {
    db.exec(`ALTER TABLE customers ADD COLUMN allowedDomains TEXT NOT NULL DEFAULT '[]'`);
}
catch {
    // Spalte existiert bereits — ignorieren
}
// ── Hilfsfunktionen ───────────────────────────────────────────────
function hashApiKey(apiKey) {
    return crypto_1.default.createHash('sha256').update(apiKey).digest('hex');
}
function validateSiteId(siteId) {
    return SITE_ID_REGEX.test(siteId);
}
function sanitizeString(str, maxLength = MAX_FIELD_LENGTH) {
    return String(str).trim().slice(0, maxLength);
}
function validateColor(color) {
    return /^#[0-9A-Fa-f]{6}$/.test(color);
}
function validateUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
    }
    catch {
        return false;
    }
}
function validateLanguage(lang) {
    return ['DE', 'FR', 'IT', 'EN', 'CH', 'AUTO'].includes(lang);
}
function validatePlan(plan) {
    return ['basic', 'pro', 'enterprise'].includes(plan);
}
function validateDomains(domains) {
    if (!Array.isArray(domains))
        return false;
    if (domains.length > 20)
        return false;
    return domains.every(d => typeof d === 'string' && d.length > 0 && d.length <= 100 && !d.includes('/'));
}
// ── Kunden-Funktionen ─────────────────────────────────────────────
// Kunde anhand siteId + apiKey authentifizieren (für Admin-Operationen)
function getCustomer(siteId, apiKey) {
    if (!validateSiteId(siteId))
        return null;
    if (!apiKey || apiKey.length > 200)
        return null;
    try {
        const hashedKey = hashApiKey(apiKey);
        const stmt = db.prepare(`
      SELECT * FROM customers 
      WHERE siteId = ? AND apiKeyHash = ? AND active = 1
    `);
        return stmt.get(siteId, hashedKey) || null;
    }
    catch (err) {
        console.error('[DB] getCustomer error:', err);
        return null;
    }
}
// Kunde nur anhand siteId laden — für Origin-basierte Auth
function getCustomerById(siteId) {
    if (!validateSiteId(siteId))
        return null;
    try {
        const stmt = db.prepare(`
      SELECT * FROM customers WHERE siteId = ? AND active = 1
    `);
        return stmt.get(siteId) || null;
    }
    catch (err) {
        console.error('[DB] getCustomerById error:', err);
        return null;
    }
}
// Origin gegen allowedDomains prüfen
function isOriginAllowed(siteId, origin) {
    const customer = getCustomerById(siteId);
    if (!customer)
        return false;
    try {
        const domains = JSON.parse(customer.allowedDomains || '[]');
        if (domains.length === 0)
            return false;
        // Origin kann "https://meggen.ch" oder "http://localhost:3000" sein
        const originHostname = new URL(origin).hostname;
        return domains.some(d => d === originHostname || originHostname.endsWith('.' + d));
    }
    catch {
        return false;
    }
}
// Neuen Kunden hinzufügen
function addCustomer(input) {
    if (!validateSiteId(input.siteId)) {
        return { success: false, error: 'siteId darf nur Kleinbuchstaben, Zahlen und - enthalten (max 50 Zeichen)' };
    }
    if (!input.apiKey || input.apiKey.length < 16 || input.apiKey.length > 200) {
        return { success: false, error: 'apiKey muss zwischen 16 und 200 Zeichen lang sein' };
    }
    if (!validateUrl(input.websiteUrl)) {
        return { success: false, error: 'Ungültige Website-URL' };
    }
    if (!validateDomains(input.allowedDomains)) {
        return { success: false, error: 'allowedDomains muss ein Array von max 20 Domains sein' };
    }
    if (!validateColor(input.primaryColor)) {
        return { success: false, error: 'Farbe muss im Format #RRGGBB sein' };
    }
    if (!validateLanguage(input.language)) {
        return { success: false, error: 'Ungültige Sprache' };
    }
    if (!validatePlan(input.plan)) {
        return { success: false, error: 'Ungültiger Plan' };
    }
    try {
        const stmt = db.prepare(`
      INSERT INTO customers (siteId, apiKeyHash, websiteUrl, allowedDomains, botName, primaryColor, language, fixedInfo, plan)
      VALUES (@siteId, @apiKeyHash, @websiteUrl, @allowedDomains, @botName, @primaryColor, @language, @fixedInfo, @plan)
    `);
        stmt.run({
            siteId: input.siteId,
            apiKeyHash: hashApiKey(input.apiKey),
            websiteUrl: sanitizeString(input.websiteUrl, 500),
            allowedDomains: JSON.stringify(input.allowedDomains),
            botName: sanitizeString(input.botName, 100),
            primaryColor: input.primaryColor,
            language: input.language,
            fixedInfo: sanitizeString(input.fixedInfo, 5000),
            plan: input.plan,
        });
        return { success: true };
    }
    catch (err) {
        if (err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
            return { success: false, error: 'siteId existiert bereits' };
        }
        console.error('[DB] addCustomer error:', err);
        return { success: false, error: 'Datenbankfehler' };
    }
}
// Kunden aktualisieren
function updateCustomer(siteId, fields) {
    if (!validateSiteId(siteId))
        return { success: false, error: 'Ungültige siteId' };
    const allowed = {
        botName: (v) => typeof v === 'string' && v.length <= 100,
        primaryColor: validateColor,
        language: validateLanguage,
        fixedInfo: (v) => typeof v === 'string' && v.length <= 5000,
        plan: validatePlan,
        active: (v) => v === 0 || v === 1,
        allowedDomains: validateDomains,
    };
    const sanitized = {};
    for (const [key, value] of Object.entries(fields)) {
        if (!allowed[key])
            continue;
        if (!allowed[key](value))
            return { success: false, error: `Ungültiger Wert für ${key}` };
        if (key === 'allowedDomains') {
            sanitized[key] = JSON.stringify(value);
        }
        else {
            sanitized[key] = typeof value === 'string' ? sanitizeString(value) : value;
        }
    }
    if (Object.keys(sanitized).length === 0) {
        return { success: false, error: 'Keine gültigen Felder zum Aktualisieren' };
    }
    try {
        const updates = Object.keys(sanitized).map(k => `${k} = @${k}`).join(', ');
        const stmt = db.prepare(`UPDATE customers SET ${updates} WHERE siteId = @siteId`);
        stmt.run({ ...sanitized, siteId });
        return { success: true };
    }
    catch (err) {
        console.error('[DB] updateCustomer error:', err);
        return { success: false, error: 'Datenbankfehler' };
    }
}
// Alle Kunden auflisten (ohne apiKeyHash)
function listCustomers() {
    try {
        return db.prepare(`
      SELECT siteId, websiteUrl, allowedDomains, botName, primaryColor, language, plan, active, createdAt
      FROM customers ORDER BY createdAt DESC
    `).all();
    }
    catch (err) {
        console.error('[DB] listCustomers error:', err);
        return [];
    }
}
// ── Cache-Funktionen ──────────────────────────────────────────────
function saveCache(siteId, scrapedText, links) {
    if (!validateSiteId(siteId))
        return;
    try {
        const stmt = db.prepare(`
      INSERT INTO sites_cache (siteId, scrapedText, links, scrapedAt)
      VALUES (@siteId, @scrapedText, @links, datetime('now'))
      ON CONFLICT(siteId) DO UPDATE SET
        scrapedText = @scrapedText,
        links       = @links,
        scrapedAt   = datetime('now')
    `);
        stmt.run({
            siteId,
            scrapedText: sanitizeString(scrapedText, 100000),
            links: JSON.stringify(links.slice(0, 200)),
        });
    }
    catch (err) {
        console.error('[DB] saveCache error:', err);
    }
}
function getCache(siteId) {
    if (!validateSiteId(siteId))
        return null;
    try {
        const row = db.prepare('SELECT * FROM sites_cache WHERE siteId = ?').get(siteId);
        if (!row)
            return null;
        return { ...row, links: JSON.parse(row.links || '[]') };
    }
    catch (err) {
        console.error('[DB] getCache error:', err);
        return null;
    }
}
function getCacheAge(siteId) {
    if (!validateSiteId(siteId))
        return null;
    try {
        const row = db.prepare(`
      SELECT (julianday('now') - julianday(scrapedAt)) * 24 AS ageHours
      FROM sites_cache WHERE siteId = ?
    `).get(siteId);
        return row ? Math.round(row.ageHours * 100) / 100 : null;
    }
    catch (err) {
        console.error('[DB] getCacheAge error:', err);
        return null;
    }
}
function deleteCache(siteId) {
    if (!validateSiteId(siteId))
        return;
    try {
        db.prepare('DELETE FROM sites_cache WHERE siteId = ?').run(siteId);
    }
    catch (err) {
        console.error('[DB] deleteCache error:', err);
    }
}
exports.default = db;
