#!/bin/bash
set -e

echo "============================================"
echo "  HACKATHON TIMER - Deploy na VPS"
echo "============================================"
echo ""

# --- 1. Node.js 20 ---
if ! command -v node &> /dev/null || [[ $(node -v | cut -d. -f1 | tr -d v) -lt 20 ]]; then
    echo "[1/5] Instalacja Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "[1/5] Node.js $(node -v) - OK"
fi

# --- 2. pm2 ---
if ! command -v pm2 &> /dev/null; then
    echo "[2/5] Instalacja pm2..."
    sudo npm install -g pm2
else
    echo "[2/5] pm2 $(pm2 -v) - OK"
fi

# --- 3. Zależności projektu ---
echo "[3/5] Instalacja zależności..."
cd "$(dirname "$0")"
npm install --production

# --- 4. Katalog logów ---
mkdir -p logs

# --- 5. Firewall ---
echo "[4/5] Konfiguracja firewalla..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp   # SSH
    sudo ufw allow 80/tcp   # Timer
    sudo ufw --force enable
    echo "  ufw: port 22 i 80 otwarte"
else
    echo "  ufw niedostępne - skipping (upewnij się że port 80 jest otwarty)"
fi

# --- 5. Uruchomienie ---
echo "[5/5] Uruchamianie timera..."
pm2 delete hackathon-timer 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null || echo "  Uruchom ręcznie: sudo env PATH=\$PATH:\$(which node | xargs dirname) pm2 startup systemd -u $USER --hp $HOME"

echo ""
echo "============================================"
echo "  GOTOWE!"
echo "============================================"
echo ""

# Pokaż IP
IP=$(hostname -I | awk '{print $1}')
echo "  Projektor:  http://${IP}/"
echo "  Pilot:      http://${IP}/remote.html"
echo "  Status:     http://${IP}/status"
echo ""
echo "  Komendy pm2:"
echo "    pm2 status          - sprawdź status"
echo "    pm2 logs            - pokaż logi"
echo "    pm2 restart all     - restart"
echo "    pm2 stop all        - zatrzymaj"
echo ""
echo "============================================"
