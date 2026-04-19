import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// ── Konstanten ────────────────────────────────────────────────────
const MAX_FIELD_LENGTH = 500;
const SITE_ID_REGEX = /^[a-z0-9-]{1,50}$/; // nur Kleinbuchstaben, Zahlen, Bindestrich

// ── Datenbank-Pfad ────────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'askly.db'));

// WAL-Modus für bessere Performance und Sicherheit
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Tabellen erstellen ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    siteId        TEXT PRIMARY KEY,
    apiKeyHash    TEXT NOT NULL,
    websiteUrl    TEXT NOT NULL,
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

// ── Typen ─────────────────────────────────────────────────────────
export interface Customer {
  siteId:       string;
  apiKeyHash:   string;
  websiteUrl:   string;
  botName:      string;
  primaryColor: string;
  language:     string;
  fixedInfo:    string;
  plan:         string;
  active:       number;
  createdAt:    string;
}

export interface CustomerInput {
  siteId:       string;
  apiKey:       string; // Klartext — wird gehasht vor dem Speichern
  websiteUrl:   string;
  botName:      string;
  primaryColor: string;
  language:     string;
  fixedInfo:    string;
  plan:         string;
}

export interface SiteCache {
  siteId:      string;
  scrapedText: string;
  links:       string[];
  scrapedAt:   string;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────

// API-Key hashen (SHA-256) — nie Klartext in DB speichern
function hashApiKey(apiKey: string): string {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

// Input validieren und bereinigen
function validateSiteId(siteId: string): boolean {
  return SITE_ID_REGEX.test(siteId);
}

function sanitizeString(str: string, maxLength: number = MAX_FIELD_LENGTH): string {
  return String(str).trim().slice(0, maxLength);
}

function validateColor(color: string): boolean {
  return /^#[0-9A-Fa-f]{6}$/.test(color);
}

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch { return false; }
}

function validateLanguage(lang: string): boolean {
  return ['DE', 'FR', 'IT', 'EN', 'CH', 'AUTO'].includes(lang);
}

function validatePlan(plan: string): boolean {
  return ['basic', 'pro', 'enterprise'].includes(plan);
}

// ── Kunden-Funktionen ─────────────────────────────────────────────

// Kunde anhand siteId + apiKey authentifizieren
export function getCustomer(siteId: string, apiKey: string): Customer | null {
  if (!validateSiteId(siteId)) return null;
  if (!apiKey || apiKey.length > 200) return null;

  try {
    const hashedKey = hashApiKey(apiKey);
    const stmt = db.prepare(`
      SELECT * FROM customers 
      WHERE siteId = ? AND apiKeyHash = ? AND active = 1
    `);
    return (stmt.get(siteId, hashedKey) as Customer) || null;
  } catch (err) {
    console.error('[DB] getCustomer error:', err);
    return null;
  }
}

// Kunde nur anhand siteId laden (intern)
export function getCustomerById(siteId: string): Customer | null {
  if (!validateSiteId(siteId)) return null;

  try {
    const stmt = db.prepare(`
      SELECT * FROM customers WHERE siteId = ? AND active = 1
    `);
    return (stmt.get(siteId) as Customer) || null;
  } catch (err) {
    console.error('[DB] getCustomerById error:', err);
    return null;
  }
}

// Neuen Kunden hinzufügen
export function addCustomer(input: CustomerInput): { success: boolean; error?: string } {
  // Validierungen
  if (!validateSiteId(input.siteId)) {
    return { success: false, error: 'siteId darf nur Kleinbuchstaben, Zahlen und - enthalten (max 50 Zeichen)' };
  }
  if (!input.apiKey || input.apiKey.length < 16 || input.apiKey.length > 200) {
    return { success: false, error: 'apiKey muss zwischen 16 und 200 Zeichen lang sein' };
  }
  if (!validateUrl(input.websiteUrl)) {
    return { success: false, error: 'Ungültige Website-URL' };
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
      INSERT INTO customers (siteId, apiKeyHash, websiteUrl, botName, primaryColor, language, fixedInfo, plan)
      VALUES (@siteId, @apiKeyHash, @websiteUrl, @botName, @primaryColor, @language, @fixedInfo, @plan)
    `);
    stmt.run({
      siteId:       input.siteId,
      apiKeyHash:   hashApiKey(input.apiKey),
      websiteUrl:   sanitizeString(input.websiteUrl, 500),
      botName:      sanitizeString(input.botName, 100),
      primaryColor: input.primaryColor,
      language:     input.language,
      fixedInfo:    sanitizeString(input.fixedInfo, 5000),
      plan:         input.plan,
    });
    return { success: true };
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return { success: false, error: 'siteId existiert bereits' };
    }
    console.error('[DB] addCustomer error:', err);
    return { success: false, error: 'Datenbankfehler' };
  }
}

// Kunden aktualisieren
export function updateCustomer(siteId: string, fields: Partial<CustomerInput>): { success: boolean; error?: string } {
  if (!validateSiteId(siteId)) return { success: false, error: 'Ungültige siteId' };

  const allowed: Record<string, (v: any) => boolean> = {
    botName:      (v) => typeof v === 'string' && v.length <= 100,
    primaryColor: validateColor,
    language:     validateLanguage,
    fixedInfo:    (v) => typeof v === 'string' && v.length <= 5000,
    plan:         validatePlan,
    active:       (v) => v === 0 || v === 1,
  };

  const sanitized: Record<string, any> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed[key]) continue;
    if (!allowed[key](value)) return { success: false, error: `Ungültiger Wert für ${key}` };
    sanitized[key] = typeof value === 'string' ? sanitizeString(value) : value;
  }

  if (Object.keys(sanitized).length === 0) {
    return { success: false, error: 'Keine gültigen Felder zum Aktualisieren' };
  }

  try {
    const updates = Object.keys(sanitized).map(k => `${k} = @${k}`).join(', ');
    const stmt = db.prepare(`UPDATE customers SET ${updates} WHERE siteId = @siteId`);
    stmt.run({ ...sanitized, siteId });
    return { success: true };
  } catch (err) {
    console.error('[DB] updateCustomer error:', err);
    return { success: false, error: 'Datenbankfehler' };
  }
}

// Alle Kunden auflisten (ohne apiKeyHash)
export function listCustomers(): Omit<Customer, 'apiKeyHash'>[] {
  try {
    return db.prepare(`
      SELECT siteId, websiteUrl, botName, primaryColor, language, plan, active, createdAt
      FROM customers ORDER BY createdAt DESC
    `).all() as Omit<Customer, 'apiKeyHash'>[];
  } catch (err) {
    console.error('[DB] listCustomers error:', err);
    return [];
  }
}

// ── Cache-Funktionen ──────────────────────────────────────────────

export function saveCache(siteId: string, scrapedText: string, links: string[]): void {
  if (!validateSiteId(siteId)) return;

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
      links: JSON.stringify(links.slice(0, 200)), // max 200 Links
    });
  } catch (err) {
    console.error('[DB] saveCache error:', err);
  }
}

export function getCache(siteId: string): SiteCache | null {
  if (!validateSiteId(siteId)) return null;

  try {
    const row = db.prepare('SELECT * FROM sites_cache WHERE siteId = ?').get(siteId) as any;
    if (!row) return null;
    return {
      ...row,
      links: JSON.parse(row.links || '[]'),
    };
  } catch (err) {
    console.error('[DB] getCache error:', err);
    return null;
  }
}

// Cache-Alter in Stunden zurückgeben
export function getCacheAge(siteId: string): number | null {
  if (!validateSiteId(siteId)) return null;

  try {
    const row = db.prepare(`
      SELECT (julianday('now') - julianday(scrapedAt)) * 24 AS ageHours
      FROM sites_cache WHERE siteId = ?
    `).get(siteId) as any;
    return row ? Math.round(row.ageHours * 100) / 100 : null;
  } catch (err) {
    console.error('[DB] getCacheAge error:', err);
    return null;
  }
}

export function deleteCache(siteId: string): void {
  if (!validateSiteId(siteId)) return;

  try {
    db.prepare('DELETE FROM sites_cache WHERE siteId = ?').run(siteId);
  } catch (err) {
    console.error('[DB] deleteCache error:', err);
  }
}

export default db;