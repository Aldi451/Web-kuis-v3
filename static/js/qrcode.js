// js/qrcode.js - pembuat QR code untuk halaman Host
//
// Library QR (vendor/qrcode.min.js, MIT) disimpan LOKAL, bukan dari CDN: QR code adalah pintu masuk peserta,
// jadi harus tetap tampil walaupun komputer host tidak punya internet (jaringan LAN saja).

const QRHelper = {
  isAvailable() {
    return typeof window.QRCode === 'function';
  },

  // Gambar QR ke dalam elemen container. Return true jika berhasil.
  render(container, text, size = 200) {
    container.innerHTML = '';
    if (!this.isAvailable()) {
      container.textContent = 'QR tidak tersedia. Bagikan link di bawah.';
      return false;
    }
    try {
      new window.QRCode(container, {
        text,
        width: size,
        height: size,
        colorDark: '#0b0f19',
        colorLight: '#ffffff',
        // M (15% koreksi error) cukup untuk dipindai dari layar/proyektor, dan jauh lebih mudah dibaca
        // kamera HP daripada H karena modulnya lebih besar dan lebih sedikit.
        correctLevel: window.QRCode.CorrectLevel.M
      });
      return true;
    } catch (err) {
      console.error('Gagal membuat QR code:', err);
      container.textContent = 'QR gagal dibuat. Bagikan link di bawah.';
      return false;
    }
  }
};

window.QRHelper = QRHelper;
