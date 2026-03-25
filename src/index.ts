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

  const websiteUrl = siteUrl || "";

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
- If you can partially answer, do so — then stop. Never add a second paragraph saying the information is not available if you already answered
- Only if you cannot answer at all, respond with exactly: "Dazu habe ich leider keine Information. Für weitere Auskünfte besuchen Sie bitte: ${websiteUrl}"
- Never explain what you know or don't know

FORMAT RULES:
- No bullet points unless listing 3 or more items that truly require them
- No bold text, no headers, no markdown formatting
- No filler phrases like "Gerne", "Natürlich", "Selbstverständlich", "Sicher"
- Numbers and times exactly as they appear on the website

LINKS:
- Only include a link if the EXACT complete URL appears in the provided context
- Never construct, guess, or modify URLs
- If a relevant exact URL exists in the context, add it on a new line at the end: Mehr Informationen: https://...
- If no exact matching URL exists, do not include any link`,

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

// Helper: scrape a single page and return text + links
async function scrapePage(url: string, origin: string, seenHrefs: Set<string>): Promise<{ text: string; links: string[] }> {
  try {
    const fetchRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WebsiteBot/1.0)" },
      signal: AbortSignal.timeout(8000),
    });
    if (!fetchRes.ok) return { text: "", links: [] };

    const html = await fetchRes.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, iframe, head, nav, footer").remove();

    const links: string[] = [];
    $("a").each((_: number, el: any) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (!href || !text || text.length < 3) return;

      let fullUrl = "";
      if (href.startsWith("http://") || href.startsWith("https://")) {
        try {
          const linkUrl = new URL(href);
          if (linkUrl.hostname === new URL(origin).hostname) fullUrl = href;
        } catch { return; }
      } else if (href.startsWith("/") && !href.startsWith("//")) {
        fullUrl = `${origin}${href}`;
      } else return;

      const cleanHref = fullUrl.split("?")[0].split("#")[0];
      if (seenHrefs.has(cleanHref)) return;
      seenHrefs.add(cleanHref);
      links.push(`${text}: ${fullUrl}`);
    });

    const rawText = $("body").text().replace(/\s+/g, " ").trim().slice(0, 5000);
    return { text: rawText, links };
  } catch {
    return { text: "", links: [] };
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
    const seenHrefs = new Set<string>();
    seenHrefs.add(url.split("?")[0].split("#")[0]);

    // Scrape main page first
    const mainPage = await scrapePage(url, parsedUrl.origin, seenHrefs);

    // Find top subpages to scrape (max 5)
    const subpageUrls = mainPage.links
      .map(l => l.split(": ")[1])
      .filter(u => u && u.startsWith(parsedUrl.origin))
      .slice(0, 5);

    // Scrape subpages in parallel
    const subpageResults = await Promise.all(
      subpageUrls.map(u => scrapePage(u, parsedUrl.origin, seenHrefs))
    );

    // Combine all text (main + subpages)
    const allText = [mainPage.text, ...subpageResults.map(r => r.text)]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 20000);

    // Combine all links
    const allLinks = [
      ...mainPage.links,
      ...subpageResults.flatMap(r => r.links),
    ].slice(0, 60);

    const linksText = allLinks.length > 0
      ? "\n\nVerfügbare Seiten (nur diese exakten URLs dürfen verwendet werden):\n" + allLinks.join("\n")
      : "";

    res.json({
      url,
      text: allText + linksText,
      links: allLinks,
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
