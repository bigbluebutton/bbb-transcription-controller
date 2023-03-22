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

bbbGW.on('UserSpeechLocaleChangedEvtMsg', (header, payload) => {
  const { meetingId, userId } = header;
  const { provider, locale } = payload;

  console.log("Speech changed", userId, provider, locale);

  setProvider(userId, provider);
  setUserLocale(userId, locale);
});

const REDIS_VOICE_ID_KEY = 'bbb-transcription-manager_voiceToMeeting';
const getVoiceToMeeting = (voiceConf, cb) => {
  bbbGW.getKey(REDIS_VOICE_ID_KEY + '_' + voiceConf, cb);
};

const setVoiceToMeeting = (voiceConf, meetingId, cb) => {
  bbbGW.setKey(REDIS_VOICE_ID_KEY + '_' + voiceConf, meetingId, cb);
};

const REDIS_USER_LOCALE_KEY = 'bbb-transcription-manager_locale';
const getUserLocale = (userId, cb) => {
  bbbGW.getKey(REDIS_USER_LOCALE_KEY + '_' + userId, cb);
};

const setUserLocale = (userId, locale, cb) => {
  bbbGW.setKey(REDIS_USER_LOCALE_KEY + '_' + userId, locale, cb);
};

const REDIS_TRANSCRIPTION_PROVIDER_KEY = 'bbb-transcription-manager_provider';
const getProvider = (userId, cb) => {
  bbbGW.getKey(REDIS_TRANSCRIPTION_PROVIDER_KEY + '_' + userId, cb);
};

const setProvider = (userId, provider, cb) => {
  bbbGW.setKey(REDIS_TRANSCRIPTION_PROVIDER_KEY + '_' + userId, provider, cb);
};

const EslWrapper = require('./lib/esl-wrapper');
const eslWrapper = new EslWrapper();

const SAMPLE_RATE = config.get("sampleRate");

const getServerUrl = (userId, cb) => {

  getProvider(userId, (err, provider) => {
    getUserLocale(userId, (err, locale) => {

      if (provider && provider != '' && config.has(provider)  && locale && locale != '') {
        return cb(config.get(provider + '.servers.' + locale), provider);
      } else {
        return cb(null);
      }
    });
  });
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

const startAudioFork = (channelId, userId) => {
  getServerUrl(userId, (serverUrl, provider) => {
    if (!serverUrl) {
      Logger.warn("No provider set, not transcribing");
      return;
    }

    const initialMessage = JSON.parse(config.get(provider + '.startMessage'));
    if (provider === 'vosk') {
      initialMessage.config.sample_rate = SAMPLE_RATE + '000';
    }

    if (socketIsStopping[channelId]) {
      socketIsStopping[channelId] = false;
    }

    if (!socketStatus[channelId]) {
      eslWrapper._executeCommand(`uuid_audio_fork ${channelId} start ${serverUrl} mono ${SAMPLE_RATE}k ${JSON.stringify(initialMessage)}`);
     socketStatus[channelId] = true;
    }
  });
};

const stopAudioFork = (channelId, userId) => {
  getProvider(userId, (err, provider) => {

    let endMessage;

    if (!provider) {
      Logger.warn("No provider set, not stopping transcription");
      endMessage = JSON.parse(config.get('vosk.endMessage'));
    } else {
      endMessage = JSON.parse(config.get(provider + '.endMessage'));
    }

    if (socketStatus[channelId]) {
      if (!socketIsStopping[channelId]) {
        socketIsStopping[channelId] = true;
      } else {
        eslWrapper._executeCommand(`uuid_audio_fork ${channelId} stop ${JSON.stringify(endMessage)}`);

        socketStatus[channelId] = false;
        socketIsStopping[channelId] = false;
      }
    }
  });
};

let prev_transcription = '';
eslWrapper.onModAudioForkJSON((msg) => {
  const channelId = msg.getHeader('Channel-Call-UUID')

  getVoiceToMeeting(msg.getHeader('variable_conference_name'), (err, meetingId) => {

    const userId = msg.getHeader('Caller-Username').split('_').slice(0,2).join('_');
    getUserLocale(userId, (err, locale) => {
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
      const payload = makeMessage(meetingId, userId, locale, transcription, result);

      bbbGW.publish(JSON.stringify(payload), C.TO_AKKA_APPS_CHAN_2x);

      if (socketIsStopping[channelId] && result) {
        stopAudioFork(channelId);
      }
  });

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

const handleStartTalking = (channelId, userId) => {
  Logger.info(`FS: Start talking ${channelId} userId: ${userId}`);
  startAudioFork(channelId, userId);
}

const handleStopTalking = (channelId, userId) => {
  Logger.info(`FS: Stop Talking ${channelId} userId: ${userId}`);
  stopAudioFork(channelId, userId);
} 

eslWrapper.on(EslWrapper.EVENTS.CHANNEL_ANSWER, handleChannelAnswer);
eslWrapper.on(EslWrapper.EVENTS.CHANNEL_HANGUP, handleChannelHangup);
eslWrapper.on(EslWrapper.EVENTS.FLOOR_CHANGED, handleFloorChanged);
eslWrapper.on(EslWrapper.EVENTS.START_TALKING, handleStartTalking);
eslWrapper.on(EslWrapper.EVENTS.STOP_TALKING, handleStopTalking);
eslWrapper.on(EslWrapper.EVENTS.MUTED, handleStopTalking);

eslWrapper._connect();

