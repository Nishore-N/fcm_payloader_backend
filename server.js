const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const { GoogleAuth } = require('google-auth-library');
const path = require('path');

const app = express();
const PORT = 3000;
const PAYLOADS_FILE = path.join(__dirname, 'payloads.json');
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'service-account.json');

app.use(bodyParser.json());
// Global Error Handler for JSON parsing errors
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'Invalid JSON payload' });
    }
    next();
});

app.use(cors({
    origin: ['https://fcm-payloader-frontend.onrender.com', 'http://localhost:3000'],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Serve Original JS Frontend
app.use('/', express.static(path.join(__dirname, '../frontend')));

// Serve Vanilla TypeScript Frontend
app.use('/ts', express.static(path.join(__dirname, '../typescript/dist')));

// Serve React TypeScript Frontend
app.use('/react', express.static(path.join(__dirname, '../typescript-react/dist')));

// Helper to get FCM Access Token
async function getAccessToken() {
    if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        throw new Error('service-account.json not found! Please provide it in the backend folder.');
    }
    const auth = new GoogleAuth({
        keyFile: SERVICE_ACCOUNT_FILE,
        scopes: 'https://www.googleapis.com/auth/firebase.messaging',
    });
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    return token.token;
}

// Endpoint to save and send notification
app.post('/api/send-notification', async (req, res) => {
    const payload = req.body;
    
    // 1. Validation
    if (!payload.title || !payload.body || !payload.target) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    // 2. Persistence
    let payloads = [];
    if (fs.existsSync(PAYLOADS_FILE)) {
        payloads = await fs.readJson(PAYLOADS_FILE);
    }
    payloads.push({ ...payload, timestamp: new Date().toISOString() });
    await fs.writeJson(PAYLOADS_FILE, payloads, { spaces: 2 });

    // 3. Triggering
    if (payload.triggerType === 'scheduled' && payload.delay) {
        const delayMs = parseInt(payload.delay) * 1000;
        console.log(`Scheduling notification in ${payload.delay}s`);
        setTimeout(() => processSending(payload), delayMs);
        return res.json({ message: 'Notification scheduled successfully' });
    } else {
        try {
            const results = await processSending(payload);
            return res.json({ 
                message: Array.isArray(results) ? `Successfully sent to ${results.length} devices` : 'Notification sent successfully' 
            });
        } catch (error) {
            console.error('FCM Error:', error);
            return res.status(500).json({ error: 'Failed to send FCM', details: error.message });
        }
    }
});

async function processSending(payload) {
    if (payload.targetType === 'token' && Array.isArray(payload.target)) {
        // Send to multiple tokens concurrently
        const sendPromises = payload.target.map(token => {
            const singlePayload = { ...payload, target: token };
            return sendFCM(singlePayload);
        });
        return await Promise.all(sendPromises);
    } else {
        // Single token or topic
        return await sendFCM(payload);
    }
}

async function sendFCM(data) {
    const accessToken = await getAccessToken();
    const projectId = require(SERVICE_ACCOUNT_FILE).project_id;
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    const message = {
        message: {
            data: {
                title: data.title,
                body: data.body,
                app_name: data.appName || 'Application',
                app_icon_text: data.appIconText || 'App',
                app_icon_url: data.appIconUrl || '',
                image_url: data.imageUrl || '',
                card_type: data.cardType || '1',
                button_type: data.buttonType || '1',
                button_text: data.buttonText || 'Open',
                button_action: data.deepLink || 'home',
                deep_link: data.deepLink || 'home',
                persistent: 'true'
            },
            android: {
                priority: 'high'
            }
        }
    };

    // Target: Token or Topic
    if (data.targetType === 'topic') {
        message.message.topic = data.target;
    } else {
        message.message.token = data.target;
    }

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
    });

    const result = await response.json();
    if (!response.ok) {
        throw new Error(JSON.stringify(result));
    }
    console.log('FCM Response:', result);
    return result;
}

// Catch-all for 404 (must be after all other routes)
app.use((req, res) => {
    res.status(404).json({ 
        error: 'API Endpoint Not Found', 
        path: req.path,
        tip: 'Ensure your frontend is calling the correct backend URL.' 
    });
});

app.listen(PORT, () => {
    const RENDER_URL = 'https://fcm-payloader-frontend.onrender.com';
    console.log(`\n🚀 Backend Server Running!`);
    console.log(`----------------------------------`);
    console.log(`Local Access  : http://localhost:${PORT}`);
    console.log(`Render Deploy : ${RENDER_URL}`);
    console.log(`----------------------------------`);
    console.log(`Standard JS   : ${RENDER_URL}`);
    console.log(`Vanilla TS    : ${RENDER_URL}/ts`);
    console.log(`React TSX     : ${RENDER_URL}/react`);
    console.log(`----------------------------------\n`);
});
