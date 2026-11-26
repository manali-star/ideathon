const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const gate = $('#workspace-gate');
const dashboard = $('#dashboard');
const tokenForm = $('#token-form');
const tokenInput = $('#admin-token');
const message = $('#judge-message');
const list = $('#submission-list');
const searchInput = $('#submission-search');
const domainSelect = $('#submission-domain');
const statusSelect = $('#submission-status');
const sortSelect = $('#submission-sort');
const reviewDialog = $('#review-dialog');
const reviewContent = $('#review-content');
let accessToken = '';
let currentRole = 'Organizer';
let entries = [];
let announcements = [];
let settings = {};

const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const dateLabel = (value) => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value)) : '—';
const timestamp = (value) => value ? new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
const initials = (value = 'Team') => value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
const api = async (url, options = {}) => {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${accessToken}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, cache: 'no-store' });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Could not complete that request.');
  return body;
};
const countWords = (text) => String(text || '').trim().split(/\s+/).filter(Boolean).length;

function setView(name) {
  $$('.dashboard-view').forEach((view) => view.classList.toggle('hidden', view.id !== `view-${name}`));
  $$('.side-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  const titles = { overview: 'Event overview', projects: 'Project review', announcements: 'Event announcements', operations: 'Event settings' };
  $('#dashboard-title').textContent = currentRole === 'Participant' ? 'Your event journey' : currentRole === 'Mentor' ? 'Team mentoring' : titles[name] || titles.overview;
  $('#breadcrumb-role').textContent = name.toUpperCase();
  if (location.hash !== `#${name}`) history.replaceState(null, '', `#${name}`);
}

function statusClass(status) { return `status-${String(status || 'Submitted').toLowerCase().replace(/\s+/g, '-')}`; }
function renderAnnouncements(target, items, empty = 'No announcements yet. Updates from the event team will appear here.') {
  if (!target) return;
  if (!items.length) { target.innerHTML = `<div class="empty-note">${esc(empty)}</div>`; return; }
  const overview = target.id === 'overview-announcements';
  target.innerHTML = items.slice(0, overview ? 3 : 50).map((item) => `<article class="announcement-entry"><div class="announcement-date">${dateLabel(item.publishedAt)} <span>·</span> EVENT UPDATE</div><h4>${esc(item.title)}</h4><p>${esc(item.message)}</p>${overview ? '' : `<button class="announcement-delete" type="button" data-announcement-id="${esc(item.id)}">Delete announcement</button>`}</article>`).join('');
  if (!overview) $$('[data-announcement-id]', target).forEach((button) => button.addEventListener('click', async () => {
    if (!window.confirm('Delete this announcement? It will also disappear from the event homepage.')) return;
    button.disabled = true;
    try { await api(`/api/admin/announcements/${encodeURIComponent(button.dataset.announcementId)}`, { method: 'DELETE' }); await refresh(); }
    catch (error) { button.disabled = false; button.textContent = error.message; }
  }));
}

function renderOverview(metrics) {
  $('#metric-registrations').textContent = metrics.registrations ?? 0;
  $('#metric-teams').textContent = metrics.submissions ?? 0;
  $('#metric-review').textContent = metrics.statuses?.['Under Review'] ?? 0;
  $('#metric-selected').textContent = metrics.selected ?? 0;
  const total = Math.max(metrics.submissions || 0, 1);
  const pipeline = $('#pipeline');
  const statusRows = [['Submitted', 'Newly received'], ['Under Review', 'In evaluation'], ['Selected', 'Going forward'], ['Rejected', 'Not selected']];
  pipeline.innerHTML = statusRows.map(([name, sub]) => { const number = metrics.statuses?.[name] || 0; const pct = Math.round(number / total * 100); return `<div class="pipeline-row"><span class="pipeline-name">${esc(name)}<small>${esc(sub)}</small></span><div class="pipeline-track"><i class="${statusClass(name)}" style="width:${pct}%"></i></div><span class="pipeline-count">${number}<small>${pct}%</small></span></div>`; }).join('');
  const domains = new Map(); entries.forEach((entry) => domains.set(entry.domain || 'Unassigned', (domains.get(entry.domain || 'Unassigned') || 0) + 1));
  const max = Math.max(...domains.values(), 1);
  $('#domain-breakdown').innerHTML = domains.size ? [...domains.entries()].sort((a, b) => b[1] - a[1]).map(([domain, amount]) => `<div class="domain-row"><span>${esc(domain)}</span><span class="domain-track"><i style="width:${Math.max(6, amount / max * 100)}%"></i></span><b>${amount}</b></div>`).join('') : '<div class="empty-note">Domain activity will take shape as teams submit ideas.</div>';
}

function renderProjects() {
  if (!list) return;
  const query = searchInput.value.trim().toLowerCase(); const domain = domainSelect.value; const status = statusSelect.value; const sort = sortSelect.value;
  const filtered = entries.filter((entry) => (!domain || entry.domain === domain) && (!status || (entry.status || 'Submitted') === status) && (!query || [entry.teamName, entry.idea, entry.teamLead, entry.college, entry.projectTitle].some((value) => String(value || '').toLowerCase().includes(query))));
  filtered.sort((a, b) => sort === 'oldest' ? a.submittedAt.localeCompare(b.submittedAt) : sort === 'team' ? a.teamName.localeCompare(b.teamName) : sort === 'domain' ? a.domain.localeCompare(b.domain) || a.teamName.localeCompare(b.teamName) : b.submittedAt.localeCompare(a.submittedAt));
  $('#project-total').textContent = entries.length; $('#nav-project-count').textContent = entries.length;
  if (!filtered.length) { list.innerHTML = `<div class="empty-projects"><span>IDEAS IN PROGRESS</span><strong>${entries.length ? 'No projects match these filters.' : 'Your next great idea is on its way.'}</strong><p>${entries.length ? 'Try a different team name, domain, or review status.' : 'Submitted teams will be collected here for review.'}</p></div>`; return; }
  list.innerHTML = filtered.map((entry) => `<article class="project-row"><div class="project-identity"><span class="project-avatar">${esc(initials(entry.teamName))}</span><span><strong>${esc(entry.projectTitle || entry.teamName || 'Untitled idea')}</strong><small>${esc(entry.teamName)} <i>·</i> ${esc(entry.teamLead || 'Team lead')}${entry.college ? ` <i>·</i> ${esc(entry.college)}` : ''}</small></span></div><span class="project-domain">${esc(entry.domain || 'Unassigned')}</span><span class="project-date">${dateLabel(entry.submittedAt)}</span><span><em class="status-pill ${statusClass(entry.status)}">${esc(entry.status || 'Submitted')}</em></span><button class="review-open" data-entry="${esc(entry.id)}">Open review <b>↗</b></button></article>`).join('');
  $$('.review-open', list).forEach((button) => button.addEventListener('click', () => openReview(entries.find((entry) => entry.id === button.dataset.entry))));
}

function renderDashboard(data) {
  entries = data.submissions || []; announcements = data.announcements || []; settings = data.settings || {};
  $('#today-label').textContent = new Intl.DateTimeFormat('en-IN', { dateStyle: 'full' }).format(new Date());
  renderOverview(data.metrics || {}); renderProjects();
  renderAnnouncements($('#overview-announcements'), announcements);
  renderAnnouncements($('#announcement-feed'), announcements, 'No announcements have been published.');
  const form = $('#settings-form');
  if (settings.deadline) form.elements.deadline.value = new Date(settings.deadline).toISOString().slice(0, 16);
  if (settings.eventName) form.elements.eventName.value = settings.eventName;
  if (!announcements.length) $('#overview-announcements').innerHTML = '<div class="empty-note">Event announcements will appear here when published.</div>';
}

function roleLayout() {
  $('#role-name').textContent = currentRole;
  $('#role-subtitle').textContent = currentRole === 'Organizer' ? 'Event operations' : currentRole === 'Judge' ? 'Project evaluation' : currentRole === 'Mentor' ? 'Team guidance' : 'Team workspace';
  $('#role-avatar').textContent = initials(currentRole);
  $$('.role-organizer').forEach((item) => item.classList.toggle('hidden', currentRole !== 'Organizer'));
  if (currentRole === 'Judge') { $('#metric-registrations').closest('.metric-card').classList.add('hidden'); $('#metric-teams').closest('.metric-card').querySelector('span').lastChild.textContent = 'Assigned ideas'; }
  if (currentRole === 'Mentor' || currentRole === 'Participant') { $('#metric-review').closest('.metric-card').querySelector('span').lastChild.textContent = currentRole === 'Mentor' ? 'MENTORING' : 'TEAM STATUS'; }
}

async function enterWorkspace() {
  message.textContent = 'Opening your event workspace…'; message.style.color = '';
  try {
    const auth = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: tokenInput.value }), cache: 'no-store' });
    const authResult = await auth.json().catch(() => ({}));
    if (!auth.ok) throw new Error(authResult.error || 'Could not sign in.');
    accessToken = authResult.token;
    const data = await api('/api/admin/dashboard');
    currentRole = 'Organizer';
    roleLayout(); renderDashboard(data);
    gate.classList.add('hidden'); dashboard.classList.remove('hidden'); $('#header-lock').classList.remove('hidden');
    const initialView = ['overview', 'projects', 'announcements', 'operations'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'overview';
    setView(currentRole === 'Organizer' ? initialView : currentRole === 'Participant' ? 'projects' : 'projects');
  } catch (error) { accessToken = ''; message.textContent = error.message; message.style.color = '#a3402f'; }
}

async function openReview(entry) {
  if (!entry) return;
  const evaluation = entry.evaluation || {}; const scores = evaluation.scores || {};
  const scoreKeys = [['innovation', 'Innovation'], ['feasibility', 'Technical feasibility'], ['impact', 'Expected impact'], ['scalability', 'Scalability'], ['presentation', 'Presentation quality']];
  const documentUrl = `/api/admin/submissions/${encodeURIComponent(entry.id)}/inline`;
  const preview = entry.fileName ? `<div class="document-preview"><div class="preview-toolbar"><span><i></i> ${esc(entry.originalFileName || 'Project presentation')}</span><a href="/api/admin/submissions/${encodeURIComponent(entry.id)}/presentation" class="document-download" data-download="${esc(entry.id)}">Download deck ↓</a></div><iframe title="${esc(entry.teamName)} presentation" src="${documentUrl}#toolbar=0&navpanes=0"></iframe><small>Some browsers cannot display PowerPoint files inline. Download the original deck to open it.</small></div>` : '<div class="no-document">No presentation file was included with this idea.</div>';
  reviewContent.innerHTML = `<div class="review-eyebrow">PROJECT REVIEW / ${esc(entry.domain || 'IDEATHON')}</div><h2 id="review-heading">${esc(entry.projectTitle || entry.teamName || 'Untitled idea')}</h2><p class="review-team">${esc(entry.teamName)} <span>·</span> Led by ${esc(entry.teamLead)} <span>·</span> ${esc(entry.email)}</p><div class="review-status-line"><em class="status-pill ${statusClass(entry.status)}">${esc(entry.status || 'Submitted')}</em><span>Received ${timestamp(entry.submittedAt)}</span><select id="review-status" aria-label="Update project status"><option ${(!entry.status || entry.status === 'Submitted') ? 'selected' : ''}>Submitted</option><option ${entry.status === 'Under Review' ? 'selected' : ''}>Under Review</option><option ${entry.status === 'Selected' ? 'selected' : ''}>Selected</option><option ${entry.status === 'Rejected' ? 'selected' : ''}>Rejected</option></select><button id="save-status" class="mini-save">Save status</button></div><div class="review-grid"><div class="review-details"><section><span>THE PROBLEM</span><p>${esc(entry.problemStatement || entry.idea || 'No problem statement was added.')}</p></section><section><span>PROPOSED SOLUTION</span><p>${esc(entry.proposedSolution || entry.idea || 'No detailed solution was added.')}</p></section><div class="review-detail-columns"><section><span>INNOVATION &amp; UNIQUENESS</span><p>${esc(entry.innovation || '—')}</p></section><section><span>TECHNOLOGY STACK</span><p>${esc(entry.techStack || '—')}</p></section></div><section><span>EXPECTED IMPACT</span><p>${esc(entry.impact || '—')}</p></section><section><span>TEAM CONTACT</span><p>${esc(entry.email)} · ${esc(entry.phone)}${entry.college ? `<br />${esc(entry.college)}` : ''}</p></section></div><aside class="evaluation-card"><div class="eval-title"><div><span>JUDGE / MENTOR REVIEW</span><h3>Thoughtful feedback.</h3></div><strong id="score-total">${evaluation.total ?? 0}<small> / 50</small></strong></div><form id="evaluation-form"><div class="score-fields">${scoreKeys.map(([key, label]) => `<label>${label}<span><input name="${key}" type="number" min="0" max="10" step="1" value="${Number.isInteger(scores[key]) ? scores[key] : ''}" placeholder="0" required /><small>/ 10</small></span></label>`).join('')}</div><label class="feedback-field">REVIEWER NOTES<textarea name="feedback" rows="4" maxlength="4000" placeholder="A few useful observations for the team…">${esc(evaluation.feedback || '')}</textarea></label><button class="button button-dark" type="submit">Save evaluation ↗</button><p id="evaluation-feedback" class="form-feedback" role="status"></p></form></aside></div><section class="review-history"><span>REVIEW HISTORY</span>${(entry.history || []).length ? entry.history.map((record) => `<small>${esc(record.status)} <i>·</i> ${timestamp(record.at)}</small>`).join('') : '<small>No status changes recorded.</small>'}</section>${preview}`;
  reviewDialog.classList.remove('hidden'); document.body.classList.add('dialog-open');
  $('#save-status').addEventListener('click', async () => { const button = $('#save-status'); button.disabled = true; try { await api(`/api/admin/submissions/${encodeURIComponent(entry.id)}/status`, { method: 'PATCH', body: JSON.stringify({ status: $('#review-status').value }) }); await refresh(); openReview(entries.find((item) => item.id === entry.id)); } catch (error) { button.textContent = error.message; } finally { button.disabled = false; } });
  const scoreForm = $('#evaluation-form');
  scoreForm.querySelectorAll('input[type=number]').forEach((input) => input.addEventListener('input', () => { const total = [...scoreForm.querySelectorAll('input[type=number]')].reduce((sum, node) => sum + (Number(node.value) || 0), 0); $('#score-total').innerHTML = `${total}<small> / 50</small>`; }));
  scoreForm.addEventListener('submit', async (event) => { event.preventDefault(); const formData = new FormData(scoreForm); const body = { scores: Object.fromEntries(scoreKeys.map(([key]) => [key, Number(formData.get(key))])), feedback: formData.get('feedback'), reviewer: currentRole };
    try { await api(`/api/admin/submissions/${encodeURIComponent(entry.id)}/evaluation`, { method: 'PUT', body: JSON.stringify(body) }); const feedback = $('#evaluation-feedback'); feedback.textContent = 'Evaluation saved to the review history.'; await refresh(); } catch (error) { $('#evaluation-feedback').textContent = error.message; }
  });
  $$('[data-download]', reviewContent).forEach((link) => link.addEventListener('click', async (event) => { event.preventDefault(); try { const response = await fetch(link.href, { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' }); if (!response.ok) throw new Error('Could not download this deck.'); const blob = await response.blob(); const objectURL = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = objectURL; a.download = `ideathon-${entry.id}-${(entry.originalFileName || 'deck.pptx').replace(/[\\/:*?"<>|]/g, '_')}`; a.click(); URL.revokeObjectURL(objectURL); } catch (error) { link.textContent = error.message; } }));
}

async function refresh() { const data = await api('/api/admin/dashboard'); renderDashboard(data); }
function lock() { accessToken = ''; tokenInput.value = ''; dashboard.classList.add('hidden'); gate.classList.remove('hidden'); $('#header-lock').classList.add('hidden'); reviewDialog.classList.add('hidden'); document.body.classList.remove('dialog-open'); message.textContent = 'Use the password set by the event administrator.'; message.style.color = ''; }

tokenForm.addEventListener('submit', async (event) => { event.preventDefault(); accessToken = tokenInput.value.trim(); if (accessToken) await enterWorkspace(); });
['input', 'change'].forEach((type) => { searchInput.addEventListener(type, renderProjects); domainSelect.addEventListener(type, renderProjects); statusSelect.addEventListener(type, renderProjects); sortSelect.addEventListener(type, renderProjects); });
$$('[data-view]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); const view = link.dataset.view; if (view === 'operations' && currentRole !== 'Organizer') return; setView(view); }));
$('#header-lock').addEventListener('click', lock); $('#side-lock').addEventListener('click', lock);
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => { reviewDialog.classList.add('hidden'); document.body.classList.remove('dialog-open'); }));
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && !reviewDialog.classList.contains('hidden')) { reviewDialog.classList.add('hidden'); document.body.classList.remove('dialog-open'); } });

$('#announcement-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const data = new FormData(form); const feedback = $('#announcement-feedback'); try { await api('/api/admin/announcements', { method: 'POST', body: JSON.stringify({ title: data.get('title'), message: data.get('message') }) }); form.reset(); feedback.textContent = 'Your announcement has been published.'; await refresh(); } catch (error) { feedback.textContent = error.message; } });
$('#settings-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = event.currentTarget; const feedback = $('#settings-feedback'); try { const result = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify({ eventName: form.elements.eventName.value, deadline: form.elements.deadline.value ? new Date(form.elements.deadline.value).toISOString() : '' }) }); settings = result.settings; feedback.textContent = 'Event details saved.'; } catch (error) { feedback.textContent = error.message; } });

const theme = localStorage.getItem('ideathon-theme'); if (theme === 'dark') document.body.classList.add('theme-dark');
$('#theme-toggle').addEventListener('click', () => { document.body.classList.toggle('theme-dark'); localStorage.setItem('ideathon-theme', document.body.classList.contains('theme-dark') ? 'dark' : 'light'); });
if (location.hash && tokenInput.value) setView(location.hash.slice(1));
