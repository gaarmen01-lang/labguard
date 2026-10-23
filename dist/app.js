import { extractPDF, extractDOCX } from './lib/extract.js';
import { extractiveAnswer, isActive } from './lib/rag.js';
import { demoDocuments } from './lib/demo.js';
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg aria-hidden="true"><use href="#i-${name}"/></svg>`;
const uuid = () => crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
let db, documents = [], conversations = [], activeId = null, useDemo = false, draftScope = null;
let selectedFile = null, extracting = false, fileGeneration = 0, currentURL = null, toastTimer;
let config = { ready: false, authConfigured: false }, session = null;
const requests = new Map();
const input = $('#question');
function notify(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
function current() { return conversations.find(c => c.id === activeId); }
function corpus() { return useDemo ? demoDocuments : documents; }
function activeDocuments() { const scope = (current() ? current().scope : draftScope); return corpus().filter(d => isActive(d) && (scope === null || scope.includes(d.id))); }
function closeSidebar() {
  const sidebar = $('#sidebar'), wasOpen = sidebar.classList.contains('open');
  sidebar.classList.remove('open'); $('#scrim').hidden = true; $('#open-sidebar').setAttribute('aria-expanded', 'false');
  const hidden = matchMedia('(max-width:760px)').matches || document.body.classList.contains('sidebar-collapsed');
  sidebar.inert = hidden; sidebar.setAttribute('aria-hidden', String(hidden));
  if (wasOpen && hidden) $('#open-sidebar').focus();
}
function resize() {
  input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 170) + 'px';
  const pending = requests.has(activeId);
  $('#send').disabled = !pending && !input.value.trim();
  $('#send').setAttribute('aria-label', pending ? 'Arrêter la réponse' : 'Envoyer la question');
  $('#send').innerHTML = icon(pending ? 'stop' : 'up');
}
function syncContext() {
  $('#demo-banner').hidden = !useDemo;
  const scope = (current() ? current().scope : draftScope);
  $('#scope-label').textContent = useDemo ? 'Documents fictifs' : scope === null ? 'Tous les documents' : `${activeDocuments().length} document${activeDocuments().length > 1 ? 's' : ''}`;
  $('#doc-count').textContent = documents.length;
  resize(); updateConnection();
}
function navigate() {
  const name = ['documents', 'procedures', 'administration'].includes(location.hash.slice(1)) ? 'documents' : 'assistant';
  $('#view-assistant').hidden = name !== 'assistant'; $('#view-documents').hidden = name !== 'documents';
  $('#view-title').textContent = name === 'documents' ? 'Documents' : 'Assistant';
  $$('.nav-link').forEach(a => { a.classList.toggle('active', a.dataset.view === name); if (a.dataset.view === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  closeSidebar(); if (name === 'documents') renderDocuments();
}
function newChat(focus = true) { activeId = null; useDemo = false; draftScope = null; input.value = ''; location.hash = 'assistant'; renderChat(); renderHistory(); syncContext(); closeSidebar(); if (focus) input.focus(); }
function activate(id) { const c = conversations.find(c => c.id === id); if (!c) return; activeId = id; useDemo = !!c.demo; draftScope = c.scope ?? null; input.value = c.draft || ''; location.hash = 'assistant'; renderChat(); renderHistory(); syncContext(); closeSidebar(); }
function setTheme(dark) { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme-label').textContent = dark ? 'Mode clair' : 'Mode sombre'; try { localStorage.setItem('labguard-theme', dark ? 'dark' : 'light'); } catch {} }
try { setTheme(localStorage.getItem('labguard-theme') === 'dark'); } catch { setTheme(false); }

async function openDB() {
  db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('labguard-document-preparation', 2);
    request.onupgradeneeded = () => { for (const name of ['documents', 'conversations']) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' }); };
    request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
    request.onerror = () => reject(request.error); request.onblocked = () => notify('Fermez les autres onglets LabGuard pour mettre le stockage à jour.');
  });
  [documents, conversations] = await Promise.all(['documents', 'conversations'].map(readAll));
  for (const c of conversations) for (const m of c.messages) if (m.pending) { delete m.pending; m.error = 'Cette réponse a été interrompue. Vous pouvez réessayer.'; }
}
function readAll(store) { return new Promise((resolve, reject) => { const request = db.transaction(store).objectStore(store).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
function write(store, operation, value) { if (!db) return Promise.reject(new Error('Le stockage du navigateur est indisponible.')); return new Promise((resolve, reject) => { const transaction = db.transaction(store, 'readwrite'); transaction.objectStore(store)[operation](value); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
async function persist(c) { if (c.deleted) return; c.updated = Date.now(); try { await write('conversations', 'put', c); } catch { notify('Discussion non enregistrée : le stockage de ce navigateur est indisponible.'); } }
function renderHistory() {
  const term = $('#history-search').value.trim().toLocaleLowerCase('fr');
  const rows = conversations.filter(c => !term || c.title.toLocaleLowerCase('fr').includes(term)).sort((a, b) => b.updated - a.updated);
  $('#history-list').innerHTML = rows.length ? rows.map(c => `<div class="history-item ${c.id === activeId ? 'active' : ''}"><button data-chat="${esc(c.id)}" title="${esc(c.title)}" ${c.id === activeId ? 'aria-current="true"' : ''}>${esc(c.title)}</button><button class="history-delete" data-delete-chat="${esc(c.id)}" aria-label="Supprimer la discussion ${esc(c.title)}">${icon('trash')}</button></div>`).join('') : `<p class="history-empty">${term ? 'Aucune discussion trouvée.' : 'Vos discussions apparaîtront ici.'}</p>`;
}
function inline(text) { return esc(text).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>').replace(/`([^`\n]+)`/g, '<code>$1</code>'); }
function markdown(text) {
  return String(text).split(/\n\s*\n/).map(block => {
    const lines = block.split('\n');
    if (lines.every(line => /^\s*[-*] /.test(line))) return `<ul>${lines.map(line => `<li>${inline(line.replace(/^\s*[-*] /, ''))}</li>`).join('')}</ul>`;
    if (lines.every(line => /^\s*\d+[.)] /.test(line))) return `<ol>${lines.map(line => `<li>${inline(line.replace(/^\s*\d+[.)] /, ''))}</li>`).join('')}</ol>`;
    return `<p>${lines.map(line => inline(line.replace(/^#{1,4} /, ''))).join('<br>')}</p>`;
  }).join('');
}
function citationButtons(numbers, messageId) { return numbers.map(n => `<button class="citation" data-citation="${n}" data-message="${esc(messageId)}" aria-label="Consulter la source ${n}">${n}</button>`).join(''); }
function renderAnswer(message) {
  const heading = `<div class="answer-heading"><span class="answer-logo">${icon('shield')}</span>LabGuard<span class="answer-mode">${message.answer?.mode === 'ai' ? 'Réponse IA' : message.pending ? '' : 'Lecture documentaire · sans IA'}</span></div>`;
  if (message.pending) return heading + '<div class="pending" role="status"><span class="pending-dot"></span>Recherche dans les documents…</div>';
  if (message.error) return heading + `<div class="answer-error" role="alert">${esc(message.error)}</div><div class="message-actions"><button data-retry="${esc(message.id)}">${icon('arrow')}Réessayer</button></div>`;
  const answer = message.answer;
  if (!answer) return '';
  let body = answer.message ? `<p class="${answer.insufficient ? 'answer-insufficient' : 'answer-intro'}">${esc(answer.message)}</p>` : '';
  body += answer.paragraphs.map(p => p.quotation ? `<blockquote>${esc(p.text)} ${citationButtons(p.citations, message.id)}</blockquote>` : `<div class="answer-paragraph">${markdown(p.text)}${citationButtons(p.citations, message.id)}</div>`).join('');
  if (answer.sources.length) {
    body += `<div class="sources-label">${answer.sources.length} source${answer.sources.length > 1 ? 's' : ''} · cliquez pour vérifier</div><div class="source-cards">` + answer.sources.map(s => `<button class="source-card" data-citation="${s.number}" data-message="${esc(message.id)}">${icon('doc')}<span><strong>${s.number}. ${esc(s.title)}</strong><small>${esc(s.code)} · v${esc(s.version)} · ${s.page ? 'p. ' + s.page : esc(s.section)}${s.fictional ? ' · Fictif' : ''}</small></span></button>`).join('') + '</div>';
  }
  return heading + `<div class="answer-body">${body}</div><div class="message-actions"><button data-copy="${esc(message.id)}" aria-label="Copier la réponse">${icon('copy')}Copier</button></div>`;
}
function renderChat() {
  const messages = current()?.messages || [];
  $('#welcome').hidden = messages.length > 0;
  $('#conversation').innerHTML = messages.map(m => m.role === 'user' ? `<article class="message user" aria-label="Votre question"><div class="user-bubble">${esc(m.content)}</div></article>` : `<article class="message assistant" aria-label="Réponse de LabGuard">${renderAnswer(m)}</article>`).join('');
  syncContext();
}
function scrollBottom() { const region = $('#chat-scroll'); region.scrollTop = region.scrollHeight; }
function historyFor(c, until) { return c.messages.slice(0, until).filter(m => m.role === 'user' || m.answer).map(m => ({ role: m.role, content: m.role === 'user' ? m.content : m.answer.paragraphs.map(p => p.text).join('\n') })); }
async function requestAnswer(c, message, questionIndex) {
  const controller = new AbortController(); requests.set(c.id, controller); message.pending = true; delete message.error;
  if (activeId === c.id) { renderChat(); scrollBottom(); }
  await persist(c);
  // Capture the selected corpus for this question, independent of subsequent navigation.
  const scope = c.scope;
  const selected = (c.demo ? demoDocuments : documents).filter(d => isActive(d) && (scope === null || scope.includes(d.id)));
  const question = c.messages[questionIndex].content, history = historyFor(c, questionIndex);
  try {
    if (config.ready && session?.access_token && !c.demo) {
      const payloadDocuments = selected.map(({ id, title, code, version, content, status, effective, fictional }) => ({ id, title, code, version, content, status, effective, fictional }));
      const response = await fetch('/api/chat', { method: 'POST', signal: controller.signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` }, body: JSON.stringify({ question, history, documents: payloadDocuments }) });
      const result = await response.json();
      if (!response.ok) { if (response.status === 401) { session = null; clearSession(); updateConnection(); } throw new Error(result.error || 'Le serveur n’a pas pu répondre.'); }
      message.answer = result;
    } else {
      message.answer = extractiveAnswer(question, selected, history);
    }
  } catch (error) { message.error = error.name === 'AbortError' ? 'Réponse interrompue. Vous pouvez réessayer.' : error.message || 'La connexion a été interrompue.'; }
  finally {
    delete message.pending; requests.delete(c.id); await persist(c);
    if (activeId === c.id) { renderChat(); scrollBottom(); }
    renderHistory();
  }
}
async function sendQuestion() {
  if (requests.has(activeId)) { requests.get(activeId).abort(); return; }
  const text = input.value.trim(); if (!text) return;
  let c = current();
  if (!c) { c = { id: uuid(), title: text.slice(0, 70), created: Date.now(), updated: Date.now(), demo: useDemo, scope: draftScope, messages: [] }; conversations.push(c); activeId = c.id; }
  const questionIndex = c.messages.length;
  c.messages.push({ id: uuid(), role: 'user', content: text });
  const message = { id: uuid(), role: 'assistant', pending: true }; c.messages.push(message);
  input.value = ''; c.draft = ''; renderHistory(); resize(); await requestAnswer(c, message, questionIndex);
}
function showSource(messageId, number) {
  const s = current()?.messages.find(m => m.id === messageId)?.answer?.sources.find(s => s.number === number); if (!s) return;
  const original = documents.find(d => d.id === s.documentId);
  $('#source-content').innerHTML = `<h2 id="source-title">${esc(s.title)}</h2><dl class="detail-meta"><div><dt>Code documentaire</dt><dd>${esc(s.code)}</dd></div><div><dt>Version</dt><dd>${esc(s.version)}</dd></div><div><dt>Localisation</dt><dd>${s.page ? 'Page ' + s.page : esc(s.section) + ' · sans pagination'}</dd></div><div><dt>Nature</dt><dd>${s.fictional ? 'Document fictif de démonstration' : 'Document de votre bibliothèque'}</dd></div></dl><div class="sources-label">PASSAGE CITÉ</div><blockquote class="source-quote">${esc(s.quote)}</blockquote><details class="source-context"><summary>Lire le contexte de l’extrait</summary>${esc(s.content)}</details>${original?.file ? '<button class="secondary" id="open-original">' + icon('doc') + 'Ouvrir le document original</button>' : '<p class="small-note">Extrait conservé avec la réponse. Le fichier original n’est pas disponible dans cette bibliothèque.</p>'}`;
  $('#open-original')?.addEventListener('click', () => openOriginal(original, s.page));
  $('#source-dialog').showModal();
}
function openOriginal(document, page) {
  if (currentURL) URL.revokeObjectURL(currentURL);
  currentURL = URL.createObjectURL(document.file);
  const link = window.document.createElement('a'); link.href = currentURL + (page ? `#page=${page}` : ''); link.target = '_blank'; link.rel = 'noopener';
  if (!/\.pdf$/i.test(document.filename)) link.download = document.filename;
  link.click();
}

function renderDocuments() {
  const term = $('#doc-search').value.toLocaleLowerCase('fr'), status = $('#doc-filter').value;
  const rows = (useDemo ? demoDocuments : documents).filter(d => (status === 'all' || (status === 'approved' ? isActive(d) : d.status === status)) && `${d.title} ${d.code} ${d.version}`.toLocaleLowerCase('fr').includes(term)).sort((a,b) => (b.created || 0) - (a.created || 0));
  $('#document-list').innerHTML = rows.length ? rows.map(d => `<button class="document-row" data-document="${esc(d.id)}"><span class="doc-icon">${icon('doc')}</span><span><strong>${esc(d.title)}</strong><small>${esc(d.code)} · v${esc(d.version)}${d.pages ? ' · ' + d.pages + ' p.' : ''}${d.fictional ? ' · Démonstration fictive' : ''}</small></span><span class="doc-status ${isActive(d) ? 'active' : ''}">${isActive(d) ? 'Actif' : d.status === 'archived' ? 'Archivé' : ['approved','reviewed'].includes(d.status) ? 'À venir' : 'Brouillon'}</span>${icon('chevron')}</button>`).join('') : `<div class="empty-library">${icon('book')}<h2>${term || status !== 'all' ? 'Aucun document correspondant' : 'Votre bibliothèque commence ici'}</h2><p>${term || status !== 'all' ? 'Essayez un autre terme ou modifiez le filtre.' : 'Ajoutez une procédure, vérifiez le texte et activez-la pour retrouver ses passages dans le chat.'}</p>${!documents.length && !useDemo ? '<button class="primary" data-import>' + icon('plus') + 'Ajouter un document</button>' : ''}</div>`;
  syncContext();
}
function showDocument(id) {
  const d = [...documents, ...demoDocuments].find(d => d.id === id); if (!d) return;
  $('#detail-title').textContent = d.title;
  $('#document-detail').innerHTML = `<dl class="detail-meta"><div><dt>Code · version</dt><dd>${esc(d.code)} · v${esc(d.version)}</dd></div><div><dt>Statut</dt><dd>${isActive(d) ? 'Actif pour le chat' : d.status === 'archived' ? 'Archivé' : 'Inactif'}</dd></div><div><dt>Entrée en vigueur</dt><dd>${esc(d.effective || 'Non renseignée')}</dd></div><div><dt>Fichier</dt><dd>${esc(d.filename || 'Exemple fictif intégré')}</dd></div></dl><div class="detail-actions">${d.file ? '<button class="secondary" id="detail-original">' + icon('doc') + 'Ouvrir l’original</button>' : ''}${!d.fictional ? `<button class="secondary" id="toggle-document">${isActive(d) ? 'Archiver' : 'Activer pour le chat'}</button><button class="danger" id="delete-document">Supprimer</button>` : ''}</div><div class="detail-text">${esc(d.content)}</div>`;
  $('#detail-original')?.addEventListener('click', () => openOriginal(d));
  $('#toggle-document')?.addEventListener('click', async () => {
    if (!isActive(d) && !confirm('Avez-vous vérifié le texte et confirmé que cette version est approuvée et en vigueur ? L’activer remplacera les autres versions actives de ce code.')) return;
    try {
      const activating = !isActive(d); const next = { ...d, status: activating ? 'approved' : 'archived' };
      if (activating && d.effective && d.effective > new Date().toISOString().slice(0, 10)) { notify('La date d’entrée en vigueur est dans le futur.'); return; }
      await replaceActiveVersions(next); documents = await readAll('documents'); renderDocuments(); showDocumentContentAfterUpdate(id);
    } catch { notify('Modification impossible dans ce navigateur.'); }
  });
  $('#delete-document')?.addEventListener('click', async () => {
    if (!confirm('Supprimer ce document de ce navigateur ? Les extraits cités dans les discussions existantes seront conservés.')) return;
    try { await write('documents', 'delete', d.id); documents = await readAll('documents'); $('#document-dialog').close(); renderDocuments(); notify('Document supprimé de ce navigateur.'); } catch { notify('La suppression a échoué.'); }
  });
  if (!$('#document-dialog').open) $('#document-dialog').showModal();
}
function showDocumentContentAfterUpdate(id) { showDocument(id); syncContext(); }
function replaceActiveVersions(record) {
  if (!db) return Promise.reject(new Error('Stockage indisponible'));
  return new Promise((resolve, reject) => {
    const t = db.transaction('documents', 'readwrite'), store = t.objectStore('documents');
    if (isActive(record)) for (const old of documents) if (old.id !== record.id && old.code.trim().toUpperCase() === record.code.trim().toUpperCase() && isActive(old)) store.put({ ...old, status: 'archived' });
    store.put(record); t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  });
}
function openImport() {
  fileGeneration++; selectedFile = null; extracting = false; $('#import-form').reset(); $('#save-document').disabled = true;
  $('#file-label').textContent = 'Choisir un fichier'; $('#file-status').textContent = ''; $('#page-count').textContent = ''; $('#form-error').textContent = '';
  $('#import-dialog').showModal();
}
async function processFile(file) {
  if (!file) return;
  const generation = ++fileGeneration; selectedFile = null; extracting = true; $('#save-document').disabled = true; $('#form-error').textContent = ''; $('#extracted').value = ''; $('#page-count').textContent = '';
  try {
    if (file.size > 10 * 1024 * 1024) throw new Error('Le fichier dépasse la limite de 10 Mo.');
    const ext = file.name.split('.').pop().toLowerCase(); if (!['pdf','docx','txt'].includes(ext)) throw new Error('Choisissez un PDF, DOCX ou TXT.');
    $('#file-label').textContent = file.name; $('#file-status').textContent = 'Extraction du texte…';
    const result = ext === 'pdf' ? await extractPDF(file) : ext === 'docx' ? await extractDOCX(file) : { text: await file.text(), pages: null, hasText: true };
    if (generation !== fileGeneration) return;
    if (result.text.length > 180000) throw new Error('Ce document dépasse 180 000 caractères. Importez une procédure plus courte pour ce pilote.');
    selectedFile = { file, pages: result.pages };
    $('#extracted').value = result.text; $('#page-count').textContent = result.pages ? result.pages + ' pages' : 'Sans pagination';
    $('#file-status').textContent = result.hasText && result.text.trim().length >= 30 ? 'Texte extrait. Vérifiez son exactitude avant l’activation.' : 'Pas de texte exploitable. Ajoutez une transcription vérifiée ; les PDF scannés ne sont pas lus automatiquement.';
    if (!$('#import-form').elements.title.value) $('#import-form').elements.title.value = file.name.replace(/\.[^.]+$/, '');
  } catch (error) { if (generation === fileGeneration) { $('#file-status').textContent = ''; $('#form-error').textContent = error.message || 'Le document ne peut pas être lu.'; } }
  finally { if (generation === fileGeneration) { extracting = false; $('#save-document').disabled = !selectedFile || !db; } }
}
function openScope() {
  const scope = (current() ? current().scope : draftScope), available = corpus().filter(d => isActive(d));
  $('#scope-content').innerHTML = `<label class="checkbox"><input id="scope-all" type="checkbox" ${scope === null ? 'checked' : ''}><span>Tous les documents actifs</span></label><div class="scope-options">${available.length ? available.map(d => `<label class="checkbox"><input type="checkbox" data-scope="${esc(d.id)}" ${scope === null || scope.includes(d.id) ? 'checked' : ''}><span><strong>${esc(d.title)}</strong><small>${esc(d.code)} · v${esc(d.version)}</small></span></label>`).join('') : '<p class="settings-description">Aucun document actif. Importez une procédure et vérifiez son contenu avant de l’activer.</p>'}</div>`;
  $('#scope-dialog').showModal();
}
async function setScope(value) { const c = current(); if (c) { c.scope = value; await persist(c); } else draftScope = value; syncContext(); }

function clearSession() { try { sessionStorage.removeItem('labguard-session'); } catch {} }
function updateConnection() {
  const connected = config.ready && session && !useDemo;
  $('#connection-label').textContent = connected ? 'IA connectée' : 'Lecture documentaire';
  $('#connection-status').classList.toggle('connected', !!connected);
  $('#account-label').textContent = session?.email || 'Stockage dans ce navigateur';
  $('#auth-connected').hidden = !session;
  $('#auth-form').hidden = !config.authConfigured || !!session;
  $('#session-email').textContent = session?.email || '';
  $('#setup-description').textContent = !config.ready
    ? 'Le chat est en lecture documentaire : il affiche les passages retrouvés, sans synthèse IA. La connexion IA nécessite la configuration du serveur et la réactivation du service de connexion.'
    : session ? 'Les questions utilisent l’IA avec les documents actifs sélectionnés. Les sources sont consultables dans chaque réponse.' : 'Connectez-vous avec un compte autorisé pour obtenir une synthèse IA. Sans connexion, vous pouvez consulter les passages retrouvés localement.';
}
async function loadConfiguration() {
  try { const response = await fetch('/api/config', { cache: 'no-store' }); if (response.ok) config = await response.json(); } catch {}
  try { const saved = JSON.parse(sessionStorage.getItem('labguard-session') || 'null'); if (saved?.expires_at > Date.now() / 1000) session = saved; else clearSession(); } catch { clearSession(); }
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('access_token')) {
    const access = fragment.get('access_token'), expires = Number(fragment.get('expires_in') || 3600);
    // Remove auth tokens from the address bar before any other navigation.
    history.replaceState(null, '', location.pathname + location.search + '#assistant');
    if (config.authConfigured && access && /^[A-Za-z0-9._-]+$/.test(access)) {
      try {
        const result = await fetch(`${config.supabaseUrl}/auth/v1/user`, { headers: { apikey: config.publishableKey, Authorization: `Bearer ${access}` } });
        if (!result.ok) throw new Error(); const user = await result.json();
        session = { access_token: access, expires_at: Date.now() / 1000 + Math.min(expires, 86400), email: user.email };
        sessionStorage.setItem('labguard-session', JSON.stringify(session)); notify('Connexion établie.');
      } catch { notify('Le lien de connexion a expiré ou le service est indisponible.'); }
    }
  }
  updateConnection();
}

$('#chat-form').addEventListener('submit', event => { event.preventDefault(); sendQuestion(); });
input.addEventListener('input', () => { resize(); const c = current(); if (c) c.draft = input.value; });
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!requests.has(activeId)) sendQuestion(); } });
$('#new-chat').onclick = () => newChat();
$('#open-sidebar').onclick = () => { document.body.classList.remove('sidebar-collapsed'); $('#sidebar').classList.add('open'); $('#sidebar').inert = false; $('#sidebar').setAttribute('aria-hidden', 'false'); $('#scrim').hidden = matchMedia('(min-width:761px)').matches; $('#open-sidebar').setAttribute('aria-expanded','true'); };
$('#close-sidebar').onclick = () => { if (matchMedia('(min-width:761px)').matches) document.body.classList.add('sidebar-collapsed'); closeSidebar(); };
matchMedia('(max-width:760px)').addEventListener('change', closeSidebar);
$('#scrim').onclick = closeSidebar;
$('#history-search').oninput = renderHistory;
$('#doc-search').oninput = renderDocuments; $('#doc-filter').onchange = renderDocuments;
$('#open-scope').onclick = openScope;
$('#open-settings').onclick = $('#connection-status').onclick = () => { updateConnection(); $('#settings-dialog').showModal(); };
$('#toggle-theme').onclick = () => setTheme(document.documentElement.dataset.theme !== 'dark');
$('#try-demo').onclick = () => { newChat(false); useDemo = true; syncContext(); updateConnection(); input.focus(); notify('Exemples fictifs activés. Choisissez une question pour essayer.'); };
$('#leave-demo').onclick = () => { newChat(); updateConnection(); };
$$('[data-question]').forEach(button => button.onclick = () => { if (!documents.some(d => isActive(d)) && !useDemo) useDemo = true; input.value = button.dataset.question; syncContext(); updateConnection(); sendQuestion(); });
window.addEventListener('hashchange', navigate);
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeSidebar(); if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); newChat(); } });
document.addEventListener('click', async event => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.hasAttribute('data-close')) button.closest('dialog').close();
  if (button.hasAttribute('data-import')) openImport();
  if (button.dataset.chat) activate(button.dataset.chat);
  if (button.dataset.deleteChat) {
    if (!confirm('Supprimer cette discussion de ce navigateur ?')) return;
    const id = button.dataset.deleteChat;
    const target = conversations.find(c => c.id === id); if (target) target.deleted = true;
    try { requests.get(id)?.abort(); await write('conversations', 'delete', id); conversations = conversations.filter(c => c.id !== id); if (id === activeId) newChat(); renderHistory(); } catch { notify('La discussion n’a pas pu être supprimée.'); }
  }
  if (button.dataset.citation) showSource(button.dataset.message, Number(button.dataset.citation));
  if (button.dataset.document) showDocument(button.dataset.document);
  if (button.dataset.copy) {
    const answer = current()?.messages.find(m => m.id === button.dataset.copy)?.answer; if (!answer) return;
    const text = [answer.mode === 'ai' ? 'Réponse IA LabGuard' : 'Extraits documentaires — sans synthèse IA', answer.message, ...answer.paragraphs.map(p => `${p.text} ${p.citations.map(n => '['+n+']').join(' ')}`), ...answer.sources.map(s => `[${s.number}] ${s.title} — ${s.code}, v${s.version}, ${s.page ? 'page '+s.page : s.section}${s.fictional ? ' (document fictif)' : ''}\n« ${s.quote} »`)].filter(Boolean).join('\n\n');
    try { await navigator.clipboard.writeText(text); notify('Réponse et références copiées.'); } catch { notify('La copie n’est pas autorisée par ce navigateur.'); }
  }
  if (button.dataset.retry) {
    const c = current(), index = c?.messages.findIndex(m => m.id === button.dataset.retry);
    if (c && index > 0 && !requests.has(c.id)) requestAnswer(c, c.messages[index], index - 1);
  }
});
$('#scope-content').addEventListener('change', async event => {
  if (event.target.id === 'scope-all') { const all = event.target.checked; $$('[data-scope]').forEach(x => x.checked = all); await setScope(all ? null : []); }
  else if (event.target.dataset.scope) { const values = $$('[data-scope]').filter(x => x.checked).map(x => x.dataset.scope); $('#scope-all').checked = values.length === $$('[data-scope]').length; await setScope($('#scope-all').checked ? null : values); }
});
$('#file-input').onchange = () => processFile($('#file-input').files[0]);
const dropzone = $('#dropzone');
['dragenter','dragover'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.add('dragging'); }));
['dragleave','drop'].forEach(type => dropzone.addEventListener(type, event => { event.preventDefault(); dropzone.classList.remove('dragging'); }));
dropzone.addEventListener('drop', event => processFile(event.dataTransfer.files[0]));
$('#import-dialog').addEventListener('close', () => { fileGeneration++; selectedFile = null; extracting = false; });
$('#import-form').onsubmit = async event => {
  event.preventDefault(); if (!selectedFile || extracting || !db) return;
  const form = event.currentTarget, content = $('#extracted').value.trim();
  if (content.length < 30 || content.length > 180000) { $('#form-error').textContent = 'Le texte vérifié doit contenir entre 30 et 180 000 caractères.'; return; }
  const { title, code, version, effective, reviewed } = form.elements;
  if (![title, code, version].every(x => x.value.trim())) { $('#form-error').textContent = 'Renseignez le titre, le code et la version.'; return; }
  if (reviewed.checked && effective.value && effective.value > new Date().toISOString().slice(0,10)) { $('#form-error').textContent = 'Une procédure ne peut être activée avant sa date d’entrée en vigueur.'; return; }
  const old = documents.filter(d => d.code.trim().toUpperCase() === code.value.trim().toUpperCase() && isActive(d));
  if (reviewed.checked && old.length && !confirm('Ce code possède déjà une version active. Archiver les versions actives précédentes et activer celle-ci ?')) return;
  $('#save-document').disabled = true;
  try {
    const record = { id: uuid(), title: title.value.trim(), code: code.value.trim(), version: version.value.trim(), effective: effective.value, status: reviewed.checked ? 'approved' : 'draft', content, file: selectedFile.file, filename: selectedFile.file.name, pages: selectedFile.pages, created: Date.now() };
    await replaceActiveVersions(record); documents = await readAll('documents'); $('#import-dialog').close(); useDemo = false; if (current()?.demo) { activeId = null; renderChat(); renderHistory(); } draftScope = null; renderDocuments(); updateConnection(); location.hash = 'documents'; notify(record.status === 'approved' ? 'Document actif pour vos prochaines questions.' : 'Brouillon enregistré. Vérifiez-le avant de l’activer.');
  } catch { $('#form-error').textContent = 'Le document n’a pas pu être enregistré. Vérifiez l’espace de stockage disponible.'; }
  finally { $('#save-document').disabled = !selectedFile || !db; }
};
$('#auth-form').onsubmit = async event => {
  event.preventDefault(); if (!config.authConfigured) return;
  $('#auth-submit').disabled = true; $('#auth-message').textContent = 'Envoi du lien…';
  try {
    const redirect = location.origin + '/';
    const response = await fetch(`${config.supabaseUrl}/auth/v1/otp?redirect_to=${encodeURIComponent(redirect)}`, { method: 'POST', headers: { apikey: config.publishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('#auth-email').value.trim(), create_user: false }) });
    if (!response.ok) throw new Error(); $('#auth-message').textContent = 'Si cette adresse dispose d’un compte autorisé, un lien de connexion a été envoyé. Ouvrez-le dans ce navigateur.';
  } catch { $('#auth-message').textContent = 'Envoi impossible. Le service de connexion peut être en pause ou indisponible.'; }
  finally { $('#auth-submit').disabled = false; }
};
$('#sign-out').onclick = async () => { const token = session?.access_token; session = null; clearSession(); updateConnection(); notify('Déconnexion effectuée.'); if (token && config.authConfigured) try { await fetch(`${config.supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: config.publishableKey, Authorization: `Bearer ${token}` } }); } catch {} };
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target !== dialog) return; const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); }));
try { await openDB(); } catch { notify('Le stockage est indisponible. Les documents et discussions ne pourront pas être enregistrés.'); }
navigate(); renderDocuments(); renderHistory(); renderChat(); loadConfiguration();
