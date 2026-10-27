/* eslint-disable no-console */
// Read-only discovery probe for the JRP FTP feed (explicit FTPS + PASV).
// Lists what the server exposes and, with --download, copies the feed files to
// a local directory so we can learn the layout (columns, delimiter, currency,
// brand line codes) before writing the real fetch/apply code.
//
// It never writes to the database or to Spaces, and never changes anything on
// the FTP server. Credentials come only from the env (JRP_FTP_*); they are
// never printed.
//
//   set -a; source .env.production; set +a
//   node scripts/jrp-ftp-probe.js                         # list only
//   node scripts/jrp-ftp-probe.js --download --out <dir>  # list + download

const fs = require('fs');
const net = require('net');
const path = require('path');
const tls = require('tls');
const { EventEmitter } = require('events');
const ftp = require('basic-ftp');
const { isMissingIntermediateError, fetchIntermediateViaAia } = require('../lib/feeds/aiaIntermediate');

const SOCKET_TIMEOUT_MS = 60000;
const MAX_DEPTH = 2;
const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const FEED_EXTENSIONS = /\.(csv|txt|tsv|xlsx?|zip|gz)$/i;

function parseArgs(argv) {
	const args = { download: false, out: null };
	for (let i = 0; i < argv.length; i += 1) {
		if (argv[i] === '--download') args.download = true;
		else if (argv[i] === '--out') args.out = argv[(i += 1)];
	}
	return args;
}

function readConfig(env) {
	const missing = ['JRP_FTP_HOST', 'JRP_FTP_USER', 'JRP_FTP_PASS'].filter((name) => !env[name]);
	if (missing.length) throw new Error(`Missing env: ${missing.join(', ')}`);
	return {
		host: env.JRP_FTP_HOST,
		port: Number(env.JRP_FTP_PORT || 21),
		user: env.JRP_FTP_USER,
		password: env.JRP_FTP_PASS,
	};
}

async function listTree(client, dir, depth, found) {
	const entries = await client.list(dir);
	for (const entry of entries) {
		const fullPath = path.posix.join(dir, entry.name);
		if (entry.isDirectory) {
			console.log(`📁 ${fullPath}/`);
			if (depth < MAX_DEPTH) await listTree(client, fullPath, depth + 1, found);
		} else {
			const when = entry.modifiedAt ? entry.modifiedAt.toISOString() : entry.rawModifiedAt || '?';
			console.log(`📄 ${fullPath}  ${(entry.size / 1024 / 1024).toFixed(2)}MB  ${when}`);
			found.push({ path: fullPath, size: entry.size });
		}
	}
}

// fetchIntermediateViaAia reads the leaf with a direct TLS connect, which only
// works for implicit FTPS. JRP is explicit: the session starts in plain text
// and switches to TLS after AUTH TLS. This adapter does that handshake and
// exposes the TLS socket through the same events the AIA reader listens to.
// No credentials are sent on this connection.
function explicitFtpsTlsConnect({ host, port, servername, rejectUnauthorized }) {
	const emitter = new EventEmitter();
	const raw = net.connect({ host, port });
	let tlsSocket = null;
	let authSent = false;
	let buffer = '';
	const onData = (chunk) => {
		buffer += chunk.toString('latin1');
		if (!authSent && /^220 /m.test(buffer)) {
			authSent = true;
			buffer = '';
			raw.write('AUTH TLS\r\n');
		} else if (authSent && /^234 /m.test(buffer)) {
			raw.removeListener('data', onData);
			tlsSocket = tls.connect({ socket: raw, servername, rejectUnauthorized });
			tlsSocket.once('secureConnect', () => emitter.emit('secureConnect'));
			tlsSocket.once('error', (error) => emitter.emit('error', error));
		} else if (authSent && /^[45]\d\d /m.test(buffer)) {
			emitter.emit('error', new Error(`AUTH TLS refused: ${buffer.trim()}`));
		}
	};
	raw.on('data', onData);
	raw.once('error', (error) => emitter.emit('error', error));
	emitter.getPeerX509Certificate = () => tlsSocket?.getPeerX509Certificate();
	emitter.destroy = () => {
		tlsSocket?.destroy();
		raw.destroy();
	};
	return emitter;
}

async function connect(client, config, ca) {
	await client.access({
		host: config.host,
		port: config.port,
		user: config.user,
		password: config.password,
		secure: true,
		secureOptions: { servername: config.host, ca },
	});
}

function describeCertificate(client) {
	const socket = client.ftp.socket;
	if (!socket || typeof socket.getPeerCertificate !== 'function') return;
	const cert = socket.getPeerCertificate();
	if (!cert || !cert.subject) return;
	console.log(`🔒 TLS ${socket.getProtocol?.() || ''} subject=${cert.subject.CN} issuer=${cert.issuer?.CN} validTo=${cert.valid_to}`);
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.download && !args.out) throw new Error('--download needs --out <dir>');
	const config = readConfig(process.env);

	let client = new ftp.Client(SOCKET_TIMEOUT_MS);
	client.prepareTransfer = ftp.enterPassiveModeIPv4;
	try {
		try {
			await connect(client, config, undefined);
		} catch (error) {
			if (!isMissingIntermediateError(error)) throw error;
			const found = await fetchIntermediateViaAia({
				host: config.host,
				port: config.port,
				tlsConnect: explicitFtpsTlsConnect,
			});
			console.log(`🔐 Server omits its intermediate; fetched "${found.subject}" via AIA (leaf issuer "${found.leafIssuer}")`);
			client.close();
			client = new ftp.Client(SOCKET_TIMEOUT_MS);
			client.prepareTransfer = ftp.enterPassiveModeIPv4;
			await connect(client, config, [...tls.rootCertificates, found.pem]);
		}
		console.log(`✅ Logged in (explicit FTPS, PASV, port ${config.port})`);
		describeCertificate(client);
		console.log(`📍 Working directory: ${await client.pwd()}`);

		const found = [];
		await listTree(client, '', 0, found);
		console.log(`\n${found.length} files listed`);

		if (!args.download) return;
		fs.mkdirSync(args.out, { recursive: true });
		for (const file of found) {
			if (!FEED_EXTENSIONS.test(file.path)) continue;
			if (file.size > MAX_DOWNLOAD_BYTES) {
				console.log(`⏭️  ${file.path} skipped (larger than ${MAX_DOWNLOAD_BYTES} bytes)`);
				continue;
			}
			const localPath = path.join(args.out, file.path.replace(/^\.\//, '').replace(/\//g, '__'));
			await client.downloadTo(localPath, file.path);
			console.log(`⬇️  ${file.path} -> ${localPath} (${fs.statSync(localPath).size} bytes)`);
		}
	} finally {
		client.close();
	}
}

main().catch((error) => {
	console.error(`❌ JRP probe failed: ${error.code ? `${error.code} ` : ''}${error.message}`);
	process.exitCode = 1;
});
