FROM oven/bun:1.3.8

# Install git and common dev utilities
RUN apt-get update && apt-get install -y \
    git \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
