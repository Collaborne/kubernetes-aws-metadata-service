FROM node:erbium-alpine AS build

# Install build dependencies (marked as 'build-dependencies' group)
RUN if [ -f /etc/alpine-release ]; then apk add --no-cache --virtual build-dependencies git bash gcc g++ python make openssl-dev lz4-dev zlib-dev; fi

# Configure NPM
RUN npm config set progress=false
RUN npm config set //registry.npmjs.org/:_authToken=${NPM_TOKEN}

WORKDIR /source

# Install the application
ADD . /source
RUN npm install
RUN npm run lint
RUN npm run build
RUN npm test

#
# Create actual runtime environment
#
FROM node:erbium-alpine AS runtime

ARG NODE_ENV
ENV NODE_ENV=${NODE_ENV:-production}
ENV LOG4JS_CONFIG=/app/log4js.json

# Install runtime dependencies
RUN if [ -f /etc/alpine-release ]; then apk add --no-cache openssl lz4-libs zlib; fi

WORKDIR /app
COPY --from=build /source/build /app/build
COPY --from=build /source/package.json /source/log4js.json /app
# Copy the dependencies and prune them for the selected environment
# This saves in amount of bytes downloaded from the internet, and avoids having the npm token stored in the
# runtime container image
COPY --from=build /source/node_modules /app/node_modules
RUN npm prune

EXPOSE 8080
ENTRYPOINT ["npm", "start", "--"]
