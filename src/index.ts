import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import * as cheerio from "cheerio";

const app = express();
app.use(cors());
app.use(express.json());

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get("/api", (_req, res) => {
  res.send("<h1>Chatbot Backend läuft ✓</h1>");
});

app.post("/api/chat", async (req, res) => {
  const { message, context, siteUrl } = req.body;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "Field 'message' is required and must be a string." });
    return;
  }
  if (!context || typeof context !== "string") {
    res.status(400).json({ error: "Field 'context' is required and must be a string." });
    return;
  }

  const response = await client.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 1024,
    system: `You are a helpful and precise website assistant. Your sole purpose is to answer visitor questions based exclusively on the provided website content.

LANGUAGE: Always respond in German regardless of the question language.

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
- Only if you cannot answer at all, respond with exactly: "Dazu habe ich leider keine Information. Bitte nutzen Sie die Kontaktangaben auf dieser Website."
- Never explain what you know or don't know

FORMAT RULES:
- No bullet points unless listing 3 or more items that truly require them
- No bold text, no headers, no markdown formatting
- No filler phrases like "Gerne", "Natürlich", "Selbstverständlich", "Sicher"
- Numbers and times exactly as they appear on the website

LINKS:
- Only include a link if it appears EXACTLY in the VERIFIED LINKS section of the context
- Never construct, modify, or guess any URL — not even small changes
- If a relevant verified link exists, add it on a new line: Mehr Informationen: https://...
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
    $("script, style, noscript, iframe, head, nav, footer").remove();
    return $("body").text().replace(/\s+/g, " ").trim().slice(0, 4000);
  } catch {
    return "";
  }
}

// Schlüsselwörter für wichtige Seiten — werden bevorzugt gescrapt
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
  // Kürzere URLs bevorzugen (Hauptseiten statt Unterunterseiten)
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

    // Nach Priorität sortieren
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

    // Top 10 Unterseiten nach Priorität scrapen (statt 4 zufällige)
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
