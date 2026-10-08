"""
netutils.py - utilitas jaringan (hanya library standar Python).

Dipakai oleh:
  * run_server.py  -> menampilkan alamat yang bisa dibuka dari HP di console
  * app.py         -> endpoint /api/server-info (supaya QR code berisi IP LAN, bukan "localhost")
"""

import ipaddress
import socket
from typing import List


def _is_usable_ipv4(ip: str) -> bool:
    """IPv4 yang masuk akal untuk diakses perangkat lain (bukan loopback / link-local)."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return (
        addr.version == 4
        and not addr.is_loopback
        and not addr.is_link_local      # 169.254.x.x (adapter tanpa DHCP)
        and not addr.is_multicast
        and not addr.is_unspecified
    )


def _primary_ip() -> str:
    """
    IP interface yang dipakai komputer ini untuk keluar ke jaringan (default route).
    Biasanya itu WiFi/LAN utama. Trik UDP connect() tidak mengirim paket apa pun.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.settimeout(0.5)
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except Exception:
        return ""
    finally:
        sock.close()


def get_lan_ips() -> List[str]:
    """
    Daftar IPv4 LAN komputer ini. Urutan pertama = kandidat terbaik (default route).
    Komputer dengan banyak adapter (VirtualBox, WSL, VPN) bisa punya beberapa IP,
    makanya hasilnya berupa list supaya host bisa memilih.
    """
    found: List[str] = []

    primary = _primary_ip()
    if primary and _is_usable_ipv4(primary):
        found.append(primary)

    # Semua IP yang terdaftar untuk hostname komputer ini (termasuk hotspot Windows 192.168.137.1)
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            ip = info[4][0]
            if _is_usable_ipv4(ip) and ip not in found:
                found.append(ip)
    except Exception:  # OSError, atau UnicodeError untuk nama komputer Windows non-ASCII
        pass

    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if _is_usable_ipv4(ip) and ip not in found:
                found.append(ip)
    except Exception:
        pass

    return found


def is_loopback_host(hostname: str) -> bool:
    """True jika hostname hanya bisa dijangkau dari komputer ini sendiri."""
    host = (hostname or "").strip("[]").lower()
    if host in ("localhost", "ip6-localhost", "::1", ""):
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return host.endswith(".localhost")


def is_port_free(port: int, host: str = "0.0.0.0") -> bool:
    """Cek apakah port bisa dipakai (untuk memilih port cadangan jika bentrok)."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        # Di Windows SO_REUSEADDR membolehkan dua proses memakai port yang sama,
        # jadi jangan dipakai di sini supaya hasil cek akurat.
        sock.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        sock.close()
