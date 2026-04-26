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
const MAX_TEXT_PER_PAGE = 4000;
const MAX_TOTAL_TEXT = 20000;
const MAX_SUBPAGES = 10;
const MAX_LINKS = 80;
const SCRAPE_TIMEOUT_MS = 15000;
const SITEMAP_TIMEOUT_MS = 10000;
const MAX_PAGE_SIZE_BYTES = 5000000;
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
    'preise', 'pricing', 'termin', 'appointment', 'booking', 'job',
    'stelle', 'stellen', 'karriere', 'career', 'register', 'registrieren',
];
// ── URL-Validierung (SSRF-Schutz) ─────────────────────────────────
function isValidUrl(urlString) {
    try {
        const parsed = new URL(urlString);
        if (!ALLOWED_PROTOCOLS.has(parsed.protocol))
            return { valid: false };
        const hostname = parsed.hostname.toLowerCase();
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
            hostname.startsWith('169.254.') ||
            hostname.endsWith('.internal') ||
            hostname.endsWith('.local') ||
            hostname === 'metadata.google.internal' ||
            hostname === '100.100.100.200') {
            return { valid: false };
        }
        return { valid: true, parsed };
    }
    catch {
        return { valid: false };
    }
}
// ── Jina AI Reader (rendert auch JS-Seiten) ───────────────────────
async function scrapeWithJina(url) {
    try {
        const jinaUrl = `https://r.jina.ai/${url}`;
        const res = await fetch(jinaUrl, {
            headers: {
                'Accept': 'text/plain',
                'User-Agent': 'Mozilla/5.0 (compatible; AsklyBot/1.0)',
            },
            signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
        });
        if (!res.ok)
            return '';
        const text = await res.text();
        return text.slice(0, MAX_TEXT_PER_PAGE);
    }
    catch {
        return '';
    }
}
// ── Fallback: direktes Scraping mit cheerio ───────────────────────
async function scrapeWithCheerio(url) {
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
        const contentType = fetchRes.headers.get('content-type') || '';
        if (!contentType.includes('text/html'))
            return '';
        const html = await fetchRes.text();
        if (html.length > MAX_PAGE_SIZE_BYTES)
            return '';
        const $ = cheerio.load(html);
        $('script, style, noscript, iframe, head, nav, footer, .cookie-banner, .ad').remove();
        const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
        return bodyText.slice(0, MAX_TEXT_PER_PAGE);
    }
    catch {
        return '';
    }
}
// ── Einzelne Seite scrapen (Jina zuerst, dann Fallback) ──────────
async function scrapePage(url) {
    const { valid } = isValidUrl(url);
    if (!valid)
        return '';
    // Jina zuerst versuchen (rendert JS)
    const jinaText = await scrapeWithJina(url);
    // Wenn Jina genug Text liefert, fertig
    if (jinaText.length > 200)
        return jinaText;
    // Sonst Fallback auf direktes Scraping
    return scrapeWithCheerio(url);
}
// ── Link-Priorität berechnen ──────────────────────────────────────
function scoreLinkByPriority(linkText, linkUrl) {
    const combined = (linkText + ' ' + linkUrl).toLowerCase();
    let score = 0;
    for (const keyword of PRIORITY_KEYWORDS) {
        if (combined.includes(keyword))
            score++;
    }
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
        // Für Sitemap direktes fetch verwenden (brauchen HTML mit Links)
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
                return;
            }
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
        links.sort((a, b) => b.score - a.score);
        return links.slice(0, MAX_LINKS).map(l => `${l.label}: ${l.url}`);
    }
    catch {
        return [];
    }
}
// ── Kompletten Website-Kontext aufbauen ───────────────────────────
async function buildFullContext(url, parsedUrl) {
    const [mainText, sitemap] = await Promise.all([
        scrapePage(url),
        buildSitemap(url, parsedUrl.origin),
    ]);
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
