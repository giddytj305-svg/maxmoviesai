import fs from "fs";
import path from "path";
import crypto from "crypto";

// Admin endpoints for MaxMovies API
const MEMORY_DIR = "/tmp/memory";
const RATE_LIMIT_DIR = "/tmp/ratelimits";

// Verify admin token
function verifyAdminToken(authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }
  
  const token = authHeader.substring(7);
  const adminToken = process.env.ADMIN_TOKEN;
  
  if (!adminToken) {
    console.error("ADMIN_TOKEN environment variable not set");
    return false;
  }
  
  // Constant-time comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(token, 'utf8'),
      Buffer.from(adminToken, 'utf8')
    );
  } catch (err) {
    return false;
  }
}

// Get system stats
function getSystemStats() {
  try {
    const memoryFiles = fs.existsSync(MEMORY_DIR) 
      ? fs.readdirSync(MEMORY_DIR).filter(f => f.endsWith('.json'))
      : [];
    
    const rateLimitFiles = fs.existsSync(RATE_LIMIT_DIR)
      ? fs.readdirSync(RATE_LIMIT_DIR)
      : [];
    
    return {
      memory: {
        count: memoryFiles.length,
        size: memoryFiles.reduce((total, file) => {
          try {
            return total + fs.statSync(path.join(MEMORY_DIR, file)).size;
          } catch {
            return total;
          }
        }, 0)
      },
      rateLimits: {
        count: rateLimitFiles.length
      },
      system: {
        uptime: process.uptime(),
        nodeVersion: process.version,
        memoryUsage: process.memoryUsage(),
        timestamp: new Date().toISOString()
      }
    };
  } catch (err) {
    console.error("Error getting system stats:", err);
    return null;
  }
}

// Get user list
function getUserList(limit = 50) {
  try {
    if (!fs.existsSync(MEMORY_DIR)) {
      return [];
    }
    
    const files = fs.readdirSync(MEMORY_DIR)
      .filter(f => f.startsWith('memory_') && f.endsWith('.json'))
      .slice(0, limit);
    
    const users = files.map(file => {
      try {
        const userId = file.replace('memory_', '').replace('.json', '');
        const filePath = path.join(MEMORY_DIR, file);
        const stats = fs.statSync(filePath);
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        
        return {
          userId,
          lastActive: stats.mtime,
          conversationLength: data.conversation?.length || 0,
          lastProject: data.lastProject || null,
          lastTask: data.lastTask || null
        };
      } catch (err) {
        return {
          userId: file.replace('memory_', '').replace('.json', ''),
          error: "Failed to load"
        };
      }
    });
    
    return users;
  } catch (err) {
    console.error("Error getting user list:", err);
    return [];
  }
}

// Get user details
function getUserDetails(userId) {
  try {
    const memoryFile = path.join(MEMORY_DIR, `memory_${userId}.json`);
    
    if (!fs.existsSync(memoryFile)) {
      return { error: "User not found" };
    }
    
    const memory = JSON.parse(fs.readFileSync(memoryFile, 'utf-8'));
    
    // Get rate limit files for this user
    let rateLimitFiles = [];
    if (fs.existsSync(RATE_LIMIT_DIR)) {
      rateLimitFiles = fs.readdirSync(RATE_LIMIT_DIR)
        .filter(f => f.includes(userId))
        .map(file => {
          try {
            const data = JSON.parse(fs.readFileSync(
              path.join(RATE_LIMIT_DIR, file), 
              'utf-8'
            ));
            return { file, data };
          } catch {
            return { file, error: "Failed to parse" };
          }
        });
    }
    
    return {
      userId,
      memory: {
        lastProject: memory.lastProject,
        lastTask: memory.lastTask,
        conversationLength: memory.conversation?.length || 0,
        firstMessages: memory.conversation
          ?.filter(m => m.role === 'user')
          .slice(0, 5)
          .map(m => m.content.substring(0, 100))
      },
      rateLimits: rateLimitFiles,
      lastModified: fs.statSync(memoryFile).mtime
    };
  } catch (err) {
    console.error("Error getting user details:", err);
    return { error: err.message };
  }
}

// Delete user memory
function deleteUserMemory(userId) {
  try {
    const memoryFile = path.join(MEMORY_DIR, `memory_${userId}.json`);
    
    if (fs.existsSync(memoryFile)) {
      fs.unlinkSync(memoryFile);
    }
    
    // Also delete rate limit files for this user
    if (fs.existsSync(RATE_LIMIT_DIR)) {
      const rateLimitFiles = fs.readdirSync(RATE_LIMIT_DIR)
        .filter(f => f.includes(userId));
      
      rateLimitFiles.forEach(file => {
        fs.unlinkSync(path.join(RATE_LIMIT_DIR, file));
      });
    }
    
    return { success: true, message: `Deleted memory for ${userId}` };
  } catch (err) {
    return { error: err.message };
  }
}

// Clear all memory (use with caution!)
function clearAllMemory() {
  try {
    if (fs.existsSync(MEMORY_DIR)) {
      const files = fs.readdirSync(MEMORY_DIR);
      files.forEach(file => {
        fs.unlinkSync(path.join(MEMORY_DIR, file));
      });
    }
    
    if (fs.existsSync(RATE_LIMIT_DIR)) {
      const files = fs.readdirSync(RATE_LIMIT_DIR);
      files.forEach(file => {
        fs.unlinkSync(path.join(RATE_LIMIT_DIR, file));
      });
    }
    
    return { success: true, message: "Cleared all memory and rate limits" };
  } catch (err) {
    return { error: err.message };
  }
}

// Main handler
export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  // Verify admin token for all routes except health check
  if (req.query.action !== 'health') {
    const isAuthorized = verifyAdminToken(req.headers.authorization);
    if (!isAuthorized) {
      return res.status(401).json({ 
        error: "Unauthorized",
        message: "Invalid or missing admin token"
      });
    }
  }
  
  try {
    const { action, userId, limit } = req.query;
    
    switch (req.method) {
      case 'GET':
        switch (action) {
          case 'health':
            return res.status(200).json({ 
              status: 'ok', 
              service: 'MaxMovies Admin API',
              timestamp: new Date().toISOString()
            });
            
          case 'stats':
            const stats = getSystemStats();
            return res.status(200).json(stats || { error: "Failed to get stats" });
            
          case 'users':
            const userList = getUserList(limit || 100);
            return res.status(200).json({ users: userList });
            
          case 'user':
            if (!userId) {
              return res.status(400).json({ error: "Missing userId parameter" });
            }
            const userDetails = getUserDetails(userId);
            return res.status(200).json(userDetails);
            
          default:
            return res.status(200).json({
              endpoints: [
                { method: 'GET', path: '/api/admin?action=health', description: 'Health check' },
                { method: 'GET', path: '/api/admin?action=stats', description: 'System statistics' },
                { method: 'GET', path: '/api/admin?action=users&limit=50', description: 'List users' },
                { method: 'GET', path: '/api/admin?action=user&userId=USER_ID', description: 'Get user details' },
                { method: 'DELETE', path: '/api/admin?action=delete&userId=USER_ID', description: 'Delete user memory' },
                { method: 'POST', path: '/api/admin?action=clearAll', description: 'Clear all memory (DANGER)' }
              ]
            });
        }
        
      case 'DELETE':
        if (action === 'delete') {
          if (!userId) {
            return res.status(400).json({ error: "Missing userId parameter" });
          }
          const result = deleteUserMemory(userId);
          return res.status(200).json(result);
        }
        break;
        
      case 'POST':
        if (action === 'clearAll') {
          const result = clearAllMemory();
          return res.status(200).json(result);
        }
        break;
    }
    
    return res.status(404).json({ error: "Endpoint not found" });
    
  } catch (err) {
    console.error("Admin API error:", err);
    return res.status(500).json({ 
      error: "Internal server error",
      message: err.message 
    });
  }
}
