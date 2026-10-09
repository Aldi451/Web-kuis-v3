// js/admin.js - manajemen pengguna (Admin)

document.addEventListener('DOMContentLoaded', () => {
  // Guard page for Admin role only
  const currentUser = window.Auth.requireRole(['Admin']);

  const tableBody = document.getElementById('users-table-body');
  const formAddUser = document.getElementById('form-add-user');

  function roleBadge(role) {
    const cls = role === 'Admin' ? 'badge-pass' : role === 'Member' ? 'badge-member' : 'badge-waiting';
    return `<span class="badge ${cls}">${window.escapeHTML(role)}</span>`;
  }

  // Load and render user list
  async function loadUsers() {
    tableBody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500 py-4">Memuat data...</td></tr>';

    try {
      const users = await window.API.getUsers();

      if (users.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" class="text-center text-gray-500 py-4">Tidak ada pengguna ditemukan.</td></tr>';
        return;
      }

      tableBody.innerHTML = '';
      users.forEach((user) => {
        const isSystem = user.username === 'admin';
        const isSelf = user.username === currentUser.username;
        const row = document.createElement('tr');
        row.innerHTML = `
          <td data-label="ID" class="text-xs text-gray-400">#${Number(user.id)}</td>
          <td data-label="Username" class="font-medium">${window.escapeHTML(user.username)}</td>
          <td data-label="Role">${roleBadge(user.role)}</td>
          <td class="text-right cell-actions">
            ${isSystem
              ? '<span class="text-xs text-gray-600">Sistem</span>'
              : `<button type="button" class="btn btn-danger text-xs py-1 px-3 btn-delete-user" style="min-height: 38px;"
                         data-id="${Number(user.id)}" data-name="${window.escapeHTML(user.username)}" data-self="${isSelf}">Hapus</button>`}
          </td>
        `;
        tableBody.appendChild(row);
      });

      // Attach delete listeners
      tableBody.querySelectorAll('.btn-delete-user').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const userId = btn.getAttribute('data-id');
          const name = btn.getAttribute('data-name');
          const self = btn.getAttribute('data-self') === 'true';
          const ok = await window.UI.confirm({
            title: 'Hapus pengguna?',
            message: self
              ? `Anda akan menghapus akun Anda sendiri (${name}). Anda tidak akan bisa login lagi dengan akun ini.`
              : `Akun "${name}" akan dihapus dan tidak bisa login lagi.`,
            confirmText: 'Hapus', cancelText: 'Batal', danger: true
          });
          if (!ok) return;
          try {
            await window.API.deleteUser(userId);
            window.UI.toast('Pengguna dihapus.', 'success');
            if (self) { window.Auth.logout(); return; }
            loadUsers();
          } catch (err) {
            window.UI.alert('Gagal menghapus user: ' + err.message);
          }
        });
      });
    } catch (err) {
      tableBody.innerHTML = `<tr><td colspan="4" class="text-center text-red-500 py-4">Error: ${window.escapeHTML(err.message)}</td></tr>`;
    }
  }

  // Tombol lihat/sembunyikan password
  const toggle = document.getElementById('toggle-add-password');
  toggle.addEventListener('click', () => {
    const input = document.getElementById('add-password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'SEMBUNYI' : 'LIHAT';
  });

  // Handle Form submit
  formAddUser.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('add-username').value.trim();
    const password = document.getElementById('add-password').value;
    const role = document.getElementById('add-role').value;

    const button = document.getElementById('btn-add-user');
    window.UI.setBusy(button, true, 'Menyimpan...');
    try {
      await window.API.register(username, password, role);
      formAddUser.reset();
      window.UI.toast(`Pengguna "${username}" ditambahkan.`, 'success');
      loadUsers();
    } catch (err) {
      window.UI.alert('Gagal menambahkan user: ' + err.message);
    } finally {
      window.UI.setBusy(button, false);
    }
  });

  // Initial load
  loadUsers();
});
