# The whole pipeline (Paper, Node/Mineflayer, kev training and serving) in one CUDA container, for the Windows machine.
# Built and used through docker/compose.yml; see docker/README.md. The repos are bind-mounted, not copied.
FROM nvidia/cuda:12.8.1-base-ubuntu24.04

ENV DEBIAN_FRONTEND=noninteractive TZ=America/Los_Angeles
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential pkg-config python3 python3-venv python-is-python3 ca-certificates curl git procps util-linux tzdata \
      ffmpeg xvfb libxi-dev libgl1-mesa-dev libglu1-mesa-dev libpango1.0-dev libjpeg-dev libgif-dev libcairo2-dev \
      librsvg2-dev libxext-dev libx11-dev openjdk-21-jre-headless \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (Mineflayer, the agent, headless-gl build)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# uv and a managed Python 3.13 for kev (the kev venv itself lives in a named volume, created by docker/setup.sh)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/
ENV UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_LINK_MODE=copy UV_CACHE_DIR=/root/.cache/uv
RUN uv python install 3.13

# The analysis python ($CPY in the scripts): matplotlib for the reliability diagrams
RUN python3 -m venv /opt/cpy && /opt/cpy/bin/pip install --no-cache-dir matplotlib numpy requests
ENV CPY=/opt/cpy/bin/python

# headless-gl (the video recorder) needs an X display on Linux
ENV DISPLAY=:99
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
WORKDIR /work/minecraft-kev
CMD ["sleep", "infinity"]
