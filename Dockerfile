FROM node:18-bullseye

# Install ffmpeg (for video) and a basic font (for captions)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    fonts-dejavu-core \
    curl \
    && rm -rf /var/lib/apt/lists/*

# App directory
WORKDIR /app

# Install deps (we'll add package.json in the next steps)
COPY package*.json ./
RUN npm install --omit=dev

# Copy app source (we'll add server.js next)
COPY . .

# Render will pass PORT; our app will listen on it
ENV PORT=8080
EXPOSE 8080

# Start the server (we'll create server.js in the next step)
CMD ["node", "server.js"]
