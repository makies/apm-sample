FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

# ADOT auto-instrumentation is loaded via --require, no code changes needed in
# src/index.ts. This is safe to bake into the image: it's a no-op unless the
# OTEL_* environment variables below are also set (done in the ECS task def).
ENV NODE_OPTIONS="--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register"

EXPOSE 8080
CMD ["node", "dist/index.js"]
