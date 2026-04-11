import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";

const app = express();

const corsOptions = {
  origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
    if (
      !origin ||
      origin.includes('github.io') ||
      origin.includes('meggen.ch') ||
      origin.includes('localhost') ||
      origin.includes('127.0.0.1')
    ) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Server-seitiger Cache (24h) ───────────────────────────────────
interface CacheEntry {
  text: string;
  links: string[];
  siteUrl: string;
  timestamp: number;
}
const scrapeCache = new Map<string, CacheEntry>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 Stunden

function getCached(url: string): CacheEntry | null {
  const entry = scrapeCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    scrapeCache.delete(url);
    return null;
  }
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

app.get("/api", (_req, res) => {
  res.send("<h1>Chatbot Backend läuft ✓</h1>");
});

app.post("/api/chat", async (req, res) => {
  const { message, context, siteUrl, language } = req.body;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Field 'message' is required and must be a string." });
    return;
  }

  const safeContext = (typeof context === "string") ? context : "";

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

  const selectedLanguage = language && languageInstructions[language] ? language : "AUTO";
  const languageRule = languageInstructions[selectedLanguage];

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
        content: `Website-Kontext:\n${FIXED_INFO}\n\n${safeContext}\n\nFrage: ${message}`,
      },
    ],
  });

  const reply = response.content[0].type === "text" ? response.content[0].text : "";
  res.json({ reply });
});

async function scrapePage(url: string): Promise<string> {
  try {
    const fetchRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; AsklyBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!fetchRes.ok) return "";
    const html = await fetchRes.text();
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
    const combined = uniqueContact
      ? `KONTAKTDATEN: ${uniqueContact}\n\n${bodyText}`
      : bodyText;

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
      if (!text || text.length < 2) return;

      let fullUrl = "";
      if (href.startsWith("http://") || href.startsWith("https://")) {
        try {
          if (new URL(href).origin === origin) fullUrl = href.split("?")[0].split("#")[0];
        } catch { return; }
      } else if (href.startsWith("/") && !href.startsWith("//")) {
        fullUrl = `${origin}${href.split("?")[0].split("#")[0]}`;
      } else return;

      if (!fullUrl || seen.has(fullUrl) || fullUrl === origin || fullUrl === `${origin}/`) return;
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
    .filter(u => u && u.startsWith(parsedUrl.origin))
    .slice(0, 10);

  const subTexts = await Promise.all(subUrls.map(u => scrapePage(u)));
  const allText = [mainText, ...subTexts].filter(Boolean).join("\n\n").slice(0, 20000);

  const verifiedLinksText = sitemap.length > 0
    ? "\n\nVERIFIED LINKS — only these exact URLs may be used in answers:\n" + sitemap.join("\n")
    : "";

  return {
    text: allText + verifiedLinksText,
    links: sitemap,
    siteUrl: parsedUrl.origin,
  };
}

app.get("/api/scrape", async (req, res) => {
  const url = req.query.url as string;

  if (!url || typeof url !== "string") {
    res.status(400).json({ error: "Query parameter 'url' is required." });
    return;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: "Invalid URL provided." });
    return;
  }

  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    res.status(400).json({ error: "Only http and https URLs are allowed." });
    return;
  }

  // Cache prüfen
  const cached = getCached(url);
  if (cached) {
    console.log(`[Cache HIT] ${url}`);
    res.json({ url, ...cached, cached: true });
    return;
  }

  try {
    console.log(`[Cache MISS] Scraping ${url}...`);
    const result = await buildFullContext(url, parsedUrl);

    // In Cache speichern
    scrapeCache.set(url, {
      ...result,
      timestamp: Date.now(),
    });

    res.json({ url, ...result, cached: false });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Could not reach URL: ${message}` });
  }
});

// Cache manuell leeren (für Debugging)
app.get("/api/cache/clear", (_req, res) => {
  scrapeCache.clear();
  res.json({ message: "Cache cleared." });
});

// Cache Status anzeigen
app.get("/api/cache/status", (_req, res) => {
  const entries = Array.from(scrapeCache.entries()).map(([url, entry]) => ({
    url,
    cachedAt: new Date(entry.timestamp).toISOString(),
    expiresIn: Math.round((CACHE_TTL - (Date.now() - entry.timestamp)) / 60000) + " min",
  }));
  res.json({ count: entries.length, entries });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
