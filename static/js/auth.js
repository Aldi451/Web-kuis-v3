// js/auth.js - sesi login Host / Admin (disimpan di localStorage browser)

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

    // Store user session info
    localStorage.setItem('auth_user', JSON.stringify({
      username: data.username,
      role: data.role
    }));

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

  logout() {
    localStorage.removeItem('auth_user');
    localStorage.removeItem('host_active_room');
    window.location.href = 'index.html';
  },

  requireRole(allowedRoles) {
    const user = this.getCurrentUser();
    if (!user || !allowedRoles.includes(user.role)) {
      // Pesan ditampilkan di halaman tujuan (alert() sebelum redirect sering terblokir di browser HP)
      if (window.UI) window.UI.flash('Akses ditolak. Silakan login terlebih dahulu.');
      window.location.href = 'index.html';
      throw new Error('Unauthorized access.');
    }
    return user;
  }
};

window.Auth = Auth;
