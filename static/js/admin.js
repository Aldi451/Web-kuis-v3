// js/admin.js

document.addEventListener('DOMContentLoaded', () => {
  // Guard page for Admin role only
  window.Auth.requireRole(['Admin']);

  const tableBody = document.getElementById('users-table-body');
  const formAddUser = document.getElementById('form-add-user');

  // Load and render user list
  async function loadUsers() {
    tableBody.innerHTML = '<tr><td colspan="3" class="text-center text-gray-500 py-4">Memuat data...</td></tr>';
    
    try {
      const users = await window.API.getUsers();

    if (users.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="3" class="text-center text-gray-500 py-4">Tidak ada pengguna ditemukan.</td></tr>';
      return;
    }

    tableBody.innerHTML = '';
    users.forEach(user => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="font-medium">${escapeHTML(user.username)}</td>
        <td><span class="badge ${user.role === 'Admin' ? 'badge-pass' : 'badge-waiting'}">${user.role}</span></td>
        <td class="text-right">
          ${user.username === 'admin' ? 
            `<span class="text-xs text-gray-600">Sistem</span>` : 
            `<button class="btn btn-danger text-xs py-1 px-3 btn-delete-user" data-id="${user.id}">Hapus</button>`
          }
        </td>
      `;
      tableBody.appendChild(row);
    });

    } catch (err) {
      tableBody.innerHTML = `<tr><td colspan="3" class="text-center text-red-500 py-4">Error: ${err.message}</td></tr>`;
    }

    // Attach delete listeners
    document.querySelectorAll('.btn-delete-user').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const userId = e.target.getAttribute('data-id');
        if (confirm('Apakah Anda yakin ingin menghapus pengguna ini?')) {
          try {
            await window.API.deleteUser(userId);
            loadUsers();
          } catch (err) {
            alert('Gagal menghapus user: ' + err.message);
          }
        }
      });
    });
  }

  // Handle Form submit
  formAddUser.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('add-username').value.trim();
    const password = document.getElementById('add-password').value;
    const role = document.getElementById('add-role').value;

    try {
      await window.API.register(username, password, role);
      formAddUser.reset();
      loadUsers();
    } catch (err) {
      alert('Gagal menambahkan user: ' + err.message);
    }
  });

  function escapeHTML(str) {
    return str.replace(/[&<>'"]/g, 
      tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
  }

  // Initial load
  loadUsers();
});
