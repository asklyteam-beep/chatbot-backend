import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";

const app = express();

app.use(cors({
  origin: [
    'https://asklyteam-beep.github.io',
    'https://www.meggen.ch',
    'http://localhost:3000',
    'http://127.0.0.1:5500',
    'http://localhost:5500',
  ],
  methods: ['GET', 'POST'],
}));

app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get("/api", (_req, res) => {
  res.send("<h1>Chatbot Backend läuft ✓</h1>");
});

app.post("/api/chat", async (req, res) => {
  const { message, context, siteUrl, language } = req.body;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Field 'message' is required and must be a string." });
    return;
  }
  if (!context || typeof context !== "string") {
    res.status(400).json({ error: "Field 'context' is required and must be a string." });
    return;
  }

  const languageInstructions: Record<string, string> = {
    DE: "Always respond in standard German (Hochdeutsch).",
    FR: "Always respond in French.",
    IT: "Always respond in Italian.",
    EN: "Always respond in English.",
    CH: "Always respond in Swiss German dialect (Schweizerdeutsch). Use typical Swiss German expressions and spelling.",
    AUTO: `Detect the language of the user's question carefully and respond in that exact same language.
- If the question is in French → respond in French
- If the question is in Italian → respond in Italian
- If the question is in English → respond in English
- If the question is in Swiss German dialect → respond in Swiss German dialect
- If the question is in German → respond in German
- If unclear → respond in German
Never mix languages in your response.`,
  };

  const selectedLanguage = language && languageInstructions[language] ? language : "AUTO";
  const languageRule = languageInstructions[selectedLanguage];

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: `You are a helpful and precise website assistant. Your sole purpose is to answer visitor questions based exclusively on the provided website content.

LANGUAGE: ${languageRule}

RESPONSE RULES:
- Answer immediately and directly
- Never repeat the question
- Never use introductions like "Basierend auf dem Kontext", "Die Website sagt", "Im vorliegenden Kontext" or similar
- Keep answers concise: 1-3 sentences maximum
- Always use a friendly professional tone
- Never refer to yourself as a bot or mention internal context, knowledge base, or data sources

CONTENT RULES:
- Only use information from the provided website content
- Never speculate, guess, or use external knowledge
- If you can partially answer, give the answer — then stop. Never add a second paragraph saying the information is not available after already answering
- Only if you cannot answer at all, respond with the equivalent of "Dazu habe ich leider keine Information. Bitte nutzen Sie die Kontaktangaben auf dieser Website." translated into the response language
- Never explain what you know or don't know
- Contact information such as address, phone number and email are always available in the website content — always use them when asked

FORMAT RULES:
- No bullet points unless listing 3 or more items that truly require them
- No bold text, no headers, no markdown formatting
- No filler phrases like "Gerne", "Natürlich", "Selbstverständlich", "Sicher"
- Numbers and times exactly as they appear on the website

LINKS:
- Only include a link if it appears EXACTLY in the VERIFIED LINKS section of the context
- Never construct, modify, or guess any URL — not even small changes
- Only add a link if the user would clearly benefit from visiting that page — for example to fill out a form, download a document, find contact details, or get more specific information than you could provide
- Do NOT add a link if the answer is already complete and no further action on a webpage is needed
- If a link is appropriate, add it on a new line using the correct prefix for the response language:
  German: "Mehr Informationen: https://..."
  French: "Plus d'informations: https://..."
  Italian: "Ulteriori informazioni: https://..."
  English: "More information: https://..."
  Swiss German: "Meh Informatione: https://..."
- If no exact verified link exists for the topic, do not include any link at all`,

    messages: [
      {
        role: "user",
        content: `Website-Kontext:\n${context}\n\nFrage: ${message}`,
      },
    ],
  });

  const reply = response.content[0].type === "text" ? response.content[0].text : "";
  res.json({ reply });
});

async function scrapePage(url: string): Promise<string> {
  try {
    const fetchRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WebsiteBot/1.0)" },
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
  "kontakt", "contact",
  "oeffnungszeit", "öffnungszeit", "opening",
  "verwaltung", "administration",
  "bau", "bauen", "baubewilligung",
  "steuer", "steuern", "tax",
  "hund", "hundsteuer", "hundesteuer",
  "abfall", "entsorgung", "recycling",
  "gemeinde", "buerger", "bürger",
  "schalter", "dienstleistung",
  "anmeldung", "ummeldung", "abmeldung",
  "pass", "ausweis", "dokument",
  "schule", "bildung",
  "sozial", "gesundheit",
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
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WebsiteBot/1.0)" },
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

      links.push({
        label: text,
        url: fullUrl,
        score: scoreLinkByPriority(text, fullUrl),
      });
    });

    links.sort((a, b) => b.score - a.score);
    return links.slice(0, 80).map(l => `${l.label}: ${l.url}`);
  } catch {
    return [];
  }
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

  try {
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

    res.json({
      url,
      text: allText + verifiedLinksText,
      links: sitemap,
      siteUrl: parsedUrl.origin,
    });

  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Could not reach URL: ${message}` });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
