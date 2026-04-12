import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";

const app = express();

// ── Sicherheit: Rate Limiting ─────────────────────────────────────
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX_CHAT = 30;
const RATE_LIMIT_MAX_SCRAPE = 5;

function rateLimit(maxRequests: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
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
      res.status(429).json({ error: "Too many requests. Please try again later." });
      return;
    }

    entry.count++;
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap.entries()) {
    if (now > entry.resetAt) rateLimitMap.delete(key);
  }
}, 5 * 60 * 1000);

// ── CORS ──────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://asklyteam-beep.github.io',
  'https://www.meggen.ch',
  'https://meggen.ch',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) { callback(null, true); return; }
    if (ALLOWED_ORIGINS.includes(origin)) { callback(null, true); return; }
    callback(new Error(`CORS: Origin ${origin} not allowed`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// ── Body-Parser mit Limit ─────────────────────────────────────────
app.use(express.json({ limit: '500kb' })); // ← GEÄNDERT von 10kb

// ── Security Headers ──────────────────────────────────────────────
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.removeHeader('X-Powered-By');
  next();
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Input-Validierung ─────────────────────────────────────────────
const MAX_MESSAGE_LENGTH = 500;
const MAX_CONTEXT_LENGTH = 25000;
const ALLOWED_LANGUAGES = new Set(['DE', 'FR', 'IT', 'EN', 'CH', 'AUTO']);
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

function sanitizeString(str: unknown, maxLength: number): string {
  if (typeof str !== 'string') return '';
  return str.slice(0, maxLength).trim();
}

function isValidUrl(urlString: string): { valid: boolean; parsed?: URL } {
  try {
    const parsed = new URL(urlString);
    if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return { valid: false };
    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.startsWith('192.168.') ||
      hostname.startsWith('10.') ||
      hostname.startsWith('172.16.') ||
      hostname.endsWith('.internal') ||
      hostname === 'metadata.google.internal'
    ) {
      return { valid: false };
    }
    return { valid: true, parsed };
  } catch {
    return { valid: false };
  }
}

// ── Cache ─────────────────────────────────────────────────────────
interface CacheEntry {
  text: string;
  links: string[];
  siteUrl: string;
  timestamp: number;
}
const scrapeCache = new Map<string, CacheEntry>();
const CACHE_TTL = 24 * 60 * 60 * 1000;

function getCached(url: string): CacheEntry | null {
  const entry = scrapeCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) { scrapeCache.delete(url); return null; }
  return entry;
}

// ── Garantierte Basis-Infos ───────────────────────────────────────
const FIXED_INFO = `
GARANTIERTE INFORMATIONEN DER GEMEINDE MEGGEN:

ÖFFNUNGSZEITEN Gemeindeverwaltung:
Montag bis Freitag: 08.00–11.45 Uhr und 13.30–17.00 Uhr
Donnerstagnachmittag: geschlossen
Terminvereinbarungen ausserhalb der Öffnungszeiten nach persönlicher Vereinbarung möglich.

ADRESSE: Gemeinde Meggen, Am Dorfplatz 3, Postfach 572, 6045 Meggen
TELEFON: 041 379 81 11
EMAIL: info@meggen.ch
`;

app.get("/api", (_req: Request, res: Response) => {
  res.send("<h1>Chatbot Backend läuft ✓</h1>");
});

// ── Chat Endpoint ─────────────────────────────────────────────────
app.post("/api/chat", rateLimit(RATE_LIMIT_MAX_CHAT), async (req: Request, res: Response): Promise<void> => {
  const message = sanitizeString(req.body.message, MAX_MESSAGE_LENGTH);
  const context = sanitizeString(req.body.context, MAX_CONTEXT_LENGTH);
  const rawLanguage = sanitizeString(req.body.language, 10).toUpperCase();
  const language = ALLOWED_LANGUAGES.has(rawLanguage) ? rawLanguage : 'AUTO';

  if (!message) {
    res.status(400).json({ error: "Field 'message' is required and must be a non-empty string." });
    return;
  }

  const languageInstructions: Record<string, string> = {
    DE: "Always respond in standard German (Hochdeutsch).",
    FR: "Always respond in French.",
    IT: "Always respond in Italian.",
    EN: "Always respond in English.",
    CH: "Always respond in Swiss German dialect (Schweizerdeutsch). Use typical Swiss German expressions and spelling.",
    AUTO: `Detect the language of the user's question and respond in that exact same language.
- French question → French response
- Italian question → Italian response
- English question → English response
- Swiss German dialect → Swiss German dialect response
- German question → German response
- Unclear → German
Never mix languages.`,
  };

  const languageRule = languageInstructions[language];

  try {
    const response = await client.messages.create({
      model: "claude-opus-4-5",
      max_tokens: 1024,
      system: `You are a precise and friendly website assistant for the municipality of Meggen (Gemeinde Meggen), Switzerland. You answer visitor questions exclusively based on the provided website content and guaranteed information.

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
  "hundssteuer / dog taxx / taxe chien / tassa cane" → Hundesteuer
  "bawbewilligung / building permit / permis construire / permesso costruzione" → Baubewilligung
  "anmeldng / register / s'inscrire / registrazione" → Anmeldung
- Always infer intent from imperfect input

MULTILINGUAL CONTENT MAPPING (website is in German):
- opening hours / heures d'ouverture / orari di apertura / Öffnigsziite → Öffnungszeiten
- address / contact / adresse / indirizzo / adrässe → Adresse / Kontakt
- tax / impôts / tasse / stüüre → Steuern
- dog tax / taxe chiens / tassa cane / hundsstüür → Hundesteuer
- building permit / permis construire / permesso costruzione / baue → Baubewilligung
- register / move / s'inscrire / registrazione / amälde → Anmeldung / Umzug
- waste / déchets / rifiuti / müll → Abfall / Entsorgung
- town hall / mairie / municipio / gmeind → Gemeinde / Verwaltung
- passport / ID / passeport / passaporto / uswis → Pass / Ausweis
- school / école / scuola / schuel → Schule
- health / social / santé / salute / gsundheit → Gesundheit / Soziales
- environment / environnement / ambiente / umwelt → Umwelt

CONTENT RULES:
- Use ONLY information from the provided context and guaranteed info
- Never guess, speculate, or use external knowledge
- If you can partially answer: give the partial answer and stop — never add "I don't have more info"
- If you truly cannot answer at all: respond with the equivalent of "Dazu habe ich leider keine Information. Bitte kontaktieren Sie die Gemeinde direkt unter 041 379 81 11 oder info@meggen.ch." in the response language
- Contact info (address, phone, email, opening hours) is ALWAYS available — never say you don't have it

FORMAT:
- No bullet points unless listing 3+ items
- No bold, no headers, no markdown
- Times and numbers exactly as on the website

LINKS:
- Only use URLs from the VERIFIED LINKS section — never invent or modify URLs
- Only include a link if the user would benefit from visiting that page (forms, documents, contact pages)
- If appropriate, add on a new line:
  DE: "Mehr Informationen: https://..."
  FR: "Plus d'informations: https://..."
  IT: "Ulteriori informazioni: https://..."
  EN: "More information: https://..."
  CH: "Meh Informatione: https://..."
- If no exact verified link exists: omit entirely`,

      messages: [
        {
          role: "user",
          content: `Website-Kontext:\n${FIXED_INFO}\n\n${context}\n\nFrage: ${message}`,
        },
      ],
    });

    const reply = response.content[0].type === "text" ? response.content[0].text : "";
    res.json({ reply });
  } catch (err: unknown) {
    console.error("Anthropic API error:", err);
    res.status(502).json({ error: "AI service temporarily unavailable." });
  }
});

// ── Scraper ───────────────────────────────────────────────────────
async function scrapePage(url: string): Promise<string> {
  const { valid } = isValidUrl(url);
  if (!valid) return "";

  try {
    const fetchRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; AsklyBot/1.0)",
        "Accept": "text/html",
        "Accept-Language": "de,en;q=0.9",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!fetchRes.ok) return "";

    const contentType = fetchRes.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return "";

    const html = await fetchRes.text();
    if (html.length > 5_000_000) return "";

    const $ = cheerio.load(html);
    $("script, style, noscript, iframe, head, nav").remove();

    const contactInfo: string[] = [];
    $("*").each((_: number, el: any) => {
      const text = $(el).text().trim();
      if (
        /\b\d{3}\s?\d{3}\s?\d{2}\s?\d{2}\b/.test(text) ||
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(text) ||
        /\b\d{4}\s[A-Z][a-zA-Z]+\b/.test(text)
      ) {
        if (text.length < 200) contactInfo.push(text);
      }
    });

    const bodyText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 3500);
    const uniqueContact = [...new Set(contactInfo)].join(" | ");
    const combined = uniqueContact ? `KONTAKTDATEN: ${uniqueContact}\n\n${bodyText}` : bodyText;
    return combined.slice(0, 4000);
  } catch {
    return "";
  }
}

const PRIORITY_KEYWORDS = [
  "kontakt", "contact", "oeffnungszeit", "öffnungszeit", "opening",
  "verwaltung", "administration", "bau", "bauen", "baubewilligung",
  "steuer", "steuern", "tax", "hund", "hundsteuer", "hundesteuer",
  "abfall", "entsorgung", "recycling", "gemeinde", "buerger", "bürger",
  "schalter", "dienstleistung", "anmeldung", "ummeldung", "abmeldung",
  "pass", "ausweis", "dokument", "schule", "bildung", "sozial", "gesundheit",
];

function scoreLinkByPriority(linkText: string, linkUrl: string): number {
  const combined = (linkText + " " + linkUrl).toLowerCase();
  let score = 0;
  for (const keyword of PRIORITY_KEYWORDS) {
    if (combined.includes(keyword)) score++;
  }
  const depth = (linkUrl.match(/\//g) || []).length;
  score -= depth * 0.1;
  return score;
}

async function buildSitemap(url: string, origin: string): Promise<string[]> {
  const { valid } = isValidUrl(url);
  if (!valid) return [];

  try {
    const fetchRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AsklyBot/1.0)" },
      signal: AbortSignal.timeout(10000),
    });
    if (!fetchRes.ok) return [];

    const html = await fetchRes.text();
    const $ = cheerio.load(html);
    const seen = new Set<string>();
    const links: { label: string; url: string; score: number }[] = [];

    $("a[href]").each((_: number, el: any) => {
      const href = $(el).attr("href") || "";
      const text = $(el).text().trim();
      if (!text || text.length < 2 || text.length > 200) return;

      let fullUrl = "";
      if (href.startsWith("http://") || href.startsWith("https://")) {
        try {
          if (new URL(href).origin === origin) fullUrl = href.split("?")[0].split("#")[0];
        } catch { return; }
      } else if (href.startsWith("/") && !href.startsWith("//")) {
        fullUrl = `${origin}${href.split("?")[0].split("#")[0]}`;
      } else return;

      if (!fullUrl || seen.has(fullUrl) || fullUrl === origin || fullUrl === `${origin}/`) return;
      const { valid: linkValid } = isValidUrl(fullUrl);
      if (!linkValid) return;

      seen.add(fullUrl);
      links.push({ label: text, url: fullUrl, score: scoreLinkByPriority(text, fullUrl) });
    });

    links.sort((a, b) => b.score - a.score);
    return links.slice(0, 80).map(l => `${l.label}: ${l.url}`);
  } catch {
    return [];
  }
}

async function buildFullContext(url: string, parsedUrl: URL): Promise<{ text: string; links: string[]; siteUrl: string }> {
  const [mainText, sitemap] = await Promise.all([
    scrapePage(url),
    buildSitemap(url, parsedUrl.origin),
  ]);

  const subUrls = sitemap
    .map(l => l.split(": ").slice(1).join(": "))
    .filter(u => {
      if (!u || !u.startsWith(parsedUrl.origin)) return false;
      const { valid } = isValidUrl(u);
      return valid;
    })
    .slice(0, 10);

  const subTexts = await Promise.all(subUrls.map(u => scrapePage(u)));
  const allText = [mainText, ...subTexts].filter(Boolean).join("\n\n").slice(0, 20000);

  const verifiedLinksText = sitemap.length > 0
    ? "\n\nVERIFIED LINKS — only these exact URLs may be used in answers:\n" + sitemap.join("\n")
    : "";

  return { text: allText + verifiedLinksText, links: sitemap, siteUrl: parsedUrl.origin };
}

// ── Scrape Endpoint ───────────────────────────────────────────────
app.get("/api/scrape", rateLimit(RATE_LIMIT_MAX_SCRAPE), async (req: Request, res: Response): Promise<void> => {
  const rawUrl = sanitizeString(req.query.url, 2000);

  if (!rawUrl) {
    res.status(400).json({ error: "Query parameter 'url' is required." });
    return;
  }

  const { valid, parsed: parsedUrl } = isValidUrl(rawUrl);
  if (!valid || !parsedUrl) {
    res.status(400).json({ error: "Invalid or disallowed URL provided." });
    return;
  }

  const cached = getCached(rawUrl);
  if (cached) {
    console.log(`[Cache HIT] ${rawUrl}`);
    res.json({ url: rawUrl, ...cached, cached: true });
    return;
  }

  try {
    console.log(`[Cache MISS] Scraping ${rawUrl}...`);
    const result = await buildFullContext(rawUrl, parsedUrl);
    scrapeCache.set(rawUrl, { ...result, timestamp: Date.now() });
    res.json({ url: rawUrl, ...result, cached: false });
  } catch (err: unknown) {
    console.error("Scrape error:", err);
    res.status(502).json({ error: "Could not reach the provided URL." });
  }
});

// ── Cache Management ──────────────────────────────────────────────
const CACHE_ADMIN_KEY = process.env.CACHE_ADMIN_KEY || '';

app.get("/api/cache/clear", (req: Request, res: Response): void => {
  const key = req.query.key as string;
  if (!CACHE_ADMIN_KEY || key !== CACHE_ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  scrapeCache.clear();
  res.json({ message: "Cache cleared." });
});

app.get("/api/cache/status", (req: Request, res: Response): void => {
  const key = req.query.key as string;
  if (!CACHE_ADMIN_KEY || key !== CACHE_ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }
  const entries = Array.from(scrapeCache.entries()).map(([url, entry]) => ({
    url,
    cachedAt: new Date(entry.timestamp).toISOString(),
    expiresIn: Math.round((CACHE_TTL - (Date.now() - entry.timestamp)) / 60000) + " min",
  }));
  res.json({ count: entries.length, entries });
});

// ── 404 Handler ───────────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found." });
});

// ── Error Handler ─────────────────────────────────────────────────
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error." });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
