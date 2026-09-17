# Single lightweight image: Node backend + nginx front, no npm dependencies.
FROM node:22-alpine

# nginx from Alpine repos
RUN apk add --no-cache nginx

WORKDIR /app

# Backend (Node built-ins only, so no `npm install` needed)
COPY backend/ ./backend/

# Static frontend served by nginx
COPY frontend/ /usr/share/nginx/html/

# nginx site config (Alpine includes /etc/nginx/http.d/*.conf)
COPY nginx/default.conf /etc/nginx/http.d/default.conf

# Startup script (launches node + nginx)
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV PORT=3000 \
    DB_PATH=/data/lab.db

# SQLite file lives here (fixed accounts are re-seeded if empty)
VOLUME ["/data"]

EXPOSE 80

CMD ["/entrypoint.sh"]
