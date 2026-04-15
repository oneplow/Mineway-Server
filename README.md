# Mineway Tunnel Server

WebSocket Tunnel Server สำหรับระบบ **Mineway** — รับการเชื่อมต่อจากปลั๊กอิน Minecraft (Java/Bedrock) แล้วเปิด TCP/UDP Port ให้ผู้เล่นเข้าเกมได้โดยตรง

## สถาปัตยกรรม

```
ผู้เล่น ──► [TCP/UDP :random port] ──► Tunnel Server ──► [WebSocket] ──► Minecraft Server (Plugin)
                                            ▲
                                      Caddy (Auto-SSL)
                                      wss://tunnel.domain.com
```

1. **Plugin** เชื่อม WebSocket (`wss://`) ผ่าน Caddy → ส่ง API Key เพื่อยืนยันตัวตน
2. **Tunnel Server** ตรวจสอบ Key กับ Web Dashboard → ได้รับ port ที่กำหนดมา
3. **Server Bind** เปิด TCP + UDP ที่ port นั้น → ผู้เล่นเข้าเกมได้ทันที
4. **Proxy** ข้อมูลทั้งหมดไหลผ่าน WebSocket กลับไปยัง Minecraft Server แบบ Layer 4

## โครงสร้างไฟล์

```
mineway-server/
├── server.js              # Entry point — WebSocket server + HTTP endpoints
├── Caddyfile              # Caddy reverse proxy config (Auto-SSL)
├── docker-compose.yml     # Docker deploy (Caddy + Tunnel Server)
├── Dockerfile
├── lib/
│   ├── logger.js          # JSON structured logging
│   ├── keyVerifier.js     # API Key verification + memory cache
│   ├── stats.js           # Bandwidth reporting → Web Dashboard
│   └── session.js         # TCP/UDP proxy + socket lifecycle
├── .env.example
└── package.json
```

## Quick Start (Deploy)

### 1. Clone และตั้งค่า

```bash
git clone <repo-url> && cd mineway-server
cp .env.example .env
nano .env
```

แก้ไขค่าเหล่านี้ใน `.env`:

```env
TUNNEL_DOMAIN=tunnel.yourdomain.com    # Domain สำหรับ tunnel (ต้องชี้ DNS มาที่ VPS นี้)
WEB_API_URL=https://yourdomain.com     # URL ของ Web Dashboard
INTERNAL_SECRET=your-random-secret     # ต้องตรงกับ Web Dashboard
```

### 2. Deploy

```bash
docker compose up -d --build
```

**จบ!** 🎉 ไม่ต้องติดตั้ง cert, ไม่ต้อง nginx, ไม่ต้อง cron

Caddy จะ:
- ✅ ขอ SSL certificate อัตโนมัติจาก Let's Encrypt
- ✅ Renew อัตโนมัติ
- ✅ Proxy `wss://tunnel.yourdomain.com` → `ws://localhost:8765`

### 3. เช็คสถานะ

```bash
# ดู logs
docker logs mineway-server
docker logs mineway-caddy

# Health check
curl http://localhost:8765/health
```

## ย้ายไป VPS / Domain อื่น

แค่เปลี่ยน `TUNNEL_DOMAIN` ใน `.env` แล้ว:

```bash
docker compose down
docker compose up -d --build
```

ไม่ต้องยุ่งกับ SSL cert เลย — Caddy จัดการให้ทั้งหมด

## Environment Variables

| ตัวแปร | หน้าที่ | ค่าตัวอย่าง |
|---|---|---|
| `TUNNEL_DOMAIN` | Domain สำหรับ Caddy auto-SSL | `tunnel.mineway.cloud` |
| `WS_PORT` | Port ภายในของ Tunnel Server | `8765` |
| `WEB_API_URL` | URL ของ Web Dashboard | `https://mineway.cloud` |
| `INTERNAL_SECRET` | Secret สำหรับ internal API | `random-string-here` |
| `BASE_DOMAIN` | Fallback domain สำหรับแสดงผล | `mineway.cloud` |
| `KEY_CACHE_TTL` | Cache timeout ของ key verification (วินาที) | `60` |

## HTTP Endpoints (Internal)

| Method | Path | Auth | หน้าที่ |
|---|---|---|---|
| `GET` | `/health` | — | Health check (Docker, monitoring) |
| `GET` | `/stats` | `x-internal-secret` | ดู sessions + bandwidth แบบ realtime |
| `POST` | `/kick/{keyId}` | `x-internal-secret` | ตัดการเชื่อมต่อของ key |
| `POST` | `/suspend/{keyId}` | `x-internal-secret` | Suspend tunnel (ผู้เล่นทั้งหมดถูกตัด) |
| `POST` | `/resume/{keyId}` | `x-internal-secret` | Resume tunnel กลับมา |

## Prerequisites

- VPS ที่มี Docker + Docker Compose
- Domain ที่ชี้ DNS (A Record) มายัง IP ของ VPS
- Port 80, 443 เปิดอยู่ (สำหรับ Caddy SSL)
- Port 10000-60000 เปิดอยู่ (สำหรับ player connections)
