const iso6391 = require('iso-639-1');

function shortLocaleToLong(shortLocale) {
  // Should map the short locale name to a longer one used by BBB
  // Right now it's hardcoded, but we should store the original locale
  // for each message and translate it back before returing
  return {
    en: 'en-US',
    pt: 'pt-BR',
    de: 'de-DE',
    fr: 'fr-FR',
    es: 'es-ES',
  }[shortLocale];
}

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
  shortLocaleToLong,
}

