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

## Running Tests

The test suite uses Node's built-in `node:test` runner — no extra dependencies required.

```bash
npm test
```

This runs all 5 test files in sequence and prints a pass/fail summary:

| File | What it covers |
|------|---------------|
| `tests/routes.test.js` | Every HTTP route returns the correct status code (200, 301, 404, etc.) |
| `tests/websocket.test.js` | Room lifecycle over WebSocket — create, join, leave, bot toggle, observer flow, session rejoin |
| `tests/games/fuzznet.test.js` | FuzzNet game flow — lobby rules, game start, actions, cancellation, multiplayer |
| `tests/games/byteclub.test.js` | ByteClub game flow — lobby rules, game start, card hands, actions, cancellation, multiplayer |
| `tests/games/clusterflick.test.js` | ClusterFlick game flow — lobby rules, game start, flick actions, cancellation, multiplayer |

**Requirements:** Node.js v18 or higher (uses the built-in `node:test` module).

To run a single test file in isolation:

```bash
node --test tests/routes.test.js
node --test tests/websocket.test.js
node --test tests/games/byteclub.test.js
node --test tests/games/clusterflick.test.js
node --test tests/games/fuzznet.test.js
```

---

## Waiting-Room Pages — Template-Driven

The `<div id="waiting">` block on each game page — the screen shown when a room has been created but the host hasn't started the game yet (host can also add a bot here) — is rendered at request time from a shared fragment-template + per-game JSON. The URL state for this screen is `/<domain>/<game>/lobby`.

**Files involved:**

| File | Role |
|---|---|
| `games/lobby.template.html` | Shared waiting-room fragment: room code, share buttons, player list, observer section, bot toggle, Start/Leave |
| `games/lobby-renderer.js` | Auto-discovers `games/*/lobby.json`, renders the fragment, injects it into each game HTML's `<!-- LOBBY_HTML -->` marker |
| `games/<game-key>/lobby.json` | Per-game data **and** the `mount` field that points at the game HTML file |

**Request flow:** Request to a game page → `site-routing.js` resolves it to the game HTML file → `server.js` consults both `creategameRenderer.getMounts()` and `lobbyRenderer.getMounts()` → if either matches, the file is read and its `<!-- CREATEGAME_HTML -->` and `<!-- LOBBY_HTML -->` markers are replaced with the rendered fragments → returns 200.

### Adding a new game's waiting room

**One step:** drop in `games/<game-key>/lobby.json` with just a `mount` field pointing at your game's HTML file. The HTML file needs a `<!-- LOBBY_HTML -->` marker where the `<div id="waiting">…</div>` block should go.

```jsonc
{
  "mount": "/games/<game-key>/<game-name>.html"
}
```

The waiting-room template currently has **no per-game variation** — every game renders the identical fragment. Canonical IDs the JS hooks into: `room-code-display`, `player-list`, `btn-bot-toggle`, `btn-start-game`, `btn-leave`, `waiting-error`.

### Shared status-message logic

Each game's `renderLobbyPlayers()` function follows the same logic for the `#waiting-error` message:

| Role | < 2 players | 2+ players |
|---|---|---|
| Host (player) | "Add a bot or invite players to start" | _(empty — ready)_ |
| Host (observer) | "Waiting for players to join..." | "Ready. Start the game when players are set." |
| Non-host player | "Waiting for more players..." | "Waiting for host to start..." |
| Non-host observer | "Waiting for players to join..." | "Waiting for host to start..." |

Bot toggle shows only when a **player-host** is alone (`humans === 1`). Start button shows for any host but stays disabled until `players.length >= 2`. Keep new games' lobby JS consistent with this contract.

**To change the waiting-room layout for all games:** edit `lobby.template.html` once.

---

## Create-Game (Lobby) Pages — Template-Driven

The `<div id="lobby">` block on each game page (`/cybersecurity/byteclub`, `/ai/neural-network/fuzznet`, `/ai/knn/clusterflick`) is **not** stored in the per-game HTML files. It is rendered at request time from a single shared fragment-template + per-game JSON config, and **injected into a `<!-- CREATEGAME_HTML -->` marker** in the game HTML by the server.

**Files involved:**

| File | Role |
|---|---|
| `games/creategame.template.html` | Shared lobby fragment: hero, learning objectives, create/join cards, Event Hub, workshop banner, footer slot |
| `games/creategame-renderer.js` | Auto-discovers `games/*/creategame.json`, renders the fragment, injects it into each game HTML's marker |
| `games/<game-key>/creategame.json` | Per-game data **and** the `mount` field that points at the game HTML file |
| `games/template-util.js` | Shared Mustache-lite templater used by both the marketing hub and create-game renderers |

**Request flow:** Request to a game page (e.g. `/ai/knn/clusterflick`) → `site-routing.js` resolves to `games/ai-knn/clusterflick.html` → `server.js` checks `creategameRenderer.getMounts()` and finds the file is mounted → server reads the HTML, replaces `<!-- CREATEGAME_HTML -->` with the rendered create-game fragment, returns 200.

### Adding a new game's lobby

**One step:** drop in `games/<game-key>/creategame.json` with a `mount` field pointing at your game's HTML file. The HTML file just needs a `<!-- CREATEGAME_HTML -->` marker where the `<div id="lobby">…</div>` block should go.

```jsonc
{
  "mount": "/games/<game-key>/<game-name>.html",   // ← HTML file to inject into

  "game_display_name": "My Game",
  "hero_visual_html": "<img src=\"/images/...\" alt=\"\">",   // or <canvas>
  "hero_subtitle": "…",
  "time_text": "30 Min",

  "learning_objectives": [
    { "icon_svg": "<svg…>", "title": "…", "description": "…" },
    // …4 items total
  ],

  "observer_subtitle": "…",
  "workshop_url": "/blog/…",
  "workshop_title": "…",
  "footer_cta_html": ""    // optional Shopify CTA, or empty
}
```

The renderer scans the filesystem on next server start, builds a mount map, and the server auto-injects the fragment into the marker in your HTML file. No router edits. No HTML to hand-write.

**To change the lobby layout for all games:** edit `creategame.template.html` once.

### Per-game theming (e.g. dark mode for ByteClub)

The template renders **classes**, not inline styles. Defaults live in `games/hub.css` (light/green). Per-game CSS files override those classes to apply a different theme.

| Layer | File | Purpose |
|---|---|---|
| Structure | `games/creategame.template.html` | Markup + class names only — no theme colors |
| Default theme | `games/hub.css` | Light/green values (FuzzNet, ClusterFlick render with these directly) |
| Per-game override | `games/<game-key>/<game>.css` | Re-defines the same classes with that game's palette |

Example: ByteClub uses a dark "hacker terminal" theme. Its `games/cybersecurity/byteclub.css` re-defines the lobby-shared classes with dark backgrounds and mint text:

```css
/* hub.css (default light theme) */
.workshop-banner       { background: #f4fae8; border: 1.5px solid #c8dda0; }
.workshop-banner-title { color: #1a2a0a; }
.event-hub-name-input  { background: #f8f7f4; color: #333; border: 1.5px solid #c8dda0; }

/* byteclub.css (dark override) */
.workshop-banner       { background: #0d1a03; border-color: #253347; }
.workshop-banner-title { color: #d1fae5; }
.event-hub-name-input  { background: #0d1a03; color: #d1fae5; border-color: #253347; }
```

**Class hooks already in the template** (override these as needed for a new theme):
`.event-hub-card`, `.event-hub-desc`, `.event-hub-name-row`, `.event-hub-name-input`, `.event-hub-hint-text`, `.event-hub-add`, `.event-table`, `.ev-code`, `.ev-copy-btn`, `.ev-observe-btn`, `.ev-status`, `.workshop-banner`, `.workshop-banner-icon`, `.workshop-banner-title`, `.workshop-banner-sub`, `.workshop-banner-arrow`

**Rule of thumb:** if you ever feel the urge to put a hardcoded color in `creategame.template.html`, lift it into a CSS class instead — that's the only way per-game themes can override it.

---

## Marketing Hub Pages — Template-Driven

The game-domain marketing pages (**`/cybersecurity`**, **`/ai/neural-network`**, **`/ai/knn`**, …) are not static HTML files. They are rendered at request time from a **single shared template** + **per-game JSON config**, and routes are **auto-discovered** at startup — no router edits needed when adding a new game.

**Files involved:**

| File | Role |
|---|---|
| `games/marketing-hub.template.html` | Shared HTML skeleton (hero, features, CTA bar, game-info bar, learning objectives, workshop section, footer) |
| `games/marketing-hub-renderer.js` | ~100-line zero-dependency Mustache-lite templater + filesystem auto-discovery |
| `games/<game-key>/marketing.json` | Per-game content **and** the `routes` array that registers its URL(s) |
| `games/hub.css` | Shared layout/typography. Per-game CSS (`games/<game-key>/<game-key>.css`) only carries brand color overrides. |

**Request flow:** Request → `site-routing.js` consults `hubRenderer.getHubRoutes()` (built once at startup by scanning `games/*/marketing.json`) → matched route returns `{ renderHub: <gameKey> }` → `server.js` calls `hubRenderer.renderHub(key)` → 200 + rendered HTML.

**Templating syntax** (zero dependencies):

- `{{key}}` — substitute as raw HTML
- `{{#array}}…{{/array}}` — iterate; inner placeholders resolve against the current item

### Adding a new game's marketing page

**One step:** drop in `games/<game-key>/marketing.json`. That's it.

```jsonc
{
  "routes": ["/your-domain", "/your-domain.html"],   // ← URLs to serve this page on

  "page_title": "…",
  "meta_description": "…",
  "hero_badge": "…",
  "hero_h1": "<span class=\"game-name\">My Game</span>",
  "hero_subtitle_html": "<p class=\"hero-subtitle\">…</p>",
  "hero_visual_svg": "<svg …>…</svg>",
  "features": [ { "icon_svg": "…", "title": "…", "description": "…" }, … ],
  // …see existing marketing.json files for the full schema
}
```

On next server start the renderer scans the filesystem, picks up the new file, and registers every URL in its `routes` array. The router and test suite both consume the same discovered map, so:

- **No `site-routing.js` edits**
- **No `tests/routes.test.js` edits** — the hub-route test auto-iterates over discovered routes
- **No HTML to write** — the template covers it

Copy one of the existing `marketing.json` files as a starting point for the full schema (metadata, JSON-LD, hero, features, concept cards, workshop content, etc.).

**To change layout/spacing/typography for all games:** edit `marketing-hub.template.html` or `games/hub.css` once.

---

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

---

## How to Play

1. One player clicks **Create Room** and selects a color — a 4-character room code is generated.
2. Other players click **Join Room**, enter the code, and pick a color.
3. The host starts the game once at least 2 players have joined (up to 4 players).
