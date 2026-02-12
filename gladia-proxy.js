const http = require('http');
const url = require('url');
const config = require('config');
const WebSocket = require('ws');

const API_URL = config.get('gladia.apiUrl');
const API_KEY = config.get('gladia.key');
const MIN_CONFIDENCE = config.get('gladia.minConfidence');
const BIT_DEPTH = config.get('gladia.bitDepth');
const MODEL_TYPE = config.get('gladia.modelType');
const ENDPOINTING = config.get('gladia.endpointing');
const MAX_BEFORE_ENDPOINTING = config.get('gladia.maxBeforeEndpointing');
const TRANSLATION_ENABLED = config.get('gladia.translation.enabled');
const TRANSLATION_LANGUAGES = config.get('gladia.translation.languages');
const TRANSLATION_MIN_CONFIDENCE = config.get('gladia.translation.minConfidence');

const { tryParseJSON, getLanguageName } = require('./lib/utils');

const server = http.createServer();
const wss = new WebSocket.Server({ server });

function wrapChunk(buf) {
  return JSON.stringify({
    type: 'audio_chunk',
    data: { chunk: buf.toString('base64') },
  });
}

const fixInitialMessage = (message, ws) => {
  const obj = tryParseJSON(message);

  ws.partialUtterances = obj.partialUtterances == "true" ? true : false;
  ws.minUtteranceLength = parseInt(obj.minUtteranceLength);
  ws.sampleRate = parseInt(obj.sample_rate);

  // If message has a language field either correct the name or remove it
  if (obj.language == 'auto') {
    delete obj.language;
  }

  return JSON.stringify(obj);
}

const fixResultMessage = (message, partialUtterances, minUtteranceLength, openTime) => {
  const obj = tryParseJSON(message);
  const newMsg = {};

  if (obj?.type == "transcript") {
    if (obj?.data?.utterance && obj.data.utterance.confidence < MIN_CONFIDENCE) {
      console.log("Skipped transcription because of low confidence", obj.data.utterance.confidence, "<", MIN_CONFIDENCE);
      return
    }

    const { data } = obj;
    newMsg.time_begin = Math.floor(openTime + obj.data.utterance.start);
    newMsg.time_end = Math.floor(openTime + obj.data.utterance.end);
    const duration = newMsg.time_end - newMsg.time_begin;
    if (data.is_final !== true && partialUtterances && duration > minUtteranceLength) {
      newMsg.partial = data.utterance.text;
      newMsg.locale = data.utterance.language;
    } else if (data.is_final === true) {
      newMsg.text = data.utterance.text;
      newMsg.locale = data.utterance.language;
    } else {
      console.log(`Skipping small partial message: ${JSON.stringify(obj)}`);
      return null;
    }
  } else if (obj?.type == "translation") {
    const { data } = obj;
    if (obj?.data?.utterance && obj.data.utterance.confidence < TRANSLATION_MIN_CONFIDENCE) {
      console.log("Skipped translation because of low confidence", obj.data.utterance.confidence, "<", MIN_CONFIDENCE);
      return
    }
    newMsg.time_begin = Math.floor(openTime + obj.data.translated_utterance.start);
    newMsg.time_end = Math.floor(openTime + obj.data.translated_utterance.end);
    newMsg.text = data.translated_utterance.text;
    newMsg.locale = data.translated_utterance.language;
  } else {
    console.log("Message not matched", obj?.type);
    return null;
  }

  return JSON.stringify(newMsg);
}

wss.on('connection', async (ws, req) => {
  const queue = [];

  ws.firstMessage = true;
  ws.openTime = new Date().getTime() / 1000;

  ws.lastMessage = null;
  console.log('New mod_audio_fork connection');

  ws.on('close', function close(code) {
    ws.firstMessage = true;
    console.log('mod_audio_fork disconnected');
    console.log('last message', code, JSON.stringify(ws.lastMessage));

    // Close proxy socket to gladia
    if (code == 1000) {
      ws?.externalWs?.close(1000);
      ws.externalWs = null;
    }
  });

  ws.on('message', async function incoming(message) {
    ws.lastMessage = tryParseJSON(message);
    if (ws.firstMessage) {
      ws.firstMessage = false;

      message = fixInitialMessage(message, ws);
      parsedMessage = tryParseJSON(message);

      console.log('received first message: %s', parsedMessage);
      ws.externalWs = await connectExternal(parsedMessage.language, queue, ws);
      return;
    }

    // Proxy the message to the external WebSocket server
    if (ws.externalWs?.readyState === WebSocket.OPEN) {
      ws.externalWs.send(wrapChunk(message));
    } else {
      queue.push(message);
    }
  });

});

const getApiEndpoint = async (language, sampleRate, partialUtterances) => {
  // Get TRANSLATION_LANGUAGES from config but remove the one
  // for this connection, it will be transcribed and not translated
  let translationLanguages = TRANSLATION_LANGUAGES.slice(0);
  let language_config = undefined;
  if (language) {
    translationLanguages.splice(TRANSLATION_LANGUAGES.indexOf(language), 1);
    language_config = {
      "languages": [language],
      "code_switching": false,
    };
  }

  console.log(language, sampleRate, partialUtterances);
  const options = {
    encoding: "wav/pcm",
    bit_depth: BIT_DEPTH,
    sample_rate: sampleRate,
    channels: 1,
    endpointing: ENDPOINTING,
    maximum_duration_without_endpointing: MAX_BEFORE_ENDPOINTING,
    language_config,
    messages_config: {
      receive_partial_transcripts: partialUtterances,
      receive_final_transcripts: true,
      receive_speech_events: false,
      receive_pre_processing_events: true,
      receive_realtime_processing_events: true,
      receive_post_processing_events: true,
      receive_acknowledgments: false,
      receive_errors: true,
    },
    pre_processing: {
      audio_enhancer: true,
    },
    realtime_processing: {
      translation: TRANSLATION_ENABLED,
      translation_config: {
        target_languages: translationLanguages,
        model: MODEL_TYPE,
        match_original_utterances: true,
        lipsync: true,
        context_adaptation: false,
        context: "",
        informal: false
      },
    },
  };

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Gladia-Key': API_KEY,
    },
    body: JSON.stringify(options),
  });
  if (!response.ok) {
    // Look at the error message
    // It might be a configuration issue
    console.error(`${response.status}: ${(await response.text()) || response.statusText}`);
    process.exit(response.status);
  }
  const { url } = await response.json();
  return url;
}

const connectExternal = async (language, queue, proxyWs) => {
  const url = await getApiEndpoint(language, proxyWs.sampleRate, proxyWs.partialUtterances);
  const ws = new WebSocket(url);

  console.log("connectExternal(",language, ",", typeof queue, ",", typeof proxyWs, ")");

  ws.on('open', function () {
    for (m in queue) {
      ws.send(wrapChunk(queue.shift()));
    }
  });

  // Handle messages from the external WebSocket server for the specific client
  ws.on('message', function incoming(message) {
    // Process the message from the external WebSocket
    // Reply to the specific client WebSocket
    console.log('Received message from external server: %s', message);
    if (proxyWs.readyState === WebSocket.OPEN) {
      let newMsg = fixResultMessage(message, proxyWs.partialUtterances, proxyWs.minUtteranceLength, proxyWs.openTime);

       if (newMsg) {
        proxyWs.send(newMsg);
      }
    }
  });

  ws.on('close', function (code) {
    console.log("gladia has closed the connection", code);

    if (code >= 4000) {
      console.log("Gladia internal error");
      return proxyWs.send(JSON.stringify({ errorCode: code, errorMessage: 'Gladia internal error' }));
    }

    proxyWs.close();

    if (code != 1000) {
      console.log("Restarting with error", code)
    }
  });

  ws.on('error', function (e) {
    console.log("gladia connection error", e);
    proxyWs.externalWs = connectExternal(language, queue, proxyWs);
  });

  proxyWs.externalWs = ws;
  return ws;
}

server.listen(8777, function listening() {
  console.log('Listening on %d', server.address().port);
});

