import fs from "fs";
import path from "path";
import crypto from "crypto";

// ===== CONFIGURATION =====
const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const MEMORY_DIR = "/tmp/memory";
const RATE_LIMIT_DIR = "/tmp/ratelimits";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Initialize directories
[ MEMORY_DIR, RATE_LIMIT_DIR ].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ===== RATE LIMIT CONFIG =====
const RATE_LIMITS = {
  FREE: {
    requestsPerMinute: 30,
    requestsPerHour: 200,
    burstWindowMs: 10000,
    burstMax: 5,
    dailyTokens: 100000
  }
};

// ===== RATE LIMITER =====
class RateLimiter {
  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 600000); // Clean every 10 minutes
  }

  async checkLimit(userId, ip, tokens = 0) {
    const now = Date.now();
    const limits = {
      allowed: true,
      violations: [],
      retryAfter: 0,
      resetAt: now + 60000
    };

    // Check per-minute limit
    const minuteKey = `minute_${userId}_${ip}`;
    const minuteLimit = await this.getLimit(minuteKey, 60000);
    if (minuteLimit.count >= RATE_LIMITS.FREE.requestsPerMinute) {
      limits.allowed = false;
      limits.violations.push(`Minute limit (${RATE_LIMITS.FREE.requestsPerMinute}/min)`);
      limits.retryAfter = Math.max(limits.retryAfter, Math.ceil((minuteLimit.resetAt - now) / 1000));
    }

    // Check per-hour limit
    const hourKey = `hour_${userId}_${ip}`;
    const hourLimit = await this.getLimit(hourKey, 3600000);
    if (hourLimit.count >= RATE_LIMITS.FREE.requestsPerHour) {
      limits.allowed = false;
      limits.violations.push(`Hour limit (${RATE_LIMITS.FREE.requestsPerHour}/hour)`);
      limits.retryAfter = Math.max(limits.retryAfter, Math.ceil((hourLimit.resetAt - now) / 1000));
    }

    // Check burst limit
    const burstKey = `burst_${userId}_${ip}`;
    const burstLimit = await this.getLimit(burstKey, RATE_LIMITS.FREE.burstWindowMs);
    if (burstLimit.count >= RATE_LIMITS.FREE.burstMax) {
      limits.allowed = false;
      limits.violations.push(`Burst limit (${RATE_LIMITS.FREE.burstMax}/10s)`);
      limits.retryAfter = Math.max(limits.retryAfter, Math.ceil((burstLimit.resetAt - now) / 1000));
    }

    // Check daily token limit
    const tokenKey = `tokens_${userId}`;
    const tokenUsage = await this.getDailyTokens(tokenKey);
    if (tokenUsage + tokens > RATE_LIMITS.FREE.dailyTokens) {
      limits.allowed = false;
      limits.violations.push(`Daily token limit (${RATE_LIMITS.FREE.dailyTokens})`);
      limits.retryAfter = 86400; // 24 hours
    }

    // IP-based global limit
    const ipKey = `ip_${ip}`;
    const ipLimit = await this.getLimit(ipKey, 3600000);
    if (ipLimit.count > 1000) {
      limits.allowed = false;
      limits.violations.push("IP limit exceeded");
      limits.retryAfter = Math.max(limits.retryAfter, Math.ceil((ipLimit.resetAt - now) / 1000));
    }

    // Update counts if allowed
    if (limits.allowed) {
      await this.updateLimit(minuteKey, 60000);
      await this.updateLimit(hourKey, 3600000);
      await this.updateLimit(burstKey, RATE_LIMITS.FREE.burstWindowMs);
      await this.updateDailyTokens(tokenKey, tokens);
      await this.updateLimit(ipKey, 3600000);
    }

    return limits;
  }

  async getLimit(key, windowMs) {
    const filePath = path.join(RATE_LIMIT_DIR, `${key}.json`);
    const now = Date.now();
    
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (now > data.resetAt) {
          return { count: 0, resetAt: now + windowMs, firstRequest: now };
        }
        return data;
      }
    } catch (err) {
      // File corrupted, ignore
    }
    
    return { count: 0, resetAt: now + windowMs, firstRequest: now };
  }

  async updateLimit(key, windowMs) {
    const filePath = path.join(RATE_LIMIT_DIR, `${key}.json`);
    const now = Date.now();
    
    let data = await this.getLimit(key, windowMs);
    data.count++;
    
    if (now > data.resetAt) {
      data.count = 1;
      data.resetAt = now + windowMs;
      data.firstRequest = now;
    }
    
    try {
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    } catch (err) {
      console.warn(`Failed to update limit ${key}:`, err);
    }
  }

  async getDailyTokens(key) {
    const filePath = path.join(RATE_LIMIT_DIR, `${key}.json`);
    const now = Date.now();
    
    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        // Reset at midnight UTC
        const midnight = new Date();
        midnight.setUTCHours(24, 0, 0, 0);
        const midnightTime = midnight.getTime();
        
        if (now > midnightTime) {
          return 0;
        }
        return data.total || 0;
      }
    } catch (err) {
      // File corrupted
    }
    
    return 0;
  }

  async updateDailyTokens(key, tokens) {
    const filePath = path.join(RATE_LIMIT_DIR, `${key}.json`);
    const now = Date.now();
    
    let data;
    try {
      if (fs.existsSync(filePath)) {
        data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } else {
        data = { total: 0 };
      }
      
      const midnight = new Date();
      midnight.setUTCHours(24, 0, 0, 0);
      const midnightTime = midnight.getTime();
      
      if (now > midnightTime) {
        data.total = tokens;
      } else {
        data.total = (data.total || 0) + tokens;
      }
      
      fs.writeFileSync(filePath, JSON.stringify(data), 'utf-8');
    } catch (err) {
      console.warn(`Failed to update token usage:`, err);
    }
  }

  cleanup() {
    try {
      const files = fs.readdirSync(RATE_LIMIT_DIR);
      const hourAgo = Date.now() - 3600000;
      
      files.forEach(file => {
        const filePath = path.join(RATE_LIMIT_DIR, file);
        try {
          const stats = fs.statSync(filePath);
          if (stats.mtimeMs < hourAgo) {
            fs.unlinkSync(filePath);
          }
        } catch (err) {
          // File may have been deleted
        }
      });
    } catch (err) {
      console.warn("Rate limit cleanup error:", err);
    }
  }
}

const rateLimiter = new RateLimiter();

// ===== SPAM DETECTOR =====
class SpamDetector {
  constructor() {
    this.suspiciousPatterns = [
      /(buy|sell|cheap|discount|offer|deal)\s+(followers|likes|views|subscribers)/i,
      /(http|https|ftp):\/\/[^\s]+/g,
      /[0-9]{16,}/,
      /(\S)\1{15,}/,
      /(.{20,})\1{3,}/
    ];
    
    this.suspiciousKeywords = [
      'casino', 'gambling', 'porn', 'xxx', 'viagra', 'cialis',
      'crypto', 'bitcoin', 'investment', 'earn money', 'work from home',
      'click here', 'bit.ly', 'tinyurl', 'shorturl', 'adf.ly',
      'prescription', 'drugs', 'medication', 'lottery', 'betting'
    ];
    
    this.gibberishThreshold = 4.5;
  }

  analyze(prompt) {
    const result = {
      isSpam: false,
      score: 0,
      flags: [],
      reason: ""
    };

    // Check length
    if (prompt.length < 2) {
      result.score += 20;
      result.flags.push("too_short");
    }

    if (prompt.length > 2000) {
      result.score += 15;
      result.flags.push("too_long");
    }

    // Check patterns
    this.suspiciousPatterns.forEach((pattern, index) => {
      if (pattern.test(prompt)) {
        result.score += 25;
        result.flags.push(`pattern_${index}`);
      }
    });

    // Check keywords
    const lowerPrompt = prompt.toLowerCase();
    this.suspiciousKeywords.forEach(keyword => {
      if (lowerPrompt.includes(keyword)) {
        result.score += 20;
        result.flags.push(`keyword_${keyword}`);
      }
    });

    // Check for gibberish (high entropy)
    const entropy = this.calculateEntropy(prompt);
    if (entropy > this.gibberishThreshold) {
      result.score += 30;
      result.flags.push("high_entropy");
    }

    // Check for excessive repetition
    const repeatedChars = (prompt.match(/(.)\1{10,}/g) || []).length;
    if (repeatedChars > 0) {
      result.score += repeatedChars * 10;
      result.flags.push(`repetition_${repeatedChars}`);
    }

    result.isSpam = result.score > 40;
    result.reason = result.flags.join(", ");
    
    return result;
  }

  calculateEntropy(text) {
    if (text.length < 10) return 0;
    
    const freq = {};
    for (const char of text) {
      freq[char] = (freq[char] || 0) + 1;
    }
    
    let entropy = 0;
    const length = text.length;
    for (const char in freq) {
      const p = freq[char] / length;
      entropy -= p * Math.log2(p);
    }
    
    return entropy;
  }
}

const spamDetector = new SpamDetector();

// ===== MEMORY FUNCTIONS =====
function loadMemory(userId) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      // Ensure conversation array exists
      if (!Array.isArray(data.conversation)) {
        data.conversation = [];
      }
      return data;
    }
  } catch (err) {
    console.error(`Failed to load memory for ${userId}:`, err);
  }

  // Default memory structure
  return {
    userId,
    lastProject: null,
    lastTask: null,
    conversation: [
      {
        role: "system",
        content: `You are **MaxMovies AI** — an expressive, helpful, brilliant film-focused digital assistant 🤖🎬.

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
• Never say "I'm an AI" — you are MaxMovies AI, Max's digital creation.
• ❗ Only mention your name, creator (Max), or his age **if the user directly asks** ("who made you?", "what's your name?").
• Be lively and expressive, but not over the top.

💻 TECH STYLE:
• Format code using markdown (\`\`\`js\`\`\` etc.).
• Explain code and tech clearly and enthusiastically.
• Still fully capable of giving deep, complete code when asked.
• Adapt to the user's tone.

🗣️ LANGUAGE BEHAVIOR:
• Detect and mirror the user's language.
• English → English.
• Swahili/Sheng → reply the same way.
• Mixed → blend naturally.

🎬 ENTERTAINMENT INTELLIGENCE:
• Provide film/series recommendations, summaries, analysis, comparisons, lore, viewing order guides, watchlists, and streaming suggestions.
• Explain genres, tropes, acting, cinematography, scoring, directing styles, or franchise histories.
• Always stay spoiler-safe unless the user asks for spoilers.`
      }
    ]
  };
}

function saveMemory(userId, memory) {
  const filePath = path.join(MEMORY_DIR, `memory_${userId}.json`);
  
  try {
    // Trim conversation if too long (keep last 20 messages + system prompt)
    if (memory.conversation.length > 25) {
      const systemMsg = memory.conversation.find(m => m.role === "system");
      const recentMsgs = memory.conversation.slice(-24);
      memory.conversation = systemMsg ? [systemMsg, ...recentMsgs] : recentMsgs;
    }
    
    fs.writeFileSync(filePath, JSON.stringify(memory, null, 2), "utf-8");
  } catch (err) {
    console.error(`Failed to save memory for ${userId}:`, err);
  }
}

// ===== LANGUAGE DETECTION =====
function detectLanguage(text) {
  if (!text || text.length < 3) return "english";
  
  const lower = text.toLowerCase();
  
  // Swahili words and phrases
  const swahiliMarkers = [
    "habari", "jambo", "asante", "karibu", "pole", "sawa", 
    "ndio", "hapana", "tafadhali", "samahani", "niko", "nina",
    "nakupenda", "nimefika", "nataka", "napenda", "ninakuja"
  ];
  
  // Sheng words (Nairobi slang)
  const shengMarkers = [
    "mambo", "poa", "safi", "noma", "fiti", "buda", 
    "msee", "gang", "vibe", "chill", "dope", "fresh",
    "manze", "maze", "kwani", "ata", "ama"
  ];
  
  let swCount = 0;
  let shCount = 0;
  
  swahiliMarkers.forEach(word => {
    if (lower.includes(word)) swCount++;
  });
  
  shengMarkers.forEach(word => {
    if (lower.includes(word)) shCount++;
  });
  
  // Check for English patterns
  const englishPatterns = /\b(the|and|you|are|for|this|that|with|have|from|what|where|when|why|how)\b/i;
  const hasEnglish = englishPatterns.test(text);
  
  // Determine language
  if (swCount === 0 && shCount === 0) return "english";
  if ((swCount > 2 || shCount > 2) && !hasEnglish) return "swahili";
  if ((swCount > 0 || shCount > 0) && hasEnglish) return "mixed";
  
  return "english";
}

// ===== HELPER FUNCTIONS =====
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 
         req.headers['x-real-ip'] || 
         req.socket?.remoteAddress || 
         'unknown';
}

function sanitizeInput(text) {
  if (typeof text !== 'string') return '';
  
  return text
    .replace(/[<>]/g, '') // Remove HTML tags
    .substring(0, 2000)   // Limit length
    .trim();
}

function validateRequest(body) {
  const errors = [];
  
  if (!body.prompt) errors.push("Missing 'prompt'");
  if (!body.userId) errors.push("Missing 'userId'");
  
  if (body.prompt && body.prompt.length > 2000) {
    errors.push("Prompt too long (max 2000 characters)");
  }
  
  if (body.userId && !/^[a-zA-Z0-9_-]{3,50}$/.test(body.userId)) {
    errors.push("Invalid userId format (3-50 chars, alphanumeric, dash, underscore)");
  }
  
  return errors;
}

function verifyAdminToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  
  const token = authHeader.substring(7);
  
  if (!ADMIN_TOKEN) {
    console.error("ADMIN_TOKEN environment variable not set");
    return false;
  }
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token, 'utf8'),
      Buffer.from(ADMIN_TOKEN, 'utf8')
    );
  } catch (err) {
    return false;
  }
}

// ===== ADMIN FUNCTIONS =====
function adminGetStats() {
  try {
    const memoryFiles = fs.existsSync(MEMORY_DIR) 
      ? fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.json'))
      : [];
    
    const rateLimitFiles = fs.existsSync(RATE_LIMIT_DIR)
      ? fs.readdirSync(RATE_LIMIT_DIR)
      : [];
    
    // Calculate memory size
    let totalMemorySize = 0;
    memoryFiles.forEach(file => {
      try {
        totalMemorySize += fs.statSync(path.join(MEMORY_DIR, file)).size;
      } catch (err) {
        // File might have been deleted
      }
    });
    
    return {
      memory: {
        count: memoryFiles.length,
        size: totalMemorySize,
        sizeMB: Math.round(totalMemorySize / 1024 / 1024 * 100) / 100
      },
      rateLimits: {
        count: rateLimitFiles.length
      },
      system: {
        uptime: process.uptime(),
        nodeVersion: process.version,
        memoryUsage: {
          heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
          rss: Math.round(process.memoryUsage().rss / 1024 / 1024)
        },
        timestamp: new Date().toISOString()
      },
      limits: RATE_LIMITS.FREE
    };
  } catch (err) {
    console.error("Error getting admin stats:", err);
    return { error: err.message };
  }
}

function adminGetUsers(limit = 50) {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      return [];
    }
    
    const files = fs.readdirSync(MEMORY_DIR)
      .filter(f => f.startsWith('memory_') && f.endsWith('.json'))
      .slice(0, limit);
    
    return files.map(file => {
      try {
        const userId = file.replace('memory_', '').replace('.json', '');
        const filePath = path.join(MEMORY_DIR, file);
        const stats = fs.statSync(filePath);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        
        return {
          userId,
          lastActive: stats.mtime,
          lastModified: stats.mtime,
          conversationLength: data.conversation?.length || 0,
          lastProject: data.lastProject || null,
          lastTask: data.lastTask || null,
          fileSize: stats.size
        };
      } catch (err) {
        return {
          userId: file.replace('memory_', '').replace('.json', ''),
          error: "Failed to load"
        };
      }
    });
  } catch (err) {
    console.error("Error getting users:", err);
    return [];
  }
}

function adminGetUser(userId) {
  try {
    const memoryFile = path.join(MEMORY_DIR, `memory_${userId}.json`);
    
    if (!fs.existsSync(memoryFile)) {
      return { error: "User not found" };
    }
    
    const memory = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
    const stats = fs.statSync(memoryFile);
    
    // Get recent messages (user only, for privacy)
    const recentUserMessages = memory.conversation
      ?.filter(m => m.role === 'user')
      .slice(-10)
      .map(m => ({
        content: m.content.substring(0, 100) + (m.content.length > 100 ? '...' : ''),
        length: m.content.length
      }));
    
    return {
      userId,
      memory: {
        lastProject: memory.lastProject,
        lastTask: memory.lastTask,
        conversationLength: memory.conversation?.length || 0,
        recentUserMessages,
        systemMessage: memory.conversation?.[0]?.role === 'system' ? 'Present' : 'Missing'
      },
      fileInfo: {
        size: stats.size,
        created: stats.birthtime,
        modified: stats.mtime
      }
    };
  } catch (err) {
    console.error("Error getting user:", err);
    return { error: err.message };
  }
}

function adminDeleteUser(userId) {
  try {
    const memoryFile = path.join(MEMORY_DIR, `memory_${userId}.json`);
    let deletedFiles = 0;
    
    if (fs.existsSync(memoryFile)) {
      fs.unlinkSync(memoryFile);
      deletedFiles++;
    }
    
    // Delete rate limit files for this user
    if (fs.existsSync(RATE_LIMIT_DIR)) {
      const rateLimitFiles = fs.readdirSync(RATE_LIMIT_DIR)
        .filter(f => f.includes(userId));
      
      rateLimitFiles.forEach(file => {
        fs.unlinkSync(path.join(RATE_LIMIT_DIR, file));
        deletedFiles++;
      });
    }
    
    return {
      success: true,
      message: `Deleted ${deletedFiles} files for user: ${userId}`,
      deletedFiles
    };
  } catch (err) {
    return { error: err.message };
  }
}

// ===== MAIN HANDLER =====
export async function GET(req) {
  const url = new URL(req.url);
  const searchParams = url.searchParams;
  const action = searchParams.get('action');
  
  // Health check (no auth required)
  if (action === 'health') {
    return Response.json({
      status: 'ok',
      service: 'MaxMovies AI',
      timestamp: new Date().toISOString(),
      version: '1.0.0'
    });
  }
  
  // Admin endpoints require authentication
  const authHeader = req.headers.get('authorization');
  const isAdmin = verifyAdminToken(authHeader);
  
  if (!isAdmin && action !== 'health') {
    return Response.json(
      { error: "Unauthorized", message: "Invalid or missing admin token" },
      { status: 401 }
    );
  }
  
  // Admin endpoints
  switch (action) {
    case 'stats':
      const stats = adminGetStats();
      return Response.json(stats);
      
    case 'users':
      const limit = parseInt(searchParams.get('limit') || '50');
      const users = adminGetUsers(limit);
      return Response.json({ users });
      
    case 'user':
      const userId = searchParams.get('userId');
      if (!userId) {
        return Response.json(
          { error: "Missing userId parameter" },
          { status: 400 }
        );
      }
      const user = adminGetUser(userId);
      return Response.json(user);
      
    default:
      return Response.json({
        endpoints: {
          public: [
            { method: 'POST', path: '/api/maxmovies', description: 'Main AI endpoint' },
            { method: 'GET', path: '/api/maxmovies?action=health', description: 'Health check' }
          ],
          admin: [
            { method: 'GET', path: '/api/maxmovies?action=stats', description: 'System statistics' },
            { method: 'GET', path: '/api/maxmovies?action=users&limit=50', description: 'List users' },
            { method: 'GET', path: '/api/maxmovies?action=user&userId=ID', description: 'Get user details' },
            { method: 'DELETE', path: '/api/maxmovies?action=delete&userId=ID', description: 'Delete user memory' }
          ]
        }
      });
  }
}

export async function DELETE(req) {
  const url = new URL(req.url);
  const searchParams = url.searchParams;
  const action = searchParams.get('action');
  const userId = searchParams.get('userId');
  
  // Verify admin token
  const authHeader = req.headers.get('authorization');
  const isAdmin = verifyAdminToken(authHeader);
  
  if (!isAdmin) {
    return Response.json(
      { error: "Unauthorized", message: "Invalid or missing admin token" },
      { status: 401 }
    );
  }
  
  if (action === 'delete') {
    if (!userId) {
      return Response.json(
        { error: "Missing userId parameter" },
        { status: 400 }
      );
    }
    
    const result = adminDeleteUser(userId);
    return Response.json(result);
  }
  
  return Response.json(
    { error: "Invalid action" },
    { status: 400 }
  );
}

export async function POST(req) {
  const startTime = Date.now();
  
  // Set CORS headers
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'X-Powered-By': 'MaxMovies AI'
  };
  
  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers });
  }
  
  try {
    const body = await req.json();
    
    // Validate request
    const validationErrors = validateRequest(body);
    if (validationErrors.length > 0) {
      return Response.json(
        { error: "Validation failed", details: validationErrors },
        { status: 400, headers }
      );
    }
    
    const { prompt, userId, project } = body;
    const sanitizedPrompt = sanitizeInput(prompt);
    const clientIp = getClientIp(req);
    
    // ===== SPAM DETECTION =====
    const spamAnalysis = spamDetector.analyze(sanitizedPrompt);
    if (spamAnalysis.isSpam) {
      console.warn(`🚨 SPAM DETECTED: ${userId} (${clientIp})`, {
        score: spamAnalysis.score,
        flags: spamAnalysis.flags,
        prompt: sanitizedPrompt.substring(0, 100)
      });
      
      return Response.json(
        {
          error: "Request flagged as suspicious",
          code: "SPAM_DETECTED",
          retryAfter: 60
        },
        {
          status: 429,
          headers: {
            ...headers,
            'Retry-After': '60'
          }
        }
      );
    }
    
    // ===== RATE LIMITING =====
    const estimatedTokens = Math.ceil(sanitizedPrompt.length / 4);
    const rateLimit = await rateLimiter.checkLimit(userId, clientIp, estimatedTokens);
    
    if (!rateLimit.allowed) {
      const resetTime = new Date(rateLimit.resetAt).toISOString();
      
      return Response.json(
        {
          error: "Rate limit exceeded",
          code: "RATE_LIMITED",
          violations: rateLimit.violations,
          retryAfter: rateLimit.retryAfter,
          resetAt: resetTime
        },
        {
          status: 429,
          headers: {
            ...headers,
            'X-RateLimit-Limit': RATE_LIMITS.FREE.requestsPerMinute.toString(),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': Math.floor(rateLimit.resetAt / 1000).toString(),
            'Retry-After': rateLimit.retryAfter.toString()
          }
        }
      );
    }
    
    // ===== PROCESS REQUEST =====
    
    // Load memory
    let memory = loadMemory(userId);
    if (project) memory.lastProject = project;
    memory.lastTask = sanitizedPrompt;
    memory.conversation.push({ role: "user", content: sanitizedPrompt });
    
    // Detect language
    const lang = detectLanguage(sanitizedPrompt);
    let languageInstruction = "";
    
    switch (lang) {
      case "swahili":
        languageInstruction = "Respond fully in Swahili or Sheng naturally depending on tone.";
        break;
      case "mixed":
        languageInstruction = "Respond bilingually — mostly English, with natural Swahili/Sheng flavor.";
        break;
      default:
        languageInstruction = "Respond in English, friendly Kenyan developer tone.";
    }
    
    // Build conversation context
    const conversationText = memory.conversation
      .map(msg => `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`)
      .join('\n\n');
    
    const promptText = `${conversationText}\n\n${languageInstruction}\nCurrent date: ${new Date().toISOString().split('T')[0]}`;
    
    // Call Gemini API
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY environment variable not set");
    }
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    
    try {
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
              topP: 0.95,
              topK: 40
            },
            safetySettings: [
              {
                category: "HARM_CATEGORY_HARASSMENT",
                threshold: "BLOCK_MEDIUM_AND_ABOVE"
              },
              {
                category: "HARM_CATEGORY_SPAM",
                threshold: "BLOCK_MEDIUM_AND_ABOVE"
              }
            ]
          }),
          signal: controller.signal
        }
      );
      
      clearTimeout(timeout);
      
      if (!geminiResponse.ok) {
        const errorText = await geminiResponse.text();
        console.error("Gemini API error:", errorText);
        
        // Refund tokens on API error
        await rateLimiter.updateDailyTokens(`tokens_${userId}`, -estimatedTokens);
        
        return Response.json(
          { error: "AI service temporarily unavailable", code: "AI_SERVICE_ERROR" },
          { status: 502, headers }
        );
      }
      
      const result = await geminiResponse.json();
      const fullResponse = result?.candidates?.[0]?.content?.parts?.[0]?.text || 
                          "I apologize, but I couldn't generate a response. Please try again.";
      
      // Clean response
      const cleanResponse = fullResponse
        .replace(/as an ai|language model|i am ai|i'm an ai/gi, "")
        .trim();
      
      // Update memory
      memory.conversation.push({ role: "assistant", content: cleanResponse });
      saveMemory(userId, memory);
      
      const responseTime = Date.now() - startTime;
      
      // Return successful response
      return Response.json(
        {
          reply: cleanResponse,
          meta: {
            tokens: estimatedTokens,
            language: lang,
            responseTime: `${responseTime}ms`,
            conversationId: userId
          }
        },
        {
          status: 200,
          headers: {
            ...headers,
            'X-Response-Time': `${responseTime}ms`,
            'X-RateLimit-Limit': RATE_LIMITS.FREE.requestsPerMinute.toString(),
            'X-RateLimit-Remaining': 'variable',
            'X-Processing-Time': `${responseTime}`
          }
        }
      );
      
    } catch (fetchError) {
      clearTimeout(timeout);
      
      if (fetchError.name === 'AbortError') {
        return Response.json(
          { error: "Request timeout", code: "TIMEOUT", suggestion: "Please try again with a shorter prompt" },
          { status: 504, headers }
        );
      }
      
      throw fetchError;
    }
    
  } catch (err) {
    console.error("💥 MaxMovies API error:", err);
    
    const errorId = crypto.randomBytes(8).toString('hex');
    console.error(`Error ID: ${errorId}`);
    
    return Response.json(
      {
        error: "Internal server error",
        code: "INTERNAL_ERROR",
        errorId: errorId,
        timestamp: new Date().toISOString()
      },
      {
        status: 500,
        headers
      }
    );
  }
}

// Default export for Next.js App Router
export default async function handler(req) {
  switch (req.method) {
    case 'GET':
      return GET(req);
    case 'POST':
      return POST(req);
    case 'DELETE':
      return DELETE(req);
    case 'OPTIONS':
      return new Response(null, { status: 200 });
    default:
      return Response.json(
        { error: "Method not allowed" },
        { status: 405 }
      );
  }
}
