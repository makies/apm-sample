FROM composer:2 AS composer

FROM php:8.3-cli AS build
RUN apt-get update && apt-get install -y --no-install-recommends unzip git && rm -rf /var/lib/apt/lists/*
COPY --from=mlocati/php-extension-installer /usr/bin/install-php-extensions /usr/bin/
RUN install-php-extensions pdo_mysql opentelemetry
COPY --from=composer /usr/bin/composer /usr/bin/composer
WORKDIR /app
COPY composer.json composer.lock ./
RUN composer install --no-dev --optimize-autoloader --no-scripts --no-interaction
COPY . .
RUN composer dump-autoload --optimize --no-dev

FROM php:8.3-apache
COPY --from=mlocati/php-extension-installer /usr/bin/install-php-extensions /usr/bin/
RUN install-php-extensions pdo_mysql opentelemetry

# `php artisan serve` (the built-in dev server) crashes the whole process on
# the first instrumented request -- the OTel extension's request lifecycle
# hooks don't get along with its single-process-per-request-loop model.
# Apache+mod_php is the simplest way to get a real, per-request process
# model without adding a second nginx+php-fpm container.
RUN a2enmod rewrite \
  && sed -i 's/^Listen 80$/Listen 8080/' /etc/apache2/ports.conf \
  && sed -i 's/<VirtualHost \*:80>/<VirtualHost *:8080>/' /etc/apache2/sites-available/000-default.conf \
  && sed -i 's#DocumentRoot /var/www/html#DocumentRoot /var/www/html/public#' /etc/apache2/sites-available/000-default.conf \
  && printf '<Directory /var/www/html/public>\n    AllowOverride All\n    Require all granted\n</Directory>\n' >> /etc/apache2/sites-available/000-default.conf

WORKDIR /var/www/html
COPY --from=build /app ./
RUN chown -R www-data:www-data storage bootstrap/cache

ENV APP_ENV=production
ENV APP_DEBUG=false
ENV LOG_CHANNEL=json
# Zero-code instrumentation: no ADOT distro exists for PHP, so this just
# turns on the vanilla OpenTelemetry SDK's Composer-autoloaded
# auto-instrumentation (open-telemetry/opentelemetry-auto-laravel,
# ...-auto-pdo) picked up via the opentelemetry extension installed above.
ENV OTEL_PHP_AUTOLOAD_ENABLED=true

EXPOSE 8080
CMD ["sh", "-c", "php artisan migrate --force && apache2-foreground"]
