# MCTunnel — VPS Tunnel Server

รันบน VPS ตลอดเวลา รับ WebSocket จาก Minecraft Plugin แล้ว forward TCP traffic ไป-กลับ

## โครงสร้างไฟล์

```
mct-tunnel-server/
├── index.js                  ← entry point
├── .env.example
├── src/
│   ├── tunnelServer.js       ← WebSocket server หลัก + health check HTTP
│   ├── tunnelSession.js      ← จัดการ 1 plugin connection + TCP server
│   ├── keyVerifier.js        ← verify API key กับ Next.js web app
│   ├── statsReporter.js      ← รายงาน bandwidth กลับ Next.js ทุก 30s
│   ├── portAllocator.js      ← จัดการ TCP port pool
│   └── logger.js             ← structured JSON logger
└── nextjs-routes/            ← copy ไปใส่ใน Next.js app/api/internal/
    ├── verify-key/route.js
    └── report-usage/route.js
```

## ติดตั้ง

```bash
npm install
cp .env.example .env
# แก้ไข .env ให้ถูกต้อง
```

## .env ที่ต้องตั้ง

```env
WS_PORT=8765
WEB_API_URL=https://your-web-app.com
INTERNAL_SECRET=random-secret-ยาวๆ   # ต้องตรงกับ INTERNAL_SECRET ใน Next.js
PORT_RANGE_START=25500
PORT_RANGE_END=25999
```

## รัน

```bash
# Development
npm run dev

# Production (แนะนำใช้ PM2)
npm install -g pm2
pm2 start index.js --name mct-tunnel
pm2 save
pm2 startup
```

## Next.js — ไฟล์ที่ต้องเพิ่ม

copy ไฟล์จาก `nextjs-routes/` ไปไว้ที่:
```
app/api/internal/verify-key/route.js
app/api/internal/report-usage/route.js
```

และเพิ่มใน Next.js `.env`:
```env
INTERNAL_SECRET=random-secret-ตัวเดียวกัน
```

## Protocol Plugin <-> Tunnel Server

### Plugin ส่งมา (WebSocket JSON)
| type | fields | ความหมาย |
|------|--------|----------|
| `auth` | `key` | ส่ง API key ตอนแรก |
| `mc_data` | `connId`, `data` (base64) | ข้อมูลจาก MC server กลับไปผู้เล่น |
| `mc_disconnect` | `connId` | MC server ปิด connection |
| `pong` | — | ตอบ ping |

### Tunnel Server ส่งให้ Plugin (WebSocket JSON)
| type | fields | ความหมาย |
|------|--------|----------|
| `auth_ok` | `keyId`, `plan` | auth ผ่าน |
| `auth_failed` | `reason` | auth ไม่ผ่าน |
| `tunnel_ready` | `port` | TCP port พร้อมแล้ว |
| `player_connect` | `connId` | ผู้เล่นใหม่เชื่อมต่อ |
| `player_data` | `connId`, `data` (base64) | ข้อมูลจากผู้เล่น -> MC server |
| `player_disconnect` | `connId` | ผู้เล่นหลุด |
| `ping` | — | ตรวจว่า plugin ยังอยู่ |

## Firewall

เปิด port บน VPS:
```bash
# WebSocket port (plugin เชื่อม)
ufw allow 8765/tcp

# TCP port range (ผู้เล่นเชื่อม)
ufw allow 25500:25999/tcp
```

## Health Check

```
GET http://localhost:8765/health
→ { "status": "ok", "sessions": 3, "ports": { "total": 500, "used": 3, "free": 497 } }
```
