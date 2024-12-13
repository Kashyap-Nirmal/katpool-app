# Use the official Node.js image as the base image
FROM node:20.18.0

# Install Bun
RUN curl -fsSL https://bun.sh/install | bash

# Set the working directory in the container
WORKDIR /app

# Add Bun to the PATH environment variable
ENV PATH="/root/.bun/bin:$PATH"

# Copy the package.json and bun.lockb files to the working directory
COPY package.json ./

# Install dependencies
RUN bun install
RUN bun upgrade --canary

# Copy the rest of your application code to the working directory
COPY . .

# Expose the port your app runs on
EXPOSE 7777

# Start the application
CMD ["bun", "run", "index.ts"]
