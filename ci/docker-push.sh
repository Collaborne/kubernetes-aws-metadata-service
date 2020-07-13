#!/bin/sh

echo "${DOCKER_PASSWORD}" | docker login -u "${DOCKER_USERNAME}" --password-stdin

DOCKER_NAME=$1
shift
for tag in "$@"; do
	docker push "${DOCKER_NAME}:${tag}"
done