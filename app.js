'use strict'

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch (ex) {
    return {};
  }
}

const config = require('config');
const EventEmitter = require('events').EventEmitter;
const Logger = require('./lib/logger');
const LOG_PREFIX = "[bbb-transcript-manager]";

const C = require('./lib/Constants');
const BigBlueButtonGW = require('./lib/bbb-gw');

const bbbGW = new BigBlueButtonGW();

const socketStatus = {};
const socketIsStopping = {};

const REDIS_CHANNEL = config.get('redis.publishChannel')

bbbGW.addSubscribeChannel(REDIS_CHANNEL);
bbbGW.on('MeetingCreatedEvtMsg', (header, payload) => {
  setVoiceToMeeting(payload.props.voiceProp.voiceConf, payload.props.meetingProp.intId);
});

let currentLocale = 'en-US';
//const getLocale = (, cb) => {
//  bbbGW.getKey(REDIS_LOCALE + '_' + voiceConf, cb);
//}

//const setLocale = () => {
//
//}

const REDIS_VOICE_ID_KEY = 'bbb-trascription-manager_voiceToMeeting';
const getVoiceToMeeting = (voiceConf, cb) => {
  bbbGW.getKey(REDIS_VOICE_ID_KEY + '_' + voiceConf, cb);
};

const setVoiceToMeeting = (voiceConf, meetingId, cb) => {
  bbbGW.setKey(REDIS_VOICE_ID_KEY + '_' + voiceConf, meetingId, cb);
};

const EslWrapper = require('./lib/esl-wrapper');
const eslWrapper = new EslWrapper();

const SAMPLE_RATE = config.get("sampleRate");
const TRANSCRIPTION_SERVER = config.get("transcriptionServer");

const INITIAL_MESSAGE = JSON.parse(config.get(TRANSCRIPTION_SERVER +'.startMessage'));
const FINAL_MESSAGE = JSON.parse(config.get(TRANSCRIPTION_SERVER +'.endMessage'));

if (TRANSCRIPTION_SERVER === 'vosk') {
  INITIAL_MESSAGE.config.sample_rate = SAMPLE_RATE + '000';
}

const getServerUrl = (locale) => {
  return config.get(TRANSCRIPTION_SERVER + '.servers.' + locale);
};

const makeMessage = (meetingId, userId, locale, transcript, result) => {
  return {
    envelope: {
      name: 'UpdateTranscriptPubMsg',
      routing: {
        meetingId,
        userId,
      },
      timestamp: Date.now(),
    },
    core: {
      header: {
        name: 'UpdateTranscriptPubMsg',
        meetingId,
        userId,
      },
      body: {
        transcriptId: userId + '-'+ Date.now(),
        start: '0',
        end: '0',
        text: '',
        transcript,
        locale,
        result,
      },
    }
  };
};

const startAudioFork = (channelId) => {
  const serverUrl = getServerUrl(currentLocale);

  if (socketIsStopping[channelId]) {
    socketIsStopping[channelId] = false;
  }

  if (!socketStatus[channelId]) {
    eslWrapper._executeCommand(`uuid_audio_fork ${channelId} start ${serverUrl} mono ${SAMPLE_RATE}k ${JSON.stringify(INITIAL_MESSAGE)}`);
   socketStatus[channelId] = true;
  }
};

const stopAudioFork = (channelId) => {
  if (socketStatus[channelId]) {
    if (!socketIsStopping[channelId]) {
      socketIsStopping[channelId] = true;
    } else {
      eslWrapper._executeCommand(`uuid_audio_fork ${channelId} stop ${JSON.stringify(FINAL_MESSAGE)}`);

      socketStatus[channelId] = false;
      socketIsStopping[channelId] = false;
    }
  }
};

let prev_transcription = '';
eslWrapper.onModAudioForkJSON((msg) => {
  const channelId = msg.getHeader('Channel-Call-UUID')

  getVoiceToMeeting(msg.getHeader('variable_conference_name'), (err, meetingId) => {

    const userId = msg.getHeader('Caller-Username').split('_').slice(0,2).join('_');
    const ignore = [ '', 'the']

    const body = tryParseJson(msg.body);
    const transcription = body.text || body.partial;

    if (body.text) {
      Logger.info(`Final text is: ${body.text}`);
    }

    if ((ignore.includes(transcription) || transcription == prev_transcription) && !body.text) {
      return;
    }

    prev_transcription = transcription;
    const result = Boolean(body.text);
    const payload = makeMessage(meetingId, userId, currentLocale, transcription, result);

    bbbGW.publish(JSON.stringify(payload), C.TO_AKKA_APPS_CHAN_2x);

    if (socketIsStopping[channelId] && result) {
      stopAudioFork(channelId);
    }

  });
});

const handleChannelAnswer = (channelId, callId) => {
  Logger.info(`FS: Associating channel ${channelId} ${callId}`);
}

const handleChannelHangup = (channelId, callId) => {
  Logger.info(`FS: channel hangup ${channelId} ${callId}`);
}

const handleFloorChanged = (roomId, newFloorMemberId) => {
  Logger.info(`FS: floor changed ${roomId} ${newFloorMemberId}`);
}

const handleStartTalking = (channelId) => {
  Logger.info(`FS: Start talking ${channelId}`);
  startAudioFork(channelId);
}

const handleStopTalking = (channelId) => {
  Logger.info('FS: Stop Talking', channelId);
  stopAudioFork(channelId);
} 

eslWrapper.on(EslWrapper.EVENTS.CHANNEL_ANSWER, handleChannelAnswer);
eslWrapper.on(EslWrapper.EVENTS.CHANNEL_HANGUP, handleChannelHangup);
eslWrapper.on(EslWrapper.EVENTS.FLOOR_CHANGED, handleFloorChanged);
eslWrapper.on(EslWrapper.EVENTS.START_TALKING, handleStartTalking);
eslWrapper.on(EslWrapper.EVENTS.STOP_TALKING, handleStopTalking);
eslWrapper.on(EslWrapper.EVENTS.MUTED, handleStopTalking);

eslWrapper._connect();

const http = require('http');

const requestListener = function(req, res) {
  res.writeHead(200);
  res.end('fs');
};

const server = http.createServer(requestListener);
server.listen(8989);

