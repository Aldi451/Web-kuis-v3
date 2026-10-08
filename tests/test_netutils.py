"""Tes deteksi IP LAN (dasar QR code yang bisa dibuka dari HP)."""
import socket

import netutils


def fake_network(monkeypatch, primary="", addrinfo=(), by_name=()):
    monkeypatch.setattr(netutils, "_primary_ip", lambda: primary)
    monkeypatch.setattr(
        socket, "getaddrinfo",
        lambda host, port, family=0, *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)) for ip in addrinfo])
    monkeypatch.setattr(socket, "gethostbyname_ex", lambda host: (host, [], list(by_name)))


def test_primary_route_ip_comes_first_and_duplicates_removed(monkeypatch):
    # PC dengan WiFi + adapter VirtualBox + WSL: IP default route harus di urutan pertama
    fake_network(monkeypatch, primary="192.168.1.23",
                 addrinfo=["192.168.56.1", "192.168.1.23", "172.28.80.1"],
                 by_name=["192.168.1.23", "10.0.0.5"])
    assert netutils.get_lan_ips() == ["192.168.1.23", "192.168.56.1", "172.28.80.1", "10.0.0.5"]


def test_loopback_and_link_local_are_ignored(monkeypatch):
    fake_network(monkeypatch, primary="169.254.10.4", addrinfo=["127.0.0.1", "127.0.1.1", "169.254.3.3"])
    assert netutils.get_lan_ips() == []


def test_hotspot_adapter_without_default_route_is_found(monkeypatch):
    # Windows Mobile Hotspot: tidak ada default route, tetapi hostname terdaftar di 192.168.137.1
    fake_network(monkeypatch, primary="", addrinfo=["192.168.137.1"])
    assert netutils.get_lan_ips() == ["192.168.137.1"]


def test_resolution_errors_do_not_crash(monkeypatch):
    def boom(*a, **k):
        raise OSError("no network")
    monkeypatch.setattr(netutils, "_primary_ip", lambda: "")
    monkeypatch.setattr(socket, "getaddrinfo", boom)
    monkeypatch.setattr(socket, "gethostbyname_ex", boom)
    assert netutils.get_lan_ips() == []


def test_is_loopback_host():
    for host in ("localhost", "127.0.0.1", "127.5.5.5", "::1", "[::1]", "LOCALHOST", "", "app.localhost"):
        assert netutils.is_loopback_host(host), host
    for host in ("192.168.1.23", "10.0.0.5", "kuis.contoh.com", "8000-abc.e2b.app"):
        assert not netutils.is_loopback_host(host), host


def test_is_port_free():
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("0.0.0.0", 0))
    sock.listen(1)
    busy_port = sock.getsockname()[1]
    try:
        assert netutils.is_port_free(busy_port) is False
    finally:
        sock.close()
    assert netutils.is_port_free(busy_port) is True
