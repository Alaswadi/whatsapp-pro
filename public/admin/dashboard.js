// ─── Auth Helpers ────────────────────────────────────────────
const TOKEN_KEY = 'adminToken';
const USER_KEY = 'adminUser';

function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

function authHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
    };
}

function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    window.location.href = 'login.html';
}

// Check auth on load
if (!getToken()) {
    window.location.href = 'login.html';
}

// ─── Toast ───────────────────────────────────────────────────
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="ri-${type === 'success' ? 'check' : 'error-warning'}-line"></i> ${message}`;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ─── API Helper ──────────────────────────────────────────────
async function apiCall(url, method = 'GET', body = null) {
    try {
        const options = {
            method,
            headers: authHeaders()
        };
        if (body) options.body = JSON.stringify(body);

        const res = await fetch(url, options);

        if (res.status === 401) {
            logout();
            return null;
        }

        return await res.json();
    } catch (err) {
        showToast('تعذر الاتصال بالخادم', 'error');
        return null;
    }
}

// ─── Load Dashboard Data ─────────────────────────────────────
async function loadDashboard() {
    // Set username
    const username = localStorage.getItem(USER_KEY) || 'admin';
    document.getElementById('usernameDisplay').textContent = username;
    document.getElementById('userAvatar').textContent = username.charAt(0).toUpperCase();

    // Load stats
    const stats = await apiCall('/api/stats');
    if (stats) {
        document.getElementById('statSessions').textContent = stats.active_sessions;
        document.getElementById('statModel').textContent = stats.model.split('/').pop();
        document.getElementById('statApiStatus').innerHTML = stats.has_api_key
            ? '<span style="color: var(--success)"><i class="ri-checkbox-circle-fill"></i> مُفعّل</span>'
            : '<span style="color: var(--danger)"><i class="ri-close-circle-fill"></i> غير مُكوّن</span>';
    }

    // Load settings
    const settings = await apiCall('/api/settings');
    if (settings) {
        // API Key
        if (settings.has_api_key) {
            document.getElementById('apiKeyInput').placeholder = settings.api_key_masked;
        }

        // Model
        const modelSelect = document.getElementById('modelSelect');
        const customModel = document.getElementById('customModel');

        // Check if model is in the dropdown
        let found = false;
        for (const option of modelSelect.options) {
            if (option.value === settings.model_name) {
                option.selected = true;
                found = true;
                break;
            }
        }
        if (!found) {
            customModel.value = settings.model_name;
        }

        // System Prompt
        document.getElementById('systemPromptInput').value = settings.system_prompt || '';

        // Twilio
        if (settings.twilio_account_sid) {
            document.getElementById('twilioAccountSid').value = settings.twilio_account_sid;
        }
        if (settings.has_twilio_auth_token) {
            document.getElementById('twilioAuthToken').placeholder = '••••••••';
        }
        if (settings.twilio_phone_number) {
            document.getElementById('twilioPhoneNumber').value = settings.twilio_phone_number;
        }
        if (settings.support_agent_phone) {
            document.getElementById('supportAgentPhone').value = settings.support_agent_phone;
        }
        document.getElementById('twilioWebhookUrl').value = window.location.origin + '/api/twilio/webhook';
    }
}

// ─── Save API Key ────────────────────────────────────────────
async function saveApiKey() {
    const apiKey = document.getElementById('apiKeyInput').value.trim();
    if (!apiKey) {
        showToast('يرجى إدخال مفتاح API', 'error');
        return;
    }

    const result = await apiCall('/api/settings', 'PUT', { api_key: apiKey });
    if (result) {
        showToast('تم حفظ مفتاح API بنجاح');
        document.getElementById('apiKeyInput').value = '';
        loadDashboard(); // Refresh stats
    }
}

// ─── Save Model ──────────────────────────────────────────────
async function saveModel() {
    const customModel = document.getElementById('customModel').value.trim();
    const selectModel = document.getElementById('modelSelect').value;

    const model = customModel || selectModel;
    if (!model) {
        showToast('يرجى اختيار نموذج', 'error');
        return;
    }

    const result = await apiCall('/api/settings', 'PUT', { model_name: model });
    if (result) {
        showToast('تم حفظ النموذج بنجاح');
        if (customModel) {
            document.getElementById('customModel').value = '';
        }
        loadDashboard();
    }
}

// ─── Save System Prompt ──────────────────────────────────────
async function savePrompt() {
    const prompt = document.getElementById('systemPromptInput').value;
    if (!prompt.trim()) {
        showToast('يرجى إدخال التعليمات النظامية', 'error');
        return;
    }

    const result = await apiCall('/api/settings', 'PUT', { system_prompt: prompt });
    if (result) {
        showToast('تم حفظ التعليمات النظامية بنجاح');
    }
}

// ─── Save Twilio Settings ──────────────────────────────────────
async function saveTwilioSettings() {
    const accountSid = document.getElementById('twilioAccountSid').value.trim();
    const authToken = document.getElementById('twilioAuthToken').value.trim();
    const phoneNumber = document.getElementById('twilioPhoneNumber').value.trim();
    const supportPhone = document.getElementById('supportAgentPhone').value.trim();

    const payload = {
        twilio_account_sid: accountSid,
        twilio_phone_number: phoneNumber,
        support_agent_phone: supportPhone
    };
    if (authToken) {
        payload.twilio_auth_token = authToken;
    }

    const result = await apiCall('/api/settings', 'PUT', payload);
    if (result) {
        showToast('تم حفظ إعدادات Twilio بنجاح');
        document.getElementById('twilioAuthToken').value = '';
        if (authToken) {
            document.getElementById('twilioAuthToken').placeholder = '••••••••';
        }
    }
}

// ─── Change Password ─────────────────────────────────────────
async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;

    if (!currentPassword || !newPassword) {
        showToast('يرجى ملء جميع الحقول', 'error');
        return;
    }

    if (newPassword.length < 6) {
        showToast('كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل', 'error');
        return;
    }

    const result = await apiCall('/api/auth/change-password', 'POST', {
        currentPassword,
        newPassword
    });

    if (result && !result.error) {
        showToast('تم تغيير كلمة المرور بنجاح');
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
    } else if (result) {
        showToast(result.error, 'error');
    }
}

// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', loadDashboard);
