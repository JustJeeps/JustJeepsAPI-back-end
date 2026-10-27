// TLS connect for explicit FTPS (AUTH TLS), shaped like tls.connect so
// fetchIntermediateViaAia can read the leaf certificate of a server that
// starts in plain text. A direct tls.connect only works for implicit FTPS.
//
// The adapter waits for the 220 banner, sends AUTH TLS, upgrades the same
// socket on 234 and exposes the TLS socket through the events and methods the
// AIA reader uses (secureConnect, error, getPeerX509Certificate, destroy).
// Nothing but AUTH TLS is sent, so no credentials leave the process.
//
// netConnect/tlsConnect are injectable so the tests run without network.

const net = require('net');
const tls = require('tls');
const { EventEmitter } = require('events');

const READY_REPLY = /^220 /m;
const AUTH_ACCEPTED_REPLY = /^234 /m;
const REFUSED_REPLY = /^[45]\d\d /m;
const AUTH_TLS_COMMAND = 'AUTH TLS\r\n';

function createExplicitTlsConnect({ netConnect = net.connect, tlsConnect = tls.connect } = {}) {
	return function explicitTlsConnect({ host, port, servername = host, rejectUnauthorized }) {
		const emitter = new EventEmitter();
		const raw = netConnect({ host, port });
		let tlsSocket = null;
		let authSent = false;
		let replies = '';

		const upgrade = () => {
			raw.removeListener('data', onData);
			tlsSocket = tlsConnect({ socket: raw, servername, rejectUnauthorized });
			tlsSocket.once('secureConnect', () => emitter.emit('secureConnect'));
			tlsSocket.once('error', (error) => emitter.emit('error', error));
		};

		function onData(chunk) {
			replies += chunk.toString('latin1');
			if (!authSent && READY_REPLY.test(replies)) {
				authSent = true;
				replies = '';
				raw.write(AUTH_TLS_COMMAND);
				return;
			}
			if (!authSent) return;
			if (AUTH_ACCEPTED_REPLY.test(replies)) return upgrade();
			if (REFUSED_REPLY.test(replies)) emitter.emit('error', new Error(`AUTH TLS refused: ${replies.trim()}`));
		}

		raw.on('data', onData);
		raw.once('error', (error) => emitter.emit('error', error));
		emitter.getPeerX509Certificate = () => tlsSocket?.getPeerX509Certificate();
		emitter.destroy = () => {
			tlsSocket?.destroy();
			raw.destroy();
		};
		return emitter;
	};
}

const explicitTlsConnect = createExplicitTlsConnect();

module.exports = { createExplicitTlsConnect, explicitTlsConnect };
