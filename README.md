# ☁️ Drive Gabungan

Gabungkan beberapa akun Google Drive dalam satu penampil. Self-host: setiap orang men-deploy salinannya sendiri dan otomatis jadi pemilik (admin) instance-nya.

Developed by [OutsiderDev](https://outsiderdev.com)

## Fitur
- Total kuota gabungan + rincian per akun (warna berbeda tiap akun)
- Tampilan "Semua akun" atau per akun, navigasi folder
- Pencarian lintas akun (tombol ✕ untuk menghapus isi pencarian) + filter jenis file
- Pratinjau gambar, video, audio, PDF, Google Docs/Sheets/Slides
- Upload (tombol atau seret-lepas) dengan pilihan akun & folder tujuan (akun paling lega terpilih otomatis); file besar dikirim per potongan 8 MB
- Tombol **Baru**: folder, upload file/folder, Google Dokumen/Spreadsheet/Slide/Formulir, dengan pilihan akun & folder tujuan
- Menu **Dibagikan ke saya**, **Berbintang**, **Sampah** (pulihkan, hapus selamanya, kosongkan) dengan pilihan akun
- Bagikan file/folder, pilih banyak, unduh sebagai ZIP, ganti nama, pindah, hapus
- Beranda: ringkasan ruang, donut per akun, saran merapikan (file kembar, akun hampir penuh, file besar terbengkalai), aktivitas terbaru
- Pindah/salin file & folder **antar akun** (juga lewat seret ke akun di sidebar), seret ke folder untuk memindah
- Panel detail, galeri foto, durasi video, foto profil akun
- Keamanan: kunci otomatis, masuk dengan sidik jari/wajah (passkey), riwayat masuk (termasuk percobaan gagal, peringatan perangkat baru), daftar perangkat yang login, pintasan keyboard (tekan `?`), urungkan hapus
- Link berbagi sendiri (`/s/…`) untuk file **dan folder** (jelajah subfolder, unduh semua sebagai ZIP): bisa diunduh atau **hanya lihat** (pratinjau), durasi dalam menit/jam/hari, password, batas unduhan/dibuka
- Cadangan folder ke akun lain: otomatis harian/mingguan (cron Cloudflare) atau manual
- Notifikasi di HP saat akun hampir penuh, akses terputus, atau cadangan selesai
- Cari sampai ke isi dokumen + filter waktu, ukuran, pemilik; sematkan folder di sidebar
- Terima file dari tombol **Bagikan** di HP (PWA share target)
- Login satu password pemilik; token Google disimpan di D1 milikmu sendiri

## Pasang (sekali klik)

📖 **Panduan bergambar:** https://drive.outsiderdev.com/panduan · **Halaman produk:** https://drive.outsiderdev.com/tentang

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abdghofur66/drive-gabungan)

1. Klik tombol di atas → login/daftar Cloudflare (gratis) → pilih akun GitHub → isi **Project name** yang belum dipakai sebagai nama repo di GitHub-mu (mis. `drive-saya`) → **Deploy**. Database dibuat otomatis.
2. **Segera** buka alamat Worker yang diberikan → buat password pemilik. Instance ini sekarang milikmu.
3. Aplikasi meminta **Client ID & Secret Google** (sekali saja, lihat bawah) → tempel → Simpan.
4. Klik **+ Hubungkan akun Google**, ulangi untuk setiap akun.
   Saat muncul layar "Google belum memverifikasi aplikasi ini" → **Lanjutan → Buka (tidak aman)**. Ini wajar, aplikasinya milikmu sendiri.

### Membuat Client ID & Secret Google (±5 menit)
1. Buka https://console.cloud.google.com → buat project baru.
2. **APIs & Services → Library** → **Google Drive API** → **Enable**.
3. **Google Auth Platform → Get started**: isi nama aplikasi & email, tipe **External**, centang persetujuan → Create.
   Lalu di **Branding** isi *Application home page*, *privacy policy link* dan *terms of service link* dengan alamat aplikasimu → Save. **Wajib**, tanpa ini tombol Publish app tidak aktif.
4. **Data Access → Add or remove scopes** → tambahkan `.../auth/drive`.
5. **Clients → Create client** → **Web application** → Authorized redirect URI: salin dari aplikasi (tombol **Salin**).
6. **Audience → Publish app** → status **In production**.
   ⚠️ Jangan biarkan di *Testing*: token kedaluwarsa tiap 7 hari. Tidak perlu mengajukan verifikasi.

### Domain sendiri (opsional)
Jika domainmu sudah dikelola di Cloudflare:
1. **Workers & Pages → project-mu → Domains → Add Domain** → pilih domain → isi subdomain (mis. `drive`) → **Add domain**.
2. **Google Auth Platform → Clients → client-mu → Authorized redirect URIs → Add URI**: `https://drive.domainmu.com/oauth/callback` → **Save** (tunggu 5–10 menit).
3. Masuk lagi di alamat baru (login, passkey, dan aplikasi terpasang tersimpan per alamat). Alamat `.workers.dev` tetap berfungsi.

### Cara manual (tanpa tombol)
```bash
npm install && npx wrangler login && npx wrangler deploy
```

## Catatan
- Saat upload atau membuat item baru, kamu memilih akun dan folder tujuan; akun paling lega ditandai, akun yang ruangnya tidak cukup tidak bisa dipilih.
- Satu file tidak dipecah ke beberapa akun; ukurannya harus muat di salah satu akun.
- Hapus = pindah ke Sampah Google Drive (bisa dipulihkan dari Drive).
- Memutus akun di aplikasi juga mencabut izinnya; file di Drive tetap aman.
- Batas gratis Cloudflare Workers: 100.000 request/hari, lebih dari cukup untuk pemakaian pribadi.
- Lupa password: Cloudflare → D1 SQLite Database → database aplikasimu → Console, jalankan
  `DELETE FROM settings WHERE key LIKE 'pw_%'; DELETE FROM sessions;` lalu buka aplikasi untuk membuat password baru (akun Google tetap terhubung).

## Lisensi

Open source dengan [lisensi MIT](LICENSE): bebas dipakai, diubah, dan dikembangkan (termasuk komersial) dengan tetap mencantumkan nama pembuat.

📰 Artikel perkenalan: https://outsiderdev.com/artikel/drive-gabungan-satukan-akun-google-drive
