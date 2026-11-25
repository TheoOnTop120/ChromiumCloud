FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache docker-cli ca-certificates
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /data
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node","server.js"]
