const iso6391 = require('iso-639-1');

function getLanguageName(languageCode) {
  try {
    return iso6391.getName(languageCode).toLowerCase() || 'unknown';
  } catch (error) {
    return 'unknown';
  }
}

function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (ex) {
    return {};
  }
}

module.exports = {
  tryParseJSON,
  getLanguageName,
}

