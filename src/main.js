const menuToggle = document.querySelector('.menu-toggle');
const mainNav = document.querySelector('.main-nav');
menuToggle?.addEventListener('click', () => {
  const open = mainNav.classList.toggle('open');
  menuToggle.setAttribute('aria-expanded', String(open));
});
mainNav?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  mainNav.classList.remove('open');
  menuToggle?.setAttribute('aria-expanded', 'false');
}));

async function loadPublicAnnouncements() {
  const target = document.querySelector('.update-list');
  if (!target) return;
  try {
    const response = await fetch('./api/announcements', { cache: 'no-store' });
    if (!response.ok) return;
    const { announcements = [] } = await response.json();
    if (!announcements.length) return;
    const date = (value) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
    for (const item of announcements.slice(0, 3)) {
      const article = document.createElement('article'); article.className = 'update-item';
      const stamp = document.createElement('span'); stamp.className = 'update-date'; stamp.textContent = date(item.publishedAt);
      const content = document.createElement('div'); const title = document.createElement('h3'); title.textContent = item.title;
      const description = document.createElement('p'); description.textContent = item.message; content.append(title, description);
      const tag = document.createElement('span'); tag.className = 'update-tag tag-soon'; tag.textContent = 'EVENT UPDATE';
      article.append(stamp, content, tag); target.prepend(article);
    }
  } catch { /* Announcements are optional when served as static files. */ }
}
loadPublicAnnouncements();

const fileInput = document.querySelector('#ppt-file');
const fileDrop = document.querySelector('.file-drop');
const selectedFile = document.querySelector('#selected-file');
const note = document.querySelector('#form-note');
const setFile = (file) => {
  if (!file) return;
  const isPpt = /\.pptx?$/i.test(file.name);
  if (!isPpt) {
    selectedFile.textContent = 'Please choose a .ppt or .pptx file.';
    selectedFile.style.color = '#b34e39';
    fileInput.value = '';
    return;
  }
  if (file.size > 4 * 1024 * 1024) {
    selectedFile.textContent = 'That file is over the 4 MB Netlify upload limit.';
    selectedFile.style.color = '#b34e39';
    fileInput.value = '';
    return;
  }
  selectedFile.style.color = '';
  selectedFile.textContent = `${file.name} · ${(file.size / (1024 * 1024)).toFixed(1)} MB`;
  note.textContent = 'File selected. Your entry will be sent securely when you submit the form.';
};
fileInput?.addEventListener('change', () => setFile(fileInput.files[0]));
fileDrop?.addEventListener('dragover', (event) => { event.preventDefault(); fileDrop.classList.add('dragover'); });
fileDrop?.addEventListener('dragleave', () => fileDrop.classList.remove('dragover'));
fileDrop?.addEventListener('drop', (event) => {
  event.preventDefault();
  fileDrop.classList.remove('dragover');
  const file = event.dataTransfer.files[0];
  if (file) {
    try { fileInput.files = event.dataTransfer.files; } catch { /* Display the dropped file even where assignment is restricted. */ }
    setFile(file);
  }
});

document.querySelector('#submission-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = fileInput.files[0];
  if (!file) {
    note.textContent = 'Please attach your PPT before submitting.';
    note.style.color = '#b34e39';
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  button.firstChild.textContent = 'Uploading… ';
  note.textContent = 'Uploading your entry securely…';
  note.style.color = '';
  try {
    const response = await fetch('./api/submissions', { method: 'POST', body: new FormData(form) });
    const responseText = await response.text();
    let result;
    try { result = JSON.parse(responseText); } catch {
      throw new Error('The submission function is not deployed. Confirm Netlify Functions directory is set to netlify/functions, then redeploy.');
    }
    if (!response.ok) throw new Error(result.error || 'Submission could not be saved.');
    note.textContent = `Submission received. Your reference number is ${result.id}.`;
    note.style.color = '#1776b9';
    form.reset();
    selectedFile.textContent = '';
  } catch (error) {
    note.textContent = error instanceof TypeError
      ? 'Could not reach the upload server. Start it with “node server.mjs” and open the website at http://localhost:8000.'
      : `${error.message} Please try again or contact the organisers.`;
    note.style.color = '#b34e39';
  } finally {
    button.disabled = false;
    button.firstChild.textContent = 'Send your submission ';
  }
});
