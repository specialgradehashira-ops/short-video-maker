FROM node:18-bullseye

# ffmpeg (includes ffprobe) + a readable font + curl (handy for healthchecks)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

# Render will supply PORT; we listen on it
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
