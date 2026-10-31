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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, action TEXT, detail TEXT, acc_id INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS passkeys (id TEXT PRIMARY KEY, pubkey TEXT, alg INTEGER, name TEXT, created INTEGER, host TEXT)'),
  ]);
  for (const col of ['ua TEXT', 'ip TEXT', 'created INTEGER', 'seen INTEGER']) {
    await env.DB.prepare('ALTER TABLE sessions ADD COLUMN ' + col).run().catch(() => {});
  }
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
  const r = await env.DB.prepare('SELECT expires, seen FROM sessions WHERE token=?').bind(t).first();
  if (!r || r.expires <= Date.now()) return false;
  if (!r.seen || Date.now() - r.seen > 5 * 60000) {
    await env.DB.prepare('UPDATE sessions SET seen=?, ip=? WHERE token=?').bind(Date.now(), req.headers.get('cf-connecting-ip') || '', t).run();
  }
  return true;
}
async function newSessionCookie(env, req) {
  const t = randHex(32);
  await env.DB.prepare('DELETE FROM sessions WHERE expires<?').bind(Date.now()).run();
  await env.DB.prepare('INSERT INTO sessions(token,expires,ua,ip,created,seen) VALUES(?,?,?,?,?,?)')
    .bind(t, Date.now() + 30 * 864e5, (req?.headers.get('user-agent') || '').slice(0, 300), req?.headers.get('cf-connecting-ip') || '', Date.now(), Date.now()).run();
  return `sid=${t}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 86400}`;
}
async function logAct(env, action, detail, accId = null) {
  try {
    await env.DB.prepare('INSERT INTO activity(ts,action,detail,acc_id) VALUES(?,?,?,?)').bind(Date.now(), action, String(detail || '').slice(0, 300), accId).run();
    if (Math.random() < 0.05) await env.DB.prepare('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET 500)').run();
  } catch (e) { /* riwayat tidak boleh menggagalkan aksi */ }
}

// ---------- passkey (WebAuthn) ----------
function b64u(buf) { return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)); }
function derToRaw(der) {
  // ECDSA DER -> r||s (64 byte)
  let i = 2; if (der[1] & 0x80) i += der[1] & 0x7f;
  const read = () => { i++; let len = der[i++]; let v = der.slice(i, i + len); i += len; while (v.length > 32 && v[0] === 0) v = v.slice(1); const o = new Uint8Array(32); o.set(v, 32 - v.length); return o; };
  const r = read(), s2 = read(); const out = new Uint8Array(64); out.set(r); out.set(s2, 32); return out;
}
async function checkClient(cdj, type, env, url, key) {
  const c = JSON.parse(new TextDecoder().decode(cdj));
  const want = await getSetting(env, key);
  await setSetting(env, key, '');
  if (c.type !== type) throw new HttpError(400, 'Jenis permintaan passkey tidak cocok');
  if (!want || c.challenge !== want.split('|')[0] || Date.now() - Number(want.split('|')[1]) > 5 * 60000) throw new HttpError(400, 'Permintaan passkey kedaluwarsa, ulangi');
  if (c.origin !== url.origin) throw new HttpError(400, 'Asal passkey tidak cocok');
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
      const d = await gjson(env, a, '/about?fields=storageQuota,user(photoLink)');
      const q = d.storageQuota || {};
      return {
        ...base, photo: d.user?.photoLink || null, limit: q.limit ? Number(q.limit) : null, usage: Number(q.usage || 0),
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
          fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,sharedWithMeTime,starred,trashed,thumbnailLink,webViewLink,ownedByMe,owners(displayName,emailAddress),sharingUser(displayName,emailAddress),videoMediaMetadata(durationMillis),imageMediaMetadata(width,height))',
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
      passkey: !!(await env.DB.prepare('SELECT id FROM passkeys WHERE host=? LIMIT 1').bind(url.hostname).first()),
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
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env, req) });
  }

  if (p === '/api/login' && m === 'POST') {
    const { password } = await body(req);
    const salt = await getSetting(env, 'pw_salt');
    const hash = await getSetting(env, 'pw_hash');
    if (!hash || !safeEq(await hashPw(password || '', salt), hash)) {
      await new Promise((r) => setTimeout(r, 1000));
      throw new HttpError(401, 'Password salah');
    }
    await logAct(env, 'login', 'Masuk dengan password');
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env, req) });
  }

  // passkey: masuk tanpa password
  if (p === '/api/passkey/login-options' && m === 'POST') {
    const ch = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await setSetting(env, 'pk_login', ch + '|' + Date.now());
    const ids = (await env.DB.prepare('SELECT id FROM passkeys WHERE host=?').bind(url.hostname).all()).results || [];
    return json({ challenge: ch, rpId: url.hostname, allow: ids.map((x) => x.id) });
  }
  if (p === '/api/passkey/login' && m === 'POST') {
    const b = await body(req);
    const pk = await env.DB.prepare('SELECT * FROM passkeys WHERE id=? AND host=?').bind(b.id, url.hostname).first();
    if (!pk) throw new HttpError(401, 'Passkey tidak dikenal di alamat ini');
    const cdj = unb64u(b.clientDataJSON), ad = unb64u(b.authenticatorData), sig = unb64u(b.signature);
    await checkClient(cdj, 'webauthn.get', env, url, 'pk_login');
    const rpHash = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(url.hostname)));
    if (!rpHash.every((v, i) => v === ad[i])) throw new HttpError(401, 'Passkey untuk alamat lain');
    if ((ad[32] & 5) !== 5) throw new HttpError(401, 'Verifikasi pengguna gagal');
    const data = new Uint8Array(ad.length + 32);
    data.set(ad); data.set(new Uint8Array(await crypto.subtle.digest('SHA-256', cdj)), ad.length);
    const spki = unb64u(pk.pubkey);
    let ok;
    if (pk.alg === -7) {
      const key = await crypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), data);
    } else {
      const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
      ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data);
    }
    if (!ok) throw new HttpError(401, 'Tanda tangan passkey tidak valid');
    await logAct(env, 'login', 'Masuk dengan passkey: ' + pk.name);
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env, req) });
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
    return json({ ok: true }, 200, { 'set-cookie': await newSessionCookie(env, req) });
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

  if (p === '/api/details') {
    const a = await getAcc(env, qp('acc'));
    const id = encodeURIComponent(qp('id'));
    const f = await gjson(env, a, `/files/${id}?fields=id,name,mimeType,size,createdTime,modifiedTime,viewedByMeTime,starred,shared,description,webViewLink,parents,owners(displayName,emailAddress,photoLink),lastModifyingUser(displayName),imageMediaMetadata(width,height,cameraMake,cameraModel,time),videoMediaMetadata(width,height,durationMillis),capabilities(canEdit,canShare,canTrash)`);
    const path = [];
    try {
      const root = (await gjson(env, a, '/files/root?fields=id')).id;
      let par = f.parents?.[0];
      for (let i = 0; par && i < 12; i++) {
        if (par === root) { path.unshift('Drive Saya'); break; }
        const x = await gjson(env, a, `/files/${par}?fields=name,parents`);
        path.unshift(x.name); par = x.parents?.[0];
        if (!par) path.unshift('Dibagikan ke saya');
      }
    } catch (e) { /* lokasi opsional */ }
    const perms = await gjson(env, a, `/files/${id}/permissions?fields=permissions(type,role,emailAddress,displayName)`).catch(() => ({ permissions: [] }));
    return json({ ...f, acc: a.id, path, permissions: perms.permissions || [] });
  }

  if (p === '/api/transfer' && m === 'POST') {
    const b = await body(req);
    const src = await getAcc(env, b.from), dst = await getAcc(env, b.to);
    const id = encodeURIComponent(b.id);
    const meta = await gjson(env, src, `/files/${id}?fields=name,mimeType,size`);
    if (meta.mimeType === FOLDER) throw new HttpError(400, 'Folder dipindah per isi, bukan sekaligus');
    let file;
    if (meta.mimeType.startsWith('application/vnd.google-apps.')) {
      const ex = EXPORT_DL[meta.mimeType];
      if (!ex || meta.mimeType.endsWith('drawing')) throw new HttpError(400, `"${meta.name}" (jenis ini) tidak bisa dipindah antar akun. Salin manual dari Google Drive.`);
      const r = await gapi(env, src, `/files/${id}/export?mimeType=${encodeURIComponent(ex[0])}`);
      if (!r.ok) throw new HttpError(r.status, 'Gagal mengekspor ' + meta.name);
      const data = await r.arrayBuffer();
      const bd = 'dg' + randHex(8);
      const head = `--${bd}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: meta.name, mimeType: meta.mimeType, parents: [b.folder || 'root'] })}\r\n--${bd}\r\ncontent-type: ${ex[0]}\r\n\r\n`;
      const mp = new Blob([head, data, `\r\n--${bd}--`]);
      file = await gjson(env, dst, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
        method: 'POST', headers: { 'content-type': 'multipart/related; boundary=' + bd }, body: mp,
      });
    } else {
      const size = Number(meta.size || 0);
      const init = await gapi(env, dst, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=UTF-8', 'x-upload-content-type': meta.mimeType, 'x-upload-content-length': String(size) },
        body: JSON.stringify({ name: meta.name, parents: [b.folder || 'root'] }),
      });
      if (!init.ok) { const d = await init.json().catch(() => ({})); throw new HttpError(init.status, d.error?.message || 'Akun tujuan menolak'); }
      const loc = init.headers.get('location');
      let up;
      if (size === 0) up = await fetch(loc, { method: 'PUT', headers: { 'content-range': 'bytes */0' } });
      else {
        const r = await gapi(env, src, `/files/${id}?alt=media`);
        if (!r.ok) throw new HttpError(r.status, 'Gagal mengambil ' + meta.name);
        const { readable, writable } = new FixedLengthStream(size);
        r.body.pipeTo(writable);
        up = await fetch(loc, { method: 'PUT', body: readable });
      }
      if (!up.ok) { const d = await up.json().catch(() => ({})); throw new HttpError(up.status, d.error?.message || 'Upload ke akun tujuan gagal'); }
      file = await up.json();
    }
    if (b.mode === 'move') {
      await gjson(env, src, `/files/${id}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    }
    await logAct(env, b.mode === 'move' ? 'transfer' : 'copy', `${meta.name}: ${src.email} → ${dst.email}`, dst.id);
    return json({ ok: true, file });
  }

  if (p === '/api/insights') {
    const accs = await allAcc(env);
    const all = [], errors = [];
    const q = encodeURIComponent(`trashed=false and mimeType!='${FOLDER}' and 'me' in owners`);
    await Promise.all(accs.map(async (a) => {
      try {
        const d = await gjson(env, a, `/files?q=${q}&orderBy=quotaBytesUsed desc&pageSize=400&fields=files(id,name,mimeType,size,md5Checksum,viewedByMeTime,modifiedTime,createdTime,thumbnailLink,webViewLink)`);
        for (const { thumbnailLink, ...f } of d.files || []) all.push({ ...f, hasThumb: !!thumbnailLink, acc: a.id });
      } catch (e) { errors.push(`${a.email}: ${e.message}`); }
    }));
    const groups = {};
    for (const f of all) if (f.md5Checksum && Number(f.size) > 0) (groups[f.md5Checksum + f.size] ||= []).push(f);
    const dupes = Object.values(groups).filter((g) => g.length > 1)
      .map((g) => ({ size: Number(g[0].size), waste: Number(g[0].size) * (g.length - 1), files: g }))
      .sort((x, y) => y.waste - x.waste).slice(0, 30);
    const year = Date.now() - 365 * 864e5;
    const stale = all.filter((f) => Number(f.size) >= 20 * 1024 * 1024 && new Date(f.viewedByMeTime || f.modifiedTime) < year)
      .sort((x, y) => Number(y.size) - Number(x.size)).slice(0, 30);
    return json({ dupes, stale, errors });
  }

  if (p === '/api/activity') {
    const r = (await env.DB.prepare('SELECT a.ts, a.action, a.detail, a.acc_id FROM activity a ORDER BY a.id DESC LIMIT 60').all()).results || [];
    return json({ items: r });
  }

  if (p === '/api/sessions') {
    const me = getCookie(req, 'sid');
    if (m === 'DELETE') {
      if (qp('all') === '1') await env.DB.prepare('DELETE FROM sessions WHERE token<>?').bind(me).run();
      else await env.DB.prepare('DELETE FROM sessions WHERE rowid=? AND token<>?').bind(Number(qp('id')), me).run();
      await logAct(env, 'sessions', qp('all') === '1' ? 'Mengeluarkan semua perangkat lain' : 'Mengeluarkan satu perangkat');
      return json({ ok: true });
    }
    const r = (await env.DB.prepare('SELECT rowid AS id, token, ua, ip, created, seen FROM sessions WHERE expires>? ORDER BY seen DESC').bind(Date.now()).all()).results || [];
    return json({ sessions: r.map(({ token, ...x }) => ({ ...x, current: token === me })) });
  }

  if (p === '/api/passkeys') {
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM passkeys WHERE id=?').bind(qp('id')).run(); return json({ ok: true }); }
    const r = (await env.DB.prepare('SELECT id, name, created, host FROM passkeys ORDER BY created DESC').all()).results || [];
    return json({ passkeys: r });
  }
  if (p === '/api/passkey/register-options' && m === 'POST') {
    const ch = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await setSetting(env, 'pk_reg', ch + '|' + Date.now());
    const ex = (await env.DB.prepare('SELECT id FROM passkeys WHERE host=?').bind(url.hostname).all()).results || [];
    return json({ challenge: ch, rpId: url.hostname, userId: b64u(enc.encode('owner')), exclude: ex.map((x) => x.id) });
  }
  if (p === '/api/passkey/register' && m === 'POST') {
    const b = await body(req);
    await checkClient(unb64u(b.clientDataJSON), 'webauthn.create', env, url, 'pk_reg');
    if (![-7, -257].includes(b.alg)) throw new HttpError(400, 'Jenis kunci passkey tidak didukung');
    await env.DB.prepare('INSERT OR REPLACE INTO passkeys(id,pubkey,alg,name,created,host) VALUES(?,?,?,?,?,?)')
      .bind(b.id, b.publicKey, b.alg, String(b.name || 'Perangkat').slice(0, 60), Date.now(), url.hostname).run();
    await logAct(env, 'passkey', 'Passkey ditambahkan: ' + (b.name || 'Perangkat'));
    return json({ ok: true });
  }

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
    await logAct(env, 'disconnect', a.email);
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
      const file = await r.json().catch(() => ({}));
      await logAct(env, 'upload', file.name || 'file', up.acc_id);
      return json({ done: true, file });
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
    await logAct(env, 'create', f.name, a.id);
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
    await logAct(env, 'restore', b.name || 'item', a.id);
    return json({ ok: true });
  }

  if (p === '/api/delete-forever' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, `/files/${encodeURIComponent(b.id)}`, { method: 'DELETE' });
    await logAct(env, 'delete', b.name || 'item', a.id);
    return json({ ok: true });
  }

  if (p === '/api/empty-trash' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, '/files/trash', { method: 'DELETE' });
    await logAct(env, 'empty', a.email, a.id);
    return json({ ok: true });
  }

  if (p === '/api/rename' && m === 'POST') {
    const b = await body(req);
    const a = await getAcc(env, b.acc);
    await gjson(env, a, `/files/${encodeURIComponent(b.id)}?fields=id`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: b.name }),
    });
    await logAct(env, 'rename', b.name, a.id);
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
      await logAct(env, 'share', (b.type === 'anyone' ? 'Link publik: ' : b.email + ': ') + (b.name || ''), a.id);
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
    await logAct(env, 'trash', b.name || 'item', a.id);
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
