// Store dos feeds de vendor no DO Spaces (API S3-compativel). Landing zone
// IMUTAVEL: cada upload gera uma key nova (timestamp + sha8) — nunca
// sobrescreve, o historico bruto e a evidencia de auditoria.
//
// O client S3 entra por parametro (mesmo padrao do axios injetado em
// lib/trello/trelloClient.js) para os testes rodarem sem rede. Envs iguais as
// do storage de anexos (services/storage/requestAttachmentsStorage.js), com
// bucket proprio opcional: DO_SPACES_FEEDS_BUCKET cai para DO_SPACES_BUCKET.

const fs = require('fs');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

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
				// Spaces usa virtual-hosted style; path style so para MinIO local.
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

	// { body (stream), contentLength } para pipe em resposta HTTP ou gravacao
	// em disco — o bucket continua privado, sem URL publica.
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

	return { isConfigured, bucket: () => bucket, buildKey, putFile, getObjectStream, listObjects };
}

module.exports = { createFeedStore };
