// js/pdf.js - ekspor PDF yang konsisten di HP maupun desktop
//
// Masalah di HP: html2pdf merender elemen sesuai lebar layar saat itu (sekitar 350 px), sehingga PDF
// berukuran huruf raksasa dan tata letak berubah. Solusi: elemen disalin ke area di luar layar berlebar
// tetap setara kertas A4 (794 px), lalu PDF dibuat dari salinan itu.
//
// html2pdf berukuran sekitar 900 KB, jadi tidak dimuat bersama halaman. Baru diunduh saat tombol PDF ditekan.

const PDFExport = {
  SRC: 'https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js',
  A4_WIDTH_PX: 794,

  async fromElement(sourceElement, filename) {
    await window.UI.loadScript(this.SRC, () => typeof window.html2pdf === 'function');

    const wrapper = document.createElement('div');
    wrapper.style.cssText = `position:absolute;left:-10000px;top:0;width:${this.A4_WIDTH_PX}px;background:#fff;`;

    const clone = sourceElement.cloneNode(true);
    clone.removeAttribute('id');
    clone.classList.remove('hidden');
    clone.style.width = `${this.A4_WIDTH_PX}px`;
    // Tinggi mengikuti isi. Jangan dipaksa setinggi kertas penuh (min-height: 297mm): setelah dikurangi margin,
    // elemen setinggi itu selalu "tumpah" ke halaman kedua yang nyaris kosong.
    clone.style.minHeight = '0';
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);

    try {
      // HP punya batas ukuran canvas (iOS Safari ~16 juta piksel); skala lebih kecil mencegah PDF kosong pada laporan panjang
      const scale = window.UI.isMobile() ? 1.5 : 2;
      await window.html2pdf().set({
        margin: 10,
        filename,
        image: { type: 'jpeg', quality: 0.95 },
        html2canvas: {
          scale,
          useCORS: true,
          backgroundColor: '#ffffff',
          windowWidth: this.A4_WIDTH_PX,
          scrollX: 0,
          scrollY: 0
        },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: { mode: ['css', 'legacy'], avoid: ['.pdf-avoid-break'] }
      }).from(clone).save();
    } finally {
      if (wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    }
  },

  // Nama file aman untuk semua sistem operasi
  safeFilename(text, fallback = 'Quiz') {
    const base = String(text || '').replace(/[\\/:*?"<>|]+/g, ' ').trim().replace(/\s+/g, '_');
    return base || fallback;
  }
};

window.PDFExport = PDFExport;
