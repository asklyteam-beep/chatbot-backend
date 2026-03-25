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
  const { message, context } = req.body;

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
    system: "You are a helpful and precise website assistant. Your sole purpose is to answer visitor questions based exclusively on the provided website content. LANGUAGE: Always respond in German regardless of the question language. RESPONSE RULES: Answer immediately and directly — never repeat the question or use introductions like Based on the context or The website states. Keep answers concise: 1-3 sentences maximum. Always use a friendly professional tone. CONTENT RULES: Only use information from the provided website context. Never speculate guess or use external knowledge. If the answer is not in the context respond only with: Diese Information liegt mir leider nicht vor. Bitte wenden Sie sich direkt an die Kontaktangaben auf der Website. Never say what you do or dont know — just answer or refer to contact. FORMAT RULES: No bullet points unless listing 3+ items that truly need them. No bold text no headers no markdown. No filler phrases like Gerne Natürlich Selbstverständlich. Numbers and times exactly as they appear on the website.",
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
    const fetchRes = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WebsiteBot/1.0)" },
    });

    if (!fetchRes.ok) {
      res.status(502).json({ error: `Failed to fetch URL: ${fetchRes.status} ${fetchRes.statusText}` });
      return;
    }

    const html = await fetchRes.text();
    const $ = cheerio.load(html);
    $("script, style, noscript, iframe, head").remove();

    const links: string[] = [];
    $("a").each((_: number, el: any) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href && text && href.startsWith("/") && text.length > 2) {
        links.push(`${text}: ${parsedUrl.origin}${href}`);
      }
    });

    const rawText = $("body").text();
    const cleaned = rawText
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 15000);

    res.json({ url, text: cleaned, links: links.slice(0, 50) });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Could not reach URL: ${message}` });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
