// Shared by the browser's explicit extractive mode and the server's AI route.
const stopwords = new Set(('a au aux avec ce ces cette dans de des du elle en et est il je la le les leur ma me mes mon ne nos nous on ou par pas pour qu que quel quelle quelles quels qui sa sans se ses son sur un une vos votre vous ai puis dois doit faire comment notre faut cas').split(' '));
const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
const tokens = text => normalize(text).match(/[a-z0-9]+/g)?.filter(t => t.length > 2 && !stopwords.has(t)).map(t => t.length > 5 ? t.replace(/s$/, '') : t) || [];
export const comparable = text => String(text || '').normalize('NFC').replace(/\s+/g, ' ').trim();

export function isActive(document, now = new Date()) {
  return ['approved', 'reviewed'].includes(document.status) && (!document.effective || document.effective <= now.toISOString().slice(0, 10));
}

export function chunkDocuments(documents, now = new Date()) {
  const chunks = [];
  for (const document of documents.filter(d => isActive(d, now))) {
    // Page numbers come only from PDF extraction, never from the model.
    const sections = String(document.content || '').split(/(?:^|\n)\[Page (\d+)\]\s*\n/);
    const pages = sections.length > 1
      ? Array.from({ length: (sections.length - 1) / 2 }, (_, i) => ({ page: Number(sections[i * 2 + 1]), text: sections[i * 2 + 2] }))
      : [{ page: null, text: document.content || '' }];
    for (const { page, text } of pages) {
      let start = 0, index = 0;
      while (start < text.length) {
        let end = Math.min(start + 1400, text.length);
        if (end < text.length) {
          const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('. ', end));
          if (boundary > start + 600) end = boundary + 1;
        }
        const content = text.slice(start, end).trim();
        if (content.length > 25) chunks.push({
          id: `${document.id}:${page ?? 'text'}:${index}`,
          documentId: document.id, title: document.title, code: document.code,
          version: document.version, page, section: `Extrait ${index + 1}`,
          fictional: !!document.fictional, content,
        });
        if (end === text.length) break;
        start = Math.max(start + 1, end - 180);
        index++;
      }
    }
  }
  return chunks;
}

export function retrieve(question, documents, history = [], limit = 5) {
  const chunks = chunkDocuments(documents);
  const current = [...new Set(tokens(question))];
  if (!current.length || !chunks.length) return [];
  // Context helps follow-up questions without letting an old topic overwhelm a new one.
  const followup = /^(et |pour |dans ce cas|qu.en est|lesquels|laquelle|lequel|pourquoi|peux.tu|pr[eé]cise)/i.test(question);
  const previous = followup ? history.filter(m => m.role === 'user').slice(-1).map(m => m.content).join(' ') : '';
  const query = [...new Set([...current, ...tokens(previous)])];
  const rows = chunks.map(chunk => ({ chunk, body: tokens(chunk.content), title: tokens(`${chunk.title} ${chunk.code}`) }));
  const average = rows.reduce((n, r) => n + r.body.length, 0) / rows.length || 1;
  const frequency = new Map(query.map(t => [t, rows.filter(r => r.body.includes(t) || r.title.includes(t)).length]));
  return rows.map(({ chunk, body, title }) => {
    let score = 0, matched = 0;
    for (const term of query) {
      const count = body.filter(t => t === term).length;
      const titleMatch = title.includes(term);
      if (count || titleMatch) matched++;
      const idf = Math.log(1 + (rows.length - frequency.get(term) + 0.5) / (frequency.get(term) + 0.5));
      score += idf * (count * 2.2 / (count + 1.2 * (0.25 + 0.75 * body.length / average)) + (titleMatch ? 1.8 : 0));
    }
    return { ...chunk, score, matched };
  }).filter(c => c.score > 0 && c.matched >= Math.min(query.length, 2))
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

export function insufficientAnswer() {
  return { mode: 'extractive', insufficient: true, paragraphs: [], sources: [],
    message: 'Je ne trouve pas de passage suffisamment pertinent dans les documents actifs. Ajoutez la procédure applicable ou précisez votre question.' };
}

export function extractiveAnswer(question, documents, history = []) {
  const matches = retrieve(question, documents, history, 3);
  if (!matches.length) return insufficientAnswer();
  return { mode: 'extractive', insufficient: false,
    message: 'Voici les passages retrouvés. Ce mode affiche le texte des documents, sans synthèse par une IA.',
    paragraphs: matches.map((source, i) => ({ text: source.content, citations: [i + 1], quotation: true })),
    sources: matches.map((source, i) => ({ ...source, number: i + 1, quote: source.content })),
  };
}
