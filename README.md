# bbb-transcription-controller

Controls the transcription of voice streams coming from BigBlueButton.

This node.js app listens to ESL events from Freeswitch and uses `mod_audio_fork`
to send the audio data into a voice transcription server. The returning transcription
is then sent into Redis and can be displayed by the HTML5 client

## Configuration


