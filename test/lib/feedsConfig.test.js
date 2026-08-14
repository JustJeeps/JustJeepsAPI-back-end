const test = require('node:test');
const assert = require('node:assert');

const feedsConfig = require('../../config/feeds.js');

// O upload assinado (multipart direto ao bucket) existe justamente para
// arquivos que NAO cabem no caminho via API (disco do container). O teto do
// painel (uploadPanelMaxBytes, 100MB) protege so o caminho legado via multer —
// ele nao pode clampar o limite proprio do feed, senao o Keystone (600MB) e a
// WheelPros (~500MB por CSV) ficam presos nos 100MB (incidente de 2026-08-14).

const MB = 1024 * 1024;

const byName = (name) => feedsConfig.getFeedDefinitions().find((feed) => feed.name === name);

test('keystone mantem o limite proprio de 600MB no caminho assinado', () => {
	assert.strictEqual(byName('keystone-ftp').maxUploadBytes, 600 * MB);
});

test('wheelpros-inventory declara limite proprio para os CSVs de ~500MB', () => {
	assert.ok(byName('wheelpros-inventory').maxUploadBytes >= 600 * MB);
});

test('feed sem limite proprio continua no default de 100MB', () => {
	assert.strictEqual(byName('keyparts').maxUploadBytes, 100 * MB);
});

test('o teto do painel (caminho legado via API) continua exportado e em 100MB por default', () => {
	assert.strictEqual(feedsConfig.config.uploadPanelMaxBytes, 100 * MB);
});
