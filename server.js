const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware de CORS robusto para Preflight y bypass de Ngrok
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, ngrok-skip-browser-warning");
    
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.static('public'));
app.use(express.json());

// Puertas de enlace unificadas de Voximplant
const KIT_API_HOST = process.env.VOXIMPLANT_API_HOST || 'https://kitapi-us.voximplant.com';
const DOMAIN_NAME = 'rbarahona';

const formatV4Date = (date) => date.toISOString().slice(0, 19).replace('T', ' ');

// 1. ENDPOINT: HISTORIAL DE LLAMADAS (API v4)
app.get('/api/history/calls', async (req, res) => {
    let { phone_b } = req.query;
    
    console.log(`\n=============================================================`);
    console.log(`📡 [DEBUG HISTORIAL] Petición entrante desde Frontend`);
    console.log(`   👉 phone_b recibido: "${phone_b}"`);
    console.log(`=============================================================`);

    if (!phone_b || phone_b === 'null' || phone_b === 'undefined' || phone_b.trim() === '') {
        console.error('❌ [DEBUG HISTORIAL] Rechazado: Parámetro telefónico vacío.');
        return res.status(400).json({ error: 'El parámetro phone_b es requerido y no puede estar vacío.' });
    }

    const tieneLetrasOLlaves = /[a-zA-Z{} ]/.test(phone_b);
    if (tieneLetrasOLlaves) {
        console.error('❌ [DEBUG HISTORIAL] Rechazado: El parámetro contiene llaves o texto literal.');
        return res.status(400).json({ error: 'Parámetro inválido. Se recibió el texto literal de la variable sin renderizar.' });
    }

    const phoneClean = phone_b.replace(/\s+/g, '').replace(/\+/g, '');
    const token = process.env.VOXIMPLANT_API_TOKEN;

    const now = new Date();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const fromStr = formatV4Date(thirtyDaysAgo);
    const toStr = formatV4Date(now);

    try {
        const payload = new URLSearchParams();
        payload.append('access_token', token);
        payload.append('phone', phoneClean);
        payload.append('phone_full_text', 'true');
        payload.append('from', fromStr);
        payload.append('to', toStr);
        payload.append('call_direction', 'all');
        payload.append('with_wrap_up_code', 'true');
        payload.append('limit', '50');

        const targetUrl = `${KIT_API_HOST}/api/v4/history/searchCalls?domain=${DOMAIN_NAME}`;
        console.log(`📡 [DEBUG HISTORIAL] Enviando POST a: ${targetUrl}`);

        const response = await axios.post(targetUrl, payload, { 
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
        });

        const allCalls = Array.isArray(response.data?.result)
            ? response.data.result
            : response.data?.result?.calls || [];

        const callsWithWrapUp = allCalls.filter(call => call.wrap_up_code !== null && call.wrap_up_code !== undefined).slice(0, 10);

        const result = callsWithWrapUp.map(call => ({
            id:             call.id,
            fecha:          call.datetime_start,
            telefono_desde: call.phone_a,
            telefono_hacia: call.phone_b,
            duracion_seg:   call.duration,
            resultado:      call.completion_code,
            wrap_up_code:   call.wrap_up_code,
            agente_id:      call.user_id
        }));

        console.log(`✅ [DEBUG HISTORIAL] Éxito. Registros devueltos: ${result.length}`);
        res.json({ success: true, result });
    } catch (error) {
        console.error('❌ [DEBUG HISTORIAL] Error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Error en searchCalls v4', details: error.response?.data || error.message });
    }
});

// 2. ENDPOINT: MÉTRICAS DE ESTADOS DEL AGENTE (API v3)
// El frontend extrae el agent_id del historial de llamadas y lo envía directamente aquí.
// Este endpoint solo consulta las métricas acumuladas del día para ese agente.
app.get('/api/agent/summary', async (req, res) => {
    let { agent_id } = req.query;
    const token = process.env.VOXIMPLANT_API_TOKEN;
    const intervalKey = 'since12am';

    console.log(`\n=============================================================`);
    console.log(`📡 [DEBUG MÉTRICAS] Petición entrante desde Frontend`);
    console.log(`   👉 agent_id recibido: "${agent_id}"`);
    console.log(`=============================================================`);

    if (!agent_id || agent_id === 'null' || agent_id === 'undefined' || agent_id.trim() === '') {
        console.error('❌ [DEBUG MÉTRICAS] Rechazado: agent_id vacío.');
        return res.status(400).json({ error: 'Se requiere el agent_id para consultar métricas del agente.' });
    }

    const tieneLetrasOLlaves = /[a-zA-Z{} ]/.test(agent_id);
    if (tieneLetrasOLlaves) {
        console.error('❌ [DEBUG MÉTRICAS] Rechazado: agent_id contiene texto o llaves.');
        return res.status(400).json({ error: 'Parámetro inválido. Esperando un ID numérico de agente.' });
    }

    const agentIdNum = Number(agent_id);

    try {
        // Consultar métricas acumuladas del día para el agente recibido
        const metricsPayload = new URLSearchParams();
        metricsPayload.append('access_token', token);
        metricsPayload.append('domain', DOMAIN_NAME);
        metricsPayload.append('interval', intervalKey);
        metricsPayload.append('agent_ids', JSON.stringify([agentIdNum]));
        metricsPayload.append('timezone', 'America/Mexico_City');

        // 🛠️ CORRECCIÓN: path correcto es /api/v3/metrics/
        const metricsUrl = `${KIT_API_HOST}/api/v3/metrics/getAgentsMetricsCalls?domain=${DOMAIN_NAME}`;
        console.log(`📡 [DEBUG MÉTRICAS] Solicitando acumulados del día para agente [${agentIdNum}] en: ${metricsUrl}`);

        const metricsResponse = await axios.post(metricsUrl, metricsPayload, { 
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' } 
        });

        // Trazabilidad de la estructura que responde el clúster americano
        console.log(`📦 [DEBUG MÉTRICAS] Respuesta cruda de Voximplant recibida con éxito.`);

        const stats = metricsResponse.data?.result?.stat || {};
        const agentContainer = stats[agentIdNum] || {};
        const intervalData = agentContainer[intervalKey] || {};
        const rawMetrics = intervalData.metrics || {};

        console.log(`📊 [DEBUG MÉTRICAS] Claves de métricas recibidas: ${Object.keys(rawMetrics).length}`);

        const dynamicStates = [];
        Object.keys(rawMetrics).forEach(key => {
            if (key.startsWith('total_') && key.endsWith('_time') && rawMetrics[key] > 0) {
                let cleanName = key.replace('total_', '').replace('_time', '').toUpperCase();
                dynamicStates.push({ name: cleanName, total_duration: rawMetrics[key] });
            }
        });

        console.log(`✅ [DEBUG MÉTRICAS] Estados dinámicos compilados con éxito: ${dynamicStates.length}`);
        
        res.json({ 
            success: true, 
            result: { 
                agent_id: agentIdNum, 
                agent_name: `Agente ID: ${agentIdNum}`, 
                states: dynamicStates 
            } 
        });
        
    } catch (error) {
        console.error('❌ [DEBUG MÉTRICAS] Error en métricas:', error.response?.data || error.message);
        res.status(500).json({ error: 'Fallo al procesar métricas en tiempo real', details: error.response?.data || error.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n=============================================================`);
    console.log(`🕵️‍♂️ SERVIDOR DE AUDITORÍA AVANZADA ACTIVO EN http://localhost:${PORT}`);
    console.log(`=============================================================\n`);
});