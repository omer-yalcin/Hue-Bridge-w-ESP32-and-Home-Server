#pragma once

#include <Arduino.h>
#include <NeoPixelBus.h>
#include "color_math.h"
#include "config_store.h"

constexpr uint8_t MAX_GRADIENT_STOPS = 8;

struct SegmentRuntimeState {
  bool on = false;
  uint8_t bri = 254;
  RgbwColor4 startRgbw = {0, 0, 0, 0};
  RgbwColor4 currentRgbw = {0, 0, 0, 0};
  RgbwColor4 targetRgbw = {0, 0, 0, 0};
  uint32_t transitionStartMs = 0;
  uint16_t transitionMs = 400;
  String effect = "none";
  uint32_t alertUntilMs = 0;
  uint32_t identifyUntilMs = 0;
  uint8_t gradientCount = 0;
  RgbwColor4 gradientStops[MAX_GRADIENT_STOPS];
};

class LedEngine {
 public:
  ~LedEngine();
  void begin(const HardwareConfig& hw, const SegmentConfig* segs, uint8_t segCount);
  void updateSegments(const SegmentConfig* segs, uint8_t segCount);
  void applySegmentState(
      const String& segmentId,
      bool on,
      uint8_t bri,
      const RgbwColor4& rgbw,
      uint16_t transitionMs,
      const String& effect,
      const String& alert,
      const RgbwColor4* gradient,
      uint8_t gradientCount);
  void applyFastFrame(uint8_t segmentIndex, const RgbwColor4& rgbw, bool on);
  void triggerIdentify(const String& segmentId);
  void loop();
  float currentFps() const { return _fps; }

 private:
  void setPixelRemapped(uint16_t idx, const RgbwColor4& c);
  void applyCurrentLimiter();
  RgbwColor4 renderEffectPixel(
      const SegmentRuntimeState& st,
      uint16_t relIdx,
      uint16_t segLen,
      uint32_t nowMs);

  HardwareConfig _hw;
  uint8_t _segCount = 0;
  SegmentConfig _segs[MAX_SEGMENTS];
  SegmentRuntimeState _states[MAX_SEGMENTS];
  RgbwColor4* _frameBuffer = nullptr;

  NeoPixelBus<NeoGrbFeature, NeoWs2812xMethod>* _rgbStrip = nullptr;
  NeoPixelBus<NeoGrbwFeature, NeoSk6812Method>* _rgbwStrip = nullptr;

  ColorMath _color;
  uint32_t _lastRenderMs = 0;
  uint32_t _fpsWindowStartMs = 0;
  uint16_t _frameCount = 0;
  float _fps = 60.0f;
};

