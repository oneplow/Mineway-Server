# Mineway Tunnel Server

Mineway Tunnel Server is the Node.js WebSocket relay that sits on your VPS and bridges Minecraft players to plugin-hosted servers. Each plugin connects via WebSocket, authenticates with an API key, and the server dynamically allocates TCP/UDP ports for player traffic.

## Architecture

```
Player (MC Client)
    │
    ▼  TCP/UDP :assignedPort
┌─────────────────────────┐
│   Mineway Tunnel Server │  ← WebSocket relay (port 8765)
│   (this project)        │
└───────────┬─────────────┘
            │ WebSocket (ws:// or wss://)
            ▼
┌─────────────────────────┐
│   MC Server + Plugin    │  ← runs on the server owner's machine
└─────────────────────────┘
```

## Requirements

- **Node.js** 18+ (LTS recommended)
- **npm** (comes with Node.js)
- A **domain name** pointed to this VPS (for SSL via Caddy, optional but recommended)
- **Mineway Web** dashboard running and accessible (for API key verification)

---

## Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url> mineway-server
cd mineway-server
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
# URL of the Mineway Web dashboard (API server)
WEB_API_URL=https://mineway.cloud

# Node token from Admin > Nodes in the dashboard
NODE_TOKEN=your-node-token-from-dashboard

# Base domain (used as fallback hostname for tunnels)
BASE_DOMAIN=mineway.cloud

# Internal WebSocket port (default: 8765)
# WS_PORT=8765
```

### 3. Run

```bash
# Production
npm start

# Development (auto-restart on changes)
npm run dev
```

---

## Deployment with Docker (Linux)

The recommended way to deploy on Linux is with Docker Compose, which includes **Caddy** for automatic SSL:

```bash
cp .env.example .env
# Edit .env with your values

docker compose up -d
```

This starts:
- **Caddy** — Auto-SSL reverse proxy on port 443 (handles `wss://`)
- **Mineway Server** — WebSocket relay on port 8765 (internal)

### Caddy Configuration

Edit `Caddyfile` to set your domain(s):

```caddyfile
# Add your domains separated by commas
your-node.example.com, node2.example.com {
    reverse_proxy localhost:8765
}
```

---

## Deployment without Docker (Standalone)

If you prefer to run without Docker (e.g., on Windows), you only need Node.js:

```bash
npm install
npm start
```

> **Note:** Without Caddy, the plugin will connect directly via `ws://` (unencrypted) on the configured port. For production use with SSL, set up Caddy or nginx as a reverse proxy separately.

---

## Firewall Configuration

Mineway Server dynamically allocates **TCP and UDP ports** for each tunnel session. The default range is `10000–60000`. You **must** open these ports on your firewall for players to connect.

### Ubuntu / Debian (Linux)

#### Using UFW (recommended)

```bash
# Allow the WebSocket port (internal, needed if not using Caddy)
sudo ufw allow 8765/tcp

# Allow Minecraft tunnel port range
sudo ufw allow 10000:60000/tcp
sudo ufw allow 10000:60000/udp

# If using Caddy for SSL
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp

# Apply
sudo ufw enable
sudo ufw status
```

#### Using iptables (advanced)

```bash
# WebSocket port
sudo iptables -A INPUT -p tcp --dport 8765 -j ACCEPT

# Minecraft tunnel port range (TCP + UDP)
sudo iptables -A INPUT -p tcp --dport 10000:60000 -j ACCEPT
sudo iptables -A INPUT -p udp --dport 10000:60000 -j ACCEPT

# Caddy ports (if using SSL)
sudo iptables -A INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -A INPUT -p tcp --dport 80 -j ACCEPT

# Save rules (persist after reboot)
sudo apt install iptables-persistent -y
sudo netfilter-persistent save
```

### Windows Server

Open **PowerShell as Administrator** and run:

```powershell
# Allow the WebSocket port
New-NetFirewallRule -DisplayName "Mineway WS Port" -Direction Inbound -Protocol TCP -LocalPort 8765 -Action Allow

# Allow Minecraft tunnel port range (TCP)
New-NetFirewallRule -DisplayName "Mineway Tunnel Ports TCP" -Direction Inbound -Protocol TCP -LocalPort 10000-60000 -Action Allow

# Allow Minecraft tunnel port range (UDP — for Bedrock Edition)
New-NetFirewallRule -DisplayName "Mineway Tunnel Ports UDP" -Direction Inbound -Protocol UDP -LocalPort 10000-60000 -Action Allow
```

To verify rules were created:

```powershell
Get-NetFirewallRule -DisplayName "Mineway*" | Format-Table DisplayName, Direction, Action, Enabled
```

To remove rules if needed:

```powershell
Remove-NetFirewallRule -DisplayName "Mineway Tunnel Ports TCP"
Remove-NetFirewallRule -DisplayName "Mineway Tunnel Ports UDP"
Remove-NetFirewallRule -DisplayName "Mineway WS Port"
```

---

## Running as a Background Service

### Linux (systemd)

Create `/etc/systemd/system/mineway-server.service`:

```ini
[Unit]
Description=Mineway Tunnel Server
After=network.target

[Service]
Type=simple
User=mineway
WorkingDirectory=/opt/mineway-server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable mineway-server
sudo systemctl start mineway-server

# Check status
sudo systemctl status mineway-server

# View logs
journalctl -u mineway-server -f
```

### Windows (PM2 or NSSM)

#### Option A: PM2

```powershell
npm install -g pm2
pm2 start server.js --name mineway-server
pm2 save
pm2 startup   # Follow the instructions to set up auto-start
```

#### Option B: NSSM (Non-Sucking Service Manager)

```powershell
# Download NSSM from https://nssm.cc/download
nssm install MinewaySever "C:\Program Files\nodejs\node.exe" "C:\path\to\mineway-server\server.js"
nssm set MinewayServer AppDirectory "C:\path\to\mineway-server"
nssm start MinewayServer
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `WEB_API_URL` | ✅ | `http://localhost:3000` | URL of the Mineway Web dashboard |
| `NODE_TOKEN` | ✅ | `change-me` | Authentication token (from Admin > Nodes) |
| `BASE_DOMAIN` | ❌ | `mineway.cloud` | Fallback domain for tunnel hostnames |
| `WS_PORT` | ❌ | `8765` | Internal WebSocket listen port |
| `KEY_CACHE_TTL` | ❌ | `60` | API key verification cache (seconds) |
| `NODE_ENV` | ❌ | `production` | Node environment |

---

## Security Notes

- **Opening port range 10000–60000 is safe.** These ports only accept Minecraft protocol traffic piped through the tunnel. They do not expose any shell, admin, or management interface.
- **API key verification** happens on every connection through the Mineway Web API, ensuring only authorized plugins can create tunnels.
- **For production, always use SSL** via Caddy or nginx. This encrypts WebSocket traffic and prevents API key interception.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Plugin: `Connection timed out (Code: -1)` | Firewall blocking ports, or SSL mismatch | Check firewall rules. If not using Caddy, use `ws://` (port ≠ 443) |
| Plugin: `auth_failed` | Wrong API key, or `WEB_API_URL` misconfigured | Verify `.env` settings and reset the API key |
| Plugin: `port_bind_failed` | Another process using the assigned port | Restart the server, or adjust `PORT_RANGE_START` |
| Dashboard shows 0 traffic | Server not reporting stats | Restart the tunnel server (stats report every 30s now) |
| Players can't join but tunnel is connected | DNS not resolving, or firewall blocking | Ensure `*.yourdomain.com` DNS points to VPS IP |

---

## License

Proprietary — Mineway Cloud
