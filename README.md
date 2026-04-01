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

```bash
pm2 start npm --name "fuzznet" -- start
pm2 save                        # persist across reboots
pm2 startup                     # follow the printed command to enable autostart
```

Useful PM2 commands:

```bash
pm2 status          # check if the server is running
pm2 logs fuzznet    # view live logs
pm2 restart fuzznet # restart the server
pm2 stop fuzznet    # stop the server
```

### Deploying Updates

Pull the latest code from master and restart:

```bash
cd ~/techgames
git pull origin master
npm install          # in case dependencies changed
pm2 restart fuzznet
```

### 7. Open the Firewall Port

Digital Ocean droplets use `ufw` by default. Allow port 8090:

```bash
sudo ufw allow 8090/tcp
sudo ufw enable
sudo ufw status
```

You can also add a firewall rule via the Digital Ocean dashboard under **Networking > Firewalls** if you prefer managing it there.

### 8. Access the Game

Open your browser and navigate to:

```
http://<your-droplet-ip>:8090
```

Share that URL with players — anyone with internet access can join.

---

### Optional: Run on Port 80 with Nginx

If you want players to access the game without specifying a port (i.e. just `http://<ip>`), set up Nginx as a reverse proxy.

**Install Nginx:**

```bash
sudo apt install -y nginx
```

**Configure the proxy** — create `/etc/nginx/sites-available/fuzznet`:

```nginx
server {
    listen 80;

    location / {
        proxy_pass http://localhost:8090;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

**Enable the config:**

```bash
sudo ln -s /etc/nginx/sites-available/fuzznet /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
sudo ufw allow 80/tcp
```

Players can now access the game at:

```
http://<your-droplet-ip>
```

---

## How to Play

1. One player clicks **Create Room** and selects a color — a 4-character room code is generated.
2. Other players click **Join Room**, enter the code, and pick a color.
3. The host starts the game once at least 2 players have joined (up to 4 players).
