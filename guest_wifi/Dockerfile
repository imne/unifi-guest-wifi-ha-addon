# Built by the Home Assistant Supervisor from this folder.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json server.js automations.js ./
COPY public ./public
EXPOSE 8099
CMD ["node", "server.js"]
