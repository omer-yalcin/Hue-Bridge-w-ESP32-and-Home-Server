#include "led_engine.h"

LedEngine::~LedEngine() {
  delete _rgbStrip;
  delete _rgbwStrip;
  delete[] _frameBuffer;
}

void LedEngine::begin(const HardwareConfig& hw, const SegmentConfig* segs, uint8_t segCount) {
  _hw = hw;
  _color.setGamma(_hw.gamma);
  updateSegments(segs, segCount);

  delete _rgbStrip;
  delete _rgbwStrip;
  delete[] _frameBuffer;
  _rgbStrip = nullptr;
  _rgbwStrip = nullptr;

  _frameBuffer = new RgbwColor4[_hw.ledCount]();

  if (_hw.stripType == "sk6812_rgbw") {
    _rgbwStrip = new NeoPixelBus<NeoGrbwFeature, NeoSk6812Method>(_hw.ledCount, _hw.gpioPin);
    _rgbwStrip->Begin();
    _rgbwStrip->Show();
  } else {
    _rgbStrip = new NeoPixelBus<NeoGrbFeature, NeoWs2812xMethod>(_hw.ledCount, _hw.gpioPin);
    _rgbStrip->Begin();
    _rgbStrip->Show();
  }

  _fpsWindowStartMs = millis();
}

void LedEngine::updateSegments(const SegmentConfig* segs, uint8_t segCount) {
  _segCount = min<uint8_t>(segCount, MAX_SEGMENTS);
  for (uint8_t i = 0; i < _segCount; i++) {
    _segs[i] = segs[i];
  }
}

void LedEngine::applySegmentState(
    const String& segmentId,
    bool on,
    uint8_t bri,
    const RgbwColor4& rgbw,
    uint16_t transitionMs,
    const String& effect,
    const String& alert,
    const RgbwColor4* gradient,
    uint8_t gradientCount) {
  uint32_t now = millis();
  for (uint8_t i = 0; i < _segCount; i++) {
    if (_segs[i].id != segmentId && !(segmentId == "main" && i == 0)) continue;
    SegmentRuntimeState& st = _states[i];
    st.on = on;
    st.bri = bri;
    st.startRgbw = st.currentRgbw;
    st.targetRgbw = on ? rgbw : RgbwColor4{0, 0, 0, 0};
    st.transitionStartMs = now;
    st.transitionMs = transitionMs;
    st.effect = effect.length() > 0 ? effect : "none";

    if (alert == "select") {
      st.alertUntilMs = now + 900;
    } else if (alert == "lselect") {
      st.alertUntilMs = now + 10000;
    }

    st.gradientCount = min<uint8_t>(gradientCount, MAX_GRADIENT_STOPS);
    for (uint8_t g = 0; g < st.gradientCount; g++) {
      st.gradientStops[g] = gradient[g];
    }
  }
}

void LedEngine::applyFastFrame(uint8_t segmentIndex, const RgbwColor4& rgbw, bool on) {
  if (segmentIndex >= _segCount) return;
  SegmentRuntimeState& st = _states[segmentIndex];
  st.on = on;
  st.startRgbw = st.currentRgbw;
  st.targetRgbw = on ? rgbw : RgbwColor4{0, 0, 0, 0};
  st.currentRgbw = st.targetRgbw;
  st.transitionMs = 0;
  st.effect = "none";
  st.gradientCount = 0;
}

void LedEngine::triggerIdentify(const String& segmentId) {
  uint32_t now = millis();
  for (uint8_t i = 0; i < _segCount; i++) {
    if (segmentId.length() == 0 || _segs[i].id == segmentId) {
      _states[i].identifyUntilMs = now + 1800;
    }
  }
}

RgbwColor4 LedEngine::renderEffectPixel(
    const SegmentRuntimeState& st,
    uint16_t relIdx,
    uint16_t segLen,
    uint32_t nowMs) {
  float briScale = static_cast<float>(st.bri) / 254.0f;

  if (st.effect == "rainbow") {
    uint16_t hue = static_cast<uint16_t>((nowMs * 18 + (relIdx * 65535UL) / max<uint16_t>(1, segLen)) & 0xFFFF);
    return ColorMath::hsvToRgbw(hue, 255, static_cast<uint8_t>(255.0f * briScale));
  }

  if (st.effect == "colorloop" || st.effect == "prism") {
    uint16_t hue = static_cast<uint16_t>((nowMs * 8 + relIdx * 320) & 0xFFFF);
    return ColorMath::hsvToRgbw(hue, 255, static_cast<uint8_t>(255.0f * briScale));
  }

  if (st.effect == "breathe") {
    float wave = 0.5f + 0.5f * sinf(static_cast<float>(nowMs) * 0.003f);
    float scale = 0.15f + 0.85f * wave;
    return {
        static_cast<uint8_t>(st.currentRgbw.r * scale),
        static_cast<uint8_t>(st.currentRgbw.g * scale),
        static_cast<uint8_t>(st.currentRgbw.b * scale),
        static_cast<uint8_t>(st.currentRgbw.w * scale),
    };
  }

  if (st.effect == "candle" || st.effect == "fire") {
    float base = st.effect == "fire" ? 0.45f : 0.65f;
    float jitter = (sinf(nowMs * 0.017f + relIdx * 1.9f) + sinf(nowMs * 0.031f + relIdx * 3.1f)) * 0.2f;
    float f = constrain(base + jitter, 0.2f, 1.0f) * briScale;
    uint8_t gVal = st.effect == "fire" ? static_cast<uint8_t>(75 * f) : static_cast<uint8_t>(135 * f);
    return {
        static_cast<uint8_t>(255 * f),
        gVal,
        static_cast<uint8_t>(10 * f),
        0,
    };
  }

  if (st.effect == "sparkle" || st.effect == "glisten") {
    uint32_t seed = (nowMs / 75) * 2654435761UL + relIdx * 73856093UL;
    if ((seed & 0x1F) == 0) {
      uint8_t peak = static_cast<uint8_t>(255.0f * briScale);
      return _hw.stripType == "sk6812_rgbw" ? RgbwColor4{0, 0, 0, peak} : RgbwColor4{peak, peak, peak, 0};
    }
    return {
        static_cast<uint8_t>(st.currentRgbw.r * 0.35f),
        static_cast<uint8_t>(st.currentRgbw.g * 0.35f),
        static_cast<uint8_t>(st.currentRgbw.b * 0.35f),
        static_cast<uint8_t>(st.currentRgbw.w * 0.35f),
    };
  }

  if (st.effect == "opal") {
    uint16_t hue = static_cast<uint16_t>(36000 + sinf(nowMs * 0.0012f + relIdx * 0.25f) * 14000.0f);
    return ColorMath::hsvToRgbw(hue, 180, static_cast<uint8_t>(255.0f * briScale));
  }

  if (st.effect == "chase") {
    uint16_t pos = (nowMs / 65) % max<uint16_t>(1, segLen);
    if (abs(static_cast<int>(relIdx) - static_cast<int>(pos)) <= 1) {
      return st.currentRgbw;
    }
    return {0, 0, 0, 0};
  }

  return st.currentRgbw;
}

void LedEngine::setPixelRemapped(uint16_t idx, const RgbwColor4& c) {
  uint8_t a = c.r, b = c.g, d = c.b;
  // NeoPixelBus NeoGrbFeature expects (R, G, B) -> outputs G, R, B.
  // Remap software channels to match user-configured wire color order.
  if (_hw.colorOrder == "RGB") {
    a = c.g; b = c.r; d = c.b;
  } else if (_hw.colorOrder == "BRG") {
    a = c.r; b = c.b; d = c.g;
  } else if (_hw.colorOrder == "RBG") {
    a = c.b; b = c.r; d = c.g;
  } else if (_hw.colorOrder == "GBR") {
    a = c.b; b = c.g; d = c.r;
  } else if (_hw.colorOrder == "BGR") {
    a = c.g; b = c.b; d = c.r;
  }

  if (_rgbwStrip) {
    _rgbwStrip->SetPixelColor(idx, RgbwColor(a, b, d, c.w));
  } else if (_rgbStrip) {
    _rgbStrip->SetPixelColor(idx, RgbColor(a, b, d));
  }
}

void LedEngine::applyCurrentLimiter() {
  uint32_t totalMa = 0;
  for (uint16_t i = 0; i < _hw.ledCount; i++) {
    const RgbwColor4& p = _frameBuffer[i];
    // ~20mA max per diode channel at 255
    totalMa += ((static_cast<uint32_t>(p.r) + p.g + p.b + p.w) * 20UL) / 255UL;
  }
  if (totalMa <= _hw.maxCurrentMa || totalMa == 0) return;

  float scale = static_cast<float>(_hw.maxCurrentMa) / static_cast<float>(totalMa);
  for (uint16_t i = 0; i < _hw.ledCount; i++) {
    _frameBuffer[i].r = static_cast<uint8_t>(_frameBuffer[i].r * scale);
    _frameBuffer[i].g = static_cast<uint8_t>(_frameBuffer[i].g * scale);
    _frameBuffer[i].b = static_cast<uint8_t>(_frameBuffer[i].b * scale);
    _frameBuffer[i].w = static_cast<uint8_t>(_frameBuffer[i].w * scale);
  }
}

void LedEngine::loop() {
  uint32_t now = millis();
  if (now - _lastRenderMs < 16) return;  // ~60 FPS cap
  _lastRenderMs = now;

  memset(_frameBuffer, 0, sizeof(RgbwColor4) * _hw.ledCount);

  for (uint8_t s = 0; s < _segCount; s++) {
    const SegmentConfig& seg = _segs[s];
    SegmentRuntimeState& st = _states[s];

    if (st.transitionMs == 0 || now - st.transitionStartMs >= st.transitionMs) {
      st.currentRgbw = st.targetRgbw;
    } else {
      float t = static_cast<float>(now - st.transitionStartMs) / static_cast<float>(st.transitionMs);
      st.currentRgbw = ColorMath::lerp(st.startRgbw, st.targetRgbw, t);
    }

    uint16_t start = min<uint16_t>(seg.startLed, _hw.ledCount - 1);
    uint16_t end = min<uint16_t>(seg.endLed, _hw.ledCount - 1);
    uint16_t segLen = (end >= start) ? (end - start + 1) : 1;

    for (uint16_t idx = start; idx <= end; idx++) {
      uint16_t rel = seg.reverse ? (end - idx) : (idx - start);
      RgbwColor4 px = {0, 0, 0, 0};

      if (now < st.identifyUntilMs) {
        bool blinkOn = ((now / 220) % 2) == 0;
        px = blinkOn ? RgbwColor4{0, 140, 255, 80} : RgbwColor4{0, 0, 0, 0};
      } else if (st.on) {
        if (st.effect != "none") {
          px = renderEffectPixel(st, rel, segLen, now);
        } else if (st.gradientCount >= 2 && segLen > 1) {
          float pos = (static_cast<float>(rel) / static_cast<float>(segLen - 1)) * (st.gradientCount - 1);
          uint8_t idxA = min<uint8_t>(static_cast<uint8_t>(floorf(pos)), st.gradientCount - 2);
          float frac = pos - idxA;
          px = ColorMath::lerp(st.gradientStops[idxA], st.gradientStops[idxA + 1], frac);
        } else {
          px = st.currentRgbw;
        }

        if (now < st.alertUntilMs) {
          float pulse = 0.25f + 0.75f * fabsf(sinf(now * 0.01f));
          px.r = static_cast<uint8_t>(px.r * pulse);
          px.g = static_cast<uint8_t>(px.g * pulse);
          px.b = static_cast<uint8_t>(px.b * pulse);
          px.w = static_cast<uint8_t>(px.w * pulse);
        }
      }

      _frameBuffer[idx] = _color.applyGammaRgbw(px);
    }
  }

  applyCurrentLimiter();

  for (uint16_t i = 0; i < _hw.ledCount; i++) {
    setPixelRemapped(i, _frameBuffer[i]);
  }

  if (_rgbwStrip) {
    _rgbwStrip->Show();
  } else if (_rgbStrip) {
    _rgbStrip->Show();
  }

  _frameCount++;
  if (now - _fpsWindowStartMs >= 2000) {
    _fps = (static_cast<float>(_frameCount) * 1000.0f) / static_cast<float>(now - _fpsWindowStartMs);
    _frameCount = 0;
    _fpsWindowStartMs = now;
  }
}

