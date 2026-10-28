// CA bundle for FTPS servers that send only their leaf certificate. Node
// cannot build the chain on its own and fails with "unable to verify the
// first certificate". The fix is not to turn verification off: it is to
// supply the missing intermediate, keeping signature and hostname validated.
//
// The intermediate is NOT kept in the repository. Resolution order, with env
// names derived from the vendor's prefix (for example KEYSTONE_FTP):
//   1. <PREFIX>_CA_PEM         PEM content (or base64) straight from the env
//   2. <PREFIX>_CA_FILE        absolute path outside the project
//   3. private object in the Space (<PREFIX>_CA_OBJECT_KEY, or the default the
//      caller passes), downloaded once and kept in the local feed cache
// plus every intermediate fetched through the certificate's AIA URL and kept
// in <cacheDir>/certs/aia/ (lib/feeds/aiaIntermediate.js). Those are public
// intermediates signed by a system root, so vendors can share the folder.

const fs = require('fs');
const path = require('path');

const PEM_MARKER = 'BEGIN CERTIFICATE';

const certsDirFor = (cacheDir) => path.join(cacheDir, 'certs');
const aiaDirFor = (cacheDir) => path.join(certsDirFor(cacheDir), 'aia');

// A missing object is the normal state for a vendor whose intermediate is
// fetched through AIA, not a failure. Spaces answers GetObject on a missing key
// with a 404 the SDK may surface as NoSuchKey, NotFound or a bare UnknownError,
// so the HTTP status is the reliable signal.
function isMissingObject(error) {
	if (!error) return false;
	if (error.name === 'NoSuchKey' || error.name === 'NotFound') return true;
	if (error.Code === 'NoSuchKey' || error.Code === 'NotFound') return true;
	return Boolean(error.$metadata && error.$metadata.httpStatusCode === 404);
}

async function readObject(store, objectKey) {
	const { body } = await store.getObjectStream(objectKey);
	const chunks = [];
	for await (const chunk of body) chunks.push(chunk);
	return Buffer.concat(chunks).toString('utf8');
}

// Looks for the PEM in the env or in the private bucket. Never in the repository.
async function loadConfiguredCa({ env, envPrefix, defaultObjectKey, store, cacheDir, log }) {
	const inline = env[`${envPrefix}_CA_PEM`];
	if (inline) {
		return inline.includes(PEM_MARKER) ? inline : Buffer.from(inline, 'base64').toString('utf8');
	}

	const caFile = env[`${envPrefix}_CA_FILE`];
	if (caFile && fs.existsSync(caFile)) return fs.readFileSync(caFile, 'utf8');

	const objectKey = env[`${envPrefix}_CA_OBJECT_KEY`] || defaultObjectKey;
	const cachePath = path.join(certsDirFor(cacheDir), path.basename(objectKey));
	if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');

	if (!store || !store.isConfigured || !store.isConfigured()) return null;
	try {
		const pem = await readObject(store, objectKey);
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		fs.writeFileSync(cachePath, pem);
		return pem;
	} catch (error) {
		if (isMissingObject(error)) {
			log.log(`ℹ️ No pinned CA at ${objectKey} in the bucket`);
			return null;
		}
		log.warn(`⚠️ Could not read ${objectKey} from the bucket: ${error.message}`);
		return null;
	}
}

function loadAiaCas(cacheDir) {
	const dir = aiaDirFor(cacheDir);
	if (!fs.existsSync(dir)) return [];
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.pem'))
		.sort()
		.map((name) => fs.readFileSync(path.join(dir, name), 'utf8'));
}

function saveAiaCa(cacheDir, { fingerprint, pem }) {
	const dir = aiaDirFor(cacheDir);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, `${fingerprint}.pem`), pem);
}

module.exports = { isMissingObject, loadConfiguredCa, loadAiaCas, saveAiaCa };
