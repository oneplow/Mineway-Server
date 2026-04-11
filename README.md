# Mineway Server

Tunnel Server สำหรับระบบ **Mineway**
ทำหน้าที่รับการเชื่อมต่อผ่าน WebSockets จากปลั๊กอิน Minecraft (Java/Bedrock) ต้นทาง และเปิด Port Allocation พิเศษสำหรับให้ผู้เล่นทั่วไปต่อเข้ามาแบบดิบๆ (Layer 4)

## Architecture: Port Allocation

ระบบนี้เปลี่ยนจากการทำ Subdomain Routing มาใช้โมเดล **Port Allocation** เพื่อรองรับร้อยละร้อยอย่างเต็มที่กับทั้ง Java Edition และ Bedrock Edition (UDP) 

1. **Authentication:** 
   เมื่อ Plugin รัน จะส่ง `{"type":"auth", "key":"..."}` ผ่าน WebSocket วิ่งเข้าพอร์ต `:8765`
2. **Key Verification:** 
   Tunnel Server ตรวจสอบ API Key กับ `mc-tunnels-web` (Next.js API) ถ้าผ่าน จะได้ `assignedPort` ประจำตัวมา
3. **Session Binding:** 
   ระบบจะทำการผูก (Bind) `net.createServer()` (TCP) และ `dgram.createSocket()` (UDP) ไว้ที่พอร์ตตัวเลขนั้น (เช่น `:10000`, `:10001`...)
4. **Proxy:** 
   ผู้เล่นเข้าเกมผ่านพอร์ตดังกล่าว ข้อมูลทั้งหมดจะถูกส่งกลับเข้าไปใน WebSocket สู่ตัวเซิร์ฟเวอร์ Minecraft อย่างโปร่งใส (Fast & Clean)

## โครงสร้างตัวแอปพลิเคชัน (Structure)

```text
mct-tunnel-server/
├── server.js              ← Entry point แจกจ่ายและเปิด WebSocketServer ต่อสายรวมครบในไฟล์เดียว
├── lib/
│   ├── logger.js          ← ระบบ JSON log สำหรับลง Console / Log file 
│   ├── keyVerifier.js     ← ลอจิกตรวจสอบ API Key แถมมี Memory Caching ในตัว
│   ├── stats.js           ← ลอจิกรวบรวม Bandwidth ส่งรายงานกลับ Next.js 
│   └── session.js         ← กลไก TCP+UDP Proxy + Socket Lifecycle
├── .env.example
└── package.json
```

## ตัวแปร Environment (.env)

จำลองไฟล์ `.env` ตามตัวอย่างใน `.env.example`:

| ตัวแปร | หน้าที่ | ค่าแนะนำ |
| --- | --- | --- |
| `WS_PORT` | พอร์ตเอาไว้รับ Plugin แบบ WebSocket | `8765` |
| `BASE_DOMAIN` | ชื่อโดเมนที่เอาไว้ส่งกลับไปโชว์สวยๆ ในหน้า Console เกม | `play.lexten.store` |
| `WEB_API_URL` | URL ของ Next.js Web Dashboard | `http://localhost:3000` |
| `INTERNAL_SECRET` | รหัสผ่านหลังบ้าน เอาไว้คุย API ระหว่าง Node.js ด้วยกัน | `your-secret-here` |
| `KEY_CACHE_TTL` | ระยะเวลาจำ API Key ในเครื่อง (วินาที) | `60` |

## วิธีเปิดใช้งาน

1. รันฝั่ง Web Dashboard ก่อน (แน่ใจว่าเข้า `WEB_API_URL` ได้)
2. ก๊อปปี้ไฟล์ `.env.example` เป็น `.env` และตั้งค่าตัวแปร
3. ลง Dependencies:
   ```bash
   npm install
   ```
4. เปิดติดเลย:
   ```bash
   npm start
   ```

*Tip: สำหรับ Dev สามารใช้ `npm run dev` (nodemon) เพื่อคอยรีสตาร์ทตัวแอประหว่างเขียนโค้ดได้*

## HTTP Endpoints (Internal)

ตัวเซิร์ฟยังได้เปิดพอร์ต HTTP เบาๆ ไปที่พอร์ตเดียวกับหน้าเชื่อม WebSocket:

- `GET /health` : เช็คว่าเซิร์ฟเวอร์รอดไหม (เช็ค Healthcheck ของ Docker ฯลฯ)
- `GET /stats` : ดูลิสต์ Session ตอนนี้พร้อม Bandwidth แบบสดๆ (ระบุ header `x-internal-secret`)
