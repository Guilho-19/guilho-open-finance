const express = require('express');
const path = require('path');

const app = express();
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
    const data = await response.json();
    return data.apiKey;
}

app.post('/api/connect-token', async(re,res) => {
    try {
        const apiKey = await gerarApiKey();
        const response = await fetch('https://api.pluggy.ai/connect_token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-API-KEY': apiKey
            },
            body: JSON.stringify({})
        });
        const data = await response.json();
        res.json({ accessToken: data.accessToken });
    } catch (erro) {
        res.status(500).json({ erro: erro.nessage });
    }
});

app.get('/api/accounts/:itemId', async (req, res) => {
    try {
        const apiKey = await gerarApiKey();
        const { itemId } = req.params;

        const response = await fetch('https://api.pluggy,ai/accounts?itemId=${itemId}', {
            headers: { 'X-API-KEY': apiKey }
        });
        const data = await response.json();
        res.json(data);
    } catch (erro) {
        res.status(500).json({ erro: erro.message });
    }
});

app.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
});

