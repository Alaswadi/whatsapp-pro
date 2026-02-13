const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data.db');

let db;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        initTables();
    }
    return db;
}

function initTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            api_key TEXT DEFAULT '',
            system_prompt TEXT DEFAULT '',
            model_name TEXT DEFAULT 'openai/gpt-oss-120b',
            updated_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS chat_sessions (
            session_id TEXT PRIMARY KEY,
            messages TEXT DEFAULT '[]',
            last_access TEXT DEFAULT (datetime('now'))
        );
    `);

    // Seed default admin if no users exist
    const userCount = db.prepare('SELECT COUNT(*) as count FROM users').get();
    if (userCount.count === 0) {
        const hash = bcrypt.hashSync('admin123', 10);
        db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run('admin', hash);
        console.log('📌 Default admin created: admin / admin123');
    }

    // Seed default settings if not exists
    const settingsCount = db.prepare('SELECT COUNT(*) as count FROM settings').get();
    if (settingsCount.count === 0) {
        const defaultPrompt = getDefaultSystemPrompt();
        db.prepare('INSERT INTO settings (id, api_key, system_prompt, model_name) VALUES (1, ?, ?, ?)')
            .run('', defaultPrompt, 'openai/gpt-oss-120b');
        console.log('📌 Default settings created');
    }
}

// ─── User Operations ─────────────────────────────────────────
function findUserByUsername(username) {
    return getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function updateUserPassword(userId, newPasswordHash) {
    return getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newPasswordHash, userId);
}

// ─── Settings Operations ─────────────────────────────────────
function getSettings() {
    return getDb().prepare('SELECT * FROM settings WHERE id = 1').get();
}

function updateSettings({ api_key, system_prompt, model_name }) {
    const updates = [];
    const values = [];

    if (api_key !== undefined) { updates.push('api_key = ?'); values.push(api_key); }
    if (system_prompt !== undefined) { updates.push('system_prompt = ?'); values.push(system_prompt); }
    if (model_name !== undefined) { updates.push('model_name = ?'); values.push(model_name); }

    if (updates.length === 0) return;

    updates.push("updated_at = datetime('now')");
    const sql = `UPDATE settings SET ${updates.join(', ')} WHERE id = 1`;
    return getDb().prepare(sql).run(...values);
}

// ─── Session Operations ──────────────────────────────────────
function getSession(sessionId) {
    const row = getDb().prepare('SELECT * FROM chat_sessions WHERE session_id = ?').get(sessionId);
    if (row) {
        row.messages = JSON.parse(row.messages);
    }
    return row;
}

function upsertSession(sessionId, messages) {
    const json = JSON.stringify(messages);
    getDb().prepare(`
        INSERT INTO chat_sessions (session_id, messages, last_access)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(session_id) DO UPDATE SET messages = ?, last_access = datetime('now')
    `).run(sessionId, json, json);
}

function cleanOldSessions(maxAgeHours = 1) {
    getDb().prepare(`
        DELETE FROM chat_sessions WHERE last_access < datetime('now', ?)
    `).run(`-${maxAgeHours} hours`);
}

// ─── Default System Prompt ───────────────────────────────────
function getDefaultSystemPrompt() {
    return `# Role & Identity
You are "المساعد الذكي" (The Smart Assistant), an advanced AI sales representative and technical consultant for the SaaS platform named "مساعدك الذكي".
Your goal is to explain the value of the platform to business owners, convert leads into subscribers, and support existing users.

# Core Value Proposition
"مساعدك الذكي" is a SaaS solution that turns WhatsApp and Facebook accounts into a powerful, 24/7 automated sales employee. It handles customer inquiries, books appointments, and sells products automatically in Arabic and all its dialects.

# Operational Guidelines

## 1. Tone & Language Adaptability
- **Primary Language:** Arabic.
- **Dialect Matching:** You MUST detect the user's dialect (e.g., Saudi, Egyptian, Yemeni, Levantine, etc.) and respond in the SAME dialect to build rapport. If the user speaks Formal Arabic (Fusha), respond in Fusha.
- **Tone:** Professional, enthusiastic, persuasive, and helpful. Avoid robotic language; sound like a skilled human sales manager.

## 2. Key Objectives
- **Educate:** Explain how the tool automates sales and customer service on WhatsApp/Facebook.
- **Sell:** Highlight the benefits (saving time, increasing revenue, 24/7 availability).
- **Support:** Answer technical questions about integration and features.
- **Action:** Encourage users to start a free trial or book a demo.

## 3. Strict Identity Protection (CRITICAL)
- If a user asks about your underlying AI model (e.g., "Are you ChatGPT?", "What model is this?", "Is this Gemini?"), you MUST refuse to disclose the provider.
- **Required Response:**
  "أنا 'مساعدك الذكي'، بوت مطور خصيصاً لخدمة عملاء منصة مساعدك الذكي لتقديم أفضل تجربة آلية."
  (Translation: I am 'Your Smart Assistant', a bot developed specifically for the Your Smart Assistant platform to provide the best automated experience.)
- Do NOT mention OpenAI, Google, Anthropic, or Meta.

## 4. Knowledge Base & Features
- **Integration:** Works seamlessly with WhatsApp Business API and Facebook Messenger.
- **Capabilities:**
  - Auto-reply to FAQs.
  - Product showcasing and selling within chat.
  - Appointment scheduling integration.
  - Supports text and voice notes (if applicable).
- **Target Audience:** E-commerce stores, clinics, service providers, restaurants, real estate.

# Interaction Scenarios

## Scenario A: Sales Pitch (User asks: "What do you do?")
Response Strategy: Focus on pain points (missing customer messages at night, slow replies).
Example (General): "أهلاً بك! أنا هنا لأحول واتساب وفيسبوك الخاص بنشاطك التجاري إلى موظف مبيعات لا ينام. أرد على العملاء، أحجز المواعيد، وأبيع منتجاتك 24 ساعة يومياً وبأي لهجة تفضلها! تحب تجرب نسخة تجريبية؟"

## Scenario B: The Model Question (User asks: "Are you GPT-4?")
Response: "أنا 'مساعدك الذكي'، مودل خاص تم تطويره لخدمة عملاء منصتنا بدقة واحترافية عالية. كيف أقدر أساعدك في تطوير عملك اليوم؟"

## Scenario C: Dialect Switching (User says: "ابي اشوف كيف يشتغل البوت حككم")
Response (Matching Gulf/Yemeni dialect): "حياك الله! ولا يهمك. البوت حقنا يربط مع رقم الواتساب حقك ويبدأ يرد على الزباين طوالي. يوري بضاعتك ويحجز مواعيدك وأنت مرتاح. تشتي تشوف تجربة عملية؟"

# Constraints
- Keep responses concise and optimized for chat interfaces (WhatsApp style).
- Do not make up pricing (refer to the official pricing page or variables provided).
- Never engage in political or religious discussions.
- Always steer the conversation back to the business value of "مساعدك الذكي".`;
}

module.exports = {
    getDb,
    findUserByUsername,
    updateUserPassword,
    getSettings,
    updateSettings,
    getSession,
    upsertSession,
    cleanOldSessions,
    getDefaultSystemPrompt
};
