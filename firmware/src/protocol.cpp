#include "protocol.h"
#include <ArduinoJson.h>
#include <WebServer.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <WiFiUdp.h>

static WebSocketsClient wsClient;
static WebServer httpServer(80);
static WiFiUDP udpServer;
static BridgeProtocol* activeProtocol = nullptr;

static String detectBoardName() {
#if defined(CONFIG_IDF_TARGET_ESP32S3)
  return "esp32-s3";
#elif defined(CONFIG_IDF_TARGET_ESP32C3)
  return "esp32-c3";
#else
  return "esp32";
#endif
}

static String buildNodeId() {
  String mac = WiFi.macAddress();
  mac.replace(":", "");
  mac.toLowerCase();
  return "esp-" + mac;
}

static void populateInfoJson(JsonDocument& doc, const ConfigStore& store) {
  const NodeConfig& cfg = store.data();
  doc["type"] = "hello";
  doc["nodeId"] = buildNodeId();
  doc["mac"] = WiFi.macAddress();
  doc["name"] = cfg.nodeName;
  doc["board"] = detectBoardName();
  doc["firmwareVersion"] = "1.0.0";
  doc["ip"] = WiFi.localIP().toString();
  doc["port"] = 80;
  doc["rssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();

  JsonObject hw = doc["hardware"].to<JsonObject>();
  hw["gpioPin"] = cfg.hardware.gpioPin;
  hw["ledCount"] = cfg.hardware.ledCount;
  hw["stripType"] = cfg.hardware.stripType;
  hw["colorOrder"] = cfg.hardware.colorOrder;
  hw["maxCurrentMa"] = cfg.hardware.maxCurrentMa;
  hw["whiteTempK"] = cfg.hardware.whiteTempK;
  hw["gamma"] = cfg.hardware.gamma;
  hw["defaultTransitionMs"] = cfg.hardware.defaultTransitionMs;

  JsonArray segs = doc["segments"].to<JsonArray>();
  for (uint8_t i = 0; i < cfg.segmentCount; i++) {
    JsonObject s = segs.add<JsonObject>();
    s["id"] = cfg.segments[i].id;
    s["name"] = cfg.segments[i].name;
    s["startLed"] = cfg.segments[i].startLed;
    s["endLed"] = cfg.segments[i].endLed;
    s["reverse"] = cfg.segments[i].reverse;
  }
}

BridgeProtocol::BridgeProtocol(ConfigStore& store, LedEngine& leds)
    : _store(store), _leds(leds) {
  activeProtocol = this;
}

void BridgeProtocol::begin() {
  setupHttpServer();
  udpServer.begin(21324);

  if (_store.data().serverHost.length() > 0) {
    setServerTarget(_store.data().serverHost, _store.data().serverPort);
  }
}

void BridgeProtocol::setServerTarget(const String& host, uint16_t port) {
  if (host.length() == 0) return;
  if (_serverHost == host && _serverPort == port && _wsConnected) return;

  _serverHost = host;
  _serverPort = port == 0 ? 80 : port;

  wsClient.disconnect();
  wsClient.begin(_serverHost, _serverPort, "/ws/esp32");
  wsClient.setReconnectInterval(3000);
  wsClient.enableHeartbeat(15000, 5000, 2);
  wsClient.onEvent([](WStype_t type, uint8_t* payload, size_t length) {
    if (!activeProtocol) return;
    if (type == WStype_CONNECTED) {
      activeProtocol->_wsConnected = true;
      activeProtocol->sendHello();
    } else if (type == WStype_DISCONNECTED) {
      activeProtocol->_wsConnected = false;
    } else if (type == WStype_TEXT) {
      activeProtocol->handleWsMessage(payload, length);
    }
  });
}

void BridgeProtocol::sendHello() {
  JsonDocument doc;
  populateInfoJson(doc, _store);
  String out;
  serializeJson(doc, out);
  wsClient.sendTXT(out);
}

void BridgeProtocol::sendTelemetry() {
  if (!_wsConnected) return;
  JsonDocument doc;
  doc["type"] = "telemetry";
  doc["nodeId"] = buildNodeId();
  doc["rssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  doc["fps"] = _leds.currentFps();
  String out;
  serializeJson(doc, out);
  wsClient.sendTXT(out);
}

void BridgeProtocol::applyStateJson(JsonObjectConst obj) {
  String segId = obj["segmentId"] | "main";
  bool on = obj["on"] | false;
  uint8_t bri = obj["bri"] | 254;
  uint16_t transitionMs = obj["transitionMs"] | _store.data().hardware.defaultTransitionMs;
  String effect = obj["effect"] | "none";
  String alert = obj["alert"] | "none";

  RgbwColor4 rgbw = {0, 0, 0, 0};
  JsonArrayConst c = obj["rgbw"];
  if (!c.isNull() && c.size() >= 3) {
    rgbw.r = c[0] | 0;
    rgbw.g = c[1] | 0;
    rgbw.b = c[2] | 0;
    rgbw.w = c.size() >= 4 ? (c[3] | 0) : 0;
  }

  RgbwColor4 grad[MAX_GRADIENT_STOPS];
  uint8_t gradCount = 0;
  JsonArrayConst gradArr = obj["gradient"];
  if (!gradArr.isNull()) {
    for (JsonArrayConst stop : gradArr) {
      if (gradCount >= MAX_GRADIENT_STOPS) break;
      if (stop.size() >= 3) {
        grad[gradCount++] = {
            static_cast<uint8_t>(stop[0] | 0),
            static_cast<uint8_t>(stop[1] | 0),
            static_cast<uint8_t>(stop[2] | 0),
            static_cast<uint8_t>(stop.size() >= 4 ? (stop[3] | 0) : 0),
        };
      }
    }
  }

  _leds.applySegmentState(segId, on, bri, rgbw, transitionMs, effect, alert, grad, gradCount);
}

void BridgeProtocol::handleWsMessage(uint8_t* payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length) != DeserializationError::Ok) {
    return;
  }

  String msgType = doc["type"] | "";
  if (msgType == "state_update") {
    applyStateJson(doc.as<JsonObjectConst>());
    return;
  }

  if (msgType == "sync_all") {
    JsonArrayConst states = doc["states"];
    for (JsonObjectConst st : states) {
      applyStateJson(st);
    }
    return;
  }

  if (msgType == "identify") {
    String segId = doc["segmentId"] | "";
    _leds.triggerIdentify(segId);
    return;
  }

  if (msgType == "reboot") {
    ESP.restart();
    return;
  }

  if (msgType == "update_segments") {
    JsonArrayConst segs = doc["segments"];
    if (!segs.isNull() && segs.size() > 0) {
      NodeConfig& cfg = _store.data();
      cfg.segmentCount = 0;
      uint16_t maxIdx = cfg.hardware.ledCount > 0 ? cfg.hardware.ledCount - 1 : 0;
      for (JsonObjectConst s : segs) {
        if (cfg.segmentCount >= MAX_SEGMENTS) break;
        SegmentConfig& dst = cfg.segments[cfg.segmentCount++];
        dst.id = s["id"] | String("seg-") + String(cfg.segmentCount);
        dst.name = s["name"] | String("Segment ") + String(cfg.segmentCount);
        dst.startLed = constrain(s["startLed"] | 0, 0, maxIdx);
        dst.endLed = constrain(s["endLed"] | maxIdx, dst.startLed, maxIdx);
        dst.reverse = s["reverse"] | false;
      }
      _store.save();
      _leds.updateSegments(cfg.segments, cfg.segmentCount);
    }
    return;
  }

  if (msgType == "update_hardware") {
    NodeConfig& cfg = _store.data();
    bool needsReboot = false;

    if (doc["name"].is<const char*>()) cfg.nodeName = doc["name"].as<String>();
    JsonObjectConst hw = doc["hardware"];
    if (!hw.isNull()) {
      uint8_t newPin = hw["gpioPin"] | cfg.hardware.gpioPin;
      uint16_t newCount = hw["ledCount"] | cfg.hardware.ledCount;
      String newType = hw["stripType"] | cfg.hardware.stripType;

      if (newPin != cfg.hardware.gpioPin || newCount != cfg.hardware.ledCount ||
          newType != cfg.hardware.stripType) {
        needsReboot = true;
      }

      cfg.hardware.gpioPin = newPin;
      cfg.hardware.ledCount = constrain(newCount, 1, 2000);
      cfg.hardware.stripType = newType;
      if (hw["colorOrder"].is<const char*>()) cfg.hardware.colorOrder = hw["colorOrder"].as<String>();
      if (hw["maxCurrentMa"].is<uint16_t>()) cfg.hardware.maxCurrentMa = hw["maxCurrentMa"].as<uint16_t>();
      if (hw["whiteTempK"].is<uint16_t>()) cfg.hardware.whiteTempK = hw["whiteTempK"].as<uint16_t>();
      if (hw["gamma"].is<float>()) cfg.hardware.gamma = hw["gamma"].as<float>();
      if (hw["defaultTransitionMs"].is<uint16_t>()) {
        cfg.hardware.defaultTransitionMs = hw["defaultTransitionMs"].as<uint16_t>();
      }
    }
    _store.save();
    if (needsReboot) {
      delay(150);
      ESP.restart();
    } else {
      _leds.begin(cfg.hardware, cfg.segments, cfg.segmentCount);
    }
  }
}

void BridgeProtocol::setupHttpServer() {
  httpServer.on("/", HTTP_GET, [this]() {
    const NodeConfig& cfg = _store.data();
    String html = "<html><body style='font-family:sans-serif;background:#111;color:#eee;padding:24px'>";
    html += "<h2>" + cfg.nodeName + "</h2>";
    html += "<p>IP: " + WiFi.localIP().toString() + " | MAC: " + WiFi.macAddress() + "</p>";
    html += "<p>Server: " + (_serverHost.length() ? _serverHost + ":" + String(_serverPort) : String("Searching via mDNS")) + "</p>";
    html += "<p>WS Connected: " + String(_wsConnected ? "Yes" : "No") + "</p>";
    html += "<p>LEDs: " + String(cfg.hardware.ledCount) + " (" + cfg.hardware.stripType + ") on GPIO " + String(cfg.hardware.gpioPin) + "</p>";
    html += "</body></html>";
    httpServer.send(200, "text/html", html);
  });

  httpServer.on("/api/info", HTTP_GET, [this]() {
    JsonDocument doc;
    populateInfoJson(doc, _store);
    String out;
    serializeJson(doc, out);
    httpServer.send(200, "application/json", out);
  });

  httpServer.on("/api/state", HTTP_POST, [this]() {
    JsonDocument doc;
    if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
      httpServer.send(400, "application/json", "{\"error\":\"invalid json\"}");
      return;
    }
    applyStateJson(doc.as<JsonObjectConst>());
    httpServer.send(200, "application/json", "{\"ok\":true}");
  });

  httpServer.on("/api/config", HTTP_POST, [this]() {
    JsonDocument doc;
    if (deserializeJson(doc, httpServer.arg("plain")) != DeserializationError::Ok) {
      httpServer.send(400, "application/json", "{\"error\":\"invalid json\"}");
      return;
    }
    if (doc["serverHost"].is<const char*>()) {
      _store.data().serverHost = doc["serverHost"].as<String>();
      _store.data().serverPort = doc["serverPort"] | 80;
      _store.save();
      setServerTarget(_store.data().serverHost, _store.data().serverPort);
    }
    httpServer.send(200, "application/json", "{\"ok\":true}");
  });

  httpServer.begin();
}

void BridgeProtocol::handleUdpStream() {
  int packetSize = udpServer.parsePacket();
  if (packetSize < 9) return;
  uint8_t buf[16];
  int len = udpServer.read(buf, min<int>(packetSize, sizeof(buf)));
  if (len >= 9 && buf[0] == 'H' && buf[1] == 'E' && buf[2] == 0x01) {
    uint8_t segIdx = buf[3];
    RgbwColor4 rgbw = {buf[4], buf[5], buf[6], buf[7]};
    bool on = (buf[8] & 0x01) != 0;
    _leds.applyFastFrame(segIdx, rgbw, on);
  }
}

void BridgeProtocol::loop() {
  httpServer.handleClient();
  handleUdpStream();
  if (_serverHost.length() > 0) {
    wsClient.loop();
  }

  uint32_t now = millis();
  if (_wsConnected && now - _lastTelemetryMs >= 10000) {
    _lastTelemetryMs = now;
    sendTelemetry();
  }
}

