# ☁️ Drive Gabungan

Gabungkan beberapa akun Google Drive dalam satu penampil. Self-host: setiap orang men-deploy salinannya sendiri dan otomatis jadi pemilik (admin) instance-nya.

Developed by [OutsiderDev](https://outsiderdev.com)

## Fitur
- Total kuota gabungan + rincian per akun (warna berbeda tiap akun)
- Tampilan "Semua akun" atau per akun, navigasi folder
- Pencarian lintas akun (tombol ✕ untuk menghapus isi pencarian) + filter jenis file
- Pratinjau gambar, video, audio, PDF, Google Docs/Sheets/Slides
- Upload (tombol atau seret-lepas), otomatis masuk ke akun yang paling lega; file besar dikirim per potongan 8 MB
- Unduh, ganti nama, pindah folder, hapus (ke Sampah), buat folder
- Login satu password pemilik; token Google disimpan di D1 milikmu sendiri

## Pasang (sekali klik)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/abdghofur66/drive-gabungan)

1. Klik tombol di atas → login/daftar Cloudflare (gratis) → **Deploy**. Database dibuat otomatis.
2. **Segera** buka alamat Worker yang diberikan → buat password pemilik. Instance ini sekarang milikmu.
3. Aplikasi meminta **Client ID & Secret Google** (sekali saja, lihat bawah) → tempel → Simpan.
4. Klik **+ Hubungkan akun Google**, ulangi untuk setiap akun.
   Saat muncul layar "Google belum memverifikasi aplikasi ini" → **Lanjutan → Buka (tidak aman)**. Ini wajar, aplikasinya milikmu sendiri.

### Membuat Client ID & Secret Google (±5 menit)
1. Buka https://console.cloud.google.com → buat project baru.
2. **APIs & Services → Library** → **Google Drive API** → **Enable**.
3. **Google Auth Platform → Branding**: isi nama aplikasi & email, tipe **External**.
4. **Data Access → Add or remove scopes** → tambahkan `.../auth/drive`.
5. **Clients → Create client** → **Web application** → Authorized redirect URI: salin dari aplikasi (tombol **Salin**).
6. **Audience → Publish app** → status **In production**.
   ⚠️ Jangan biarkan di *Testing*: token kedaluwarsa tiap 7 hari. Tidak perlu mengajukan verifikasi.

### Cara manual (tanpa tombol)
```bash
npm install && npx wrangler login && npx wrangler deploy
```

## Catatan
- Upload dari tampilan "Semua akun" (di root) masuk ke akun dengan ruang kosong terbanyak. Di dalam folder, file masuk ke folder & akun itu.
- Satu file tidak dipecah ke beberapa akun; ukurannya harus muat di salah satu akun.
- Hapus = pindah ke Sampah Google Drive (bisa dipulihkan dari Drive).
- Memutus akun di aplikasi juga mencabut izinnya; file di Drive tetap aman.
- Batas gratis Cloudflare Workers: 100.000 request/hari, lebih dari cukup untuk pemakaian pribadi.
- Lupa password: hapus data pengaturan lalu buat ulang:
  `npx wrangler d1 execute drive-gabungan --remote --command "DELETE FROM settings; DELETE FROM sessions;"`
