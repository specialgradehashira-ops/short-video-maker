FROM node:18-bullseye

# ffmpeg (incl. ffprobe) + a readable font + curl (handy for healthchecks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# Render passes PORT; we listen on it
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
