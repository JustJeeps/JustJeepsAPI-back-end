const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const { createExplicitTlsConnect } = require('../../../lib/feeds/explicitTlsConnect');

// Plain socket stand-in: records what the client writes and lets the test
// play the server's replies.
function makeRawSocket() {
	const raw = new EventEmitter();
	raw.written = [];
	raw.destroyed = false;
	raw.write = (text) => raw.written.push(text);
	raw.destroy = () => {
		raw.destroyed = true;
	};
	return raw;
}

function makeTlsSocket() {
	const socket = new EventEmitter();
	socket.destroyed = false;
	socket.getPeerX509Certificate = () => ({ subject: 'CN=ftp.example.test' });
	socket.destroy = () => {
		socket.destroyed = true;
	};
	return socket;
}

function setup() {
	const raw = makeRawSocket();
	const tlsSocket = makeTlsSocket();
	const calls = { net: [], tls: [] };
	const connect = createExplicitTlsConnect({
		netConnect: (options) => {
			calls.net.push(options);
			return raw;
		},
		tlsConnect: (options) => {
			calls.tls.push(options);
			return tlsSocket;
		},
	});
	const socket = connect({ host: 'ftp.example.test', port: 21, servername: 'ftp.example.test', rejectUnauthorized: false });
	return { raw, tlsSocket, calls, socket };
}

test('sends AUTH TLS after the banner and upgrades the same socket on 234', async () => {
	const { raw, tlsSocket, calls, socket } = setup();
	assert.deepStrictEqual(calls.net, [{ host: 'ftp.example.test', port: 21 }]);

	raw.emit('data', Buffer.from('220-Welcome\r\n220 Ready\r\n'));
	assert.deepStrictEqual(raw.written, ['AUTH TLS\r\n']);

	const connected = new Promise((resolve) => socket.once('secureConnect', resolve));
	raw.emit('data', Buffer.from('234 AUTH TLS OK\r\n'));
	assert.strictEqual(calls.tls.length, 1);
	assert.strictEqual(calls.tls[0].socket, raw);
	assert.strictEqual(calls.tls[0].servername, 'ftp.example.test');
	assert.strictEqual(calls.tls[0].rejectUnauthorized, false);

	tlsSocket.emit('secureConnect');
	await connected;
	assert.deepStrictEqual(socket.getPeerX509Certificate(), { subject: 'CN=ftp.example.test' });
	assert.strictEqual(raw.written.length, 1, 'nothing else, no credentials, goes over the wire');

	socket.destroy();
	assert.ok(tlsSocket.destroyed && raw.destroyed);
});

test('a refused AUTH TLS surfaces as an error', async () => {
	const { raw, socket } = setup();
	const failed = new Promise((resolve) => socket.once('error', resolve));
	raw.emit('data', Buffer.from('220 Ready\r\n'));
	raw.emit('data', Buffer.from('534 Policy requires SSL\r\n'));
	const error = await failed;
	assert.match(error.message, /AUTH TLS refused: 534/);
});

test('socket errors before the upgrade are forwarded', async () => {
	const { raw, socket } = setup();
	const failed = new Promise((resolve) => socket.once('error', resolve));
	raw.emit('error', new Error('ECONNREFUSED'));
	assert.match((await failed).message, /ECONNREFUSED/);
});
