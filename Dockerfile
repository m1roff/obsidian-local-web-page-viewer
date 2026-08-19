FROM node:22-alpine
RUN apk add --no-cache git
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
CMD ["npm", "run", "dev"]
