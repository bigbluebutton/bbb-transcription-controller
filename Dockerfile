#
# To build: docker build -t bigbluebutton/transcription-controller .
# To run: docker run -d --name bbb-transcription-controller --restart always -v $(pwd)/default.yml:/app/config/default.yml docker.io/mconf/bbb-transcription-controller:latest

FROM node:18-slim

ENV NODE_ENV production

WORKDIR /app

COPY package.json package-lock.json /app/

RUN npm install \
 && npm cache clear --force

COPY . /app

RUN cp config/default.example.yml config/default.yml

CMD [ "npm", "start" ]
