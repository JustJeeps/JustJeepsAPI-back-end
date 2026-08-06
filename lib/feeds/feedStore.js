// Store dos feeds de vendor no DO Spaces (API S3-compativel). Landing zone
// IMUTAVEL: cada upload gera uma key nova (timestamp + sha8) — nunca
// sobrescreve, o historico bruto e a evidencia de auditoria.
//
// O client S3 entra por parametro (mesmo padrao do axios injetado em
// lib/trello/trelloClient.js) para os testes rodarem sem rede. Envs iguais as
// do storage de anexos (services/storage/requestAttachmentsStorage.js), com
// bucket proprio opcional: DO_SPACES_FEEDS_BUCKET cai para DO_SPACES_BUCKET.

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
	AbortMultipartUploadCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Validade curta das URLs assinadas: o navegador usa logo em seguida, e uma URL
// vazada expira antes de virar canal de escrita no bucket.
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

	// --- upload direto do navegador (multipart + URL assinada) ----------------
	// Motivo: hoje o arquivo atravessa a API (disco do container de 1 vCPU/2GB)
	// antes de chegar ao bucket. Assinando as partes, o navegador fala direto
	// com o Spaces: a API so autoriza e cataloga, e uma queda de rede reenvia
	// apenas a parte que faltou em vez do arquivo inteiro.

	async function createMultipartUpload({ key, contentType }) {
		const output = await getClient().send(new CreateMultipartUploadCommand({
			Bucket: bucket,
			Key: key,
			ContentType: contentType || 'application/octet-stream',
			ACL: 'private',
		}));
		return { uploadId: output.UploadId, key };
	}

	// Uma URL por parte: cada assinatura vale para ESTE upload, ESTA key e ESTE
	// numero de parte — nao serve para escrever em qualquer outro objeto.
	async function signUploadPart({ key, uploadId, partNumber }) {
		return getSignedUrl(
			getClient(),
			new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
			{ expiresIn: SIGNED_URL_TTL_SECONDS }
		);
	}

	// Partes conforme o BUCKET as registrou. Evita depender do navegador ler o
	// header ETag de cada PUT — leitura que exige ExposeHeaders no CORS, campo
	// que o painel do Spaces nao oferece.
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

	// Tamanho real do objeto no bucket: e o que o servidor cataloga, nunca o
	// numero que o navegador afirma ter enviado.
	async function headObject(key) {
		const output = await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
		return { sizeBytes: output.ContentLength, contentType: output.ContentType, etag: output.ETag };
	}

	return {
		isConfigured,
		bucket: () => bucket,
		buildKey,
		putFile,
		getObjectStream,
		listObjects,
		createMultipartUpload,
		signUploadPart,
		listParts,
		completeMultipartUpload,
		abortMultipartUpload,
		headObject,
	};
}

module.exports = { createFeedStore };
