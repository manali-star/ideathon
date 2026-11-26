import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8000);
const HOST = process.env.HOST || '127.0.0.1';
const DATA_DIR = path.resolve(process.env.SUBMISSIONS_DIR || path.join(ROOT, 'private-submissions'));
const PLATFORM_DIR = path.join(DATA_DIR, 'platform');
let ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const MAX_FILE = 20 * 1024 * 1024;
const MAX_REQUEST = MAX_FILE + 1024 * 1024;
const DOMAINS = new Set(['Construction', 'Agriculture', 'Electro-mechanical', 'Robotics', 'Information Technology', 'Renewable Energy', 'Defence', 'Rural Development', 'Space']);
const MIME = new Map([
  ['.ppt', new Set(['application/vnd.ms-powerpoint', 'application/octet-stream'])],
  ['.pptx', new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/zip', 'application/octet-stream'])],
]);
const rate = new Map();

await mkdir(DATA_DIR, { recursive: true });
await mkdir(PLATFORM_DIR, { recursive: true });
if (!ADMIN_TOKEN) {
  const tokenFile = path.join(DATA_DIR, '.organizer-token');
  try {
    ADMIN_TOKEN = (await readFile(tokenFile, 'utf8')).trim();
  } catch {
    ADMIN_TOKEN = randomBytes(32).toString('base64url');
    await writeFile(tokenFile, `${ADMIN_TOKEN}\n`, { flag: 'wx', mode: 0o600 });
  }
}

const send = (res, status, value) => {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
};

const platformPath = (name) => path.join(PLATFORM_DIR, name);
async function readStore(name, fallback) {
  try { return JSON.parse(await readFile(platformPath(name), 'utf8')); }
  catch { return fallback; }
}
async function writeStore(name, value) {
  const target = platformPath(name);
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  await rename(temp, target);
}
function authorized(req) {
  return safeEqual((req.headers.authorization || '').replace(/^Bearer\s+/i, ''), ADMIN_TOKEN);
}
async function readJson(req, max = 256_000) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Please send valid JSON.'), { status: 400 }); }
}
async function listAllSubmissions() {
  const entries = [];
  for (const name of await readdir(DATA_DIR)) {
    if (!/^\d{8}-[0-9a-f]{8}$/.test(name)) continue;
    try { entries.push(JSON.parse(await readFile(path.join(DATA_DIR, name, 'submission.json'), 'utf8'))); } catch { /* Skip incomplete records. */ }
  }
  entries.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  return entries;
}
async function getSubmission(id) {
  if (!/^\d{8}-[0-9a-f]{8}$/.test(id)) return null;
  try { return JSON.parse(await readFile(path.join(DATA_DIR, id, 'submission.json'), 'utf8')); } catch { return null; }
}
async function api(req, res, url) {
  if (!url.pathname.startsWith('/api/')) return false;
  if (req.method === 'POST' && url.pathname === '/api/submissions') { await acceptSubmission(req, res); return true; }
  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = await readJson(req, 8_192);
    if (!safeEqual(String(body.password || ''), ADMIN_TOKEN)) { send(res, 401, { error: 'That organizer password was not accepted.' }); return true; }
    send(res, 200, { ok: true, token: ADMIN_TOKEN, role: 'Organizer' }); return true;
  }
  const adminRoute = url.pathname.startsWith('/api/admin/');
  if (adminRoute && !authorized(req)) { send(res, 401, { error: 'Organizer access token required.' }); return true; }

  if (req.method === 'GET' && url.pathname === '/api/admin/dashboard') {
    const [submissions, workflow, announcements, settings] = await Promise.all([
      listAllSubmissions(), readStore('workflow.json', {}), readStore('announcements.json', []), readStore('settings.json', { deadline: '', eventName: 'Aavishkar 27 · Ideathon' }),
    ]);
    const enriched = submissions.map((entry) => ({ ...entry, ...(workflow[entry.id] || {}) }));
    const statuses = Object.fromEntries(['Submitted', 'Under Review', 'Selected', 'Rejected', 'Draft'].map((status) => [status, enriched.filter((entry) => (entry.status || 'Submitted') === status).length]));
    send(res, 200, { submissions: enriched, announcements, settings, metrics: { registrations: new Set(enriched.map((entry) => entry.email.toLowerCase())).size, teams: enriched.length, submissions: enriched.filter((entry) => (entry.status || 'Submitted') !== 'Draft').length, selected: statuses.Selected, statuses, domains: [...new Set(enriched.map((entry) => entry.domain))].length } }); return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/announcements') { send(res, 200, { announcements: await readStore('announcements.json', []) }); return true; }
  if (req.method === 'GET' && url.pathname === '/api/admin/submissions') { send(res, 200, { submissions: await listAllSubmissions() }); return true; }

  const statusMatch = url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && statusMatch) {
    const record = await getSubmission(statusMatch[1]);
    if (!record) { send(res, 404, { error: 'Submission not found.' }); return true; }
    const body = await readJson(req);
    const allowed = new Set(['Submitted', 'Under Review', 'Selected', 'Rejected', 'Draft']);
    if (!allowed.has(body.status)) { send(res, 400, { error: 'Choose a valid workflow status.' }); return true; }
    const workflow = await readStore('workflow.json', {});
    const previous = workflow[record.id] || {};
    workflow[record.id] = { ...previous, status: body.status, updatedAt: new Date().toISOString(), history: [...(previous.history || []), { status: body.status, at: new Date().toISOString() }] };
    await writeStore('workflow.json', workflow); send(res, 200, { ok: true, submission: { ...record, ...workflow[record.id] } }); return true;
  }
  const scoreMatch = url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)\/evaluation$/);
  if ((req.method === 'PUT' || req.method === 'POST') && scoreMatch) {
    const record = await getSubmission(scoreMatch[1]);
    if (!record) { send(res, 404, { error: 'Submission not found.' }); return true; }
    const body = await readJson(req);
    const criteria = ['innovation', 'feasibility', 'impact', 'scalability', 'presentation'];
    if (!criteria.every((key) => Number.isInteger(body.scores?.[key]) && body.scores[key] >= 0 && body.scores[key] <= 10)) { send(res, 400, { error: 'Each evaluation score must be a whole number from 0 to 10.' }); return true; }
    if (typeof body.feedback !== 'string' || body.feedback.length > 4000) { send(res, 400, { error: 'Feedback must be 4,000 characters or fewer.' }); return true; }
    const workflow = await readStore('workflow.json', {});
    const previous = workflow[record.id] || {};
    const evaluation = { scores: body.scores, total: criteria.reduce((sum, key) => sum + body.scores[key], 0), feedback: body.feedback.trim(), updatedAt: new Date().toISOString(), reviewer: String(body.reviewer || 'Event reviewer').slice(0, 120) };
    workflow[record.id] = { ...previous, evaluation, reviews: [...(previous.reviews || []), evaluation] };
    await writeStore('workflow.json', workflow); send(res, 200, { ok: true, evaluation }); return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/announcements') {
    const body = await readJson(req);
    const title = String(body.title || '').trim().slice(0, 160); const message = String(body.message || '').trim().slice(0, 1200);
    if (!title || !message) { send(res, 400, { error: 'Enter an announcement title and message.' }); return true; }
    const announcements = await readStore('announcements.json', []);
    const announcement = { id: randomUUID(), title, message, publishedAt: new Date().toISOString() };
    announcements.unshift(announcement); await writeStore('announcements.json', announcements.slice(0, 50)); send(res, 201, { announcement }); return true;
  }
  const announcementMatch = url.pathname.match(/^\/api\/admin\/announcements\/([^/]+)$/);
  if (req.method === 'DELETE' && announcementMatch) {
    const id = decodeURIComponent(announcementMatch[1]);
    const announcements = await readStore('announcements.json', []);
    const remaining = announcements.filter((item) => item.id !== id);
    if (remaining.length === announcements.length) { send(res, 404, { error: 'Announcement not found.' }); return true; }
    await writeStore('announcements.json', remaining); send(res, 200, { ok: true }); return true;
  }
  if (req.method === 'PUT' && url.pathname === '/api/admin/settings') {
    const body = await readJson(req);
    if (body.deadline && !Number.isFinite(Date.parse(body.deadline))) { send(res, 400, { error: 'Enter a valid deadline.' }); return true; }
    const settings = { eventName: String(body.eventName || 'Aavishkar 27 · Ideathon').trim().slice(0, 120), deadline: body.deadline || '', updatedAt: new Date().toISOString() };
    await writeStore('settings.json', settings); send(res, 200, { settings }); return true;
  }
  const documentMatch = url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)\/(presentation|inline)$/);
  if (req.method === 'GET' && documentMatch) {
    const record = await getSubmission(documentMatch[1]);
    if (!record || !record.fileName) { send(res, 404, { error: 'Presentation not found.' }); return true; }
    const filePath = path.join(DATA_DIR, record.id, record.fileName); const ext = path.extname(record.fileName).toLowerCase();
    try {
      const info = await stat(filePath); if (!info.isFile() || !MIME.has(ext)) { send(res, 404, { error: 'Presentation not found.' }); return true; }
      const type = ext === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.ms-powerpoint';
      res.writeHead(200, { 'Content-Type': documentMatch[2] === 'inline' && ext === '.pptx' ? type : type, 'Content-Length': info.size, 'Content-Disposition': `${documentMatch[2] === 'inline' ? 'inline' : 'attachment'}; filename="ideathon-${record.id}${ext}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
      await pipeline(createReadStream(filePath), res);
    } catch { if (!res.headersSent) send(res, 404, { error: 'Presentation not found.' }); }
    return true;
  }
  return false;
}

function isRateLimited(req) {
  const now = Date.now();
  const key = req.socket.remoteAddress || 'unknown';
  const current = rate.get(key);
  if (!current || current.start < now - 60_000) {
    rate.set(key, { start: now, count: 1 });
    return false;
  }
  current.count += 1;
  return current.count > 8;
}

function parseDisposition(header = '') {
  const nameMatch = header.match(/\bname=(?:"([^"]*)"|([^;\s]*))/i);
  const filenameMatch = header.match(/\bfilename=(?:"([^"]*)"|([^;\s]*))/i);
  const name = nameMatch?.[1] ?? nameMatch?.[2];
  const filename = filenameMatch?.[1] ?? filenameMatch?.[2];
  return { name, filename };
}

async function acceptSubmission(req, res) {
  if (isRateLimited(req)) return send(res, 429, { error: 'Too many attempts. Please wait a minute and try again.' });
  const contentType = req.headers['content-type'] || '';
  const boundary = contentType.match(/^multipart\/form-data\s*;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundary) return send(res, 415, { error: 'Please submit the form with a PowerPoint attachment.' });
  const marker = Buffer.from(`--${boundary[1] || boundary[2]}`);
  const fields = Object.create(null);
  let tempFile = null;
  let fileBytes = 0;
  let fileName = '';
  const cleanup = async () => { if (tempFile) await unlink(tempFile).catch(() => {}); };

  try {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += chunk.length;
      if (total > MAX_REQUEST) throw Object.assign(new Error('Submission is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks, total);
    let cursor = 0;
    let sawFinalBoundary = false;
    while (true) {
      const start = body.indexOf(marker, cursor);
      if (start < 0) break;
      let headerStart = start + marker.length;
      if (body.subarray(headerStart, headerStart + 2).toString() === '--') { sawFinalBoundary = true; break; }
      if (body.subarray(headerStart, headerStart + 2).toString() !== '\r\n') throw Object.assign(new Error('Malformed boundary separator.'), { status: 400 });
      headerStart += 2;
      const headerEnd = body.indexOf('\r\n\r\n', headerStart);
      if (headerEnd < 0) throw Object.assign(new Error('Malformed part headers.'), { status: 400 });
      const next = body.indexOf(marker, headerEnd + 4);
      if (next < 0) throw Object.assign(new Error('Malformed part terminator.'), { status: 400 });
      let dataEnd = next;
      if (dataEnd >= 2 && body.subarray(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
      const data = body.subarray(headerEnd + 4, dataEnd);
      const headers = body.subarray(headerStart, headerEnd).toString('utf8');
      const disposition = headers.match(/content-disposition:\s*form-data([^\r\n]*)/i)?.[1] || '';
      const info = parseDisposition(disposition);
      if (!info.name) throw Object.assign(new Error(`Malformed field disposition: ${disposition.slice(0, 120)}`), { status: 400 });
      if (info.filename !== undefined) {
        if (info.name !== 'ppt') throw Object.assign(new Error('Unexpected uploaded file.'), { status: 400 });
        if (info.filename) {
          fileName = path.basename(info.filename.replaceAll('\\', '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 150);
          const ext = path.extname(fileName).toLowerCase();
          if (!MIME.has(ext)) throw Object.assign(new Error('Only .ppt and .pptx files are accepted.'), { status: 415 });
          const fileMime = headers.match(/content-type:\s*([^\r\n]+)/i)?.[1]?.trim().toLowerCase() || 'application/octet-stream';
          if (!MIME.get(ext).has(fileMime)) throw Object.assign(new Error('The attached file does not appear to be a PowerPoint file.'), { status: 415 });
          if (fileBytes > 0) throw Object.assign(new Error('Attach only one PPT file.'), { status: 400 });
          if (data.length > MAX_FILE) throw Object.assign(new Error('PPT files must be 20 MB or smaller.'), { status: 413 });
          fileBytes = data.length;
          tempFile = path.join(DATA_DIR, `.upload-${randomUUID()}.tmp`);
          await writeFile(tempFile, data, { flag: 'wx', mode: 0o600 });
        }
      } else {
        if (data.length > 16_384) throw Object.assign(new Error('A form field is too long.'), { status: 413 });
        fields[info.name] = data.toString('utf8');
      }
      cursor = next;
    }
    if (!sawFinalBoundary) throw Object.assign(new Error('Malformed final boundary.'), { status: 400 });

    const required = ['teamName', 'teamLead', 'email', 'phone', 'domain', 'idea'];
    for (const key of required) {
      fields[key] = (fields[key] || '').trim();
      if (!fields[key]) throw Object.assign(new Error(`Please provide ${key === 'teamName' ? 'a team name' : key === 'teamLead' ? 'the team lead name' : key === 'email' ? 'an email address' : key === 'phone' ? 'a phone number' : key === 'domain' ? 'a domain' : 'a one-line idea'}.`), { status: 400 });
      if (fields[key].length > 500) throw Object.assign(new Error('A form field is too long.'), { status: 400 });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) throw Object.assign(new Error('Please enter a valid email address.'), { status: 400 });
    if (!DOMAINS.has(fields.domain)) throw Object.assign(new Error('Choose one of the listed competition domains.'), { status: 400 });
    if (fileBytes === 0 || !tempFile) throw Object.assign(new Error('Please attach your PPT file.'), { status: 400 });
    const id = `${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${randomUUID().slice(0, 8)}`;
    const submissionDir = path.join(DATA_DIR, id);
    await mkdir(submissionDir, { recursive: false });
    const ext = path.extname(fileName).toLowerCase();
    const storedFile = `presentation${ext}`;
    await rename(tempFile, path.join(submissionDir, storedFile));
    tempFile = null;
    const record = {
      id,
      submittedAt: new Date().toISOString(),
      teamName: fields.teamName,
      teamLead: fields.teamLead,
      email: fields.email,
      phone: fields.phone,
      domain: fields.domain,
      idea: fields.idea,
      originalFileName: fileName,
      fileName: storedFile,
      fileSize: fileBytes,
    };
    try {
      await writeFile(path.join(submissionDir, 'submission.json'), `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      await unlink(path.join(submissionDir, storedFile)).catch(() => {});
      throw error;
    }
    return send(res, 201, { ok: true, id });
  } catch (error) {
    console.error('Submission rejected:', error.message);
    await cleanup();
    return send(res, error.status || 400, { error: error.status ? error.message : 'Could not save the submission. Please try again.' });
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function listSubmissions(req, res) {
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(supplied, ADMIN_TOKEN)) return send(res, 401, { error: 'Admin token required.' });
  return send(res, 200, { submissions: await listAllSubmissions() });
}

async function downloadSubmission(req, res, id) {
  const supplied = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(supplied, ADMIN_TOKEN)) return send(res, 401, { error: 'Admin token required.' });
  if (!/^\d{8}-[0-9a-f]{8}$/.test(id)) return send(res, 400, { error: 'Invalid submission ID.' });
  try {
    const record = JSON.parse(await readFile(path.join(DATA_DIR, id, 'submission.json'), 'utf8'));
    const filePath = path.join(DATA_DIR, id, record.fileName);
    const info = await stat(filePath);
    const ext = path.extname(record.fileName).toLowerCase();
    if (!info.isFile() || !MIME.has(ext)) return send(res, 404, { error: 'Presentation not found.' });
    const safeName = `ideathon-${id}${ext}`;
    res.writeHead(200, {
      'Content-Type': ext === '.pptx' ? 'application/vnd.openxmlformats-officedocument.presentationml.presentation' : 'application/vnd.ms-powerpoint',
      'Content-Length': info.size,
      'Content-Disposition': `attachment; filename="${safeName}"`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    await pipeline(createReadStream(filePath), res);
  } catch {
    if (!res.headersSent) send(res, 404, { error: 'Presentation not found.' });
  }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.ppt': 'application/vnd.ms-powerpoint', '.md': 'text/markdown; charset=utf-8' };
async function serveStatic(req, res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
  const resolved = path.resolve(ROOT, `.${decoded}`);
  if (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`)) { res.writeHead(403).end(); return; }
  let file = resolved;
  try { if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html'); } catch { send(res, 404, { error: 'Not found.' }); return; }
  if (file.startsWith(`${DATA_DIR}${path.sep}`)) { res.writeHead(404).end(); return; }
  try {
    const info = await stat(file);
    if (!info.isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': info.size, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
    if (req.method === 'HEAD') res.end(); else await pipeline(createReadStream(file), res);
  } catch { if (!res.headersSent) res.writeHead(404).end(); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
  if (await api(req, res, url)) return;
  if (req.method === 'GET' && url.pathname === '/api/admin/submissions') return listSubmissions(req, res);
  const downloadMatch = url.pathname.match(/^\/api\/admin\/submissions\/([^/]+)\/presentation$/);
  if (req.method === 'GET' && downloadMatch) return downloadSubmission(req, res, downloadMatch[1]);
  if (req.method === 'GET' && url.pathname === '/judges') return serveStatic(req, res, '/judges.html');
  if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
  res.writeHead(404).end();
  } catch (error) {
    console.error('Request failed:', error.message);
    if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'The request could not be completed.' });
    else res.destroy();
  }
});
server.requestTimeout = 120_000;
server.headersTimeout = 15_000;
server.listen(PORT, HOST, () => {
  console.log(`Ideathon site ready at http://${HOST}:${PORT}`);
  console.log(`Submission files are stored privately in ${DATA_DIR}`);
  console.log('Judge page: /judges · organizer token stored in private-submissions/.organizer-token');
});
