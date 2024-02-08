'use strict'

const Logger = require('./lib/logger');

const config = require('config');
const { fork } = require('child_process');
const fs = require('fs');

let GLADIA_PROXY_PROCESS;
const runGladiaProxy = () => {
  const outputFile = config.get('log.gladiaProxy');

  const outputStream = fs.createWriteStream(outputFile);

  outputStream.on('open', () => {
    // Spawn the child process
    GLADIA_PROXY_PROCESS = fork('gladia-proxy.js', [], {
      stdio: [null, outputStream, outputStream, 'ipc']
    });

    GLADIA_PROXY_PROCESS.on('exit', (code, signal) => {
      Logger.info(`Closing Gladia proxy code: ${code} signal: ${signal}`);
    });
  });

  Logger.info("Starting Gladia proxy");
}

if (config.get('gladia.proxy.enabled')) {
  runGladiaProxy();
}

const { tryParseJSON }  = require('./lib/utils');

const EventEmitter = require('events').EventEmitter;
const C = require('./lib/Constants');
const BigBlueButtonGW = require('./lib/bbb-gw');

const bbbGW = new BigBlueButtonGW();

const socketStatus = {};
const userChannels = {};

const REDIS_CHANNEL = config.get('redis.publishChannel')

bbbGW.addSubscribeChannel(REDIS_CHANNEL);
bbbGW.on('MeetingCreatedEvtMsg', (header, payload) => {
  setVoiceToMeeting(payload.props.voiceProp.voiceConf, payload.props.meetingProp.intId);
});

bbbGW.on('UserSpeechLocaleChangedEvtMsg', (header, payload) => {
  const { meetingId, userId } = header;
  const { provider, locale } = payload;

  Logger.info("Speech changed " + userId + ' ' + provider + ' ' + locale);

  setProvider(userId, provider, () => {
    setUserLocale(userId, locale, () => {

      let channelId = userChannels[userId];
      if (channelId && socketStatus[channelId]) {
        stopAudioFork(channelId);
        setTimeout(() => {
          startAudioFork(channelId, userId);
        }, 1000);
      }
    });
  });
});

bbbGW.on('UserSpeechOptionsChangedEvtMsg', (header, payload) => {
  const { meetingId, userId } = header;
  const { partialUtterances, minUtteranceLength } = payload;

  Logger.info("User speech options changed " + ' ' + meetingId + ' ' + userId + ' ' + partialUtterances + ' ' + minUtteranceLength);

  setUserPartialUtterance(userId, partialUtterances, () => {
    setUserMinUtteranceLength(userId, minUtteranceLength, () => {

      let channelId = userChannels[userId];
      if (channelId && socketStatus[channelId]) {
        stopAudioFork(channelId);
        setTimeout(() => {
          startAudioFork(channelId, userId);
        }, 1000);
      }

    });
  });
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

const REDIS_USER_PARTIAL_UTTERANCE_KEY = 'bbb-transcription-manager_partial_utterance';
const getUserPartialUtterance = (userId, cb) => {
  bbbGW.getKey(REDIS_USER_PARTIAL_UTTERANCE_KEY + '_' + userId, cb);
};

const setUserPartialUtterance = (userId, partialUtterance, cb) => {
  bbbGW.setKey(REDIS_USER_PARTIAL_UTTERANCE_KEY + '_' + userId, partialUtterance, cb);
};

const REDIS_USER_MIN_UTTERANCE_LENGTH_KEY = 'bbb-transcription-manager_min_utterance_length';
const getUserMinUtteranceLength = (userId, cb) => {
  bbbGW.getKey(REDIS_USER_MIN_UTTERANCE_LENGTH_KEY + '_' + userId, cb);
};

const setUserMinUtteranceLength = (userId, minUtteranceLength, cb) => {
  bbbGW.setKey(REDIS_USER_MIN_UTTERANCE_LENGTH_KEY + '_' + userId, minUtteranceLength, cb);
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

const INCLUDE_PARTIAL_RESULTS = config.get("includePartialResults");

const getServerUrl = (userId, cb) => {

  getProvider(userId, (err, provider) => {
    getUserLocale(userId, (err, locale) => {

      if (provider && provider != '' && locale && locale != '') {
        const serverUrl = config.get(provider === 'gladia' ? 'gladia.server' : provider + '.servers.' + locale);

        return cb(serverUrl, provider, locale);
      } else {
        return cb(null);
      }
    });
  });
};

const makeMessage = (meetingId, userId, locale, transcript, result, start = 0, end = 0) => {
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
        transcriptId: userId + '-'+ start,
        start: start.toString(),
        end: end.toString(),
        text: '',
        transcript,
        locale,
        result,
      },
    }
  };
};

const makeErrorMessage = (body, meetingId, userId) => {
  const name = 'TranscriptionProviderErrorMsg';
  return {
    envelope: {
      name,
      routing: {
        meetingId,
        userId,
      },
      timestamp: Date.now(),
    },
    core: {
      header: {
        name,
        meetingId,
        userId,
      },
      body: {
        errorCode: body.errorCode,
        errorMessage: body.errorMessage
      },
    }
  };
}


const startAudioFork = (channelId, userId) => {
  Logger.info(`Start mod_audio_fork connection ${channelId} ${userId}`);

  getServerUrl(userId, (serverUrl, provider, language) => {
    getUserPartialUtterance(userId, (err, partialUtterances) => {
      getUserMinUtteranceLength(userId, (err, minUtteranceLength) => {

        if (!serverUrl) {
          Logger.warn("No provider set, not transcribing");
          return;
        }

        const initialMessage = JSON.parse(config.get(provider + '.startMessage'));

        if (provider === 'vosk') {
          initialMessage.config.sample_rate = SAMPLE_RATE + '000';
        }

        if (provider === 'gladia') {
          initialMessage.sample_rate = parseInt(SAMPLE_RATE + '000')
          initialMessage.language = language.slice(0,2);
          initialMessage.partialUtterances = partialUtterances;
          initialMessage.minUtteranceLength = minUtteranceLength;
        }

        if (!socketStatus[channelId]) {
          eslWrapper._executeCommand(`uuid_audio_fork ${channelId} start ${serverUrl} mono ${SAMPLE_RATE}k ${JSON.stringify(initialMessage)}`);
          socketStatus[channelId] = true;
          userChannels[userId] = channelId;
        }
      });
    });
  });
};

const stopAudioFork = (channelId) => {
  Logger.info(`Stop mod_audio_fork connection ${channelId}`);
  const endMessage = JSON.parse(config.get('vosk.endMessage'));

  if (socketStatus[channelId]) {
    try{
      eslWrapper._executeCommand(`uuid_audio_fork ${channelId} stop ${JSON.stringify(endMessage)}`);
    } catch (e) {
      Logger.error("Socket already closed");
    }
    socketStatus[channelId] = false;
  }
};

eslWrapper.onModAudioForkJSON((msg, channelId, userId) => {

  getVoiceToMeeting(msg.getHeader('variable_conference_name'), (err, meetingId) => {
    getUserLocale(userId, (err, locale) => {

      const body = tryParseJSON(msg.body);
      const transcription = body.text || body.partial;

      if (body.errorCode) {
        Logger.error("Transcription error", body);
        const msg = makeErrorMessage(body, meetingId, userId);
        return bbbGW.publish(JSON.stringify(msg), C.TO_AKKA_APPS_CHAN_2x);
      }

      if (body.partial && !INCLUDE_PARTIAL_RESULTS) {
        Logger.debug('Discard partial utterance', body.partial);
        return;
      }

      if (body.text) {
        Logger.info(`Final text is: ${body.text}`);
      }

      const result = Boolean(body.text);
      const payload = makeMessage(meetingId, userId, body.locale || locale, transcription, result, body.time_begin, body.time_end);

      bbbGW.publish(JSON.stringify(payload), C.TO_AKKA_APPS_CHAN_2x);
    });
  });
});

eslWrapper.onModAudioForkDisconnect((msg, channelId, userId) => {
  Logger.info(`mod_audio_fork connection dropped ${channelId} ${userId}`);
});

const handleChannelAnswer = (channelId, callId, userId) => {
  Logger.info(`FS: Associating channel ${channelId} ${callId} userId: ${userId}`);
  startAudioFork(channelId, userId);
}

const handleChannelHangup = (channelId, callId) => {
  Logger.info(`FS: channel hangup ${channelId} ${callId}`);
  stopAudioFork(channelId);
}

const handleFloorChanged = (roomId, newFloorMemberId) => {
  Logger.info(`FS: floor changed ${roomId} ${newFloorMemberId}`);
}

const handleStartTalking = (channelId, userId) => {
  Logger.info(`FS: Start talking ${channelId} userId: ${userId}`);
}

const handleStopTalking = (channelId, userId) => {
  Logger.info(`FS: Stop Talking ${channelId} userId: ${userId}`);
} 

eslWrapper.on(EslWrapper.EVENTS.CHANNEL_ANSWER, handleChannelAnswer);
eslWrapper.on(EslWrapper.EVENTS.CHANNEL_HANGUP, handleChannelHangup);
eslWrapper.on(EslWrapper.EVENTS.FLOOR_CHANGED, handleFloorChanged);
eslWrapper.on(EslWrapper.EVENTS.START_TALKING, handleStartTalking);
eslWrapper.on(EslWrapper.EVENTS.STOP_TALKING, handleStopTalking);
eslWrapper.on(EslWrapper.EVENTS.MUTED, handleStopTalking);

eslWrapper._connect();

const exitCleanup = () => {
  Logger.info('Closing process, cleaning up.');

  if (GLADIA_PROXY_PROCESS) {
    Logger.info('Killing gladia proxy');
    GLADIA_PROXY_PROCESS.kill('SIGINT');
  }
  setTimeout(() => process.exit(), 1000);
}

process.on('SIGINT', exitCleanup);
process.on('SIGQUIT', exitCleanup);
process.on('SIGTERM', exitCleanup);
