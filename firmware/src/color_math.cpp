#include "color_math.h"
#include <math.h>

void ColorMath::setGamma(float gamma) {
  float g = constrain(gamma, 1.0f, 3.5f);
  if (fabsf(g - _lastGamma) < 0.02f) return;
  _lastGamma = g;
  for (int i = 0; i < 256; i++) {
    if (i == 0) {
      _lut[0] = 0;
    } else {
      float norm = static_cast<float>(i) / 255.0f;
      uint8_t out = static_cast<uint8_t>(roundf(powf(norm, g) * 255.0f));
      _lut[i] = max<uint8_t>(1, out);
    }
  }
}

uint8_t ColorMath::applyGamma(uint8_t value) const {
  return _lut[value];
}

RgbwColor4 ColorMath::applyGammaRgbw(const RgbwColor4& c) const {
  return {_lut[c.r], _lut[c.g], _lut[c.b], _lut[c.w]};
}

RgbwColor4 ColorMath::lerp(const RgbwColor4& a, const RgbwColor4& b, float t) {
  float k = constrain(t, 0.0f, 1.0f);
  return {
      static_cast<uint8_t>(roundf(a.r + (b.r - a.r) * k)),
      static_cast<uint8_t>(roundf(a.g + (b.g - a.g) * k)),
      static_cast<uint8_t>(roundf(a.b + (b.b - a.b) * k)),
      static_cast<uint8_t>(roundf(a.w + (b.w - a.w) * k)),
  };
}

RgbwColor4 ColorMath::hsvToRgbw(uint16_t hue16, uint8_t sat, uint8_t val) {
  float h = (static_cast<float>(hue16) / 65535.0f) * 6.0f;
  float s = static_cast<float>(sat) / 255.0f;
  float v = static_cast<float>(val) / 255.0f;

  int i = static_cast<int>(floorf(h)) % 6;
  float f = h - floorf(h);
  float p = v * (1.0f - s);
  float q = v * (1.0f - f * s);
  float t = v * (1.0f - (1.0f - f) * s);

  float r = 0, g = 0, b = 0;
  switch (i) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }

  return {
      static_cast<uint8_t>(roundf(r * 255.0f)),
      static_cast<uint8_t>(roundf(g * 255.0f)),
      static_cast<uint8_t>(roundf(b * 255.0f)),
      0,
  };
}

