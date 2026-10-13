const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { X509Certificate } = require('crypto');

const {
	isMissingIntermediateError,
	fetchIntermediateViaAia,
	caIssuersUrls,
} = require('../../../lib/feeds/aiaIntermediate');

// Public certificates captured from ftp.ekeystone.com on 2026-10-13: the leaf
// Keystone installed on 2026-10-10 and the intermediate its AIA URL serves.
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const LEAF = new X509Certificate(fixture('keystone-leaf-2026.pem'));
const R36_DER = fixture('sectigo-ov-r36.der');
const R36_URL = 'http://crt.sectigo.com/SectigoPublicServerAuthenticationCAOVR36.crt';
const IN_DATE = Date.parse('2026-10-13T12:00:00Z');

// Fake TLS socket: hands out the leaf on the handshake and records what the
// probe did with it.
function fakeTls(cert = LEAF) {
	const sockets = [];
	const tlsConnect = (options) => {
		const socket = new EventEmitter();
		socket.options = options;
		socket.destroyed = false;
		socket.writes = [];
		socket.write = (data) => socket.writes.push(data);
		socket.destroy = () => {
			socket.destroyed = true;
		};
		socket.getPeerX509Certificate = () => cert;
		sockets.push(socket);
		process.nextTick(() => socket.emit('secureConnect'));
		return socket;
	};
	return { sockets, tlsConnect };
}

const serve = (map) => async (url) => {
	if (!(url in map)) throw new Error('HTTP 404');
	return map[url];
};

test('recognizes the missing intermediate errors, including the basic-ftp suffix', () => {
	assert.ok(isMissingIntermediateError(new Error('unable to verify the first certificate (control socket)')));
	assert.ok(isMissingIntermediateError({ code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', message: 'x' }));
	assert.ok(!isMissingIntermediateError(new Error('certificate has expired (control socket)')));
	assert.ok(!isMissingIntermediateError(new Error('426 Connection closed; aborted transfer')));
	assert.ok(!isMissingIntermediateError(null));
});

test('reads the CA Issuers URL from the leaf', () => {
	assert.deepStrictEqual(caIssuersUrls(LEAF), [R36_URL]);
});

test('fetches the intermediate that signed the leaf, probing without verification and without sending anything', async () => {
	const tls = fakeTls();
	const found = await fetchIntermediateViaAia({
		host: 'ftp.ekeystone.com',
		port: 990,
		tlsConnect: tls.tlsConnect,
		fetchUrl: serve({ [R36_URL]: R36_DER }),
		now: () => IN_DATE,
	});

	assert.strictEqual(found.subject, 'Sectigo Public Server Authentication CA OV R36');
	assert.strictEqual(found.leafIssuer, 'Sectigo Public Server Authentication CA OV R36');
	assert.match(found.pem, /BEGIN CERTIFICATE/);
	assert.match(found.fingerprint, /^[0-9a-f]{64}$/);

	const [socket] = tls.sockets;
	assert.strictEqual(socket.options.rejectUnauthorized, false);
	assert.strictEqual(socket.options.servername, 'ftp.ekeystone.com');
	assert.deepStrictEqual(socket.writes, [], 'nothing is written on the probe socket');
	assert.ok(socket.destroyed, 'the probe socket is closed');
});

test('accepts a PEM answer as well as DER', async () => {
	const found = await fetchIntermediateViaAia({
		host: 'h',
		port: 990,
		tlsConnect: fakeTls().tlsConnect,
		fetchUrl: serve({ [R36_URL]: fixture('sectigo-ov-r36.pem') }),
		now: () => IN_DATE,
	});
	assert.strictEqual(found.subject, 'Sectigo Public Server Authentication CA OV R36');
});

test('rejects a certificate that did not issue the leaf', async () => {
	// A real public root: a CA, in date, but not the leaf's issuer.
	const otherCa = Buffer.from(require('tls').rootCertificates[0]);
	await assert.rejects(
		fetchIntermediateViaAia({
			host: 'h',
			port: 990,
			tlsConnect: fakeTls().tlsConnect,
			fetchUrl: serve({ [R36_URL]: otherCa }),
			now: () => IN_DATE,
		}),
		/Sectigo Public Server Authentication CA OV R36.*(not the leaf issuer|self-signed)/
	);
});

test('rejects an intermediate that is not signed by a system root', async () => {
	await assert.rejects(
		fetchIntermediateViaAia({
			host: 'h',
			port: 990,
			tlsConnect: fakeTls().tlsConnect,
			fetchUrl: serve({ [R36_URL]: R36_DER }),
			now: () => IN_DATE,
			roots: () => [],
		}),
		/is not a system root/
	);
});

test('rejects an expired intermediate', async () => {
	await assert.rejects(
		fetchIntermediateViaAia({
			host: 'h',
			port: 990,
			tlsConnect: fakeTls().tlsConnect,
			fetchUrl: serve({ [R36_URL]: R36_DER }),
			now: () => Date.parse('2040-01-01T00:00:00Z'),
		}),
		/expired/
	);
});

test('a leaf with no CA Issuers URL fails naming its issuer', async () => {
	const noAia = { issuer: 'C=US\nO=Example\nCN=Some New CA', infoAccess: undefined };
	await assert.rejects(
		fetchIntermediateViaAia({ host: 'h', port: 990, tlsConnect: fakeTls(noAia).tlsConnect, fetchUrl: serve({}) }),
		(error) => error.leafIssuer === 'Some New CA' && /no CA Issuers URL/.test(error.message)
	);
});

test('a download failure is reported with the URL', async () => {
	await assert.rejects(
		fetchIntermediateViaAia({ host: 'h', port: 990, tlsConnect: fakeTls().tlsConnect, fetchUrl: serve({}) }),
		new RegExp(`${R36_URL.replace(/[.]/g, '\\.')}: HTTP 404`)
	);
});
