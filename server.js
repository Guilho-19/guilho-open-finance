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

function normalizarChaveCompraParcelada(descricao = '', totalInstallments = 1, amount = 0) {
    const descSemParcela = String(descricao)
        .toUpperCase()
        .replace(/\b\d{1,2}\s*\/\s*\d{1,2}\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return `${descSemParcela}|${totalInstallments}|${Math.abs(Number(amount) || 0).toFixed(2)}`;
}

function deduplicarTransacoesConta(txResults = []) {
    const vistos = new Set();
    const unicas = [];

    for (const t of txResults) {
        const numParc = t.creditCardMetadata?.installmentNumber || '';
        const totParc = t.creditCardMetadata?.totalInstallments || '';
        const dataDia = (t.date || '').slice(0, 10);
        const descLimpa = String(t.description || '').trim().toUpperCase();
        const valorFixo = Math.abs(Number(t.amount) || 0).toFixed(2);

        // Se for parcelada, a mesma compra + número da parcela + valor no mesmo mês não pode repetir
        const chave =
            totParc > 1
                ? `INST|${ (t.date || '').slice(0, 7) }|${descLimpa}|${numParc}/${totParc}|${valorFixo}|${t.type}`
                : `TX|${t.id || `${dataDia}|${descLimpa}|${valorFixo}|${t.type}|${t.order ?? ''}`}`;

        if (vistos.has(chave)) continue;
        vistos.add(chave);
        unicas.push(t);
    }

    return unicas;
}

const NOMES_MESES_PT = [
    'Janeiro',
    'Fevereiro',
    'Março',
    'Abril',
    'Maio',
    'Junho',
    'Julho',
    'Agosto',
    'Setembro',
    'Outubro',
    'Novembro',
    'Dezembro'
];

function formatarNomeMesAno(chaveAnoMes) {
    const [anoStr, mesStr] = String(chaveAnoMes || '').split('-');
    const mesIdx = Number(mesStr) - 1;
    if (!anoStr || mesIdx < 0 || mesIdx > 11) return chaveAnoMes;
    return `${NOMES_MESES_PT[mesIdx]}/${anoStr}`;
}

function deslocarMesAno(ano, mes, deltaMeses) {
    const d = new Date(Date.UTC(ano, mes - 1 + deltaMeses, 1));
    const novoAno = d.getUTCFullYear();
    const novoMes = d.getUTCMonth() + 1;
    return `${novoAno}-${String(novoMes).padStart(2, '0')}`;
}

function obterCompetenciaDeFaturaFechada(dueDateStr) {
    if (!dueDateStr) return null;
    const d = new Date(dueDateStr);
    if (Number.isNaN(d.getTime())) return null;
    const anoVenc = d.getUTCFullYear();
    const mesVenc = d.getUTCMonth() + 1;
    const diaVenc = d.getUTCDate();
    // Faturas que vencem até o dia 20 (ex: 06/11 ou 10/11) referem-se aos gastos do mês anterior (ex: Outubro, pago no início de Novembro)
    if (diaVenc <= 20) {
        return deslocarMesAno(anoVenc, mesVenc, -1);
    }
    return `${anoVenc}-${String(mesVenc).padStart(2, '0')}`;
}

function calcularFaturaCartao(conta, billsResults = [], txResults = []) {
    const agora = new Date();
    const anoAtual = agora.getFullYear();
    const mesAtual = agora.getMonth() + 1;
    const prefixoMesAtual = `${anoAtual}-${String(mesAtual).padStart(2, '0')}`;
    const proximoMesChave = deslocarMesAno(anoAtual, mesAtual, 1);

    const faturasOrdenadas = [...billsResults].sort(
        (a, b) => new Date(b.dueDate) - new Date(a.dueDate)
    );
    const ultimaFaturaFechada = faturasOrdenadas[0] || null;
    const faturaMesVigente =
        faturasOrdenadas.find((b) => (b.dueDate || '').startsWith(prefixoMesAtual)) ||
        ultimaFaturaFechada;

    // Descobre o dia habitual de vencimento do cartão a partir da última fatura fechada
    const diaVencimentoHabitual = ultimaFaturaFechada?.dueDate
        ? String(new Date(ultimaFaturaFechada.dueDate).getUTCDate()).padStart(2, '0')
        : null;
    const [anoProx, mesProx] = proximoMesChave.split('-');
    const vencimentoEstimadoFaturaAberta = diaVencimentoHabitual
        ? `${diaVencimentoHabitual}/${mesProx}/${anoProx}`
        : `Início de ${formatarNomeMesAno(proximoMesChave)}`;

    // 1. Transações lançadas no ciclo aberto (ainda sem billId vinculado)
    const transacoesSemFatura = txResults.filter(
        (t) => !t.creditCardMetadata?.billId && t.type === 'DEBIT'
    );

    const comprasAvulsasSemFatura = [];
    const gruposParcelasSemFatura = new Map();

    for (const t of transacoesSemFatura) {
        const numAtual = t.creditCardMetadata?.installmentNumber;
        const totalParc = t.creditCardMetadata?.totalInstallments;
        if (numAtual && totalParc && totalParc > 1) {
            const chaveCompra = normalizarChaveCompraParcelada(t.description, totalParc, t.amount);
            if (!gruposParcelasSemFatura.has(chaveCompra)) {
                gruposParcelasSemFatura.set(chaveCompra, []);
            }
            gruposParcelasSemFatura.get(chaveCompra).push(t);
        } else {
            comprasAvulsasSemFatura.push(t);
        }
    }

    const comprasCicloAtual = Number(
        comprasAvulsasSemFatura
            .reduce((acc, t) => acc + (Number(t.amount) || 0), 0)
            .toFixed(2)
    );

    // 2. Parcelas vigentes e futuras (tratando bancos que já lançam a parcela PENDING na fatura aberta e bancos que não lançam)
    let parcelasCicloAtual = 0;
    let parcelasMesesFuturos = 0;
    const itensParceladosAtivos = [];
    const comprasParceladasJaContabilizadas = new Set();

    // 2a. Parcelas que já vieram em transacoesSemFatura (ex: Nubank)
    for (const [chaveCompra, listaTx] of gruposParcelasSemFatura.entries()) {
        comprasParceladasJaContabilizadas.add(chaveCompra);
        listaTx.sort(
            (a, b) =>
                (a.creditCardMetadata?.installmentNumber || 0) -
                (b.creditCardMetadata?.installmentNumber || 0)
        );
        const parcelaVigenteTx = listaTx[0];
        const numAtual = parcelaVigenteTx.creditCardMetadata?.installmentNumber || 1;
        const totalParc = parcelaVigenteTx.creditCardMetadata?.totalInstallments || 1;
        const valorParcela = Number(parcelaVigenteTx.amount) || 0;
        const restantesAposEsta = Math.max(0, totalParc - numAtual);

        parcelasCicloAtual += valorParcela;
        parcelasMesesFuturos += valorParcela * restantesAposEsta;

        itensParceladosAtivos.push({
            date: parcelaVigenteTx.date,
            description: parcelaVigenteTx.description,
            amount: valorParcela,
            parcelaAtual: `${numAtual}/${totalParc}`,
            parcelasFuturasRestantes: restantesAposEsta
        });
    }

    // 2b. Parcelamentos ativos da última fatura fechada que ainda não apareceram em transacoesSemFatura (ex: XP)
    if (ultimaFaturaFechada) {
        const txUltimaFatura = txResults.filter(
            (t) => t.creditCardMetadata?.billId === ultimaFaturaFechada.id && t.type === 'DEBIT'
        );
        for (const t of txUltimaFatura) {
            const numAtual = t.creditCardMetadata?.installmentNumber;
            const totalParc = t.creditCardMetadata?.totalInstallments;
            if (numAtual && totalParc && totalParc > numAtual) {
                const chaveCompra = normalizarChaveCompraParcelada(
                    t.description,
                    totalParc,
                    t.amount
                );
                if (comprasParceladasJaContabilizadas.has(chaveCompra)) continue;
                comprasParceladasJaContabilizadas.add(chaveCompra);

                const valorParcela = Number(t.amount) || 0;
                const restantes = totalParc - numAtual;
                parcelasCicloAtual += valorParcela;
                parcelasMesesFuturos += valorParcela * (restantes - 1);
                itensParceladosAtivos.push({
                    date: t.date,
                    description: t.description,
                    amount: valorParcela,
                    parcelaAtual: `${numAtual + 1}/${totalParc}`,
                    parcelasFuturasRestantes: restantes - 1
                });
            }
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

    // 3. Mapeamento completo de Faturas por Mês de Competência (ex: "2026-11" = gastos de Novembro pagos no início de Dezembro)
    const faturasPorCompetencia = {};

    // 3a. Competência do mês atual (Fatura Aberta de gastos deste mês -> vencimento no início do próximo mês)
    const itensFaturaAbertaUnificados = [
        ...comprasAvulsasSemFatura.map((t) => ({
            date: t.date,
            description: t.description,
            amount: Number(t.amount) || 0,
            tipoItem: 'AVULSA',
            parcelaInfo: null
        })),
        ...itensParceladosAtivos.map((p) => ({
            date: p.date || null,
            description: p.description,
            amount: Number(p.amount) || 0,
            tipoItem: 'PARCELA',
            parcelaInfo: p.parcelaAtual
        }))
    ];

    faturasPorCompetencia[prefixoMesAtual] = {
        mesCompetencia: prefixoMesAtual,
        rotuloCompetencia: formatarNomeMesAno(prefixoMesAtual),
        mesPagamento: proximoMesChave,
        rotuloVencimento: vencimentoEstimadoFaturaAberta,
        dueDate: null,
        status: 'ABERTA',
        paga: false,
        total: totalFaturaAberta,
        comprasAvulsas: comprasCicloAtual,
        parcelasDoMes: parcelasCicloAtual,
        itens: itensFaturaAbertaUnificados
    };

    // 3b. Competências de faturas fechadas (ex: fatura com vencimento em 10/11/2026 -> competência 2026-10, Outubro)
    for (const bill of faturasOrdenadas) {
        const chaveComp = obterCompetenciaDeFaturaFechada(bill.dueDate);
        if (!chaveComp || faturasPorCompetencia[chaveComp]) continue;

        const txDaFatura = txResults.filter(
            (t) => t.creditCardMetadata?.billId === bill.id && t.type === 'DEBIT'
        );

        let avulsasBill = 0;
        let parcelasBill = 0;
        const itensBill = [];

        for (const t of txDaFatura) {
            const numAtual = t.creditCardMetadata?.installmentNumber;
            const totalParc = t.creditCardMetadata?.totalInstallments;
            const valor = Math.abs(Number(t.amount) || 0);
            const ehParcela = Boolean(numAtual && totalParc && totalParc > 1);

            if (ehParcela) {
                parcelasBill += valor;
            } else {
                avulsasBill += valor;
            }

            itensBill.push({
                date: t.date,
                description: t.description,
                amount: valor,
                tipoItem: ehParcela ? 'PARCELA' : 'AVULSA',
                parcelaInfo: ehParcela ? `${numAtual}/${totalParc}` : null
            });
        }

        avulsasBill = Number(avulsasBill.toFixed(2));
        parcelasBill = Number(parcelasBill.toFixed(2));
        const somaItens = Number((avulsasBill + parcelasBill).toFixed(2));
        const totalBill = Number((bill.totalAmount ?? somaItens).toFixed(2));

        const totalPagoBill = (bill.payments || []).reduce(
            (acc, p) => acc + (Number(p.amount) || 0),
            0
        );
        const pagaBill = totalPagoBill >= totalBill && totalBill > 0;
        const dataVencFormatada = bill.dueDate
            ? new Date(bill.dueDate).toLocaleDateString('pt-BR', { timeZone: 'UTC' })
            : '-';

        faturasPorCompetencia[chaveComp] = {
            id: bill.id,
            mesCompetencia: chaveComp,
            rotuloCompetencia: formatarNomeMesAno(chaveComp),
            mesPagamento: (bill.dueDate || '').slice(0, 7),
            rotuloVencimento: dataVencFormatada,
            dueDate: bill.dueDate,
            status: pagaBill ? 'PAGA' : 'FECHADA',
            paga: pagaBill,
            total: somaItens > 0 ? somaItens : totalBill,
            totalOriginalFatura: totalBill,
            comprasAvulsas: avulsasBill,
            parcelasDoMes: parcelasBill,
            itens: itensBill
        };
    }

    return {
        mesReferencia: `${String(mesAtual).padStart(2, '0')}/${anoAtual}`,
        mesCompetenciaAtual: prefixoMesAtual,
        faturaAberta: {
            mesCompetencia: prefixoMesAtual,
            rotuloCompetencia: formatarNomeMesAno(prefixoMesAtual),
            rotuloVencimento: vencimentoEstimadoFaturaAberta,
            total: totalFaturaAberta,
            comprasAvulsasCiclo: comprasCicloAtual,
            parcelasDoMes: parcelasCicloAtual,
            lancamentosRecentes: comprasAvulsasSemFatura.map((t) => ({
                date: t.date,
                description: t.description,
                amount: t.amount
            })),
            parcelasAtivas: itensParceladosAtivos
        },
        faturaFechadaMesVigente: infoFaturaFechada,
        faturasPorCompetencia,
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

        const [response, itemRes] = await Promise.all([
            fetch(`https://api.pluggy.ai/accounts?itemId=${itemId}`, {
                headers: { 'X-API-KEY': apiKey }
            }),
            fetch(`https://api.pluggy.ai/items/${itemId}`, {
                headers: { 'X-API-KEY': apiKey }
            })
        ]);

        const data = await response.json();
        if (itemRes.ok) {
            const itemInfo = await itemRes.json();
            data.item = {
                id: itemInfo.id,
                status: itemInfo.status,
                connector: itemInfo.connector
                    ? {
                          id: itemInfo.connector.id,
                          name: itemInfo.connector.name,
                          imageUrl: itemInfo.connector.imageUrl,
                          primaryColor: itemInfo.connector.primaryColor
                      }
                    : null
            };
        }

        if (Array.isArray(data.results)) {
            await Promise.all(
                data.results.map(async (conta) => {
                    const txPromise = fetch(
                        `https://api.pluggy.ai/v2/transactions?accountId=${conta.id}`,
                        { headers: { 'X-API-KEY': apiKey } }
                    );
                    const billsPromise =
                        conta.type === 'CREDIT'
                            ? fetch(`https://api.pluggy.ai/bills?accountId=${conta.id}`, {
                                  headers: { 'X-API-KEY': apiKey }
                              })
                            : Promise.resolve(null);

                    const [txRes, billsRes] = await Promise.all([txPromise, billsPromise]);
                    const txData = txRes && txRes.ok ? await txRes.json() : { results: [] };
                    const txResults = deduplicarTransacoesConta(txData.results || []);

                    conta.transacoes = txResults;

                    if (conta.type === 'CREDIT') {
                        const billsData =
                            billsRes && billsRes.ok ? await billsRes.json() : { results: [] };
                        conta.faturaDetalhada = calcularFaturaCartao(
                            conta,
                            billsData.results || [],
                            txResults
                        );
                    }
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

