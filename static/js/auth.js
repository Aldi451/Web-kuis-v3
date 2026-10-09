// js/auth.js - sesi login Host / Member / Admin (disimpan di localStorage browser)

const Auth = {
  async login(username, password) {
    // Lewat API.request supaya error jaringan / non-JSON tampil sebagai pesan yang bisa dibaca
    let data;
    try {
      data = await window.API.request('/api/auth/login', 'POST', { username, password }, { retries: 0 });
    } catch (e) {
      if (e.status === 401) throw new Error('Username atau password salah.');
      throw e;
    }

    // Store user session info (+ token sesi: dipakai saat Member scan barcode & join room)
    localStorage.setItem('auth_user', JSON.stringify({
      username: data.username,
      role: data.role
    }));
    localStorage.setItem('auth_token', data.token || '');

    return data;
  },

  getCurrentUser() {
    const session = localStorage.getItem('auth_user');
    if (!session) return null;
    try {
      return JSON.parse(session);
    } catch (e) {
      return null;
    }
  },

  // Token sesi login (dikirim sebagai X-Auth-Token saat join room sebagai Member)
  getToken() {
    return localStorage.getItem('auth_token') || '';
  },

  logout() {
    localStorage.removeItem('auth_user');
    localStorage.removeItem('auth_token');
    localStorage.removeItem('host_active_room');
    // Sesi kuis (peserta) ikut dibersihkan: setelah logout, mulai dari halaman login
    ['client_room_code', 'client_room_id', 'client_participant_name', 'client_department', 'client_session_v2']
      .forEach((key) => localStorage.removeItem(key));
    window.location.href = 'index.html';
  },

  requireRole(allowedRoles) {
    const user = this.getCurrentUser();
    if (!user || !allowedRoles.includes(user.role)) {
      // Pesan ditampilkan di halaman tujuan (alert() sebelum redirect sering terblokir di browser HP)
      const message = user
        ? `Akun "${user.username}" (role ${user.role}) tidak punya akses ke halaman ini. Silakan login dengan akun yang sesuai.`
        : 'Akses ditolak. Silakan login terlebih dahulu.';
      if (window.UI) window.UI.flash(message);
      window.location.href = 'index.html';
      throw new Error('Unauthorized access.');
    }
    return user;
  }
};

window.Auth = Auth;
