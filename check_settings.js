require('dotenv').config();
const db = require('./database');

async function checkSettings() {
    try {
        const settings = await db.getSettings();
        console.log('--- Current Settings in DB ---');
        console.log('Model Name:', settings.model_name);
        console.log('System Prompt Length:', settings.system_prompt ? settings.system_prompt.length : 0, 'chars');
        console.log('Twilio Account SID:', settings.twilio_account_sid ? '✅ Configured' : '❌ Empty');
        console.log('Twilio Auth Token:', settings.twilio_auth_token ? '✅ Configured' : '❌ Empty');
        console.log('Twilio Phone Number:', settings.twilio_phone_number || '❌ Empty');
        console.log('Support Agent Phone:', settings.support_agent_phone || '❌ Empty');
        console.log('--- Warning: Do not show this to users if secrets are printed ---');
        process.exit(0);
    } catch (err) {
        console.error('Error checking settings:', err);
        process.exit(1);
    }
}

checkSettings();
