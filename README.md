# FuzzNet Labs — Animal Classifier

A multiplayer browser-based card game built with Node.js and WebSockets.

## Requirements

- [Node.js](https://nodejs.org/) v18 or higher

Verify your installation:

```bash
node -v
npm -v
```

## Setup & Running Locally

**1. Clone the repository**

```bash
git clone -b master https://github.com/mnovack8/techgames.git
cd techgames
```

**2. Install dependencies**

```bash
npm install
```

This installs the only dependency: `ws` (WebSocket library).

**3. Start the server**

```bash
npm start
```

The server will start at:

```
http://localhost:8090
```

**4. Open the game**

Open your browser and go to:

```
http://localhost:8090
```

To play multiplayer, have other players on the same network navigate to:

```
http://<your-local-ip>:8090
```

Find your local IP with:

```bash
# macOS / Linux
ipconfig getifaddr en0

# Windows
ipconfig
```

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `ws`    | ^8.16.0 | WebSocket server for real-time multiplayer |

## Deploying to a Digital Ocean Droplet

### 1. Create a Droplet

1. Log in to [Digital Ocean](https://cloud.digitalocean.com/) and click **Create > Droplets**.
2. Choose **Ubuntu 24.04 (LTS)** as the image.
3. Select a plan — the **Basic $6/mo** (1 GB RAM) is sufficient.
4. Add your SSH key under **Authentication** (recommended over password).
5. Click **Create Droplet** and note the droplet's public IP address.

### 2. SSH into the Droplet

```bash
ssh root@<your-droplet-ip>
```

### 3. Install Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v  # confirm install
```

### 4. Install PM2 (process manager)

PM2 keeps the server running after you disconnect and restarts it on reboot.

```bash
npm install -g pm2
```

### 5. Clone the Repository from GitHub

```bash
git clone -b master https://github.com/mnovack8/techgames.git
cd techgames
npm install
```

### 6. Start the Server with PM2

The simplest approach is to run directly on **port 80** so players just visit `http://<your-ip>` with no port number. On a fresh Digital Ocean droplet you're already root, so this just works:

```bash
PORT=80 pm2 start npm --name "fuzznet" -- start
```

That's it. For local development or if you prefer a non-standard port, omit `PORT` and it defaults to 8090:

```bash
pm2 start npm --name "fuzznet" -- start
```

Make PM2 survive reboots:

```bash
pm2 save
pm2 startup     # follow the printed command to enable autostart
```

Useful PM2 commands:

```bash
pm2 status          # check if the server is running
pm2 logs fuzznet    # view live logs
pm2 restart fuzznet # restart the server
pm2 stop fuzznet    # stop the server
```

### 7. Open the Firewall

```bash
sudo ufw allow 80/tcp    # allow web traffic
sudo ufw allow 22/tcp    # don't lock yourself out of SSH
sudo ufw enable
sudo ufw status
```

You can also add firewall rules via the Digital Ocean dashboard under **Networking > Firewalls**.

### 8. Point a Custom Domain (optional)

To use a domain like `http://www.techboardgames.com/` instead of a raw IP address:

**1. Get your droplet's IP address:**

```bash
curl ifconfig.me
```

**2. Add DNS records at your domain registrar** (e.g. GoDaddy, Namecheap, Cloudflare):

| Type | Name | Value | TTL |
|------|------|-------|-----|
| A | `@` | `<your-droplet-ip>` | 3600 |
| A | `www` | `<your-droplet-ip>` | 3600 |

The `@` record covers `techboardgames.com` and the `www` record covers `www.techboardgames.com`.

**3. Wait for DNS propagation** (usually 5–30 minutes, can take up to 48 hours). Verify with:

```bash
dig www.techboardgames.com +short
# should return your droplet IP
```

**4. That's it.** The server is already listening on port 80, so once DNS resolves to your droplet the domain just works:

```
http://www.techboardgames.com
```

> **Tip:** If you're using Digital Ocean's nameservers, you can manage DNS directly in the DO dashboard under **Networking > Domains** — add your domain and create the two A records there.

### 9. Access the Game

```
http://www.techboardgames.com
```

Or by IP:

```
http://<your-droplet-ip>
```

Share either URL with players — anyone with internet access can join.

### Deploying Updates

Pull the latest code from master and restart:

```bash
cd ~/techgames
git pull origin master
npm install          # in case dependencies changed
pm2 restart fuzznet
```

---

### Alternative: Nginx Reverse Proxy + HTTPS (Recommended for Production)

Run the Node app on port 8090 with PM2, put Nginx in front to handle port 443 (HTTPS) and TLS termination, and use Certbot to automatically provision and renew a free TLS certificate.

**Install Nginx and Certbot:**

```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

Create `/etc/nginx/sites-available/techboardgames`:

```nginx
server {
    listen 80;
    server_name techboardgames.com www.techboardgames.com;

    location / {
        proxy_pass http://localhost:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

Enable and start Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/techboardgames /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl start nginx
```

Issue a TLS certificate (Certbot will auto-update the Nginx config for HTTPS):

```bash
sudo certbot --nginx
```

Certbot renews automatically. Test renewal with:

```bash
sudo certbot renew --dry-run
```

**Open the firewall for HTTPS:**

```bash
sudo ufw allow 443/tcp
sudo ufw allow 80/tcp     # needed for Certbot HTTP-01 challenge
sudo ufw allow 22/tcp     # don't lock yourself out of SSH
sudo ufw enable
```

---

### PM2 Application Management

The app runs under PM2 as **"techboardgames"**. Common commands:

```bash
# Start the application
pm2 start npm --name "techboardgames" -- start

# Stop and remove the process from PM2
pm2 delete techboardgames

# Check status
pm2 status

# View live logs
pm2 logs techboardgames

# Restart after a code change
pm2 restart techboardgames
```

Persist PM2 across reboots (run once after first start):

```bash
pm2 save
pm2 startup   # follow the printed command to enable autostart
```

**Deploying an update:**

```bash
cd ~/techgames
git pull origin master
npm install          # always run — picks up any new dependencies (e.g. dotenv)
pm2 delete techboardgames
pm2 start npm --name "techboardgames" -- start
pm2 save
```

---

### Secrets & Environment Variables

All secrets are injected via PM2 env vars — no `.env` file needed on the server.

**Set each variable via PM2 before starting the app:**

```bash
pm2 set techboardgames:ADMIN_PASSWORD "your-admin-password"
pm2 set techboardgames:SESSION_SECRET  "a-long-random-string"
pm2 set techboardgames:SMTP_USER       "mnovack8@gmail.com"
pm2 set techboardgames:SMTP_PASS       "your-gmail-app-password"
pm2 set techboardgames:SHEETS_ID       "your-google-sheet-id"
pm2 set techboardgames:GOOGLE_SERVICE_ACCOUNT_EMAIL   "your-service-account@project.iam.gserviceaccount.com"
pm2 set techboardgames:GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY "-----BEGIN RSA PRIVATE KEY-----\nMIIE..."
```

Then start (or restart) the app to pick them up:

```bash
pm2 delete techboardgames
pm2 start npm --name "techboardgames" -- start
pm2 save
```

**Variables reference:**

| Variable | Required | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | Yes | Password for the `/admin` dashboard |
| `SESSION_SECRET` | Yes | Signs admin session cookies — use a long random string |
| `SMTP_USER` | Yes | Gmail address used to send contact form emails |
| `SMTP_PASS` | Yes | Gmail App Password for SMTP (generate at myaccount.google.com/apppasswords) |
| `SHEETS_ID` | No | Google Sheet ID from the sheet URL |
| `GOOGLE_SERVICE_ACCOUNT_EMAIL` | No | Service account `client_email` from Google Cloud |
| `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` | No | Service account `private_key` from Google Cloud (with `\n` between lines) |

`SHEETS_ID` and the two `GOOGLE_SERVICE_ACCOUNT_*` vars are optional — if not set, Google Sheets sync is silently skipped and all metrics continue to be stored locally in `metrics.json`.

---

### Google Sheets Sync Setup

The server syncs metrics to a Google Sheet automatically — real-time event logging and a nightly daily summary written at midnight ET.

**1. Create a Google Cloud service account**

- Go to [console.cloud.google.com](https://console.cloud.google.com)
- Enable the **Google Sheets API** under APIs & Services → Library
- Go to APIs & Services → Credentials → **Create Credentials → Service account**
- Give it a name, click through, then open the service account → **Keys** tab → **Add Key → JSON**
- From the downloaded JSON, copy `client_email` and `private_key`

**2. Share the Google Sheet with the service account**

- Open your Google Sheet and click **Share**
- Paste the `client_email` address and set permission to **Editor**

**3. Set up the sheet tabs with headers**

Create four tabs in this exact order with these headers in row 1:

| Tab | Headers (row 1) |
|---|---|
| **Events** | Timestamp, Type, GameType, Mode, Button, UVKey, Referrer |
| **Daily Homepage** | Date, Visits, FuzzNet Buys, BC Buys, Qubit WL, Direct, Search, LinkedIn, Other, Bounce Rate, WS Disconnects |
| **Daily Games** | Date, Game, Started, Completed, Completion%, Tutorials, 1P+Bot, 2P, 3P, 4P, Avg Duration, Rematches |
| **Daily Funnel** | Date, Visits, Started, Completed, Buy Clicks, Visit→Start%, Start→Complete%, Complete→Buy% |

**4. Set the env vars and restart** (see Secrets section above)

---

## How to Play

1. One player clicks **Create Room** and selects a color — a 4-character room code is generated.
2. Other players click **Join Room**, enter the code, and pick a color.
3. The host starts the game once at least 2 players have joined (up to 4 players).
