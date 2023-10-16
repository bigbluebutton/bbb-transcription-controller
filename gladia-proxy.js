const http = require('http');
const url = require('url');
const config = require('config');
const WebSocket = require('ws');

const MIN_PARTIAL_DURATION = config.get('gladia.proxy.minPartialDuration');
const LANGUAGE_MANUAL = config.get('gladia.proxy.languageManual');

const { tryParseJSON } = require('./lib/utils');

// Create a new WebSocket connection to the external URL for each client
const externalUrl = config.get('gladia.proxy.address')

const server = http.createServer();
const wss = new WebSocket.Server({ server });

function heartbeat() {
  this.isAlive = true;
}

const fixInitialMessage = (message) => {
  const locales = {'en': 'english', 'es': 'spanish', 'fr': 'french', 'pt': 'portuguese'};
  const obj = tryParseJSON(message);

  // If message has a language field either correct the name or remove it
  if (obj.language) {
    if (LANGUAGE_MANUAL) {
      obj.language = locales[obj.language];
    } else {
      delete obj.language;
    }
  }

  return JSON.stringify(obj);
}

const fixResultMessage = (message) => {
  const obj = tryParseJSON(message);
  const newMsg = {};

  if (obj.event == 'transcript' && !obj.transcription) {
    // skip
  } else {
    console.log('Received message from external server: %s', message);
  }

  if (obj.type) {
    if (obj.type == "partial" && obj.duration >= MIN_PARTIAL_DURATION) {
      newMsg.partial = obj.transcription;
      newMsg.locale = obj.language;
    } else if(obj.type == "final") {
      newMsg.text = obj.transcription;
      newMsg.locale = obj.language;
    } else {
      console.log(`Skipping small partial message: ${JSON.stringify(obj)}`);
      return null;
    }
  } else {
    return null;
  }

  return JSON.stringify(newMsg);
}

wss.on('connection', function connection(ws, req) {
    const location = url.parse(req.url, true);
    const queue = [];

    ws.firstMessage = true;
    ws.on('open', function open(s) {
        console.log('New mod_audio_fork connection');
    });

    ws.on('close', function close() {
        ws.firstMessage = false;
        console.log('mod_audio_fork disconnected');
    });

    ws.on('message', function incoming(message) {
        if (ws.firstMessage) {
            ws.firstMessage = false;
            message = fixInitialMessage(message);
            console.log('received first message: %s', message);
        } else {
            message = JSON.stringify({ "frames": message.toString('base64') });
        }

        // Proxy the message to the external WebSocket server
        if (ws.externalWs.readyState === WebSocket.OPEN) {
            ws.externalWs.send(message);
        } else {
            queue.push(message);
        }
    });

    ws.isAlive = true;
    ws.on('pong', heartbeat);

    ws.externalWs = new WebSocket(externalUrl);

    ws.externalWs.on('open', function() {
      for (m in queue) {
        ws.externalWs.send(queue[m]);
      }
    });

    // Handle messages from the external WebSocket server for the specific client
    ws.externalWs.on('message', function incoming(message) {
        // Process the message from the external WebSocket
        // Reply to the specific client WebSocket
        if (ws.readyState === WebSocket.OPEN) {
          let newMsg = fixResultMessage(message);
          if (newMsg) {
            ws.send(newMsg);
          }
        }
    });
});

server.listen(8777, function listening() {
    console.log('Listening on %d', server.address().port);
});

