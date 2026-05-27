const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, ngrok-skip-browser-warning");
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.static('public'));
app.use(express.json());

const KIT_API_HOST = process.env.VOXIMPLANT_API_HOST || 'https://kitapi-us.voximplant.com';
const DOMAIN_NAME = 'rbarahona';

const formatV4Date = (date) => date.toISOString().slice(0, 19).replace('T', ' ');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 1. ENDPOINT: HISTORIAL DE LLAMADAS — hasta 200 registros con delay entre páginas
app.get('/api/history/calls', async (req, res) => {
    let { phone_b } = req.query;

    console.log(`\n=============================================================`);
    console.log(`📡 [DEBUG HISTORIAL] Petición entrante`);
    console.log(`   👉 phone_b recibido: "${phone_b}"`);
    console.log(`=============================================================`);

    if (!phone_b || phone_b === 'null' || phone_b === 'undefined' || phone_b.trim() === '') {
        return res.status(400).json({ error: 'El parámetro phone_b es requerido y no puede estar vacío.' });
    }
    const tieneLetrasOLlaves = /[a-zA-Z{} ]/.test(phone_b);
    if (tieneLetrasOLlaves) {
        return res.status(400).json({ error: 'Parámetro inválido. Se recibió el texto literal de la variable sin renderizar.' });
    }

    const phoneClean = phone_b.replace(/\s+/g, '').replace(/\+/g, '');
    const token = process.env.VOXIMPLANT_API_TOKEN;
    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fromStr = formatV4Date(thirtyDaysAgo);
    const toStr = formatV4Date(now);

    console.log(`🔎 [DEBUG HISTORIAL] phoneClean: "${phoneClean}"`);
    console.log(`🔎 [DEBUG HISTORIAL] Rango: "${fromStr}" → "${toStr}"`);

    try {
        let allCalls = [];
        let cursor = null;
        let page = 1;
        const MAX_PAGES = 4;
        const PAGE_SIZE = 50;
        const DELAY_MS = 800; // evitar 429

        while (page <= MAX_PAGES) {
            if (page > 1) {
                console.log(`⏳ [DEBUG HISTORIAL] Esperando ${DELAY_MS}ms antes de página ${page}...`);
                await sleep(DELAY_MS);
            }

            const payload = new URLSearchParams();
            payload.append('access_token', token);
            payload.append('phone', phoneClean);
            payload.append('phone_full_text', 'true');
            payload.append('from', fromStr);
            payload.append('to', toStr);
            payload.append('call_direction', 'all');
            payload.append('limit', String(PAGE_SIZE));
            if (cursor) payload.append('cursor', cursor);

            const targetUrl = `${KIT_API_HOST}/api/v4/history/searchCalls?domain=${DOMAIN_NAME}`;
            console.log(`📡 [DEBUG HISTORIAL] Página ${page} → ${targetUrl}`);

            const response = await axios.post(targetUrl, payload, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            const pageCalls = Array.isArray(response.data?.result)
                ? response.data.result
                : response.data?.result?.calls || [];

            console.log(`📊 [DEBUG HISTORIAL] Página ${page}: ${pageCalls.length} llamadas`);
            allCalls = allCalls.concat(pageCalls);

            cursor = response.data?._meta?.cursor || null;
            if (!cursor || pageCalls.length < PAGE_SIZE) {
                console.log(`📊 [DEBUG HISTORIAL] Fin de paginación en página ${page}`);
                break;
            }
            page++;
        }

        console.log(`📊 [DEBUG HISTORIAL] Total acumuladas: ${allCalls.length}`);

        const conWrapUp = allCalls.filter(c => c.wrap_up_code !== null && c.wrap_up_code !== undefined);
        const llamadaConAgente = allCalls.find(c => c.user_id !== null && c.user_id !== undefined);
        const agentIdDetectado = llamadaConAgente?.user_id || null;

        console.log(`📊 [DEBUG HISTORIAL] Con wrap_up_code: ${conWrapUp.length}`);
        console.log(`🎯 [DEBUG HISTORIAL] agent_id detectado: ${agentIdDetectado}`);

        const result = conWrapUp.slice(0, 10).map(call => ({
            id:             call.id,
            fecha:          call.datetime_start,
            telefono_desde: call.phone_a,
            telefono_hacia: call.phone_b,
            duracion_seg:   call.duration,
            resultado:      call.completion_code,
            wrap_up_code:   call.wrap_up_code,
            agente_id:      call.user_id ?? agentIdDetectado
        }));

        console.log(`✅ [DEBUG HISTORIAL] Devueltos: ${result.length} registros, agent_id: ${agentIdDetectado}`);
        res.json({ success: true, result, agent_id: agentIdDetectado });

    } catch (error) {
        const status = error.response?.status;
        console.error(`\n❌ [DEBUG HISTORIAL] ERROR HTTP ${status}: ${error.message}`);
        if (status === 429) {
            console.error(`   ⚠️  Rate limit alcanzado. Considera aumentar DELAY_MS.`);
        }
        console.error(`   Respuesta:`, JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: 'Error en searchCalls v4', details: error.response?.data || error.message });
    }
});

// 2. ENDPOINT: MÉTRICAS DEL AGENTE
app.get('/api/agent/summary', async (req, res) => {
    let { agent_id } = req.query;
    const token = process.env.VOXIMPLANT_API_TOKEN;
    const intervalKey = 'since12am';

    console.log(`\n=============================================================`);
    console.log(`📡 [DEBUG MÉTRICAS] agent_id recibido: "${agent_id}"`);
    console.log(`=============================================================`);

    if (!agent_id || agent_id === 'null' || agent_id === 'undefined' || agent_id.trim() === '') {
        return res.status(400).json({ error: 'Se requiere el agent_id.' });
    }
    if (/[a-zA-Z{} ]/.test(agent_id)) {
        return res.status(400).json({ error: 'Parámetro inválido. Esperando un ID numérico.' });
    }

    const agentIdNum = Number(agent_id);
    console.log(`🔎 [DEBUG MÉTRICAS] agentIdNum: ${agentIdNum}`);

    try {
        const metricsPayload = new URLSearchParams();
        metricsPayload.append('access_token', token);
        metricsPayload.append('domain', DOMAIN_NAME);
        metricsPayload.append('interval', intervalKey);
        metricsPayload.append('agent_ids', JSON.stringify([agentIdNum]));
        metricsPayload.append('timezone', 'America/Mexico_City');

        const metricsUrl = `${KIT_API_HOST}/api/v3/realtimeMetrics/getAgentsMetricsCalls?domain=${DOMAIN_NAME}`;
        console.log(`📡 [DEBUG MÉTRICAS] POST → ${metricsUrl}`);

        const metricsResponse = await axios.post(metricsUrl, metricsPayload, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        console.log(`\n📦 [DEBUG MÉTRICAS] Respuesta cruda:`);
        console.log(JSON.stringify(metricsResponse.data, null, 2));

        const stats = metricsResponse.data?.result?.stat || {};
        const agentContainer = stats[agentIdNum] || {};
        const intervalData = agentContainer[intervalKey] || {};
        const rawMetrics = intervalData.metrics || {};

        console.log(`📊 [DEBUG MÉTRICAS] Claves stat: ${Object.keys(stats).join(', ') || 'ninguna'}`);
        console.log(`📊 [DEBUG MÉTRICAS] Claves métricas: ${Object.keys(rawMetrics).length}`);

        const dynamicStates = [];
        Object.keys(rawMetrics).forEach(key => {
            if (key.startsWith('total_') && key.endsWith('_time') && rawMetrics[key] > 0) {
                const cleanName = key.replace('total_', '').replace('_time', '').toUpperCase();
                dynamicStates.push({ name: cleanName, total_duration: rawMetrics[key] });
            }
        });

        console.log(`✅ [DEBUG MÉTRICAS] Estados: ${dynamicStates.length}`);
        res.json({ success: true, result: { agent_id: agentIdNum, agent_name: `Agente ID: ${agentIdNum}`, states: dynamicStates } });

    } catch (error) {
        console.error(`\n❌ [DEBUG MÉTRICAS] ERROR: ${error.message}`);
        console.error(`   Respuesta:`, JSON.stringify(error.response?.data, null, 2));
        res.status(500).json({ error: 'Fallo al procesar métricas', details: error.response?.data || error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`🕵️‍♂️ SERVIDOR ACTIVO EN http://localhost:${PORT}`);
    console.log(`=============================================================\n`);
});