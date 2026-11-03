#!/usr/bin/env python3
"""Tiny WebSocket broadcast relay for Disco Ball: every text frame from one
client is forwarded to all other clients. Run on the device; the App connects
from localhost and a laptop mirror connects over the LAN. Stdlib only."""
import base64
import hashlib
import socket
import struct
import threading

PORT = 8322
GUID = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
clients = set()
lock = threading.Lock()


def handshake(conn):
    data = b''
    while b'\r\n\r\n' not in data:
        chunk = conn.recv(4096)
        if not chunk:
            return False
        data += chunk
        if len(data) > 65536:
            return False
    key = None
    for line in data.split(b'\r\n'):
        if line.lower().startswith(b'sec-websocket-key:'):
            key = line.split(b':', 1)[1].strip()
    if not key:
        return False
    accept = base64.b64encode(hashlib.sha1(key + GUID).digest())
    conn.send(b'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
              b'Connection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + b'\r\n\r\n')
    return True


def recv_exact(conn, n):
    buf = b''
    while len(buf) < n:
        chunk = conn.recv(n - len(buf))
        if not chunk:
            return None
        buf += chunk
    return buf


def send_text(conn, payload):
    n = len(payload)
    if n < 126:
        head = struct.pack('!BB', 0x81, n)
    elif n < 65536:
        head = struct.pack('!BBH', 0x81, 126, n)
    else:
        head = struct.pack('!BBQ', 0x81, 127, n)
    conn.send(head + payload)


def serve(conn):
    try:
        if not handshake(conn):
            return
        with lock:
            clients.add(conn)
        while True:
            head = recv_exact(conn, 2)
            if not head:
                break
            b1, b2 = head
            op = b1 & 0x0f
            n = b2 & 0x7f
            if n == 126:
                n = struct.unpack('!H', recv_exact(conn, 2))[0]
            elif n == 127:
                n = struct.unpack('!Q', recv_exact(conn, 8))[0]
            mask = recv_exact(conn, 4) if b2 & 0x80 else None
            payload = recv_exact(conn, n) if n else b''
            if payload is None:
                break
            if mask:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            if op == 8:
                break
            if op == 9:
                conn.send(b'\x8a' + bytes([len(payload)]) + payload)
                continue
            if op != 1:
                continue
            with lock:
                others = [c for c in clients if c is not conn]
            for c in others:
                try:
                    send_text(c, payload)
                except OSError:
                    pass
    except OSError:
        pass
    finally:
        with lock:
            clients.discard(conn)
        try:
            conn.close()
        except OSError:
            pass


def main():
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    s.bind(('0.0.0.0', PORT))
    s.listen(8)
    print('relay listening on', PORT, flush=True)
    while True:
        conn, addr = s.accept()
        conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        print('client', addr, flush=True)
        threading.Thread(target=serve, args=(conn,), daemon=True).start()


main()
