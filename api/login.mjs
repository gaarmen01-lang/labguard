import { configuration, json, rateLimit } from '../server/http.mjs';
import { AppError } from '../server/answer.mjs';

const confirmation = 'Si cette adresse est autorisée, un lien de connexion a été envoyé. Consultez votre boîte mail.';

export default async function handler(req, res) {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return json(res, 405, { error: 'Méthode non autorisée.' }); }
  try {
    if (String(req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw new AppError(415, 'Envoyez une requête JSON.');
    const config = configuration();
    if (!config.authConfigured) throw new AppError(503, 'La connexion sécurisée n’est pas encore configurée.');
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'Renseignez une adresse e-mail valide.');
    // Do not enumerate the pilot's accounts or create accounts for arbitrary visitors.
    if (!config.allowed.includes(email)) return json(res, 200, { message: confirmation });
    rateLimit(`login:${email}`, Date.now(), 2);
    const redirect = process.env.LABGUARD_APP_URL || 'https://armeng-labguard.vercel.app/';
    if (!/^https:\/\/[^\s/?#]+(?:\/[^\s?#]*)?$/.test(redirect)) throw new AppError(503, 'L’adresse de retour de connexion est invalide.');
    const response = await fetch(`${config.url}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, {
      method: 'POST', headers: { apikey: config.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, create_user: true }), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new AppError(response.status === 429 ? 429 : 503, response.status === 429 ? 'Attendez un instant avant de redemander un lien.' : 'Le lien n’a pas pu être envoyé. Réessayez plus tard ou contactez le responsable du pilote.');
    return json(res, 200, { message: confirmation });
  } catch (error) {
    return json(res, error instanceof AppError ? error.status : error instanceof SyntaxError ? 400 : 503,
      { error: error instanceof AppError ? error.message : 'La demande de connexion n’a pas pu aboutir.' });
  }
}
