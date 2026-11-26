import { randomUUID, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

const MAX_FILE = 4 * 1024 * 1024;
const DOMAINS = new Set(['Construction', 'Agriculture', 'Electro-mechanical', 'Robotics', 'Information Technology', 'Renewable Energy', 'Defence', 'Rural Development', 'Space']);
const TYPES = new Map([
  ['.ppt', 'application/vnd.ms-powerpoint'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
]);
const records = getStore('ideathon-records');
const documents = getStore('ideathon-documents');
const settingsStore = getStore('ideathon-settings');
const workflowStore = getStore('ideathon-workflow');

const json = (status, body, headers = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
};
const getJson = async (store, key, fallback) => (await store.get(key, { type: 'json' })) ?? fallback;
const validId = (id) => /^\d{8}-[0-9a-f]{8}$/.test(id);
async function allSubmissions() {
  const { blobs } = await records.list();
  const entries = await Promise.all(blobs.map(({ key }) => records.get(key, { type: 'json' })));
  return entries.filter(Boolean).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}
async function requireRecord(id) {
  if (!validId(id)) return null;
  return records.get(id, { type: 'json' });
}
async function readJson(request) {
  try { return await request.json(); }
  catch { throw Object.assign(new Error('Please send valid JSON.'), { status: 400 }); }
}
async function route(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');
  if (request.method === 'POST' && path === '/submissions') return submit(request);
  if (request.method === 'GET' && path === '/announcements') return json(200, { announcements: await getJson(settingsStore, 'announcements', []) });
  if (request.method === 'POST' && path === '/auth/login') {
    const password = String((await readJson(request)).password || '');
    const expected = process.env.ADMIN_TOKEN || '';
    if (!expected) return json(503, { error: 'Organizer sign-in is not configured. Set ADMIN_TOKEN in Netlify environment variables.' });
    if (!safeEqual(password, expected)) return json(401, { error: 'That organizer password was not accepted.' });
    return json(200, { ok: true, token: expected, role: 'Organizer' });
  }

  if (!path.startsWith('/admin/')) return json(404, { error: 'API route not found.' });
  const expected = process.env.ADMIN_TOKEN || '';
  const supplied = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!expected || !safeEqual(supplied, expected)) return json(401, { error: expected ? 'Organizer sign-in required.' : 'Set ADMIN_TOKEN in Netlify environment variables to enable organizer sign-in.' });

  if (request.method === 'GET' && path === '/admin/dashboard') {
    const [submissions, workflow, announcements, settings] = await Promise.all([
      allSubmissions(), getJson(workflowStore, 'all', {}), getJson(settingsStore, 'announcements', []), getJson(settingsStore, 'settings', { eventName: 'Aavishkar ’26 · Ideathon', deadline: '' }),
    ]);
    const enriched = submissions.map((entry) => ({ ...entry, ...(workflow[entry.id] || {}) }));
    const statuses = Object.fromEntries(['Submitted', 'Under Review', 'Selected', 'Rejected', 'Draft'].map((status) => [status, enriched.filter((entry) => (entry.status || 'Submitted') === status).length]));
    return json(200, { submissions: enriched, announcements, settings, metrics: { registrations: new Set(enriched.map((entry) => entry.email.toLowerCase())).size, teams: enriched.length, submissions: enriched.length, selected: statuses.Selected, statuses, domains: [...new Set(enriched.map((entry) => entry.domain))].length } });
  }
  if (request.method === 'GET' && path === '/admin/submissions') return json(200, { submissions: await allSubmissions() });

  const statusMatch = path.match(/^\/admin\/submissions\/([^/]+)\/status$/);
  if (request.method === 'PATCH' && statusMatch) {
    const id = decodeURIComponent(statusMatch[1]); if (!await requireRecord(id)) return json(404, { error: 'Submission not found.' });
    const { status } = await readJson(request); const allowed = new Set(['Submitted', 'Under Review', 'Selected', 'Rejected', 'Draft']);
    if (!allowed.has(status)) return json(400, { error: 'Choose a valid workflow status.' });
    const all = await getJson(workflowStore, 'all', {}); const previous = all[id] || {}; const at = new Date().toISOString();
    all[id] = { ...previous, status, updatedAt: at, history: [...(previous.history || []), { status, at }] };
    await workflowStore.setJSON('all', all); return json(200, { ok: true, submission: { id, ...all[id] } });
  }
  const evaluationMatch = path.match(/^\/admin\/submissions\/([^/]+)\/evaluation$/);
  if (['PUT', 'POST'].includes(request.method) && evaluationMatch) {
    const id = decodeURIComponent(evaluationMatch[1]); if (!await requireRecord(id)) return json(404, { error: 'Submission not found.' });
    const body = await readJson(request); const criteria = ['innovation', 'feasibility', 'impact', 'scalability', 'presentation'];
    if (!criteria.every((key) => Number.isInteger(body.scores?.[key]) && body.scores[key] >= 0 && body.scores[key] <= 10)) return json(400, { error: 'Each evaluation score must be a whole number from 0 to 10.' });
    if (typeof body.feedback !== 'string' || body.feedback.length > 4000) return json(400, { error: 'Feedback must be 4,000 characters or fewer.' });
    const all = await getJson(workflowStore, 'all', {}); const previous = all[id] || {};
    const evaluation = { scores: body.scores, total: criteria.reduce((sum, key) => sum + body.scores[key], 0), feedback: body.feedback.trim(), updatedAt: new Date().toISOString(), reviewer: String(body.reviewer || 'Event reviewer').slice(0, 120) };
    all[id] = { ...previous, evaluation, reviews: [...(previous.reviews || []), evaluation] }; await workflowStore.setJSON('all', all);
    return json(200, { ok: true, evaluation });
  }

  if (request.method === 'POST' && path === '/admin/announcements') {
    const body = await readJson(request); const title = String(body.title || '').trim().slice(0, 160); const message = String(body.message || '').trim().slice(0, 1200);
    if (!title || !message) return json(400, { error: 'Enter an announcement title and message.' });
    const announcements = await getJson(settingsStore, 'announcements', []); const announcement = { id: randomUUID(), title, message, publishedAt: new Date().toISOString() };
    announcements.unshift(announcement); await settingsStore.setJSON('announcements', announcements.slice(0, 50)); return json(201, { announcement });
  }
  const announcementMatch = path.match(/^\/admin\/announcements\/([^/]+)$/);
  if (request.method === 'DELETE' && announcementMatch) {
    const id = decodeURIComponent(announcementMatch[1]); const announcements = await getJson(settingsStore, 'announcements', []); const remaining = announcements.filter((item) => item.id !== id);
    if (remaining.length === announcements.length) return json(404, { error: 'Announcement not found.' });
    await settingsStore.setJSON('announcements', remaining); return json(200, { ok: true });
  }
  if (request.method === 'PUT' && path === '/admin/settings') {
    const body = await readJson(request);
    if (body.deadline && !Number.isFinite(Date.parse(body.deadline))) return json(400, { error: 'Enter a valid deadline.' });
    const settings = { eventName: String(body.eventName || 'Aavishkar ’26 · Ideathon').trim().slice(0, 120), deadline: body.deadline || '', updatedAt: new Date().toISOString() };
    await settingsStore.setJSON('settings', settings); return json(200, { settings });
  }

  const fileMatch = path.match(/^\/admin\/submissions\/([^/]+)\/(presentation|inline)$/);
  if (request.method === 'GET' && fileMatch) {
    const id = decodeURIComponent(fileMatch[1]); const record = await requireRecord(id); if (!record?.fileName) return json(404, { error: 'Presentation not found.' });
    const file = await documents.get(id, { type: 'arrayBuffer' }); if (!file) return json(404, { error: 'Presentation not found.' });
    const extension = record.fileName.toLowerCase().endsWith('.pptx') ? '.pptx' : '.ppt'; const mime = TYPES.get(extension);
    return new Response(file, { status: 200, headers: { 'Content-Type': mime, 'Content-Disposition': `${fileMatch[2] === 'inline' ? 'inline' : 'attachment'}; filename="ideathon-${id}${extension}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  }
  return json(404, { error: 'API route not found.' });
}

async function submit(request) {
  const form = await request.formData(); const file = form.get('ppt');
  const fields = Object.fromEntries(['teamName', 'teamLead', 'email', 'phone', 'domain', 'idea'].map((name) => [name, String(form.get(name) || '').trim()]));
  for (const [name, value] of Object.entries(fields)) {
    if (!value) return json(400, { error: `Please provide ${name === 'teamName' ? 'a team name' : name === 'teamLead' ? 'the team lead name' : name === 'email' ? 'an email address' : name === 'phone' ? 'a phone number' : name === 'domain' ? 'a domain' : 'a one-line idea'}.` });
    if (value.length > 500) return json(400, { error: 'A form field is too long.' });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return json(400, { error: 'Please enter a valid email address.' });
  if (!DOMAINS.has(fields.domain)) return json(400, { error: 'Choose one of the listed competition domains.' });
  if (!(file instanceof File) || !file.size) return json(400, { error: 'Please attach your PPT file.' });
  if (file.size > MAX_FILE) return json(413, { error: 'PPT files must be 4 MB or smaller on this Netlify deployment.' });
  const originalFileName = file.name.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 150); const extension = originalFileName.slice(originalFileName.lastIndexOf('.')).toLowerCase();
  if (!TYPES.has(extension)) return json(415, { error: 'Only .ppt and .pptx files are accepted.' });
  if (file.type && file.type !== TYPES.get(extension) && file.type !== 'application/octet-stream') return json(415, { error: 'The attached file does not appear to be a PowerPoint file.' });
  const id = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`; const storedName = `presentation${extension}`;
  const record = { id, submittedAt: new Date().toISOString(), ...fields, originalFileName, fileName: storedName, fileSize: file.size };
  await documents.set(id, new Uint8Array(await file.arrayBuffer()), { metadata: { fileName: originalFileName, contentType: TYPES.get(extension) } });
  await records.setJSON(id, record);
  return json(201, { ok: true, id });
}

export default async (request) => {
  try { return await route(request); }
  catch (error) { console.error('Netlify API request failed:', error); return json(error.status || 500, { error: error.status ? error.message : 'The request could not be completed. Please try again.' }); }
};

export const config = { path: '/api/*' };
