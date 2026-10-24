import { generateAnswer, validateRequest, AppError } from '../server/answer.mjs';
import { authenticate, configuration, json, rateLimit } from '../server/http.mjs';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Méthode non autorisée.' }); }
  try {
    const type = String(req.headers['content-type'] || '').split(';')[0];
    if (type !== 'application/json') throw new AppError(415, 'Envoyez une requête JSON.');
    const config = configuration();
    if (!config.ready) throw new AppError(503, 'La connexion IA sécurisée n’est pas encore configurée. La lecture documentaire locale reste disponible.');
    const user = await authenticate(req, config);
    rateLimit(user.id);
    if (Number(req.headers['content-length']) > 1500000) throw new AppError(413, 'Sélection documentaire trop volumineuse.');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const input = validateRequest(body);
    const answer = await generateAnswer(input, { apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL || 'gpt-5-nano' });
    return json(res, 200, answer);
  } catch (error) {
    const status = error instanceof AppError ? error.status : error instanceof SyntaxError ? 400 : 503;
    // Never return provider bodies, prompts, document text, or credentials in errors.
    return json(res, status, { error: error instanceof AppError ? error.message : status === 400 ? 'Requête JSON invalide.' : 'Le service n’a pas répondu. Réessayez dans un instant.' });
  }
}
