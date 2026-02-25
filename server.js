require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'mosaaedak-secret-key-change-in-production';

// ─── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Global Request Logger
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public'), {
    index: 'index.html',
    extensions: ['html']
}));

// ─── Auth Middleware ─────────────────────────────────────────
function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'غير مصرح - يرجى تسجيل الدخول' });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'جلسة منتهية - يرجى تسجيل الدخول مجدداً' });
    }
}

// ─── Auth Routes ─────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'اسم المستخدم وكلمة المرور مطلوبان' });
        }

        const user = await db.findUserByUsername(username);
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ token, username: user.username });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'كلمة المرور الحالية والجديدة مطلوبتان' });
        }

        const user = await db.findUserByUsername(req.user.username);
        if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
            return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة' });
        }

        const hash = bcrypt.hashSync(newPassword, 10);
        await db.updateUserPassword(user.id, hash);
        res.json({ message: 'تم تغيير كلمة المرور بنجاح' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
    res.json({ username: req.user.username });
});

// ─── Settings Routes (Protected) ────────────────────────────
app.get('/api/settings', authMiddleware, async (req, res) => {
    try {
        const settings = await db.getSettings();
        // Mask API key for display
        const maskedKey = settings.api_key
            ? settings.api_key.substring(0, 8) + '••••••••' + settings.api_key.substring(settings.api_key.length - 4)
            : '';
        res.json({
            api_key_masked: maskedKey,
            has_api_key: !!settings.api_key,
            system_prompt: settings.system_prompt,
            model_name: settings.model_name,
            updated_at: settings.updated_at,
            twilio_account_sid: settings.twilio_account_sid || '',
            twilio_auth_token: settings.twilio_auth_token ? '••••••••' : '',
            has_twilio_auth_token: !!settings.twilio_auth_token,
            twilio_phone_number: settings.twilio_phone_number || '',
            support_agent_phone: settings.support_agent_phone || ''
        });
    } catch (error) {
        console.error('Get settings error:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

app.put('/api/settings', authMiddleware, async (req, res) => {
    try {
        const { api_key, system_prompt, model_name, twilio_account_sid, twilio_auth_token, twilio_phone_number, support_agent_phone } = req.body;
        // Don't overwrite auth token if hidden dots are passed
        const updateData = { api_key, system_prompt, model_name, twilio_account_sid, twilio_phone_number, support_agent_phone };
        if (twilio_auth_token && twilio_auth_token !== '••••••••') {
            updateData.twilio_auth_token = twilio_auth_token;
        }
        await db.updateSettings(updateData);
        res.json({ message: 'تم حفظ الإعدادات بنجاح' });
    } catch (error) {
        console.error('Update settings error:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ─── Stats Route (Protected) ────────────────────────────────
app.get('/api/stats', authMiddleware, async (req, res) => {
    try {
        const dbConn = await db.getDb();
        const sessionCountResult = await dbConn.query('SELECT COUNT(*) as count FROM chat_sessions');
        const sessionCount = sessionCountResult.rows[0].count;
        const settings = await db.getSettings();
        res.json({
            active_sessions: sessionCount,
            model: settings.model_name,
            has_api_key: !!settings.api_key
        });
    } catch (error) {
        console.error('Stats error:', error);
        res.status(500).json({ error: 'خطأ في الخادم' });
    }
});

// ─── Session Memory Store ────────────────────────────────────
const MAX_MESSAGES = 20;

// Clean up expired sessions every 10 minutes
setInterval(async () => {
    await db.cleanOldSessions(1);
}, 10 * 60 * 1000);

// ─── Chat Endpoint ───────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
    try {
        const { chatInput, sessionId } = req.body;

        if (!chatInput || !sessionId) {
            return res.status(400).json({ error: 'chatInput and sessionId are required' });
        }

        // Load settings from DB
        const settings = await db.getSettings();
        if (!settings.api_key) {
            return res.json({ output: 'عذراً، النظام غير مُكوّن بعد. يرجى التواصل مع المسؤول.' });
        }

        // Get or create session from DB
        let session = await db.getSession(sessionId);
        let messages = session ? session.messages : [];

        // Add user message to history
        messages.push({ role: 'user', content: chatInput });

        // Trim to keep only last N messages
        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(-MAX_MESSAGES);
        }

        // Build messages array for OpenRouter
        const apiMessages = [
            { role: 'system', content: settings.system_prompt },
            ...messages
        ];

        // Call OpenRouter API
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.api_key}`,
                'HTTP-Referer': 'https://mosaaedak.com',
                'X-Title': 'Mosaaedak AI'
            },
            body: JSON.stringify({
                model: settings.model_name,
                messages: apiMessages
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error('OpenRouter API Error:', response.status, errorText);
            return res.json({ output: 'عذراً، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' });
        }

        const data = await response.json();
        const botReply = data.choices?.[0]?.message?.content || 'عذراً، لم أتمكن من الرد.';

        // Add assistant reply to history
        messages.push({ role: 'assistant', content: botReply });
        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(-MAX_MESSAGES);
        }

        // Save session to DB
        // Save session to DB
        await db.upsertSession(sessionId, messages);

        res.json({ output: botReply });

    } catch (error) {
        console.error('Chat endpoint error:', error);
        res.status(500).json({ output: 'عذراً، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.' });
    }
});

// ─── Twilio Webhook ─────────────────────────────────────────
app.post('/api/twilio/webhook', async (req, res) => {
    console.log('📩 Incoming Twilio Webhook Request');
    try {
        const twilioData = req.body;
        console.log('📦 Webhook Payload:', JSON.stringify(twilioData, null, 2));

        const from = twilioData.From; // e.g. whatsapp:+123456789
        const to = twilioData.To; // your twilio number
        const body = twilioData.Body;

        if (!from || !body) {
            console.error('❌ Invalid Webhook Payload: Missing From or Body');
            return res.status(400).send('Bad Request');
        }

        const settings = await db.getSettings();
        if (!settings.api_key || !settings.twilio_account_sid || !settings.twilio_auth_token) {
            console.error('❌ Missing required settings for Twilio webhook:', {
                has_api_key: !!settings.api_key,
                has_sid: !!settings.twilio_account_sid,
                has_token: !!settings.twilio_auth_token
            });
            return res.status(500).send('Server Error');
        }

        console.log(`🤖 Processing message from ${from}: "${body}"`);

        let session = await db.getSession(from);
        let messages = session ? session.messages : [];
        messages.push({ role: 'user', content: body });

        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(-MAX_MESSAGES);
        }

        const apiMessages = [
            { role: 'system', content: settings.system_prompt },
            ...messages
        ];

        // Call OpenRouter
        console.log('📡 Calling OpenRouter API...');
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.api_key}`,
                'HTTP-Referer': 'https://mosaaedak.com',
                'X-Title': 'Mosaaedak AI - Twilio Webhook'
            },
            body: JSON.stringify({
                model: settings.model_name,
                messages: apiMessages
            })
        });

        let botReply = 'عذراً، حدث خطأ في النظام. يرجى المحاولة مرة أخرى.';
        if (response.ok) {
            const data = await response.json();
            botReply = data.choices?.[0]?.message?.content || botReply;
            console.log('✨ AI Bot Reply:', botReply);

            messages.push({ role: 'assistant', content: botReply });
            if (messages.length > MAX_MESSAGES) {
                messages = messages.slice(-MAX_MESSAGES);
            }
            await db.upsertSession(from, messages);
        } else {
            const errorText = await response.text();
            console.error('❌ OpenRouter API Error in webhook:', response.status, errorText);
        }

        const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${settings.twilio_account_sid}/Messages.json`;
        const twilioAuth = Buffer.from(`${settings.twilio_account_sid}:${settings.twilio_auth_token}`).toString('base64');
        const twilioHeaders = {
            'Authorization': `Basic ${twilioAuth}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        };

        if (botReply === 'HUMAN_HELP_NEEDED') {
            console.log('👨‍💼 Human help requested. Forwarding...');
            const supportPhone = settings.support_agent_phone || 'whatsapp:+17167553793';
            // Forward to human
            const fwdRes = await fetch(twilioUrl, {
                method: 'POST',
                headers: twilioHeaders,
                body: new URLSearchParams({
                    From: settings.twilio_phone_number || to,
                    To: supportPhone,
                    Body: `${body}\nهذا سؤال الزبون من ${from}`
                })
            });
            console.log('✅ Forward to support status:', fwdRes.status);

            // Reply to user
            const replyRes = await fetch(twilioUrl, {
                method: 'POST',
                headers: twilioHeaders,
                body: new URLSearchParams({
                    From: settings.twilio_phone_number || to,
                    To: from,
                    Body: 'ولا يهمك يا غالي، الموضوع يحتاج مختص. برسل للأخ أحمد يتواصل معك حالاً..'
                })
            });
            console.log('✅ Reply to user status:', replyRes.status);
        } else {
            console.log('📤 Sending AI reply to user...');
            // Reply AI output to user
            let messageBody = botReply.replace(/https?:\/\/[^\s]+/, "").trim();
            if (!messageBody && (botReply.includes('http://') || botReply.includes('https://'))) {
                messageBody = " "; // twilio requires some body usually, or mediaurl only.
            }
            const urlMatch = botReply.match(/https?:\/\/[^\s*]+/);

            let fromNumber = settings.twilio_phone_number || to;
            let toNumber = from;

            // Ensure 'whatsapp:' prefix is present for both (case-insensitive check)
            if (!fromNumber.toLowerCase().startsWith('whatsapp:')) fromNumber = `whatsapp:${fromNumber}`;
            if (!toNumber.toLowerCase().startsWith('whatsapp:')) toNumber = `whatsapp:${toNumber}`;

            const params = new URLSearchParams({
                From: fromNumber,
                To: toNumber,
                Body: messageBody || botReply
            });
            if (urlMatch) {
                console.log('🔗 Attaching MediaUrl:', urlMatch[0]);
                params.append('MediaUrl', urlMatch[0]);
            }

            const sendRes = await fetch(twilioUrl, {
                method: 'POST',
                headers: twilioHeaders,
                body: params
            });
            console.log('✅ Send reply to user status:', sendRes.status);
            if (!sendRes.ok) {
                console.error('❌ Twilio Send Error:', await sendRes.text());
            }
        }

        res.status(200).send('OK');
    } catch (error) {
        console.error('🔥 Twilio Webhook Exception:', error);
        res.status(500).send('Server Error');
    }
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`✅ مساعدك الذكي backend running on http://localhost:${PORT}`);
    console.log(`📊 Admin dashboard: http://localhost:${PORT}/admin/login.html`);
});
