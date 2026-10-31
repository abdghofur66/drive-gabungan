// Drive Gabungan — menggabungkan beberapa akun Google Drive dalam satu penampil.
// Cloudflare Worker + D1. Satu instance = satu pemilik (self-host).
// Developed by OutsiderDev — https://outsiderdev.com
import HTML from './ui.html';
import PANDUAN from './panduan.html';
import TENTANG from './tentang.html';
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
const SW = `const C = 'dg-v2';
self.addEventListener('push', (e) => {
  e.waitUntil(fetch('/api/alerts', { credentials: 'include' }).then((r) => r.json()).then((d) => {
    const a = (d.alerts || [])[0];
    return self.registration.showNotification(a ? a.title : 'Drive Gabungan', { body: a ? a.body : 'Ada pemberitahuan baru.', icon: '/icon-192.png', badge: '/icon-192.png', tag: a ? 'dg-' + a.id : 'dg', data: { url: a ? a.url : '/' } });
  }).catch(() => self.registration.showNotification('Drive Gabungan', { body: 'Ada pemberitahuan baru. Buka aplikasi untuk melihatnya.', icon: '/icon-192.png' })));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((w) => (w[0] ? w[0].focus() : self.clients.openWindow(e.notification.data?.url || '/'))));
});
self.addEventListener('install', (e) => { e.waitUntil(caches.open(C).then((c) => c.addAll(['/', '/icon-192.png'])).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== C).map((x) => caches.delete(x)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method === 'POST' && u.pathname === '/share-target') {
    e.respondWith((async () => {
      const fd = await e.request.formData();
      const c = await caches.open('dg-share');
      for (const k of await c.keys()) await c.delete(k);
      let i = 0;
      for (const f of fd.getAll('files')) if (f && f.name) await c.put('/shared/' + i++, new Response(f, { headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name) } }));
      return Response.redirect('/?share=' + i, 303);
    })());
    return;
  }
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname.startsWith('/oauth') || u.pathname.startsWith('/s/')) return;
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
  // Cron: cek akun & jalankan cadangan otomatis sedikit demi sedikit
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      const origin = await getSetting(env, 'origin');
      if (!origin) return;
      await checkAlerts(env, origin).catch(() => {});
      await autoBackupTick(env).catch(() => {});
    })());
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
    env.DB.prepare('CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, acc_id INTEGER, file_id TEXT, name TEXT, mime TEXT, size INTEGER, expires INTEGER, pw_salt TEXT, pw_hash TEXT, max_dl INTEGER, dl INTEGER DEFAULT 0, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, title TEXT, body TEXT, url TEXT, seen INTEGER DEFAULT 0)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS backups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, src_acc INTEGER, src_folder TEXT, dst_acc INTEGER, dst_folder TEXT, mode TEXT, freq TEXT, phase TEXT DEFAULT \'idle\', last_run INTEGER, last_status TEXT, copied INTEGER DEFAULT 0, created INTEGER)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS backup_items (backup_id INTEGER, src_id TEXT, dst_id TEXT, kind TEXT, stamp TEXT, PRIMARY KEY (backup_id, src_id))'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS backup_queue (backup_id INTEGER, src_id TEXT, parent_src TEXT, name TEXT, mime TEXT, kind TEXT, stamp TEXT, done INTEGER DEFAULT 0, PRIMARY KEY (backup_id, src_id))'),
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

// ---------- notifikasi (Web Push tanpa isi; isi diambil service worker dari /api/alerts) ----------
async function vapidKeys(env) {
  let v = await getSetting(env, 'vapid');
  if (!v) {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = b64u(await crypto.subtle.exportKey('raw', k.publicKey));
    v = JSON.stringify({ pub, jwk: await crypto.subtle.exportKey('jwk', k.privateKey) });
    await setSetting(env, 'vapid', v);
  }
  return JSON.parse(v);
}
async function sendPush(env) {
  const subs = (await env.DB.prepare('SELECT endpoint FROM push_subs').all()).results || [];
  if (!subs.length) return;
  const v = await vapidKeys(env);
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  for (const { endpoint } of subs) {
    const u = new URL(endpoint);
    const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const pl = b64u(enc.encode(JSON.stringify({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:noreply@outsiderdev.com' })));
    const sig = b64u(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(h + '.' + pl)));
    const r = await fetch(endpoint, { method: 'POST', headers: { authorization: `vapid t=${h}.${pl}.${sig}, k=${v.pub}`, ttl: '86400', urgency: 'normal', 'content-length': '0' } }).catch(() => null);
    if (r && (r.status === 404 || r.status === 410)) await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(endpoint).run();
  }
}
async function addAlert(env, kind, title, bodyText, url = '/') {
  await env.DB.prepare('INSERT INTO alerts(ts,kind,title,body,url) VALUES(?,?,?,?,?)').bind(Date.now(), kind, title, bodyText, url).run();
  await env.DB.prepare('DELETE FROM alerts WHERE id <= (SELECT id FROM alerts ORDER BY id DESC LIMIT 1 OFFSET 100)').run();
  await sendPush(env).catch(() => {});
}
async function checkAlerts(env) {
  for (const a of await quotas(env)) {
    const key = 'al_' + a.id;
    const last = JSON.parse((await getSetting(env, key)) || '{}');
    const now = Date.now();
    if (a.error) {
      if (!last.err || now - last.err > 3 * 864e5) { await addAlert(env, 'error', 'Akses akun terputus', `${a.email} perlu dihubungkan ulang.`, '/'); last.err = now; }
    } else if (a.limit && a.usage / a.limit >= 0.9) {
      if (!last.full || now - last.full > 3 * 864e5) { await addAlert(env, 'full', 'Akun hampir penuh', `${a.email} sudah terpakai ${Math.round((a.usage / a.limit) * 100)}%.`, '/'); last.full = now; }
    } else { delete last.full; delete last.err; }
    await setSetting(env, key, JSON.stringify(last));
  }
}

// ---------- cadangan antar akun ----------
// Diproses bertahap: tiap langkah memakai sedikit permintaan agar aman di batas Cloudflare gratis.
async function backupStep(env, bk) {
  const src = await getAcc(env, bk.src_acc), dst = await getAcc(env, bk.dst_acc);
  let budget = 30, copied = 0;
  if (bk.phase === 'idle' || !bk.phase) {
    await env.DB.prepare('DELETE FROM backup_queue WHERE backup_id=?').bind(bk.id).run();
    await env.DB.prepare('INSERT INTO backup_queue(backup_id,src_id,parent_src,name,mime,kind,done) VALUES(?,?,?,?,?,?,0)').bind(bk.id, bk.src_folder, '', bk.name, FOLDER, 'dir').run();
    await env.DB.prepare('INSERT OR REPLACE INTO backup_items(backup_id,src_id,dst_id,kind) VALUES(?,?,?,?)').bind(bk.id, bk.src_folder, bk.dst_folder, 'dir').run();
    await env.DB.prepare("UPDATE backups SET phase='scan', last_status='Mendata isi folder…' WHERE id=?").bind(bk.id).run();
    bk.phase = 'scan';
  }
  if (bk.phase === 'scan') {
    const dirs = (await env.DB.prepare("SELECT * FROM backup_queue WHERE backup_id=? AND kind='dir' AND done=0 LIMIT 5").bind(bk.id).all()).results || [];
    for (const d of dirs) {
      if (budget < 6) break;
      const map = await env.DB.prepare('SELECT dst_id FROM backup_items WHERE backup_id=? AND src_id=?').bind(bk.id, d.src_id).first();
      let dstDir = map?.dst_id;
      if (!dstDir) {
        const parent = await env.DB.prepare('SELECT dst_id FROM backup_items WHERE backup_id=? AND src_id=?').bind(bk.id, d.parent_src).first();
        const f = await gjson(env, dst, '/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: d.name, mimeType: FOLDER, parents: [parent.dst_id] }) });
        budget -= 1; dstDir = f.id;
        await env.DB.prepare('INSERT OR REPLACE INTO backup_items(backup_id,src_id,dst_id,kind) VALUES(?,?,?,?)').bind(bk.id, d.src_id, dstDir, 'dir').run();
      }
      const q = encodeURIComponent(`'${qesc(d.src_id)}' in parents and trashed=false`);
      const r = await gjson(env, src, `/files?q=${q}&pageSize=1000&fields=files(id,name,mimeType,md5Checksum,modifiedTime)`);
      budget -= 2;
      for (const f of r.files || []) {
        const isDir = f.mimeType === FOLDER, stamp = f.md5Checksum || f.modifiedTime;
        if (!isDir) {
          const have = await env.DB.prepare('SELECT stamp FROM backup_items WHERE backup_id=? AND src_id=?').bind(bk.id, f.id).first();
          if (have && have.stamp === stamp) continue;
        }
        await env.DB.prepare('INSERT OR REPLACE INTO backup_queue(backup_id,src_id,parent_src,name,mime,kind,stamp,done) VALUES(?,?,?,?,?,?,?,0)').bind(bk.id, f.id, d.src_id, f.name, f.mimeType, isDir ? 'dir' : 'file', stamp).run();
      }
      await env.DB.prepare('UPDATE backup_queue SET done=1 WHERE backup_id=? AND src_id=?').bind(bk.id, d.src_id).run();
    }
    const left = await env.DB.prepare("SELECT COUNT(*) n FROM backup_queue WHERE backup_id=? AND kind='dir' AND done=0").bind(bk.id).first();
    if (!left.n) { await env.DB.prepare("UPDATE backups SET phase='copy' WHERE id=?").bind(bk.id).run(); bk.phase = 'copy'; }
  }
  if (bk.phase === 'copy') {
    const files = (await env.DB.prepare("SELECT * FROM backup_queue WHERE backup_id=? AND kind='file' AND done=0 LIMIT 5").bind(bk.id).all()).results || [];
    for (const f of files) {
      if (budget < 7) break;
      const parent = await env.DB.prepare('SELECT dst_id FROM backup_items WHERE backup_id=? AND src_id=?').bind(bk.id, f.parent_src).first();
      const old = await env.DB.prepare('SELECT dst_id FROM backup_items WHERE backup_id=? AND src_id=?').bind(bk.id, f.src_id).first();
      try {
        const { file } = await copyFile(env, src, f.src_id, dst, parent.dst_id);
        budget -= 5;
        if (old?.dst_id) { await gjson(env, dst, `/files/${old.dst_id}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) }).catch(() => {}); budget -= 1; }
        await env.DB.prepare('INSERT OR REPLACE INTO backup_items(backup_id,src_id,dst_id,kind,stamp) VALUES(?,?,?,?,?)').bind(bk.id, f.src_id, file.id, 'file', f.stamp).run();
        copied++;
      } catch (e) { budget -= 5; /* jenis yang tidak bisa disalin dilewati */ }
      await env.DB.prepare('UPDATE backup_queue SET done=1 WHERE backup_id=? AND src_id=?').bind(bk.id, f.src_id).run();
    }
    const left = await env.DB.prepare("SELECT COUNT(*) n FROM backup_queue WHERE backup_id=? AND kind='file' AND done=0").bind(bk.id).first();
    const total = await env.DB.prepare("SELECT COUNT(*) n FROM backup_queue WHERE backup_id=? AND kind='file'").bind(bk.id).first();
    await env.DB.prepare('UPDATE backups SET copied=copied+? WHERE id=?').bind(copied, bk.id).run();
    if (!left.n) {
      const status = total.n ? `Selesai: ${total.n} file baru/berubah disalin` : 'Selesai: tidak ada perubahan';
      await env.DB.prepare("UPDATE backups SET phase='idle', last_run=?, last_status=? WHERE id=?").bind(Date.now(), status, bk.id).run();
      await env.DB.prepare('DELETE FROM backup_queue WHERE backup_id=?').bind(bk.id).run();
      await logAct(env, 'backup', `${bk.name}: ${status}`, bk.dst_acc);
      if (total.n) await addAlert(env, 'backup', 'Cadangan selesai', `${bk.name}: ${total.n} file disalin ke ${dst.email}.`, '/');
      return { done: true, status, copied, remaining: 0 };
    }
    await env.DB.prepare('UPDATE backups SET last_status=? WHERE id=?').bind(`Menyalin… ${total.n - left.n}/${total.n}`, bk.id).run();
    return { done: false, copied, remaining: left.n, total: total.n };
  }
  return { done: false, scanning: true };
}
async function autoBackupTick(env) {
  const now = Date.now();
  const all = (await env.DB.prepare("SELECT * FROM backups WHERE mode='auto'").all()).results || [];
  const due = all.find((b) => b.phase && b.phase !== 'idle') ||
    all.find((b) => !b.last_run || now - b.last_run > (b.freq === 'daily' ? 864e5 : 7 * 864e5));
  if (due) await backupStep(env, due);
}

// ---------- halaman link berbagi publik ----------
function linkPage(title, inner) {
  return new Response(`<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<link rel="icon" href="/icon-192.png"><meta name="robots" content="noindex">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;800&display=swap" rel="stylesheet">
<style>:root{--bg:#f6f8fc;--s:#fff;--i:#16213a;--i2:#5b6782;--l:#e2e7f0;--p:#2f6bff}@media(prefers-color-scheme:dark){:root{--bg:#0d1322;--s:#151d31;--i:#e8ecf6;--i2:#a3adc4;--l:#25304d;--p:#5b8cff}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:var(--bg);color:var(--i);font-family:"Plus Jakarta Sans",system-ui,sans-serif}
.c{width:100%;max-width:400px;background:var(--s);border:1px solid var(--l);border-radius:24px;padding:28px;text-align:center}
.ic{width:72px;height:72px;border-radius:20px;background:var(--p);color:#fff;display:grid;place-items:center;margin:0 auto 16px;font-weight:800;font-size:15px}
h1{font-size:18px;margin:0 0 6px;word-break:break-word}p{color:var(--i2);margin:0 0 18px;font-size:14px}
input{width:100%;height:46px;border:1.5px solid var(--l);border-radius:12px;padding:0 14px;background:var(--bg);color:var(--i);font:inherit;margin-bottom:10px}
button,a.b{display:flex;width:100%;height:46px;align-items:center;justify-content:center;border:0;border-radius:99px;background:var(--p);color:#fff;font:700 15px inherit;text-decoration:none;cursor:pointer}
.e{color:#e5484d}.f{margin-top:22px;font-size:12.5px;color:var(--i2)}.f a{color:var(--i);font-weight:700;text-decoration:none}</style></head>
<body><div class="c">${inner}<div class="f">Dibagikan lewat <a href="https://outsiderdev.com" target="_blank" rel="noopener">Drive Gabungan · OutsiderDev</a></div></div></body></html>`,
  { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
}
function escH(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function fmtB(b) { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; b = Number(b || 0); while (b >= 1024 && i < 4) { b /= 1024; i++; } return (i ? b.toFixed(1) : b) + ' ' + u[i]; }
async function linkRoute(env, req, url, id, dl) {
  const L = await env.DB.prepare('SELECT * FROM links WHERE id=?').bind(id).first();
  const dead = !L || (L.expires && L.expires < Date.now()) || (L.max_dl && L.dl >= L.max_dl);
  if (dead) return linkPage('Link tidak tersedia', `<div class="ic">!</div><h1>Link tidak tersedia</h1><p>Link ini sudah kedaluwarsa, mencapai batas unduhan, atau dicabut pemiliknya.</p>`);
  const ext = (L.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
  const info = `${fmtB(L.size)}${L.expires ? ' · berlaku sampai ' + new Date(L.expires).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : ''}`;
  let err = '';
  if (req.method === 'POST' || dl) {
    if (L.pw_hash) {
      const pw = req.method === 'POST' ? (await req.formData()).get('pw') || '' : '';
      if (!safeEq(await hashPw(pw, L.pw_salt), L.pw_hash)) {
        if (req.method === 'POST') await new Promise((r) => setTimeout(r, 800));
        err = req.method === 'POST' ? '<p class="e">Password salah.</p>' : '';
      }
    }
    if (!err && (!L.pw_hash || req.method === 'POST')) {
      const acc = await getAcc(env, L.acc_id);
      const ex = EXPORT_DL[L.mime];
      const r = ex ? await gapi(env, acc, `/files/${encodeURIComponent(L.file_id)}/export?mimeType=${encodeURIComponent(ex[0])}`) : await gapi(env, acc, `/files/${encodeURIComponent(L.file_id)}?alt=media`);
      if (!r.ok) return linkPage('Gagal', `<div class="ic">!</div><h1>File tidak bisa diambil</h1><p>File mungkin sudah dihapus atau dipindah oleh pemiliknya.</p>`);
      await env.DB.prepare('UPDATE links SET dl=dl+1 WHERE id=?').bind(id).run();
      const name = ex && !L.name.endsWith('.' + ex[1]) ? L.name + '.' + ex[1] : L.name;
      const h = { 'content-type': ex ? ex[0] : L.mime || 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
      if (r.headers.get('content-length')) h['content-length'] = r.headers.get('content-length');
      return new Response(r.body, { headers: h });
    }
  }
  const form = L.pw_hash
    ? `<form method="post" action="/s/${escH(id)}">${err}<input type="password" name="pw" placeholder="Password dari pengirim" required autofocus><button type="submit">Unduh</button></form>`
    : `<a class="b" href="/s/${escH(id)}/dl">Unduh</a>`;
  return linkPage(escH(L.name), `<div class="ic">${escH(ext)}</div><h1>${escH(L.name)}</h1><p>${escH(info)}</p>${form}`);
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

// Salin satu file dari akun src ke folder di akun dst (file Google dikonversi lewat ekspor Office)
async function copyFile(env, src, fileId, dst, folder) {
  const id = encodeURIComponent(fileId);
  const b = { folder };
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
  return { file, meta };
}

async function listFiles(env, accId, folder, q, type, opt = {}) {
  const accs = accId === 'all' ? await allAcc(env) : [await getAcc(env, accId)];
  const parts = [folder === 'trash' && !q ? 'trashed=true' : 'trashed=false'];
  if (q) parts.push(opt.content ? `(name contains '${qesc(q)}' or fullText contains '${qesc(q)}')` : `name contains '${qesc(q)}'`);
  if (opt.after) parts.push(`modifiedTime > '${new Date(Number(opt.after)).toISOString()}'`);
  if (opt.owner === 'me') parts.push(`'me' in owners`);
  if (opt.owner === 'others') parts.push(`not 'me' in owners`);
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
      share_target: { action: '/share-target', method: 'POST', enctype: 'multipart/form-data', params: { title: 'title', text: 'text', url: 'url', files: [{ name: 'files', accept: ['*/*'] }] } },
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

  const lm = p.match(/^\/s\/([A-Za-z0-9_-]{6,20})(\/dl)?$/);
  if (lm) return linkRoute(env, req, url, lm[1], !!lm[2]);

  if (p === '/tentang' || p === '/tentang/') {
    return new Response(TENTANG, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
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

  if ((await getSetting(env, 'origin')) !== url.origin && !url.hostname.endsWith('localhost')) await setSetting(env, 'origin', url.origin);

  if (p === '/api/accounts' && m === 'GET') return json({ accounts: await quotas(env) });

  // ----- link berbagi -----
  if (p === '/api/links') {
    if (m === 'POST') {
      const b = await body(req);
      const a = await getAcc(env, b.acc);
      const meta = await gjson(env, a, `/files/${encodeURIComponent(b.id)}?fields=name,mimeType,size`);
      if (meta.mimeType === FOLDER) throw new HttpError(400, 'Link berbagi hanya untuk file. Untuk folder, gunakan Bagikan.');
      if (meta.mimeType.startsWith('application/vnd.google-apps.') && !EXPORT_DL[meta.mimeType]) throw new HttpError(400, 'Jenis file Google ini tidak bisa diunduh lewat link');
      const id = b64u(crypto.getRandomValues(new Uint8Array(6)));
      let salt = null, hash = null;
      if (b.password) { salt = randHex(16); hash = await hashPw(String(b.password), salt); }
      const exp = Number(b.days) > 0 ? Date.now() + Number(b.days) * 864e5 : null;
      await env.DB.prepare('INSERT INTO links(id,acc_id,file_id,name,mime,size,expires,pw_salt,pw_hash,max_dl,dl,created) VALUES(?,?,?,?,?,?,?,?,?,?,0,?)')
        .bind(id, a.id, b.id, meta.name, meta.mimeType, Number(meta.size || 0), exp, salt, hash, Number(b.max) > 0 ? Number(b.max) : null, Date.now()).run();
      await logAct(env, 'link', meta.name, a.id);
      return json({ ok: true, id, url: url.origin + '/s/' + id });
    }
    if (m === 'DELETE') { await env.DB.prepare('DELETE FROM links WHERE id=?').bind(qp('id')).run(); return json({ ok: true }); }
    const r = (await env.DB.prepare('SELECT id,acc_id,file_id,name,mime,size,expires,max_dl,dl,created, pw_hash IS NOT NULL AS locked FROM links ORDER BY created DESC').all()).results || [];
    return json({ links: r.map((x) => ({ ...x, url: url.origin + '/s/' + x.id, active: !((x.expires && x.expires < Date.now()) || (x.max_dl && x.dl >= x.max_dl)) })) });
  }

  // ----- notifikasi -----
  if (p === '/api/push/key') return json({ key: (await vapidKeys(env)).pub });
  if (p === '/api/push/subscribe' && m === 'POST') {
    const b = await body(req);
    if (!/^https:\/\//.test(b.endpoint || '')) throw new HttpError(400, 'Langganan tidak valid');
    await env.DB.prepare('INSERT OR REPLACE INTO push_subs(endpoint,created) VALUES(?,?)').bind(b.endpoint, Date.now()).run();
    return json({ ok: true });
  }
  if (p === '/api/push/unsubscribe' && m === 'POST') {
    const b = await body(req);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint=?').bind(b.endpoint || '').run();
    return json({ ok: true });
  }
  if (p === '/api/push/test' && m === 'POST') { await addAlert(env, 'test', 'Notifikasi aktif', 'Drive Gabungan akan memberi tahu saat akun hampir penuh atau aksesnya terputus.', '/'); return json({ ok: true }); }
  if (p === '/api/alerts') {
    if (m === 'POST') { await env.DB.prepare('UPDATE alerts SET seen=1').run(); return json({ ok: true }); }
    if (qp('check') === '1') await checkAlerts(env).catch(() => {});
    const r = (await env.DB.prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT 30').all()).results || [];
    return json({ alerts: r, unseen: r.filter((x) => !x.seen).length });
  }

  // ----- cadangan -----
  if (p === '/api/backups') {
    if (m === 'POST') {
      const b = await body(req);
      if (Number(b.src_acc) === Number(b.dst_acc)) throw new HttpError(400, 'Akun tujuan cadangan harus berbeda dari akun sumber');
      const src = await getAcc(env, b.src_acc), dst = await getAcc(env, b.dst_acc);
      const name = String(b.name || 'Folder').slice(0, 120);
      const f = await gjson(env, dst, '/files?fields=id', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cadangan - ' + name, mimeType: FOLDER, parents: ['root'] }) });
      const r = await env.DB.prepare("INSERT INTO backups(name,src_acc,src_folder,dst_acc,dst_folder,mode,freq,phase,created) VALUES(?,?,?,?,?,?,?,'idle',?)")
        .bind(name, src.id, b.src_folder || 'root', dst.id, f.id, b.mode === 'auto' ? 'auto' : 'manual', b.freq === 'daily' ? 'daily' : 'weekly', Date.now()).run();
      await logAct(env, 'backup', `Cadangan dibuat: ${name} → ${dst.email}`, dst.id);
      return json({ ok: true, id: r.meta.last_row_id });
    }
    if (m === 'PATCH') {
      const b = await body(req);
      await env.DB.prepare('UPDATE backups SET mode=?, freq=? WHERE id=?').bind(b.mode === 'auto' ? 'auto' : 'manual', b.freq === 'daily' ? 'daily' : 'weekly', Number(b.id)).run();
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      const id = Number(qp('id'));
      await env.DB.batch(['backups WHERE id', 'backup_items WHERE backup_id', 'backup_queue WHERE backup_id'].map((t) => env.DB.prepare(`DELETE FROM ${t}=?`).bind(id)));
      return json({ ok: true });
    }
    const r = (await env.DB.prepare('SELECT * FROM backups ORDER BY id').all()).results || [];
    return json({ backups: r });
  }
  if (p === '/api/backups/step' && m === 'POST') {
    const b = await body(req);
    const bk = await env.DB.prepare('SELECT * FROM backups WHERE id=?').bind(Number(b.id)).first();
    if (!bk) throw new HttpError(404, 'Cadangan tidak ditemukan');
    return json(await backupStep(env, bk));
  }

  // ----- sematan sidebar -----
  if (p === '/api/pins') {
    if (m === 'POST') { const b = await body(req); await setSetting(env, 'pins', JSON.stringify((b.pins || []).slice(0, 30))); return json({ ok: true }); }
    return json({ pins: JSON.parse((await getSetting(env, 'pins')) || '[]') });
  }

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
    const { file, meta } = await copyFile(env, src, b.id, dst, b.folder);
    if (b.mode === 'move') {
      await gjson(env, src, `/files/${encodeURIComponent(b.id)}?fields=id`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
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
    return json(await listFiles(env, qp('acc') || 'all', qp('folder'), (qp('q') || '').trim(), qp('type'), { content: qp('content') === '1', after: qp('after'), owner: qp('owner') }));
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
