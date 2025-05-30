FROM node:lts-alpine

WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY *.json ./

# Install dependencies without triggering any unwanted scripts
RUN npm install --ignore-scripts

# Copy all source code
COPY src ./src

# Build the application
RUN npm run build

# Environment variables for configuration
ENV MCP_PORT="3000"

# Expose the default port
EXPOSE ${MCP_PORT}

# Command to run the server
CMD [ "node", "build/index.js" , "--http"]