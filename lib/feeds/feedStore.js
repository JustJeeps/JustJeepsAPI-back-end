// Vendor feed store in DO Spaces (S3-compatible API). IMMUTABLE landing zone:
// every upload creates a new key (timestamp + sha8) and never overwrites,
// because the raw history is the audit evidence.
//
// The S3 client comes in as a parameter (same pattern as the axios injected in
// lib/trello/trelloClient.js) so the tests can run without network. Same envs
// as the attachments storage (services/storage/requestAttachmentsStorage.js),
// with an optional dedicated bucket: DO_SPACES_FEEDS_BUCKET falls back to
// DO_SPACES_BUCKET.

const fs = require('fs');
const {
	S3Client,
	PutObjectCommand,
	GetObjectCommand,
	ListObjectsV2Command,
	HeadObjectCommand,
	CreateMultipartUploadCommand,
	UploadPartCommand,
	CompleteMultipartUploadCommand,
	ListPartsCommand,
	DeleteObjectCommand,
	AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Short lifetime for the signed URLs: the browser uses them right away, and a
// leaked URL expires before it can become a write channel into the bucket.
const SIGNED_URL_TTL_SECONDS = Number(process.env.FEED_SIGNED_URL_TTL_SECONDS || 900);

function createFeedStore({ s3 = null, env = process.env } = {}) {
	const endpoint = env.DO_SPACES_ENDPOINT || '';
	const region = env.DO_SPACES_REGION || 'tor1';
	const bucket = env.DO_SPACES_FEEDS_BUCKET || env.DO_SPACES_BUCKET || '';
	const accessKeyId = env.DO_SPACES_KEY || '';
	const secretAccessKey = env.DO_SPACES_SECRET || '';
	const keyPrefix = (env.DO_SPACES_FEEDS_PREFIX || 'feeds').replace(/^\/+|\/+$/g, '');

	let client = s3;

	const isConfigured = () => Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

	const getClient = () => {
		if (!client) {
			client = new S3Client({
				endpoint,
				region,
				credentials: { accessKeyId, secretAccessKey },
				// Spaces uses virtual-hosted style; path style is only for local MinIO.
				forcePathStyle: env.DO_SPACES_FORCE_PATH_STYLE === 'true',
			});
		}
		return client;
	};

	// feeds/{feed}/{YYYY}/{MM}/{YYYYMMDDTHHMMSSZ}-{sha8}-{fileName}
	const buildKey = ({ feed, fileName, sha256, at = new Date() }) => {
		const iso = at.toISOString();
		const stamp = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
		return `${keyPrefix}/${feed}/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${stamp}-${sha256.slice(0, 8)}-${fileName}`;
	};

	async function putFile({ key, filePath, contentType, sizeBytes }) {
		await getClient().send(new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: fs.createReadStream(filePath),
			ContentLength: sizeBytes,
			ContentType: contentType || 'application/octet-stream',
			ACL: 'private',
		}));
	}

	// Same as putFile, but for a body the caller assembles (a byte range of a
	// file plus a header, used by the run log archive). ContentLength is
	// required: S3 cannot infer it from a stream, and without it the SDK buffers
	// the whole body in memory.
	async function putStream({ key, body, contentLength, contentType }) {
		await getClient().send(new PutObjectCommand({
			Bucket: bucket,
			Key: key,
			Body: body,
			ContentLength: contentLength,
			ContentType: contentType || 'application/octet-stream',
			ACL: 'private',
		}));
	}

	// { body (stream), contentLength } to pipe into an HTTP response or write to
	// disk; the bucket stays private, with no public URL.
	async function getObjectStream(key) {
		const output = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
		return { body: output.Body, contentLength: output.ContentLength };
	}

	async function listObjects(prefix) {
		const output = await getClient().send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
		return (output.Contents || []).map((item) => ({
			key: item.Key,
			size: item.Size,
			lastModified: item.LastModified,
		}));
	}

	// --- direct browser upload (multipart + signed URL) -----------------------
	// Reason: today the file crosses the API (disk of the 1 vCPU/2GB container)
	// before reaching the bucket. By signing the parts, the browser talks
	// straight to Spaces: the API only authorizes and catalogs, and a network
	// drop resends just the missing part instead of the whole file.

	async function createMultipartUpload({ key, contentType }) {
		const output = await getClient().send(new CreateMultipartUploadCommand({
			Bucket: bucket,
			Key: key,
			ContentType: contentType || 'application/octet-stream',
			ACL: 'private',
		}));
		return { uploadId: output.UploadId, key };
	}

	// One URL per part: each signature is valid for THIS upload, THIS key and
	// THIS part number, so it cannot be used to write to any other object.
	async function signUploadPart({ key, uploadId, partNumber }) {
		return getSignedUrl(
			getClient(),
			new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
			{ expiresIn: SIGNED_URL_TTL_SECONDS }
		);
	}

	// Parts as the BUCKET recorded them. Avoids depending on the browser reading
	// the ETag header of each PUT, a read that requires ExposeHeaders in CORS, a
	// field the Spaces panel does not offer.
	async function listParts({ key, uploadId }) {
		const output = await getClient().send(new ListPartsCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
		return (output.Parts || [])
			.map((part) => ({ partNumber: part.PartNumber, etag: part.ETag, sizeBytes: part.Size }))
			.sort((a, b) => a.partNumber - b.partNumber);
	}

	async function completeMultipartUpload({ key, uploadId, parts }) {
		await getClient().send(new CompleteMultipartUploadCommand({
			Bucket: bucket,
			Key: key,
			UploadId: uploadId,
			MultipartUpload: { Parts: parts.map((p) => ({ ETag: p.etag, PartNumber: p.partNumber })) },
		}));
	}

	async function abortMultipartUpload({ key, uploadId }) {
		await getClient().send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
	}

	async function deleteObject(key) {
		await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
	}

	// Real object size in the bucket: this is what the server catalogs, never
	// the number the browser claims to have sent.
	async function headObject(key) {
		const output = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		return { sizeBytes: output.ContentLength, contentType: output.ContentType, etag: output.ETag };
	}

	return {
		isConfigured,
		bucket: () => bucket,
		buildKey,
		putFile,
		putStream,
		getObjectStream,
		listObjects,
		createMultipartUpload,
		signUploadPart,
		listParts,
		completeMultipartUpload,
		abortMultipartUpload,
		headObject,
		deleteObject,
	};
}

module.exports = { createFeedStore };
