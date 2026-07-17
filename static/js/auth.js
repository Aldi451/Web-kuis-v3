// js/auth.js

const Auth = {
  async login(username, password) {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.detail || "Username atau password salah.");
    }
    
    const data = await res.json();

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
    window.location.href = 'index.html';
  },

  requireRole(allowedRoles) {
    const user = this.getCurrentUser();
    if (!user || !allowedRoles.includes(user.role)) {
      alert("Akses ditolak. Anda tidak memiliki izin untuk halaman ini.");
      window.location.href = 'index.html';
      throw new Error("Unauthorized access.");
    }
    return user;
  }
};

window.Auth = Auth;
