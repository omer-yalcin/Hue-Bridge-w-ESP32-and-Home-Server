#pragma once

#include <Arduino.h>

struct RgbwColor4 {
  uint8_t r;
  uint8_t g;
  uint8_t b;
  uint8_t w;
};

class ColorMath {
 public:
  void setGamma(float gamma);
  uint8_t applyGamma(uint8_t value) const;
  RgbwColor4 applyGammaRgbw(const RgbwColor4& c) const;
  static RgbwColor4 lerp(const RgbwColor4& a, const RgbwColor4& b, float t);
  static RgbwColor4 hsvToRgbw(uint16_t hue16, uint8_t sat, uint8_t val);

 private:
  float _lastGamma = -1.0f;
  uint8_t _lut[256] = {};
};

