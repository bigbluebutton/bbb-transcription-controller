function tryParseJSON(str) {
  try {
    return JSON.parse(str);
  } catch (ex) {
    return {};
  }
}

module.exports = {
  tryParseJSON,
}

