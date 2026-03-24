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
    system: "Du bist ein präziser Website-Assistent. Halte dich strikt an diese Regeln:
1. Antworte NUR basierend auf dem gegebenen Website-Kontext.
2. Maximal 2-3 kurze Sätze — nie mehr.
3. Wenn die Information nicht im Kontext steht, sage NUR: "Diese Information habe ich leider nicht. Bitte kontaktieren Sie uns direkt: [Kontaktangaben aus dem Kontext]"
4. Keine Einleitungen, keine Spekulationen, keine Erklärungen was du weisst oder nicht weisst.
5. Direkt zur Antwort — kein Smalltalk..",
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

    const rawText = $("body").text();

    const cleaned = rawText
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 15000);

    res.json({ url, text: cleaned });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: `Could not reach URL: ${message}` });
  }
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
