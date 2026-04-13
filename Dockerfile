FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install only production dependencies
RUN npm install --omit=dev

# Copy the rest of the application code
COPY . .

# Set environment to production
ENV NODE_ENV=production

# Expose the default WebSocket port
# Note: TCP Server ports (e.g., 10000-60000) are handled dynamically, 
# so network_mode: "host" is recommended in docker-compose.
EXPOSE 8765

# Start the Node.js server
CMD ["node", "server.js"]
