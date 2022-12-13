/**
 * @classdesc
 * BigBlueButton redis gateway for bbb-screenshare node app
 */

'use strict';

/* Modules */

const C = require('./Constants.js');
const RedisWrapper = require('./RedisWrapper.js');
const config = require('config');
const EventEmitter = require('events').EventEmitter;

let instance = null;

module.exports = class BigBlueButtonGW extends EventEmitter {
  constructor() {
    if(!instance){
      super();
      this.subscribers = {};
      this.publisher = null;
      this._listeners = {};
      instance = this;
    }

    return instance;
  }

  checkPublisher() {
    if (!this.publisher) {
      this.publisher = new RedisWrapper();
      this.publisher.startPublisher();
    }
  }

  addSubscribeChannel (channel) {
    if (this.subscribers[channel]) {
      return this.subscribers[channel];
    }

    let wrobj = new RedisWrapper(channel);
    this.subscribers[channel] = {};
    this.subscribers[channel] = wrobj;
    try {
      wrobj.startSubscriber();
      wrobj.on(C.REDIS_MESSAGE, this.incomingMessage.bind(this));
      return Promise.resolve(wrobj);
    } catch (error) {
      // Logger.error("Redis channel subscribe failed", { channel, errorMessage: error.message });
      return Promise.reject(error);
    }
  }

  on(messageName, f) {
    this._listeners[messageName] = f;
  }

  deserialize (message) {
    if (typeof message === 'object') return message;

    try {
      const dmsg = JSON.parse(message);
      return dmsg;
    } catch (error) {
      // Logger.error("Failed to deserialize message, use it raw", { errorMessage: error.message });
      return message;
    }
  }

  /**
   * Capture messages from subscribed channels and emit an event with it's
   * identifier and payload. Check Constants.js for the identifiers.
   *
   * @param {Object} message  Redis message
   */
  incomingMessage (message) {
    let meetingId;
    let header;
    let payload;

    const msg = this.deserialize(message);
    // Trying to parse both message types, 1x and 2x
    if (msg.header) {
      header = msg.header;
      payload = msg.payload;
    } else if (msg.core) {
      header = msg.core.header;
      payload = msg.core.body;
    }

    if (header) {
      switch (header.name) {
        case "MeetingCreatedEvtMsg":

          if (this._listeners["MeetingCreatedEvtMsg"]) {
            this._listeners["MeetingCreatedEvtMsg"](header, payload);
          }
          break;

        default:
          this.emit(header.name, { header, body: payload, });
      }
    } else {
      this.emit(C.GATEWAY_MESSAGE, msg);
    }
  }

  publish (message, channel) {
    this.checkPublisher();

    if (typeof this.publisher.publishToChannel === 'function') {
      this.publisher.publishToChannel(message, channel);
    }
  }

  setKey(key, message, callback) {
    this.checkPublisher();
    this.publisher.setKey(key, message, callback);
  }

  getKey(key, callback) {
    this.checkPublisher();
    this.publisher.getKey(key, callback);
  }

  writeMeetingKey(meetingId, message) {
    const EXPIRE_TIME = config.get('redisExpireTime');
    this.checkPublisher();

    let recKey = 'recording:' + meetingId;

    this.publisher.setKeyWithIncrement(recKey, message, (err, msgId) => {
      this.publisher.pushToList('meeting:' + meetingId + ':recordings', msgId);
      this.publisher.expireKey(recKey + ':' + msgId, EXPIRE_TIME, (error) => {
        if (error) {
          return null;
          // return Logger.error('Recording key Redis write failed', {
          //   errorMessage: error.message,
          //   meetingId,
          // });
        }

        // Logger.debug('Recording key written in redis', {
        //   messageId: msgId,
        //   key: recKey,
        //   expireTime: EXPIRE_TIME,
        // });
      });
    });
  }

  async isChannelAvailable (channel) {
    const channels = await this.publisher.getChannels();
    return channels.includes(channel);
  }

  getChannels () {
    return this.publisher.getChannels();
  }

  setEventEmitter (emitter) {
    this.emitter = emitter;
  }
}
