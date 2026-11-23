#include "config_store.h"
#include <ArduinoJson.h>
#include <Preferences.h>

#if __has_include("config.h")
#include "config.h"
#else
#include "config.example.h"
#endif

static Preferences prefs;

void ConfigStore::loadDefaults() {
  _cfg.nodeName = NODE_NAME;
  _cfg.serverHost = SERVER_HOST;
  _cfg.serverPort = SERVER_PORT;

  _cfg.hardware.gpioPin = LED_PIN;
  _cfg.hardware.ledCount = LED_COUNT;
  _cfg.hardware.stripType = STRIP_TYPE;
  _cfg.hardware.colorOrder = COLOR_ORDER;
  _cfg.hardware.maxCurrentMa = MAX_CURRENT_MA;
  _cfg.hardware.whiteTempK = WHITE_TEMP_K;
  _cfg.hardware.gamma = 2.2f;
  _cfg.hardware.defaultTransitionMs = 400;

  _cfg.segmentCount = 1;
  _cfg.segments[0] = {
      "main",
      "Main Strip",
      0,
      static_cast<uint16_t>(max(1, LED_COUNT) - 1),
      false,
  };
}

void ConfigStore::begin() {
  loadDefaults();
  prefs.begin("hue_esp", true);
  String raw = prefs.getString("cfg", "");
  prefs.end();

  if (raw.length() == 0) {
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, raw) != DeserializationError::Ok) {
    return;
  }

  if (doc["nodeName"].is<const char*>()) _cfg.nodeName = doc["nodeName"].as<String>();
  if (doc["serverHost"].is<const char*>()) _cfg.serverHost = doc["serverHost"].as<String>();
  if (doc["serverPort"].is<uint16_t>()) _cfg.serverPort = doc["serverPort"].as<uint16_t>();

  JsonObject hw = doc["hardware"];
  if (!hw.isNull()) {
    if (hw["gpioPin"].is<uint8_t>()) _cfg.hardware.gpioPin = hw["gpioPin"].as<uint8_t>();
    if (hw["ledCount"].is<uint16_t>()) {
      _cfg.hardware.ledCount = constrain(hw["ledCount"].as<uint16_t>(), 1, 2000);
    }
    if (hw["stripType"].is<const char*>()) _cfg.hardware.stripType = hw["stripType"].as<String>();
    if (hw["colorOrder"].is<const char*>()) _cfg.hardware.colorOrder = hw["colorOrder"].as<String>();
    if (hw["maxCurrentMa"].is<uint16_t>()) {
      _cfg.hardware.maxCurrentMa = constrain(hw["maxCurrentMa"].as<uint16_t>(), 100, 30000);
    }
    if (hw["whiteTempK"].is<uint16_t>()) _cfg.hardware.whiteTempK = hw["whiteTempK"].as<uint16_t>();
    if (hw["gamma"].is<float>()) _cfg.hardware.gamma = hw["gamma"].as<float>();
    if (hw["defaultTransitionMs"].is<uint16_t>()) {
      _cfg.hardware.defaultTransitionMs = hw["defaultTransitionMs"].as<uint16_t>();
    }
  }

  JsonArray segs = doc["segments"];
  if (!segs.isNull() && segs.size() > 0) {
    _cfg.segmentCount = 0;
    for (JsonObject s : segs) {
      if (_cfg.segmentCount >= MAX_SEGMENTS) break;
      SegmentConfig& dst = _cfg.segments[_cfg.segmentCount++];
      dst.id = s["id"] | String("seg-") + String(_cfg.segmentCount);
      dst.name = s["name"] | String("Segment ") + String(_cfg.segmentCount);
      uint16_t maxIdx = _cfg.hardware.ledCount > 0 ? _cfg.hardware.ledCount - 1 : 0;
      dst.startLed = constrain(s["startLed"] | 0, 0, maxIdx);
      dst.endLed = constrain(s["endLed"] | maxIdx, dst.startLed, maxIdx);
      dst.reverse = s["reverse"] | false;
    }
  }
}

void ConfigStore::save() {
  JsonDocument doc;
  doc["nodeName"] = _cfg.nodeName;
  doc["serverHost"] = _cfg.serverHost;
  doc["serverPort"] = _cfg.serverPort;

  JsonObject hw = doc["hardware"].to<JsonObject>();
  hw["gpioPin"] = _cfg.hardware.gpioPin;
  hw["ledCount"] = _cfg.hardware.ledCount;
  hw["stripType"] = _cfg.hardware.stripType;
  hw["colorOrder"] = _cfg.hardware.colorOrder;
  hw["maxCurrentMa"] = _cfg.hardware.maxCurrentMa;
  hw["whiteTempK"] = _cfg.hardware.whiteTempK;
  hw["gamma"] = _cfg.hardware.gamma;
  hw["defaultTransitionMs"] = _cfg.hardware.defaultTransitionMs;

  JsonArray segs = doc["segments"].to<JsonArray>();
  for (uint8_t i = 0; i < _cfg.segmentCount; i++) {
    JsonObject s = segs.add<JsonObject>();
    s["id"] = _cfg.segments[i].id;
    s["name"] = _cfg.segments[i].name;
    s["startLed"] = _cfg.segments[i].startLed;
    s["endLed"] = _cfg.segments[i].endLed;
    s["reverse"] = _cfg.segments[i].reverse;
  }

  String out;
  serializeJson(doc, out);

  prefs.begin("hue_esp", false);
  prefs.putString("cfg", out);
  prefs.end();
}

