// netlify/functions/generate-post-groq.js
//
// Genera el texto del post SOLO con Groq. Separada de la función de Gemini
// (generate-post-gemini.js) para que cada proveedor tenga su propio
// presupuesto completo de ~10s (límite de Netlify Functions en el plan
// gratuito). El frontend llama a esta función como respaldo cuando
// generate-post-gemini falla o no está configurada.
//
// Variable de entorno requerida en Netlify: GROQ_API_KEY
// Se consigue gratis en https://console.groq.com/keys (no pide tarjeta).
//
// Se usa gpt-oss-120b en vez de llama-3.3-70b-versatile: Llama 3.3 ignora
// instrucciones largas y estructuradas (devuelve posts cortos, sin párrafos
// separados ni hashtags suficientes). gpt-oss-120b sigue mucho mejor
// prompts extensos con reglas estrictas, con una cuota gratis similar
// (1000 req/día en Groq).

const { parseAndValidateItem, buildPrompt, parsePostJSON, jsonResponse } = require("./_post-shared");

const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Presupuesto de tiempo: Netlify corta a los 10s. Se deja ~1s de margen
// para el propio overhead de arranque/red de la función.
const TIMEOUT_MS = 9000;

exports.handler = async (event) => {
  const groqKey = process.env.GROQ_API_KEY;
  if (!groqKey) {
    return jsonResponse({ error: "GROQ_API_KEY no configurada." }, 500);
  }

  const parsed = parseAndValidateItem(event);
  if (parsed.error) return jsonResponse(parsed.error.body, parsed.error.status);

  const prompt = buildPrompt(parsed.item);

  const payload = {
    model: GROQ_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 1.05,
    top_p: 0.95,
    max_tokens: 2048,
    response_format: { type: "json_object" }
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${groqKey}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const message = json?.error?.message || `HTTP ${res.status}`;
      return jsonResponse({ error: `Groq: ${message}` }, res.status);
    }

    const rawText = json?.choices?.[0]?.message?.content;
    if (!rawText) {
      return jsonResponse({ error: "Groq no devolvió contenido." }, 502);
    }

    const result = parsePostJSON(rawText, "Groq");
    if (!result.ok) {
      return jsonResponse({ error: result.error }, result.status || 502);
    }
    return jsonResponse(result.data, 200);
  } catch (e) {
    const message = e.name === "AbortError" ? "Tiempo de espera agotado llamando a Groq." : (e.message || String(e));
    return jsonResponse({ error: message }, 500);
  } finally {
    clearTimeout(timeout);
  }
};
