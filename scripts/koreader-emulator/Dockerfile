FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      dbus-x11 \
      imagemagick \
      libegl1 \
      libgl1 \
      libwayland-client0 \
      libx11-6 \
      libxcomposite1 \
      libxcursor1 \
      libxext6 \
      libxi6 \
      libxinerama1 \
      libxkbcommon0 \
      libxrandr2 \
      libxrender1 \
      libxss1 \
      libxtst6 \
      locales \
      procps \
      python3 \
      x11-utils \
      xdotool \
      xvfb \
    && sed -i 's/^# en_US.UTF-8 UTF-8/en_US.UTF-8 UTF-8/' /etc/locale.gen \
    && locale-gen \
    && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
WORKDIR /workspace
ENTRYPOINT ["/workspace/scripts/koreader-emulator/run.sh", "--inside-container"]
