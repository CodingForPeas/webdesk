FROM node:20-alpine

ARG APP_UID=1001
ARG APP_GID=1001
ARG APP_USER=wdesk
ARG HOME_DIR=/app

ENV NODE_ENV=production
EXPOSE 3000

# Optional: install build tools needed by native modules (node-gyp, bcrypt, etc.)
RUN apk update && \
    apk add --no-cache \
    python3 make g++ \
    ca-certificates \
    curl \
    bash \
    git \
    tzdata
RUN update-ca-certificates

RUN npm install -g pnpm

# If no WORKDIR is set in a Dockerfile, npm attempts to execute in the root directory,
# causing the internal tracker to fail.
WORKDIR ${HOME_DIR}

# Copy dependency manifests first to leverage layer caching
COPY package*.json pnpm-lock.yaml ./

## Production-only deps, clean cache in same layer
#RUN npm install express cors --omit=dev
#RUN npm install helmet express-rate-limit pg cookie-parser
#
## API only works on v16.x. From v17 onward it's ESM-only!
#RUN npm install file-type@16.5.4
#
##  Using multer to handle file uploads properly.
## It extracts the file content cleanly from multipart uploads.
#RUN npm install multer sharp

# Install node modules
#RUN pnpm install --prod --frozen-lockfile || (ls -la /app && exit 1)
RUN pnpm install --prod --frozen-lockfile
#RUN npm ci --omit=dev --no-cache-dir

# Copy the rest of the source
COPY *.mjs ./
COPY public/ ./public/
COPY routes ./routes/
COPY lib ./lib/

#######################################################
# Check and remove existing group associated with our APP_USER
#######################################################
#RUN grep -q "${APP_USER}" /etc/group && delgroup "${APP_USER}"

#######################################################
# Create non-root user for security
#######################################################
RUN addgroup -g "${APP_GID}" "${APP_USER}"
RUN adduser -D -u ${APP_UID} -G ${APP_USER} -s /bin/bash -h ${HOME_DIR} ${APP_USER}

# Create data directories and set ownership
RUN chown -R ${APP_UID}:${APP_GID} /app
#RUN rm package.json

# Switch to non-root user
USER ${APP_USER}

# Expose the port
EXPOSE 3000

HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.mjs"]
