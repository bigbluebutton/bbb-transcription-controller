# bbb-transcription-controller

Controls the transcription of voice streams coming from BigBlueButton.

This node.js app listens to ESL events from Freeswitch and uses `mod_audio_fork`
to send the audio data into a voice transcription server. The returning transcription
is then sent into Redis and can be displayed by the HTML5 client

<img src="https://user-images.githubusercontent.com/32987232/218772516-dac48392-4e78-46cb-8ccc-62a65f1185ea.svg" width=650px />


## Running

    npm install


    node app.js

## Configuration

The configuration file has comments explaining each of its parts

## VOSK servers

To spawn you own VOSK servers using docker use this:

    docker run -d -p 2700:2700 alphacep/kaldi-en:latest

alphacep's docker hub has images for most of their language models

Vosk listens on a websocket and I've set up a reverse proxy to make
configuration easier. Here's an example nginx config file:

    vosk-en.conf
    location /voskEN {
     proxy_pass http://127.0.0.1:2700;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "Upgrade";
      proxy_read_timeout 60s;
      proxy_send_timeout 60s;
      client_body_timeout 60s;
      send_timeout 60s;
    }

