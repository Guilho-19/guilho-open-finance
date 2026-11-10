const express = require('express');
const path = require('path');

const aoo - express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const CLIENT_ID = '6cb7140a-90dc-4a66-a10c-5a777b73cbfe';
const CLIENT_SECRET = 'wJD-8hpvixiQtpU77NeZr3RWwb4gGaTlAKioWbyRSTM';

async function gerarApiKey() {
    const response = await fetch('https://api.pluggy.ai/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET })
    });
    const = data = await response.json();
    return data.apiKey;
}

