#pragma once

// Copy this file to firmware/include/config.h and enter your Wi-Fi credentials.

#define WIFI_SSID        "YOUR_WIFI_SSID"
#define WIFI_PASSWORD    "YOUR_WIFI_PASSWORD"

// Leave SERVER_HOST empty ("") to auto-discover the home server via mDNS (_hue-esp-srv._tcp)
#define SERVER_HOST      ""
#define SERVER_PORT      80

#define NODE_NAME        "Hue ESP32 Strip"
#define LED_PIN          4
#define LED_COUNT        60

// Supported: "ws2812b" (RGB) or "sk6812_rgbw" (RGBW)
#define STRIP_TYPE       "ws2812b"
// Supported: "GRB", "RGB", "BRG", "RBG", "GBR", "BGR"
#define COLOR_ORDER      "GRB"

#define MAX_CURRENT_MA   2000
#define WHITE_TEMP_K     3000
#define OTA_PASSWORD     "huebridge"

