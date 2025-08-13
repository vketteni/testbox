FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --only=production

# Copy application code
COPY . .

# Create data and reports directories
RUN mkdir -p /app/data /app/reports

# Expose port for benchmarking services
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ps aux | grep node || exit 1

# Default command runs data generator
CMD ["npm", "run", "generate-data"]