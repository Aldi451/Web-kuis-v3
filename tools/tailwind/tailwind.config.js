// Versi Tailwind (2.2.19) dan konfigurasi bawaan SAMA dengan file CDN yang dipakai halaman,
// sehingga hasil build ini identik dengan CDN - hanya saja berisi class yang benar-benar dipakai.
module.exports = {
  mode: 'jit',
  purge: [
    '../../static/**/*.html',
    '../../static/js/**/*.js',
  ],
  darkMode: false,
  theme: { extend: {} },
  variants: { extend: {} },
  plugins: [],
};
