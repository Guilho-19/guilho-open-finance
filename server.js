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

app.post('/api/connect-token', async (req, res) => {
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
        res.status(500).json({
            erro: erro.message,
            causa: erro.cause ? erro.cause.message || String(erro.cause) : undefined
        });
    }
});

function calcularFaturaCartao(conta, billsResults = [], txResults = []) {
    const agora = new Date();
    const anoAtual = agora.getFullYear();
    const mesAtual = agora.getMonth() + 1;
    const prefixoMesAtual = `${anoAtual}-${String(mesAtual).padStart(2, '0')}`;

    const faturasOrdenadas = [...billsResults].sort(
        (a, b) => new Date(b.dueDate) - new Date(a.dueDate)
    );
    const ultimaFaturaFechada = faturasOrdenadas[0] || null;
    const faturaMesVigente =
        faturasOrdenadas.find((b) => (b.dueDate || '').startsWith(prefixoMesAtual)) ||
        ultimaFaturaFechada;

    // 1. Compras lançadas no ciclo aberto (ainda sem billId vinculado)
    const transacoesSemFatura = txResults.filter(
        (t) => !t.creditCardMetadata?.billId && t.type === 'DEBIT'
    );
    const comprasCicloAtual = Number(
        transacoesSemFatura
            .reduce((acc, t) => acc + (Number(t.amount) || 0), 0)
            .toFixed(2)
    );

    // 2. Parcelas vigentes e futuras a partir dos parcelamentos ativos da última fatura fechada
    let parcelasCicloAtual = 0;
    let parcelasMesesFuturos = 0;
    const itensParceladosAtivos = [];

    if (ultimaFaturaFechada) {
        const txUltimaFatura = txResults.filter(
            (t) => t.creditCardMetadata?.billId === ultimaFaturaFechada.id && t.type === 'DEBIT'
        );
        for (const t of txUltimaFatura) {
            const numAtual = t.creditCardMetadata?.installmentNumber;
            const totalParc = t.creditCardMetadata?.totalInstallments;
            if (numAtual && totalParc && totalParc > numAtual) {
                const valorParcela = Number(t.amount) || 0;
                const restantes = totalParc - numAtual;
                parcelasCicloAtual += valorParcela;
                parcelasMesesFuturos += valorParcela * (restantes - 1);
                itensParceladosAtivos.push({
                    description: t.description,
                    amount: valorParcela,
                    parcelaAtual: `${numAtual + 1}/${totalParc}`,
                    parcelasFuturasRestantes: restantes - 1
                });
            }
        }
    }

    // Caso alguma compra nova na fatura aberta também seja parcelada, soma as parcelas futuras dela
    for (const t of transacoesSemFatura) {
        const numAtual = t.creditCardMetadata?.installmentNumber;
        const totalParc = t.creditCardMetadata?.totalInstallments;
        if (numAtual && totalParc && totalParc > numAtual) {
            const valorParcela = Number(t.amount) || 0;
            const restantes = totalParc - numAtual;
            parcelasMesesFuturos += valorParcela * restantes;
        }
    }

    parcelasCicloAtual = Number(parcelasCicloAtual.toFixed(2));
    parcelasMesesFuturos = Number(parcelasMesesFuturos.toFixed(2));
    const totalFaturaAberta = Number((comprasCicloAtual + parcelasCicloAtual).toFixed(2));

    let infoFaturaFechada = null;
    if (faturaMesVigente) {
        const totalPago = (faturaMesVigente.payments || []).reduce(
            (acc, p) => acc + (Number(p.amount) || 0),
            0
        );
        infoFaturaFechada = {
            id: faturaMesVigente.id,
            dueDate: faturaMesVigente.dueDate,
            billClosingDate: faturaMesVigente.billClosingDate,
            totalAmount: faturaMesVigente.totalAmount,
            minimumPaymentAmount: faturaMesVigente.minimumPaymentAmount,
            totalPago: Number(totalPago.toFixed(2)),
            paga:
                totalPago >= (faturaMesVigente.totalAmount || 0) &&
                (faturaMesVigente.totalAmount || 0) > 0
        };
    }

    return {
        mesReferencia: `${String(mesAtual).padStart(2, '0')}/${anoAtual}`,
        faturaAberta: {
            total: totalFaturaAberta,
            comprasAvulsasCiclo: comprasCicloAtual,
            parcelasDoMes: parcelasCicloAtual,
            lancamentosRecentes: transacoesSemFatura.map((t) => ({
                date: t.date,
                description: t.description,
                amount: t.amount
            })),
            parcelasAtivas: itensParceladosAtivos
        },
        faturaFechadaMesVigente: infoFaturaFechada,
        parcelasMesesFuturos,
        limiteUtilizadoTotal: conta.balance,
        limiteDisponivel: conta.creditData?.availableCreditLimit ?? null,
        limiteTotal: conta.creditData?.creditLimit ?? null
    };
}

app.get('/api/accounts/:itemId', async (req, res) => {
    try {
        const apiKey = await gerarApiKey();
        const { itemId } = req.params;

        const response = await fetch(`https://api.pluggy.ai/accounts?itemId=${itemId}`, {
            headers: { 'X-API-KEY': apiKey }
        });
        const data = await response.json();

        if (Array.isArray(data.results)) {
            await Promise.all(
                data.results.map(async (conta) => {
                    if (conta.type !== 'CREDIT') return;

                    const [billsRes, txRes] = await Promise.all([
                        fetch(`https://api.pluggy.ai/bills?accountId=${conta.id}`, {
                            headers: { 'X-API-KEY': apiKey }
                        }),
                        fetch(`https://api.pluggy.ai/v2/transactions?accountId=${conta.id}`, {
                            headers: { 'X-API-KEY': apiKey }
                        })
                    ]);

                    const billsData = billsRes.ok ? await billsRes.json() : { results: [] };
                    const txData = txRes.ok ? await txRes.json() : { results: [] };

                    conta.faturaDetalhada = calcularFaturaCartao(
                        conta,
                        billsData.results || [],
                        txData.results || []
                    );
                })
            );
        }

        res.json(data);
    } catch (erro) {
        res.status(500).json({
            erro: erro.message,
            causa: erro.cause ? erro.cause.message || String(erro.cause) : undefined
        });
    }
});

app.listen(3000, () => {
    console.log('Servidor rodando em http://localhost:3000');
});

