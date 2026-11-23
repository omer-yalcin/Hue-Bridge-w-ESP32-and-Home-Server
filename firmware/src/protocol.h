#pragma once

#include <Arduino.h>
#include "config_store.h"
#include "led_engine.h"

class BridgeProtocol {
 public:
  BridgeProtocol(ConfigStore& store, LedEngine& leds);
  void begin();
  void setServerTarget(const String& host, uint16_t port);
  bool hasServerTarget() const { return _serverHost.length() > 0; }
  void loop();

 private:
  void sendHello();
  void sendTelemetry();
  void handleWsMessage(uint8_t* payload, size_t length);
  void applyStateJson(JsonObjectConst obj);
  void setupHttpServer();
  void handleUdpStream();

  ConfigStore& _store;
  LedEngine& _leds;
  String _serverHost;
  uint16_t _serverPort = 80;
  bool _wsConnected = false;
  uint32_t _lastTelemetryMs = 0;
};

