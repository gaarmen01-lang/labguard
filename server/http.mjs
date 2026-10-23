import { AppError } from './answer.mjs';

export function json(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}

export function configuration(env = process.env) {
  const url = env.SUPABASE_URL || '';
  const key = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '';
  const allowed = (env.LABGUARD_ALLOWED_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  const authConfigured = /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(url) && !!key && allowed.length > 0;
  return { url, key, allowed, authConfigured, aiConfigured: !!env.OPENAI_API_KEY, ready: authConfigured && !!env.OPENAI_API_KEY };
}

export async function authenticate(req, config, fetcher = fetch) {
  if (!config.authConfigured) throw new AppError(503, 'La connexion sécurisée n’est pas encore configurée.');
  const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9._-]+)$/)?.[1];
  if (!token || token.length > 8000) throw new AppError(401, 'Connectez-vous pour utiliser l’IA.');
  const response = await fetcher(`${config.url}/auth/v1/user`, {
    headers: { apikey: config.key, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new AppError(response.status >= 500 ? 503 : 401, response.status >= 500 ? 'Le service de connexion est indisponible.' : 'Votre session a expiré. Reconnectez-vous.');
  const user = await response.json();
  if (!user.id || !user.email_confirmed_at || !config.allowed.includes(String(user.email).toLowerCase())) throw new AppError(403, 'Ce compte n’est pas autorisé dans le pilote LabGuard.');
  return user;
}

const limits = new Map();
export function rateLimit(id, now = Date.now()) {
  // Per warm instance; authentication is the primary access boundary.
  const current = limits.get(id);
  if (!current || now - current.started >= 60000) {
    if (limits.size > 1000) for (const [key, value] of limits) if (now - value.started >= 60000) limits.delete(key);
    limits.set(id, { started: now, count: 1 }); return;
  }
  if (current.count >= 8) throw new AppError(429, 'Trop de questions rapprochées. Attendez une minute.');
  current.count++;
}
