#!/usr/bin/env bash
# Instalacja Hackathon Timer na Raspberry Pi + własna sieć Wi-Fi (hotspot).
# Wymaga Raspberry Pi OS Bookworm (NetworkManager) i internetu podczas instalacji
# (np. kabel Ethernet) — po włączeniu hotspotu wlan0 przestaje łączyć się z innym Wi-Fi.
#
# Użycie (z katalogu timer/):
#   sudo SSID=Hackathon WIFI_PASS=haslo1234 PANEL_PASSWORD=tajne ./rpi/setup.sh
set -euo pipefail

SSID="${SSID:-Hackathon-Timer}"
WIFI_PASS="${WIFI_PASS:-hackathon123}"   # min. 8 znaków
PANEL_PASSWORD="${PANEL_PASSWORD:-pciowyadmin}"
COUNTRY="${COUNTRY:-PL}"
APP_DIR=/opt/hackathon-timer
APP_USER="${SUDO_USER:-pi}"
HOTSPOT_IP=10.42.0.1
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

[ "$(id -u)" -eq 0 ] || { echo "Uruchom przez sudo"; exit 1; }
[ ${#WIFI_PASS} -ge 8 ] || { echo "WIFI_PASS musi mieć min. 8 znaków"; exit 1; }

echo "==> Node.js"
if ! command -v node >/dev/null; then
  apt-get update
  apt-get install -y nodejs npm
fi

echo "==> Kopiowanie aplikacji do $APP_DIR"
mkdir -p "$APP_DIR"
tar -C "$SRC_DIR" --exclude=node_modules --exclude=logs --exclude=rpi -cf - . | tar -C "$APP_DIR" -xf -
mkdir -p "$APP_DIR/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
sudo -u "$APP_USER" npm --prefix "$APP_DIR" ci --omit=dev

echo "==> Usługa systemd (port 80)"
cat > /etc/systemd/system/hackathon-timer.service <<EOF
[Unit]
Description=Hackathon Timer
After=network-online.target
Wants=network-online.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$(command -v node) server.js
Environment=NODE_ENV=production
Environment=PORT=80
Environment=PANEL_PASSWORD=$PANEL_PASSWORD
AmbientCapabilities=CAP_NET_BIND_SERVICE
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now hackathon-timer

echo "==> Nazwa http://timer.lan w sieci hotspotu"
mkdir -p /etc/NetworkManager/dnsmasq-shared.d
echo "address=/timer.lan/$HOTSPOT_IP" > /etc/NetworkManager/dnsmasq-shared.d/hackathon-timer.conf

echo "==> Hotspot Wi-Fi \"$SSID\""
raspi-config nonint do_wifi_country "$COUNTRY" 2>/dev/null || true
rfkill unblock wlan || true
nmcli con delete timer-hotspot >/dev/null 2>&1 || true
nmcli con add type wifi ifname wlan0 con-name timer-hotspot autoconnect yes ssid "$SSID" \
  802-11-wireless.mode ap 802-11-wireless.band bg \
  ipv4.method shared ipv4.addresses "$HOTSPOT_IP/24" ipv6.method disabled \
  wifi-sec.key-mgmt wpa-psk wifi-sec.psk "$WIFI_PASS" \
  connection.autoconnect-priority 100
nmcli con up timer-hotspot

cat <<EOF

Gotowe. Połącz się z Wi-Fi "$SSID" (hasło: $WIFI_PASS) i otwórz:
  http://timer.lan/              (albo http://$HOTSPOT_IP/)
  http://timer.lan/display.html  — projektor
  http://timer.lan/remote.html   — pilot
Hotspot i serwer startują automatycznie po każdym włączeniu RPi.
Logi: journalctl -u hackathon-timer -f
EOF
