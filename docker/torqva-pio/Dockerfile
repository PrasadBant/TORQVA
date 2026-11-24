FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PLATFORMIO_CORE_DIR=/opt/pio \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir platformio==6.1.16

# Pre-install ESP32-S3 platform (v7.1.3 = Arduino-ESP32 2.x / IDF 4.4 matching firmware),
# toolchain, framework, and project libraries so user compilation runs completely offline (--network none).
RUN mkdir -p /tmp/warmup/src /opt/pio /opt/pio_libs && \
    printf '[env:esp32s3_wireless]\nplatform = espressif32@7.1.3\nboard = esp32-s3-devkitc-1\nframework = arduino\nboard_build.arduino.memory_type = qio_opi\nboard_upload.flash_size = 16MB\nboard_build.partitions = default_8MB.csv\nlib_deps =\n    adafruit/Adafruit INA219@^1.2.3\n    paulstoffregen/OneWire@^2.3.8\n    milesburton/DallasTemperature@^3.11.0\n    olikraus/U8g2@^2.35.19\n' > /tmp/warmup/platformio.ini && \
    printf '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n' > /tmp/warmup/src/main.cpp && \
    cd /tmp/warmup && pio pkg install -e esp32s3_wireless && \
    cp -r /tmp/warmup/.pio/libdeps/esp32s3_wireless/* /opt/pio_libs/ && \
    rm -rf /tmp/warmup && \
    chmod -R a+rX /opt/pio /opt/pio_libs

RUN useradd -m -u 10001 -s /bin/sh torqva && \
    mkdir -p /workspace && chown torqva:torqva /workspace

USER torqva
WORKDIR /workspace
