FROM nginx:stable

ARG TEMPLATES_DIR=templates

COPY pages /var/www/html/pages/
COPY ${TEMPLATES_DIR}/ /etc/nginx/templates/
COPY options-ssl-nginx.conf /etc/nginx/options-ssl-nginx.conf
COPY 99-autoreload.sh /docker-entrypoint.d/99-autoreload.sh

RUN chmod 755 /docker-entrypoint.d/99-autoreload.sh
