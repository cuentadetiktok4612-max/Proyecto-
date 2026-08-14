// netlify/functions/generate-post-openrouter.js
//
// Genera el texto del post con OpenRouter, como TERCER respaldo (después de
// Gemini y Groq). Mismo patrón que las otras dos funciones: presupuesto de
// tiempo propio (~9s), y reintento reforzado si el único problema es de
// calidad (campos faltantes) en vez de cuota/red.
//
// Variable de entorno requerida en Netlify: OPENROUTER_API_KEY
// Se consigue gratis en https://openrouter.ai/keys (no pide tarjeta para
// los modelos marcados como ":free").
//
// Se usa un modelo del catálogo gratuito de OpenRouter. Igual que con Groq,
// el free tier de OpenRouter no siempre usa schema JSON estricto, así que
// puede omitir campos — de ahí el mismo reintento reforzado que ya usa
// generate-post-groq.js.

const { parseAndValidateItem, buildPrompt, parsePostJSON, jsonResponse } = require("./_post-shared");

// Modelo gratuito de OpenRouter. Se puede cambiar por otro ":free" del
// catálogo (openrouter.ai/models?max_price=0) si este deja de estar
// disponible o rinde peor con este prompt específico.
const OPENROUTER_MODEL = "deepseek/deepseek-chat-v3.1:free";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Presupuesto de tiempo: Netlify corta a los 10s. Se deja ~1s de margen
// para el propio overhead de arranque/red de la función.
const TIMEOUT_MS = 9000;

exports.handler = async (event) => {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    return jsonResponse({ error: "OPENROUTER_API_KEY no configurada." }, 500);
  }

  const parsed = parseAndValidateItem(event);
  if (parsed.error) return jsonResponse(parsed.error.body, parsed.error.status);

  const basePrompt = buildPrompt(parsed.item);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    let result = await callOpenRouterOnce(basePrompt, orKey, controller.signal);

    if (!result.ok && result.status !== 429 && /no cumple los estándares de calidad/.test(result.error || "")) {
      const reinforcedPrompt = basePrompt + `

RECORDATORIO CRÍTICO — tu respuesta anterior falló esta validación: "${result.error}"
Antes de responder, verifica tú mismo que el JSON final tenga TODOS estos campos sin excepción:
- "headline": string no vacío.
- "body": con 2 saltos de línea dobles formando 3 bloques (párrafo, dato/opinión, pregunta de cierre), mínimo 25 palabras.
- "hashtags": un ARRAY con ENTRE 5 Y 8 strings, cada uno iniciando con #. Este campo es OBLIGATORIO y NUNCA puede quedar vacío ni faltar.`;
      result = await callOpenRouterOnce(reinforcedPrompt, orKey, controller.signal);
    }

    if (!result.ok) {
      return jsonResponse({ error: result.error }, result.status || 502);
    }
    return jsonResponse(result.data, 200);
  } catch (e) {
    const message = e.name === "AbortError" ? "Tiempo de espera agotado llamando a OpenRouter." : (e.message || String(e));
    return jsonResponse({ error: message }, 500);
  } finally {
    clearTimeout(timeout);
  }
};

async function callOpenRouterOnce(prompt, orKey, signal) {
  const payload = {
    model: OPENROUTER_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 1.05,
    top_p: 0.95,
    max_tokens: 2048,
    response_format: { type: "json_object" }
  };

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${orKey}`,
      // OpenRouter pide estos dos headers para identificar la app que llama;
      // no son secretos y no afectan la cuota, solo aparecen en su dashboard.
      "HTTP-Referer": "https://generadordepubli.netlify.app",
      "X-Title": "OtaGen"
    },
    body: JSON.stringify(payload),
    signal
  });
  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const message = json?.error?.message || `HTTP ${res.status}`;
    return { ok: false, error: `OpenRouter: ${message}`, status: res.status };
  }

  const rawText = json?.choices?.[0]?.message?.content;
  if (!rawText) {
    return { ok: false, error: "OpenRouter no devolvió contenido.", status: 502 };
  }

  return parsePostJSON(rawText, "OpenRouter");
}
