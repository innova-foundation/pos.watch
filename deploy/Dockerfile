# pos.watch — static site + nginx, for the Dell.
# Build from the repo root:  docker build -f deploy/Dockerfile -t poswatch .
FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx.conf /etc/nginx/conf.d/poswatch.conf
COPY website/ /usr/share/nginx/html/

EXPOSE 8080

# busybox wget ships in alpine; no extra tooling needed.
HEALTHCHECK --interval=30s --timeout=3s \
  CMD wget -qO /dev/null http://127.0.0.1:8080/ || exit 1
