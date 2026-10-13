// Finds the intermediate CA a TLS server forgot to send, through the AIA
// ("Authority Information Access") URL written inside its own certificate.
//
// The Keystone FTPS server sends only the leaf. On 2026-10-10 the old leaf
// expired and the new one (2026-09-08 .. 2027-03-25) came from a different CA
// (Sectigo Public Server Authentication CA OV R36 instead of GeoTrust TLS RSA
// CA G1), so the pinned intermediate stopped matching and the fetch failed for
// days with "unable to verify the first certificate". Browsers solve this by
// following the AIA URL; this does the same, once, when the chain breaks.
//
// The peer certificate is read on a socket with verification off, closed right
// after the handshake (implicit FTPS: nothing of FTP has been said yet, so no
// credentials leave the process). Whatever comes back goes into the `ca` list,
// and a certificate in that list is trusted, so a man in the middle of this
// probe could offer a CA of their own. That is why the candidate must be
// signed DIRECTLY by one of the system roots (and not be self-signed): the only
// thing this can add is a public intermediate the system already trusts
// through its root. The real FTP session then validates the whole chain,
// hostname included, exactly as before.
//
// tlsConnect/fetchUrl/roots are injectable so the tests run without network.

const tls = require('tls');
const { X509Certificate } = require('crypto');

const MAX_CERT_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;

// Node's codes for "the chain stops before a trusted root". basic-ftp rewraps
// the error with a suffix like "(control socket)", so the message is checked
// as well.
const MISSING_ISSUER_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
const MISSING_ISSUER_MESSAGE = /unable to verify the first certificate|unable to get local issuer certificate/i;

function isMissingIntermediateError(error) {
	if (!error) return false;
	return MISSING_ISSUER_CODES.has(error.code) || MISSING_ISSUER_MESSAGE.test(String(error.message || ''));
}

function commonName(distinguishedName) {
	const match = /(?:^|\n)CN=([^\n]+)/.exec(String(distinguishedName || ''));
	return match ? match[1] : String(distinguishedName || '').replace(/\n/g, ', ');
}

function caIssuersUrls(leaf) {
	const info = String(leaf.infoAccess || '');
	return [...info.matchAll(/CA Issuers - URI:(\S+)/g)]
		.map((match) => match[1])
		.filter((url) => /^https?:\/\//i.test(url));
}

// AIA files are usually DER (.crt), sometimes PEM. PKCS#7 bundles (.p7c) are
// not parsed: X509Certificate throws and the caller reports it.
function parseCertificate(buffer) {
	const text = buffer.toString('latin1');
	return new X509Certificate(text.includes('BEGIN CERTIFICATE') ? text : buffer);
}

function readPeerLeaf({ host, port, servername = host, tlsConnect = tls.connect, timeoutMs = DEFAULT_TIMEOUT_MS }) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const socket = tlsConnect({ host, port, servername, rejectUnauthorized: false });
		const done = (error, cert) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(cert);
		};
		const timer = setTimeout(() => done(new Error(`TLS handshake with ${host}:${port} timed out`)), timeoutMs);
		timer.unref?.();
		socket.once('secureConnect', () => {
			const cert = socket.getPeerX509Certificate();
			if (cert) done(null, cert);
			else done(new Error(`${host}:${port} presented no certificate`));
		});
		socket.once('error', (error) => done(error));
	});
}

async function defaultFetchUrl(url, { timeoutMs }) {
	const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const buffer = Buffer.from(await response.arrayBuffer());
	if (buffer.length > MAX_CERT_BYTES) throw new Error(`response of ${buffer.length} bytes is too large for a certificate`);
	return buffer;
}

const systemRoots = () => tls.rootCertificates.map((pem) => new X509Certificate(pem));

function signedByRoot(candidate, roots) {
	return roots.some((root) => candidate.checkIssued(root) && candidate.verify(root.publicKey));
}

// The candidate must be the one that signed the leaf, a CA, in date, and
// issued by a system root. Anything else is rejected.
function checkIssuer(leaf, candidate, nowMs, roots) {
	if (!candidate.ca) return 'it is not a CA certificate';
	if (candidate.checkIssued(candidate)) return 'it is self-signed, only system roots may be roots';
	if (!leaf.checkIssued(candidate)) return `it is "${commonName(candidate.subject)}", not the leaf issuer`;
	if (!leaf.verify(candidate.publicKey)) return 'its key did not sign the leaf';
	if (Date.parse(candidate.validTo) <= nowMs) return `it expired on ${candidate.validTo}`;
	if (Date.parse(candidate.validFrom) > nowMs) return `it is only valid from ${candidate.validFrom}`;
	if (!signedByRoot(candidate, roots)) return `its issuer "${commonName(candidate.issuer)}" is not a system root`;
	return null;
}

// Returns { pem, subject, fingerprint, leafIssuer }. Throws with the leaf
// issuer in the message, so the failure e-mail names the CA that changed.
async function fetchIntermediateViaAia({
	host,
	port,
	servername = host,
	tlsConnect = tls.connect,
	fetchUrl = defaultFetchUrl,
	now = () => Date.now(),
	roots = systemRoots,
	timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
	const leaf = await readPeerLeaf({ host, port, servername, tlsConnect, timeoutMs });
	const leafIssuer = commonName(leaf.issuer);
	const fail = (reason) => {
		const error = new Error(`could not fetch the intermediate "${leafIssuer}" for ${host}: ${reason}`);
		error.leafIssuer = leafIssuer;
		return error;
	};

	const urls = caIssuersUrls(leaf);
	if (urls.length === 0) throw fail('the certificate has no CA Issuers URL');

	const problems = [];
	for (const url of urls) {
		try {
			const candidate = parseCertificate(await fetchUrl(url, { timeoutMs }));
			const problem = checkIssuer(leaf, candidate, now(), roots());
			if (problem) {
				problems.push(`${url}: ${problem}`);
				continue;
			}
			return {
				pem: candidate.toString(),
				subject: commonName(candidate.subject),
				fingerprint: candidate.fingerprint256.replace(/:/g, '').toLowerCase(),
				leafIssuer,
			};
		} catch (error) {
			problems.push(`${url}: ${error.message}`);
		}
	}
	throw fail(problems.join('; '));
}

module.exports = {
	isMissingIntermediateError,
	fetchIntermediateViaAia,
	caIssuersUrls,
	checkIssuer,
	commonName,
};
