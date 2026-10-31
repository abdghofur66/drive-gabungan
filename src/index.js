// Drive Gabungan — menggabungkan beberapa akun Google Drive dalam satu penampil.
// Cloudflare Worker + D1. Satu instance = satu pemilik (self-host).
// Developed by OutsiderDev — https://outsiderdev.com
import HTML from './ui.html';
import PANDUAN from './panduan.html';
import * as ICONS from './icons.js';

const SCOPES = 'openid email profile https://www.googleapis.com/auth/drive';
const FOLDER = 'application/vnd.google-apps.folder';
const COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#14b8a6', '#ec4899', '#84cc16', '#6366f1', '#f97316'];
const TYPE_Q = {
  folder: `mimeType='${FOLDER}'`,
  image: "mimeType contains 'image/'",
  video: "mimeType contains 'video/'",
  audio: "mimeType contains 'audio/'",
  pdf: "mimeType='application/pdf'",
  doc: "(mimeType='application/vnd.google-apps.document' or mimeType='application/vnd.google-apps.spreadsheet' or mimeType='application/vnd.google-apps.presentation' or mimeType contains 'officedocument' or mimeType='application/msword' or mimeType='application/vnd.ms-excel')",
};
const EXPORT_DL = {
  'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  'application/vnd.google-apps.drawing': ['image/png', 'png'],
};

// Service worker: halaman tetap bisa dibuka saat sinyal buruk; data API selalu dari jaringan.
const SW = `const C = 'dg-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(['/', '/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== C).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname.startsWith('/oauth')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).then((r) => { if (u.pathname === '/' && r.ok) { const cp = r.clone(); caches.open(C).then((c) => c.put('/', cp)); } return r; }).catch(() => caches.match(u.pathname === '/' ? '/' : e.request)));
  }
});`;

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

export default {
  async fetch(req, env) {
    try {
      await ensureSchema(env);
      return await route(req, env);
    } catch (e) {
      return json({ error: e.message || String(e) }, e.status || 500);
    }
  },
};

// ---------- util ----------
const enc = new TextEncoder();
function json(d, status = 200, headers = {}) {
  return new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}
function randHex(n) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
function b64(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function qesc(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
function safeEq(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return b64(bits);
}
function getCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
async function body(req) { return req.json().catch(() => ({})); }

// ---------- database ----------
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  if (!env.DB) throw new HttpError(500, 'Database D1 (binding DB) belum dipasang. Lihat README.');
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT, color TEXT, refresh_token TEXT, access_token TEXT, token_exp INTEGER DEFAULT 0, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, acc_id INTEGER, url TEXT, created INTEGER)'),
  ]);
  schemaReady = true;
}
async function getSetting(env, k) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE key=?').bind(k).first();
  return r ? r.value : null;
}
async function setSetting(env, k, v) {
  await env.DB.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').bind(k, v).run();
}
async function allAcc(env) {
  return (await env.DB.prepare('SELECT * FROM accounts ORDER BY id').all()).results || [];
}
async function getAcc(env, id) {
  const a = await env.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(Number(id)).first();
  if (!a) throw new HttpError(404, 'Akun tidak ditemukan');
  return a;
}

// ---------- sesi ----------
async function isAuthed(req, env) {
  const t = getCookie(req, 'sid');
  if (!t) return false;
  const r = await env.DB.prepare('SELECT expires FROM sessions WHERE token=?').bind(t).first();
  return !!r && r.expires > Date.now();
}
async function newSessionCookie(env) {
  const t = randHex(32);
  await env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token,expires) VALUES(?,?)').bind(t, Date.now() + 30 * 864e5).run();
  return `sid=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
}

// ---------- Google ----------
async function gcfg(env) {
  return {
    id: env.GOOGLE_CLIENT_ID || (await getSetting(env, 'g_id')),
    secret: env.GOOGLE_CLIENT_SECRET || (await getSetting(env, 'g_secret')),
  };
}
async function accessToken(env, acc) {
  if (acc.access_token && acc.token_exp > Date.now() + 60000) return acc.access_token;
  const g = await gcfg(env);
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: g.id, client_secret: g.secret,
      refresh_token: acc.refresh_token, grant_type: 'refresh_token',
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new HttpError(502, `Akses akun ${acc.email} gagal (${d.error}). Hubungkan ulang akun ini.`);
  acc.access_token = d.access_token;
  acc.token_exp = Date.now() + d.expires_in * 1000;
  await env.DB.prepare('UPDATE accounts SET access_token=?, token_exp=? WHERE id=?').bind(acc.access_token, acc.token_exp, acc.id).run();
  return acc.access_token;
}
async function gapi(env, acc, path, opts = {}) {
  const t = await accessToken(env, acc);
  const url = path.startsWith('http') ? path : 'https://www.googleapis.com/drive/v3' + path;
  return fetch(url, { ...opts, headers: { ...(opts.headers || {}), authorization: 'Bearer ' + t } });
}
async function gjson(env, acc, path, opts) {
  const r = await gapi(env, acc, path, opts);
  const d = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status, d.error?.message || 'Google Drive error ' + r.status);
  return d;
}
async function quotas(env) {
  const accs = await allAcc(env);
  return Promise.all(accs.map(async (a) => {
    const base = { id: a.id, email: a.email, name: a.name, color: a.color };
    try {
      const d = await gjson(env, a, '/about?fields=storageQuota');
      const q = d.storageQuota || {};
      return {
        ...base, limit: q.limit ? Number(q.limit) : null, usage: Number(q.usage || 0),
        drive: Number(q.usageInDrive || 0), trash: Number(q.usageInDriveTrash || 0),
      };
    } catch (e) {
      return { ...base, error: e.message };
    }
  }));
}
async function pickAccount(env, size) {
  const qs = (await quotas(env)).filter((q) => !q.error);
  if (!qs.length) throw new HttpError(400, 'Belum ada akun Google yang terhubung');
  const free = (q) => (q.limit == null ? Infinity : q.limit - q.usage);
  qs.sort((a, b) => free(b) - free(a));
  if (free(qs[0]) < size) throw new HttpError(507, 'Ruang kosong di semua akun tidak cukup untuk file ini');
  return qs[0].id;
}

async function listFiles(env, accId, folder, q, type) {
  const accs = accId === 'all' ? await allAcc(env) : [await getAcc(env, accId)];
  const parts = [folder === 'trash' && !q ? 'trashed=true' : 'trashed=false'];
  if (q) parts.push(`name contains '${qesc(q)}'`);
  else if (folder === 'shared') parts.push('sharedWithMe = true');
  else if (folder === 'starred') parts.push('starred = true');
  else if (folder === 'trash') { /* semua isi sampah */ }
  else parts.push(`'${qesc(folder || 'root')}' in parents`);
  if (TYPE_Q[type]) parts.push(TYPE_Q[type]);
  const query = parts.join(' and ');
  const files = [];
  const errors = [];
  await Promise.all(accs.map(async (a) => {
    try {
      let pt = '';
      const shared = folder === 'shared' && !q;
      const special = ['shared', 'trash', 'starred'].includes(folder) && !q;
      for (let i = 0; i < (special ? 1 : 5); i++) {
        const p = new URLSearchParams({
          q: query, pageSize: special ? '300' : '1000',
          orderBy: shared ? 'sharedWithMeTime desc' : folder === 'trash' && !q ? 'modifiedTime desc' : 'folder,name',
          fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,sharedWithMeTime,starred,trashed,thumbnailLink,webViewLink,ownedByMe,owners(displayName,emailAddress),sharingUser(displayName,emailAddress))',
        });
        if (pt) p.set('pageToken', pt);
        const d = await gjson(env, a, '/files?' + p);
        for (const { thumbnailLink, ...f } of d.files || []) files.push({ ...f, hasThumb: !!thumbnailLink, acc: a.id });
        pt = d.nextPageToken;
        if (!pt) break;
      }
    } catch (e) {
      errors.push(`${a.email}: ${e.message}`);
    }
  }));
  files.sort((x, y) => (y.mimeType === FOLDER) - (x.mimeType === FOLDER) || x.name.localeCompare(y.name, 'id', { numeric: true }));
  return { files, errors };
}

// ---------- router ----------
async function route(req, env) {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  const qp = (k) => url.searchParams.get(k);

  if (p === '/' || p === '/index.html') {
    return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8', 'x-frame-options': 'DENY' } });
  }

  if (p === '/manifest.webmanifest') {
    return new Response(JSON.stringify({
      name: 'Drive Gabungan', short_name: 'Drive Gabungan', id: '/', start_url: '/', scope: '/',
      display: 'standalone', background_color: '#0d1322', theme_color: '#2f6bff', lang: 'id',
      description: 'Gabungkan beberapa akun Google Drive dalam satu tampilan.',
      icons: [
        { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [{ name: 'Semua file', url: '/?p=files', icons: [{ src: '/icon-192.png', sizes: '192x192' }] }],
    }), { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=86400' } });
  }
  const ICON = { '/icon-192.png': 'i192', '/icon-512.png': 'i512', '/icon-maskable.png': 'm512', '/apple-touch-icon.png': 'a180' }[p];
  if (ICON) {
    const bin = Uint8Array.from(atob(ICONS[ICON]), (c) => c.charCodeAt(0));
    return new Response(bin, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
  }
  if (p === '/sw.js') {
    return new Response(SW, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' } });
  }

  if (p === '/panduan' || p === '/panduan/') {
    return new Response(PANDUAN, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
  }

  if (p === '/api/state') {
    return json({
      setup: !!(await getSetting(env, 'pw_hash')),
      loggedIn: await isAuthed(req, env),
      configured: await gcfg(env).then((g) => !!(g.id && g.secret)),
      fromEnv: !!env.GOOGLE_CLIENT_ID,
      redirectUri: url.origin + '/oauth/callback',
    });
  }

  if (p === '/api/setup' && m === 'POST') {
    if (await getSetting(env, 'pw_hash')) throw new HttpError(403, 'Password pemilik sudah dibuat');
    const { password } = await body(req);
    if (!password || password.length < 8) throw new HttpError(400, 'Password minimal 8 karakter');
    const salt = randHex(16);
    await setSetting(env, 'pw_salt', salt);
    await setSetting(env, 'pw_hash', await hashPw(password, salt));
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env) });
  }

  if (p === '/api/login' && m === 'POST') {
    const { password } = await body(req);
    const salt = await getSetting(env, 'pw_salt');
    const hash = await getSetting(env, 'pw_hash');
    if (!hash || !safeEq(await hashPw(password || '', salt), hash)) {
      await new Promise((r) => setTimeout(r, 1000));
      throw new HttpError(401, 'Password salah');
    }
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env) });
  }

  if (p === '/api/logout' && m === 'POST') {
    const t = getCookie(req, 'sid');
    if (t) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(t).run();
    return json({ ok: true }, 200, { 'set-cookie': 'sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0' });
  }

  // ----- semua di bawah wajib login -----
  if (!(await isAuthed(req, env))) {
    if (p.startsWith('/oauth')) return Response.redirect(url.origin + '/', 302);
    throw new HttpError(401, 'Silakan login dulu');
  }

  if (p === '/api/password' && m === 'POST') {
    const { old, password } = await body(req);
    const salt = await getSetting(env, 'pw_salt');
    if (!safeEq(await hashPw(old || '', salt), await getSetting(env, 'pw_hash'))) throw new HttpError(400, 'Password lama salah');
    if (!password || password.length < 8) throw new HttpError(400, 'Password baru minimal 8 karakter');
    const ns = randHex(16);
    await setSetting(env, 'pw_salt', ns);
    await setSetting(env, 'pw_hash', await hashPw(password, ns));
    await env.DB.prepare('DELETE FROM sessions').run();
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env) });
  }

  if (p === '/api/config' && m === 'POST') {
    if (env.GOOGLE_CLIENT_ID) throw new HttpError(400, 'Client ID sudah diatur lewat secret Worker');
    const b = await body(req);
    const id = (b.id || '').trim(), secret = (b.secret || '').trim();
    if (!id.endsWith('.apps.googleusercontent.com')) throw new HttpError(400, 'Client ID tidak valid (harus berakhiran .apps.googleusercontent.com)');
    if (secret.length < 10) throw new HttpError(400, 'Client Secret tidak valid');
    await setSetting(env, 'g_id', id);
    await setSetting(env, 'g_secret', secret);
    return json({ ok: true });
  }

  if (p === '/oauth/start') {
    const g = await gcfg(env);
    if (!g.id || !g.secret) return Response.redirect(url.origin + '/?msg=' + encodeURIComponent('Isi Client ID & Secret Google dulu'), 302);
    const state = randHex(16);
    await setSetting(env, 'oauth_state', state);
    const q = new URLSearchParams({
      client_id: g.id, redirect_uri: url.origin + '/oauth/callback',
      response_type: 'code', scope: SCOPES, access_type: 'offline',
      prompt: 'consent select_account', include_granted_scopes: 'true', state,
    });
    return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
  }

  if (p === '/oauth/callback') {
    const back = (msg) => Response.redirect(url.origin + '/?msg=' + encodeURIComponent(msg), 302);
    if (qp('error')) return back('Login Google dibatalkan');
    const st = await getSetting(env, 'oauth_state');
    if (!st || st !== qp('state')) return back('State OAuth tidak cocok, ulangi');
    await setSetting(env, 'oauth_state', '');
    const g = await gcfg(env);
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        code: qp('code'), client_id: g.id, client_secret: g.secret,
        redirect_uri: url.origin + '/oauth/callback', grant_type: 'authorization_code',
      }),
    });
    const tk = await r.json();
    if (!r.ok) return back('Gagal tukar token: ' + (tk.error_description || tk.error));
    if (!tk.scope || !tk.scope.includes('auth/drive')) return back('Izin Google Drive tidak dicentang. Ulangi dan centang akses Drive.');
    const about = await (await fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers: { authorization: 'Bearer ' + tk.access_token } })).json();
    const email = about.user?.emailAddress;
    if (!email) return back('Tidak bisa membaca email akun');
    const ex = await env.DB.prepare('SELECT id, refresh_token FROM accounts WHERE email=?').bind(email).first();
    const refresh = tk.refresh_token || ex?.refresh_token;
    if (!refresh) return back('Google tidak memberi refresh token, ulangi');
    const exp = Date.now() + tk.expires_in * 1000;
    if (ex) {
      await env.DB.prepare('UPDATE accounts SET refresh_token=?, access_token=?, token_exp=?, name=? WHERE id=?')
        .bind(refresh, tk.access_token, exp, about.user.displayName || '', ex.id).run();
    } else {
      const used = (await allAcc(env)).map((a) => a.color);
      const color = COLORS.find((c) => !used.includes(c)) || COLORS[used.length % COLORS.length];
      await env.DB.prepare('INSERT INTO accounts(email,name,color,refresh_token,access_token,token_exp,created) VALUES(?,?,?,?,?,?,?)')
        .bind(email, about.user.displayName || '', color, refresh, tk.access_token, exp, Date.now()).run();
    }
    return back('Akun ' + email + ' terhubung');
  }

  if (p === '/api/accounts' && m === 'GET') return json({ accounts: await quotas(env) });

  if (p === '/api/overview') {
    const accs = await allAcc(env);
    const recent = [], largest = [], errors = [];
    const F = 'files(id,name,mimeType,size,createdTime,modifiedTime,thumbnailLink,webViewLink)';
    const q = encodeURIComponent(`trashed=false and mimeType!='${FOLDER}'`);
    await Promise.all(accs.map(async (a) => {
      try {
        const [r, l] = await Promise.all([
          gjson(env, a, `/files?q=${q}&orderBy=modifiedTime desc&pageSize=8&fields=${F}`),
          gjson(env, a, `/files?q=${q}&orderBy=quotaBytesUsed desc&pageSize=8&fields=${F}`),
        ]);
        const tag = ({ thumbnailLink, ...f }) => ({ ...f, hasThumb: !!thumbnailLink, acc: a.id });
        recent.push(...(r.files || []).map(tag));
        largest.push(...(l.files || []).map(tag));
      } catch (e) { errors.push(`${a.email}: ${e.message}`); }
    }));
    recent.sort((x, y) => new Date(y.modifiedTime) - new Date(x.modifiedTime));
    largest.sort((x, y) => Number(y.size || 0) - Number(x.size || 0));
    return json({ accounts: await quotas(env), recent: recent.slice(0, 8), largest: largest.slice(0, 8), errors });
  }

  if (p === '/api/accounts' && m === 'DELETE') {
    const a = await getAcc(env, qp('id'));
    fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(a.refresh_token), { method: 'POST' }).catch(() => {});
    await env.DB.prepare('DELETE FROM accounts WHERE id=?').bind(a.id).run();
    return json({ ok: true });
  }

  if (p === '/api/files') {
    return json(await listFiles(env, qp('acc') || 'all', qp('folder'), (qp('q') || '').trim(), qp('type')));
  }

  if (p === '/api/thumb') {
    const a = await getAcc(env, qp('acc'));
    const meta = await gjson(env, a, `/files/${encodeURIComponent(qp('id'))}?fields=thumbnailLink`);
    if (!meta.thumbnailLink) return new Response('', { status: 404 });
    const r = await gapi(env, a, meta.thumbnailLink.replace(/=s\d+$/, '=s320'));
    if (!r.ok) return new Response('', { status: 404 });
    return new Response(r.body, { headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
  }

  if (p === '/api/content') {
    const a = await getAcc(env, qp('acc'));
    const id = encodeURIComponent(qp('id'));
    const dl = qp('dl') === '1';
    const meta = await gjson(env, a, `/files/${id}?fields=name,mimeType`);
    let r, type, name = meta.name;
    if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
      const ex = dl ? EXPORT_DL[meta.mimeType] : ['application/pdf', 'pdf'];
      if (!ex) throw new HttpError(400, 'Jenis file Google ini tidak bisa diunduh, buka di Google Drive');
      r = await gapi(env, a, `/files/${id}/export?mimeType=${encodeURIComponent(ex[0])}`);
      type = ex[0];
      name += '.' + ex[1];
    } else {
      const h = {};
      if (req.headers.get('range')) h.range = req.headers.get('range');
      r = await gapi(env, a, `/files/${id}?alt=media`, { headers: h });
      type = meta.mimeType || 'application/octet-stream';
    }
    if (!r.ok && r.status !== 206) {
      const d = await r.json().catch(() => ({}));
      throw new HttpError(r.status, d.error?.message || 'Gagal mengambil file');
    }
    if (!dl && /html|xml|javascript/i.test(type) && !/svg/i.test(type)) type = 'text/plain; charset=utf-8';
    const headers = {
      'content-type': type,
      'content-disposition': `${dl ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=600',
      'x-content-type-options': 'nosniff',
    };
    if (!/pdf/i.test(type)) headers['content-security-policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'";
    for (const k of ['content-length', 'content-range']) if (r.headers.get(k)) headers[k] = r.headers.get(k);
    return new Response(r.body, { status: r.status, headers });
  }

  if (p === '/api/upload/init' && m === 'POST') {
    const b = await body(req);
    const size = Number(b.size || 0);
    const accId = b.acc && b.acc !== 'all' ? Number(b.acc) : await pickAccount(env, size);
    const a = await getAcc(env, accId);
    const parent = b.acc && b.acc !== 'all' ? b.folder || 'root' : 'root';
    const r = await gapi(env, a, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,mimeType,size', {
      method: 'POST',
      headers: {
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': b.mimeType || 'application/octet-stream',
        'x-upload-content-length': String(size),
      },
      body: JSON.stringify({ name: b.name, parents: [parent] }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new HttpError(r.status, d.error?.message || 'Gagal memulai upload');
    }
    const id = randHex(16);
    await env.DB.prepare('DELETE FROM uploads WHERE created<?').bind(Date.now() - 7 * 864e5).run();
    await env.DB.prepare('INSERT INTO uploads(id,acc_id,url,created) VALUES(?,?,?,?)').bind(id, a.id, r.headers.get('location'), Date.now()).run();
    return json({ id, acc: a.id, email: a.email });
  }

  if (p === '/api/upload/chunk' && m === 'PUT') {
    const up = await env.DB.prepare('SELECT * FROM uploads WHERE id=?').bind(qp('id')).first();
    if (!up) throw new HttpError(404, 'Sesi upload tidak ditemukan');
    const start = Number(qp('start'));
    const total = Number(qp('total'));
    const buf = await req.arrayBuffer();
    const range = total === 0 ? 'bytes */0' : `bytes ${start}-${start + buf.byteLength - 1}/${total}`;
    const r = await fetch(up.url, { method: 'PUT', headers: { 'content-range': range }, body: buf });
    if (r.status === 308) return json({ done: false });
    if (r.ok) {
      await env.DB.prepare('DELETE FROM uploads WHERE id=?').bind(up.id).run();
      return json({ done: true, file: await r.json().catch(() => ({})) });
    }
    const d = await r.json().catch(() => ({}));
    throw new HttpError(r.status, d.error?.message || 'Upload gagal');
  }

  if (p === '/api/mkdir' && m === 'POST') {
    const b = await body(req);
    const inAcc = b.acc && b.acc !== 'all';
    const a = await getAcc(env, inAcc ? b.acc : await pickAccount(env, 0));
    const f = await gjson(env, a, '/files?fields=id,name', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: b.name || 'Folder baru', mimeType: FOLDER, parents: [inAcc ? b.parent || 'root' : 'root'] }),
    });
    return json({ ok: true, file: f });
  }

  if (p === '/api/create' && m === 'POST') {
    const b = await body(req);
    const ok = [FOLDER, 'application/vnd.google-apps.document', 'application/vnd.google-apps.spreadsheet',
      'application/vnd.google-apps.presentation', 'application/vnd.google-apps.form'];
    if (!ok.includes(b.mimeType)) throw new HttpError(400, 'Jenis item tidak didukung');
    const a = await getAcc(env, b.acc);
    const f = await gjson(env, a, '/files?fields=id,name,mimeType,webViewLink', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: (b.name || '').trim() || 'Tanpa judul', mimeType: b.mimeType, parents: [b.parent || 'root'] }),
    });
    return json({ ok: true, file: { ...f, acc: a.id } });
  }

  if (p === '/api/star' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, `/files/${encodeURIComponent(b.id)}?fields=id`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ starred: !!b.starred }),
    });
    return json({ ok: true });
  }

  if (p === '/api/restore' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, `/files/${encodeURIComponent(b.id)}?fields=id`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: false }),
    });
    return json({ ok: true });
  }

  if (p === '/api/delete-forever' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, `/files/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
    return json({ ok: true });
  }

  if (p === '/api/empty-trash' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, '/files/trash', { method: 'DELETE' });
    return json({ ok: true });
  }

  if (p === '/api/rename' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, `/files/${encodeURIComponent(b.id)}?fields=id`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: b.name }),
    });
    return json({ ok: true });
  }

  if (p === '/api/share') {
    const a = await getAcc(env, qp('acc') || (await body(req.clone())).acc);
    const id = encodeURIComponent(qp('id') || (await body(req.clone())).id);
    if (m === 'GET') {
      const [meta, perms] = await Promise.all([
        gjson(env, a, `/files/${id}?fields=name,webViewLink,capabilities(canShare)`),
        gjson(env, a, `/files/${id}/permissions?fields=permissions(id,type,role,emailAddress,displayName)`).catch(() => ({ permissions: [] })),
      ]);
      return json({ ...meta, permissions: perms.permissions || [] });
    }
    if (m === 'POST') {
      const b = await body(req);
      const role = ['reader', 'commenter', 'writer'].includes(b.role) ? b.role : 'reader';
      if (b.type === 'anyone') {
        await gjson(env, a, `/files/${id}/permissions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'anyone', role }) });
      } else {
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email || '')) throw new HttpError(400, 'Alamat email tidak valid');
        const notify = b.notify === false ? 'false' : 'true';
        await gjson(env, a, `/files/${id}/permissions?sendNotificationEmail=${notify}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'user', role, emailAddress: b.email }) });
      }
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await gjson(env, a, `/files/${id}/permissions/${encodeURIComponent(qp('perm'))}`, { method: 'DELETE' });
      return json({ ok: true });
    }
  }

  if (p === '/api/trash' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, `/files/${encodeURIComponent(b.id)}?fields=id`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    });
    return json({ ok: true });
  }

  if (p === '/api/move' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    const id = encodeURIComponent(b.id);
    if (b.id === b.to) throw new HttpError(400, 'Tidak bisa memindah folder ke dirinya sendiri');
    const meta = await gjson(env, a, `/files/${id}?fields=parents`);
    const q = new URLSearchParams({ addParents: b.to || 'root', removeParents: (meta.parents || []).join(','), fields: 'id' });
    await gjson(env, a, `/files/${id}?${q}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' });
    return json({ ok: true });
  }

  throw new HttpError(404, 'Tidak ditemukan');
}
