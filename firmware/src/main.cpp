#include <Arduino.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <WiFi.h>

#include "config_store.h"
#include "led_engine.h"
#include "protocol.h"

#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

static ConfigStore configStore;
static LedEngine ledEngine;
static BridgeProtocol protocol(configStore, ledEngine);

static uint32_t lastMdnsQueryMs = 0;
static bool mdnsStarted = false;

static void startMdnsService() {
  if (mdnsStarted) return;
  String host = "hue-esp-" + WiFi.macAddress().substring(12);
  host.replace(":", "");
  host.toLowerCase();

  if (MDNS.begin(host.c_str())) {
    mdnsStarted = true;
    MDNS.addService("esp-hue", "tcp", 80);
    MDNS.addServiceTxt("esp-hue", "tcp", "mac", WiFi.macAddress());
    MDNS.addServiceTxt("esp-hue", "tcp", "name", configStore.data().nodeName);
    MDNS.addServiceTxt("esp-hue", "tcp", "leds", String(configStore.data().hardware.ledCount));
    MDNS.addServiceTxt("esp-hue", "tcp", "strip", configStore.data().hardware.stripType);
  }
}

static void discoverHomeServer() {
  if (!mdnsStarted) return;
  if (configStore.data().serverHost.length() > 0) return;

  uint32_t now = millis();
  if (now - lastMdnsQueryMs < 8000) return;
  lastMdnsQueryMs = now;

  int n = MDNS.queryService("hue-esp-srv", "tcp");
  if (n > 0) {
    IPAddress ip = MDNS.IP(0);
    uint16_t port = MDNS.port(0);
    if (ip != IPAddress(0, 0, 0, 0)) {
      Serial.printf("[mDNS] Found home server at %s:%u\n", ip.toString().c_str(), port);
      protocol.setServerTarget(ip.toString(), port);
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(250);
  Serial.println("\n[HueBridge ESP] Booting firmware...");

  configStore.begin();
  const NodeConfig& cfg = configStore.data();

  ledEngine.begin(cfg.hardware, cfg.segments, cfg.segmentCount);

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("[WiFi] Connected: %s (RSSI %d dBm)\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
    startMdnsService();
  } else {
    Serial.println("[WiFi] Initial connect timed out, will retry in background.");
  }

  ArduinoOTA.setHostname(cfg.nodeName.c_str());
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.begin();

  protocol.begin();
}

void loop() {
  if (WiFi.status() == WL_CONNECTED) {
    startMdnsService();
    if (!protocol.hasServerTarget()) {
      discoverHomeServer();
    }
    ArduinoOTA.handle();
  }
  protocol.loop();
  ledEngine.loop();
}

