// file-type is ESM only and jest runs these tests as CommonJS. The retention tests only delete files,
// never sniff one, so a stub that sniffs nothing is enough.
module.exports = { fileTypeFromBuffer: async () => undefined };
