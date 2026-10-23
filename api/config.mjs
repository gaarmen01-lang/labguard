import { configuration, json } from '../server/http.mjs';
export default function handler(req, res) {
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return json(res, 405, { error: 'Méthode non autorisée.' }); }
  const config = configuration();
  return json(res, 200, { ready: config.ready, aiConfigured: config.aiConfigured, authConfigured: config.authConfigured,
    supabaseUrl: config.authConfigured ? config.url : '', publishableKey: config.authConfigured ? config.key : '' });
}
