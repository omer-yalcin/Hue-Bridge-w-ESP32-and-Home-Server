#pragma once

#include <Arduino.h>

constexpr uint8_t MAX_SEGMENTS = 8;

struct HardwareConfig {
  uint8_t gpioPin;
  uint16_t ledCount;
  String stripType;   // "ws2812b" | "sk6812_rgbw"
  String colorOrder;  // "GRB", "RGB", etc.
  uint16_t maxCurrentMa;
  uint16_t whiteTempK;
  float gamma;
  uint16_t defaultTransitionMs;
};

struct SegmentConfig {
  String id;
  String name;
  uint16_t startLed;
  uint16_t endLed;
  bool reverse;
};

struct NodeConfig {
  String nodeName;
  String serverHost;
  uint16_t serverPort;
  HardwareConfig hardware;
  uint8_t segmentCount;
  SegmentConfig segments[MAX_SEGMENTS];
};

class ConfigStore {
 public:
  void begin();
  void save();
  NodeConfig& data() { return _cfg; }
  const NodeConfig& data() const { return _cfg; }

 private:
  void loadDefaults();
  NodeConfig _cfg;
};

