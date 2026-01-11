import fs from "fs";
import path from "path";

// ✅ Using Gemini Flash model endpoint (kept intact)
const GEMINI_API_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

// ✅ Memory folder (works on Vercel)
const MEMORY_DIR = "/tmp/memory";
if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR);

// 🧠 Load user memory
function loadMemory(userId) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
  } catch (err) {
    console.error(`❌ Failed to load memory for ${userId}:`, err);
  }

  // Default memory
  return {
    userId,
    lastProject: null,
    lastTask: null,
    conversation: [
      {
        role: "system",
        content: `
You are **MaxMovies AI** — an expressive, helpful, brilliant film-focused digital assistant 🤖🎬.

🔥 BACKSTORY:
• You were created by Max — a 21-year-old full-stack developer from Kenya 🇰🇪 with insane creativity and coding skill.
• You carry his personality and passion for problem-solving.
• Your core specialty is **movies, TV series, streaming content, characters, plots, recommendations, rankings, trivia**, and entertainment insights.
• You can still assist with coding, design, learning, life ideas, and all general creativity — but movies and series are your home turf.

🎞️ MOVIE/TV PERSONALITY:
• You think like a modern movie nerd — analytical, fun, expressive, and up-to-date with current entertainment culture.
• You're aware of the timeline and adapt naturally to current releases, trends, and streaming platforms.
• Give smart, modern recommendations based on genres, moods, actors, or viewing habits.
• Break down plots, analyze characters, explain story arcs, or help users find what to watch.

⚡ GENERAL PERSONALITY:
• Default to **English** — fluent, warm, and confident.
• Use **Swahili or Sheng** only if the user does.
• Sound like a smart, chill Nairobi techie/film fan — natural and friendly 😎.
• Never say “I’m an AI” — you are MaxMovies AI, Max’s digital creation.
• ❗ Only mention your name, creator (Max), or his age **if the user directly asks** (“who made you?”, “what’s your name?”).
• Be lively and expressive, but not over the top.

💻 TECH STYLE:
• Format code using markdown (\`\`\`js\`\`\` etc.).
• Explain code and tech clearly and enthusiastically.
• Still fully capable of giving deep, complete code when asked.
• Adapt to the user’s tone.

🗣️ LANGUAGE BEHAVIOR:
• Detect and mirror the user’s language.
• English → English.
• Swahili/Sheng → reply the same way.
• Mixed → blend naturally.

🎬 ENTERTAINMENT INTELLIGENCE:
• Provide film/series recommendations, summaries, analysis, comparisons, lore, viewing order guides, watchlists, and streaming suggestions.
• Explain genres, tropes, acting, cinematography, scoring, directing styles, or franchise histories.
• Always stay spoiler-safe unless the user asks for spoilers.

`,
      },
    ],
  };
}

// 💾 Save user memory
function saveMemory(userId, memory) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  try {
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
  } catch (err) {
    console.error(`❌ Failed to save memory for ${userId}:`, err);
  }
}

// 🧠 Simple heuristic to classify text language
function detectLanguage(text) {
  const lower = text.toLowerCase();
  const swahiliWords = ["habari", "sasa", "niko", "kwani", "basi", "ndio", "karibu", "asante"];
  const shengWords = ["bro", "maze", "manze", "noma", "fiti", "safi", "buda", "msee", "mwana", "poa"];

  const swCount = swahiliWords.filter((w) => lower.includes(w)).length;
  const shCount = shengWords.filter((w) => lower.includes(w)).length;

  if (swCount + shCount === 0) return "english";
  if (swCount + shCount < 3) return "mixed";
  return "swahili";
}

// 🚀 Main API Handler
export default async function handler(req, res) {
  // --- CORS setup ---
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")
    return res.status(405).json({ error: "Method not allowed" });

  try {
    const { prompt, project, userId } = req.body;
    if (!prompt || !userId)
      return res.status(400).json({ error: "Missing prompt or userId." });

    // 🧠 Load memory
    let memory = loadMemory(userId);
    if (project) memory.lastProject = project;
    memory.lastTask = prompt;
    memory.conversation.push({ role: "user", content: prompt });

    // 🌍 Detect language
    const lang = detectLanguage(prompt);
    let languageInstruction = "";
    if (lang === "swahili") {
      languageInstruction = "Respond fully in Swahili or Sheng naturally depending on tone.";
    } else if (lang === "mixed") {
      languageInstruction = "Respond bilingually — mostly English, with natural Swahili/Sheng flavor.";
    } else {
      languageInstruction = "Respond in English, friendly Kenyan developer tone.";
    }

    // 🧩 Build conversation context
    const promptText = `
${memory.conversation
  .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
  .join("\n")}

System instruction: ${languageInstruction}
`;

    // 🔥 Call Gemini API
    const geminiResponse = await fetch(
      `${GEMINI_API_URL}?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: promptText }] }],
          generationConfig: {
            temperature: 0.9,
            maxOutputTokens: 900,
          },
        }),
      }
    );

    if (!geminiResponse.ok) {
      const errorText = await geminiResponse.text();
      console.error("Gemini error:", errorText);
      return res.status(geminiResponse.status).json({ error: errorText });
    }

    const result = await geminiResponse.json();
    const fullResponse =
      result?.candidates?.[0]?.content?.parts?.[0]?.text ||
      "⚠️ No response received.";

    // 🧹 Clean and save memory
    const cleanText = fullResponse.replace(/as an ai|language model/gi, "");
    memory.conversation.push({ role: "assistant", content: cleanText });
    saveMemory(userId, memory);

    // ✅ Return
    return res.status(200).json({ reply: cleanText });
  } catch (err) {
    console.error("💥 Backend error:", err);
    return res.status(500).json({ error: "Server error." });
  }
}
