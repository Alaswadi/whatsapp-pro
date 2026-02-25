const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
    user: process.env.DB_USER || 'postgres',
    host: process.env.DB_HOST || 'localhost',
    database: process.env.DB_NAME || 'mosaaedak',
    password: process.env.DB_PASS || 'postgres',
    port: process.env.DB_PORT || 5432,
});

async function getDb() {
    return pool;
}

async function initTables() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                api_key TEXT DEFAULT '',
                system_prompt TEXT DEFAULT '',
                model_name TEXT DEFAULT 'openai/gpt-oss-120b',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            ALTER TABLE settings ADD COLUMN IF NOT EXISTS twilio_account_sid TEXT DEFAULT '';
            ALTER TABLE settings ADD COLUMN IF NOT EXISTS twilio_auth_token TEXT DEFAULT '';
            ALTER TABLE settings ADD COLUMN IF NOT EXISTS twilio_phone_number TEXT DEFAULT '';
            ALTER TABLE settings ADD COLUMN IF NOT EXISTS support_agent_phone TEXT DEFAULT '';

            CREATE TABLE IF NOT EXISTS chat_sessions (
                session_id TEXT PRIMARY KEY,
                messages TEXT DEFAULT '[]',
                last_access TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Seed default admin if no users exist
        const userCountResult = await pool.query('SELECT COUNT(*) as count FROM users');
        if (parseInt(userCountResult.rows[0].count) === 0) {
            const hash = bcrypt.hashSync('admin123', 10);
            await pool.query('INSERT INTO users (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
            console.log('📌 Default admin created: admin / admin123');
        }

        // Seed default settings if not exists
        const settingsCountResult = await pool.query('SELECT COUNT(*) as count FROM settings');
        if (parseInt(settingsCountResult.rows[0].count) === 0) {
            const defaultPrompt = getDefaultSystemPrompt();
            await pool.query('INSERT INTO settings (id, api_key, system_prompt, model_name) VALUES (1, $1, $2, $3)',
                ['', defaultPrompt, 'openai/gpt-oss-120b']);
            console.log('📌 Default settings created');
        }
    } catch (err) {
        console.error('Error initializing tables:', err);
        process.exit(1); // Crash so Docker restarts us
    }
}

// Initialize tables on startup
initTables();

// ─── User Operations ─────────────────────────────────────────
async function findUserByUsername(username) {
    const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return res.rows[0];
}

async function updateUserPassword(userId, newPasswordHash) {
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [newPasswordHash, userId]);
}

// ─── Settings Operations ─────────────────────────────────────
async function getSettings() {
    const res = await pool.query('SELECT * FROM settings WHERE id = 1');
    return res.rows[0] || {};
}

async function updateSettings({ api_key, system_prompt, model_name, twilio_account_sid, twilio_auth_token, twilio_phone_number, support_agent_phone }) {
    const updates = [];
    const values = [];
    let counter = 1;

    if (api_key !== undefined) { updates.push(`api_key = $${counter++}`); values.push(api_key); }
    if (system_prompt !== undefined) { updates.push(`system_prompt = $${counter++}`); values.push(system_prompt); }
    if (model_name !== undefined) { updates.push(`model_name = $${counter++}`); values.push(model_name); }
    if (twilio_account_sid !== undefined) { updates.push(`twilio_account_sid = $${counter++}`); values.push(twilio_account_sid); }
    if (twilio_auth_token !== undefined) { updates.push(`twilio_auth_token = $${counter++}`); values.push(twilio_auth_token); }
    if (twilio_phone_number !== undefined) { updates.push(`twilio_phone_number = $${counter++}`); values.push(twilio_phone_number); }
    if (support_agent_phone !== undefined) { updates.push(`support_agent_phone = $${counter++}`); values.push(support_agent_phone); }

    if (updates.length === 0) return;

    // Add updated_at
    updates.push(`updated_at = CURRENT_TIMESTAMP`);

    const sql = `UPDATE settings SET ${updates.join(', ')} WHERE id = 1`;
    await pool.query(sql, values);
}

// ─── Session Operations ──────────────────────────────────────
async function getSession(sessionId) {
    const res = await pool.query('SELECT * FROM chat_sessions WHERE session_id = $1', [sessionId]);
    const row = res.rows[0];
    if (row) {
        try {
            row.messages = JSON.parse(row.messages);
        } catch (e) {
            row.messages = [];
        }
    }
    return row;
}

async function upsertSession(sessionId, messages) {
    const json = JSON.stringify(messages);
    const query = `
        INSERT INTO chat_sessions (session_id, messages, last_access)
        VALUES ($1, $2, CURRENT_TIMESTAMP)
        ON CONFLICT(session_id) 
        DO UPDATE SET messages = $2, last_access = CURRENT_TIMESTAMP
    `;
    await pool.query(query, [sessionId, json]);
}

async function cleanOldSessions(maxAgeHours = 1) {
    await pool.query(`DELETE FROM chat_sessions WHERE last_access < NOW() - INTERVAL '${maxAgeHours} hours'`);
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
