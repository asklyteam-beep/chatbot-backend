"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.isValidUrl = isValidUrl;
exports.scrapePage = scrapePage;
exports.buildSitemap = buildSitemap;
exports.buildFullContext = buildFullContext;
const cheerio = __importStar(require("cheerio"));
// ── Konstanten ────────────────────────────────────────────────────
const MAX_PAGE_SIZE_BYTES = 5000000; // Max 5MB pro Seite
const MAX_TEXT_PER_PAGE = 4000; // Max 4000 Zeichen pro Seite
const MAX_TOTAL_TEXT = 20000; // Max 20000 Zeichen gesamt
const MAX_SUBPAGES = 10; // Max 10 Unterseiten scrapen
const MAX_LINKS = 80; // Max 80 Links speichern
const SCRAPE_TIMEOUT_MS = 8000; // 8 Sekunden Timeout
const SITEMAP_TIMEOUT_MS = 10000; // 10 Sekunden Timeout
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
const PRIORITY_KEYWORDS = [
    'kontakt', 'contact', 'oeffnungszeit', 'öffnungszeit', 'opening',
    'verwaltung', 'administration', 'bau', 'bauen', 'baubewilligung',
    'steuer', 'steuern', 'tax', 'hund', 'hundsteuer', 'hundesteuer',
    'abfall', 'entsorgung', 'recycling', 'gemeinde', 'buerger', 'bürger',
    'schalter', 'dienstleistung', 'anmeldung', 'ummeldung', 'abmeldung',
    'pass', 'ausweis', 'dokument', 'schule', 'bildung', 'sozial',
    'gesundheit', 'produkt', 'produkte', 'service', 'leistung', 'menu',
    'speisekarte', 'team', 'über uns', 'ueber uns', 'about', 'faq',
    'preise', 'pricing', 'termin', 'appointment', 'booking',
];
// ── URL-Validierung (SSRF-Schutz) ─────────────────────────────────
function isValidUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        if (!ALLOWED_PROTOCOLS.has(parsed.protocol))
            return { valid: false };
        const hostname = parsed.hostname.toLowerCase();
        // Private IPs und localhost blockieren
        if (hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '0.0.0.0' ||
            hostname.startsWith('192.168.') ||
            hostname.startsWith('10.') ||
            hostname.startsWith('172.16.') ||
            hostname.startsWith('172.17.') ||
            hostname.startsWith('172.18.') ||
            hostname.startsWith('172.19.') ||
            hostname.startsWith('172.20.') ||
            hostname.startsWith('172.21.') ||
            hostname.startsWith('172.22.') ||
            hostname.startsWith('172.23.') ||
            hostname.startsWith('172.24.') ||
            hostname.startsWith('172.25.') ||
            hostname.startsWith('172.26.') ||
            hostname.startsWith('172.27.') ||
            hostname.startsWith('172.28.') ||
            hostname.startsWith('172.29.') ||
            hostname.startsWith('172.30.') ||
            hostname.startsWith('172.31.') ||
            hostname.startsWith('169.254.') || // Link-local
            hostname.endsWith('.internal') ||
            hostname.endsWith('.local') ||
            hostname === 'metadata.google.internal' ||
            hostname === '100.100.100.200' // Alibaba Cloud metadata
        ) {
            return { valid: false };
        }
        return { valid: true, parsed };
    }
    catch {
        return { valid: false };
    }
}
// ── Einzelne Seite scrapen ────────────────────────────────────────
async function scrapePage(url) {
    const { valid } = isValidUrl(url);
    if (!valid)
        return '';
    try {
        const fetchRes = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; AsklyBot/1.0)',
                'Accept': 'text/html',
                'Accept-Language': 'de,en;q=0.9',
            },
            signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
        });
        if (!fetchRes.ok)
            return '';
        // Nur HTML verarbeiten
        const contentType = fetchRes.headers.get('content-type') || '';
        if (!contentType.includes('text/html'))
            return '';
        const html = await fetchRes.text();
        if (html.length > MAX_PAGE_SIZE_BYTES)
            return '';
        const $ = cheerio.load(html);
        // Unnötige Elemente entfernen
        $('script, style, noscript, iframe, head, nav, footer, .cookie-banner, .ad').remove();
        // Kontaktinfos gezielt extrahieren
        const contactInfo = [];
        $('*').each((_, el) => {
            const text = $(el).text().trim();
            if (/\b\d{3}\s?\d{3}\s?\d{2}\s?\d{2}\b/.test(text) || // Telefonnummer
                /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text) || // Email
                /\b\d{4}\s[A-Z][a-zA-Z]+\b/.test(text) // PLZ + Ort
            ) {
                if (text.length > 0 && text.length < 200) {
                    contactInfo.push(text);
                }
            }
        });
        const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_PER_PAGE);
        const uniqueContact = [...new Set(contactInfo)].join(' | ');
        const combined = uniqueContact
            ? `KONTAKTDATEN: ${uniqueContact}\n\n${bodyText}`
            : bodyText;
        return combined.slice(0, MAX_TEXT_PER_PAGE);
    }
    catch {
        return '';
    }
}
// ── Link-Priorität berechnen ──────────────────────────────────────
function scoreLinkByPriority(linkText, linkUrl) {
    const combined = (linkText + ' ' + linkUrl).toLowerCase();
    let score = 0;
    for (const keyword of PRIORITY_KEYWORDS) {
        if (combined.includes(keyword))
            score++;
    }
    // Tiefere URLs bekommen weniger Punkte (weniger relevant)
    const depth = (linkUrl.match(/\//g) || []).length;
    score -= depth * 0.1;
    return score;
}
// ── Alle Links einer Website sammeln ─────────────────────────────
async function buildSitemap(url, origin) {
    const { valid } = isValidUrl(url);
    if (!valid)
        return [];
    try {
        const fetchRes = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AsklyBot/1.0)' },
            signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS),
        });
        if (!fetchRes.ok)
            return [];
        const html = await fetchRes.text();
        const $ = cheerio.load(html);
        const seen = new Set();
        const links = [];
        $('a[href]').each((_, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().trim();
            // Zu kurze oder zu lange Linktexte ignorieren
            if (!text || text.length < 2 || text.length > 200)
                return;
            let fullUrl = '';
            if (href.startsWith('http://') || href.startsWith('https://')) {
                try {
                    if (new URL(href).origin === origin) {
                        fullUrl = href.split('?')[0].split('#')[0];
                    }
                }
                catch {
                    return;
                }
            }
            else if (href.startsWith('/') && !href.startsWith('//')) {
                fullUrl = `${origin}${href.split('?')[0].split('#')[0]}`;
            }
            else {
                return; // Relative Links oder andere Formate ignorieren
            }
            // Duplikate und ungültige URLs filtern
            if (!fullUrl || seen.has(fullUrl))
                return;
            if (fullUrl === origin || fullUrl === `${origin}/`)
                return;
            const { valid: linkValid } = isValidUrl(fullUrl);
            if (!linkValid)
                return;
            seen.add(fullUrl);
            links.push({
                label: text,
                url: fullUrl,
                score: scoreLinkByPriority(text, fullUrl),
            });
        });
        // Nach Priorität sortieren und begrenzen
        links.sort((a, b) => b.score - a.score);
        return links.slice(0, MAX_LINKS).map(l => `${l.label}: ${l.url}`);
    }
    catch {
        return [];
    }
}
// ── Kompletten Website-Kontext aufbauen ───────────────────────────
async function buildFullContext(url, parsedUrl) {
    // Hauptseite + Sitemap parallel laden
    const [mainText, sitemap] = await Promise.all([
        scrapePage(url),
        buildSitemap(url, parsedUrl.origin),
    ]);
    // Top-Unterseiten scrapen
    const subUrls = sitemap
        .map(l => l.split(': ').slice(1).join(': '))
        .filter(u => {
        if (!u || !u.startsWith(parsedUrl.origin))
            return false;
        const { valid } = isValidUrl(u);
        return valid;
    })
        .slice(0, MAX_SUBPAGES);
    const subTexts = await Promise.all(subUrls.map(u => scrapePage(u)));
    // Alles zusammenfügen
    const allText = [mainText, ...subTexts]
        .filter(Boolean)
        .join('\n\n')
        .slice(0, MAX_TOTAL_TEXT);
    const verifiedLinksText = sitemap.length > 0
        ? '\n\nVERIFIED LINKS — only these exact URLs may be used in answers:\n' + sitemap.join('\n')
        : '';
    return {
        text: allText + verifiedLinksText,
        links: sitemap,
    };
}
