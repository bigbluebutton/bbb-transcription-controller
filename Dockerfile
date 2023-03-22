#
# To build: docker build -t bigbluebutton/transcription-controller .
# To run: docker run --rm --name transcription-controller -v $(pwd)/config/production.yml:/app/config/production.yml bigbluebutton/transcription-controller

FROM node:18-alpine

RUN apk update && apk add git

ADD . app

WORKDIR app

ENV NODE_ENV production

RUN cp config/default.yml config/production.yml

RUN npm install \
 && npm cache clear --force

CMD [ "npm", "start" ]
