const http = require('http');
const url = require('url');
const WebSocket = require('ws');

function tryParseJson(str) {
  try {
    return JSON.parse(str);
  } catch (ex) {
    return {};
  }
}

// Create a new WebSocket connection to the external URL for each client
const externalUrl = 'wss://api.gladia.io/audio/text/audio-transcription';
//const externalUrl = 'wss://lucas.elos.dev/websocket-echo';

const server = http.createServer();
const wss = new WebSocket.Server({ server });

function heartbeat() {
  this.isAlive = true;
}

const fixInitialMessage = (message) => {
  const locales = {'en': 'english', 'es': 'spanish', 'fr': 'french', 'pt': 'portuguese'};
  const obj = tryParseJson(message);

  if (obj.language) {
    obj.language = locales[obj.language];
  }

  return JSON.stringify(obj);
}

const fixResultMessage = (message) => {
  const obj = tryParseJson(message);
  const newMsg = {};

  if (obj.type) {
    if (obj.type == "partial") {
      newMsg.partial = obj.transcription;
    } else {
      newMsg.text = obj.transcription;
    }
  } else {
    console.error(obj);
    return message;
  }

  return JSON.stringify(newMsg);
}

wss.on('connection', function connection(ws, req) {
    const location = url.parse(req.url, true);
    const queue = [];

    ws.firstMessage = true;
    ws.on('open', function open(s) {
        console.log('connected');
    });

    ws.on('close', function close() {
        ws.firstMessage = false;
        console.log('disconnected');
    });

    let lastTime = Date.now()
    ws.on('message', function incoming(message) {
        console.log(Date.now() - lastTime + 'ms', message.length);
        lastTime = Date.now()
        if (ws.firstMessage) {
            ws.firstMessage = false;
            console.log('received: %s', message);
            message = fixInitialMessage(message);
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
      console.log("Finally open");
      for (m in queue) {
        ws.externalWs.send(queue[m]);
      }
    });

    // Handle messages from the external WebSocket server for the specific client
    ws.externalWs.on('message', function incoming(message) {
        // Process the message from the external WebSocket
        console.log('Received message from external server: %s', message);

        // Reply to the specific client WebSocket
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(fixResultMessage(message));
        }
    });
});

server.listen(8777, function listening() {
    console.log('Listening on %d', server.address().port);
});

