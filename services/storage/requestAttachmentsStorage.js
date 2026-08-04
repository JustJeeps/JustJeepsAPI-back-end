// Armazenamento dos anexos de Requests no DigitalOcean Spaces (API
// S3-compativel). Sem credenciais configuradas o modulo fica "desligado" e o
// endpoint de upload responde 409 ATTACHMENTS_DISABLED — assim o deploy nao
// depende das envs novas existirem.
//
// Envs esperadas (adicionar em .env.production e config/deploy.yml):
//   DO_SPACES_ENDPOINT  ex.: https://tor1.digitaloceanspaces.com
//   DO_SPACES_REGION    ex.: tor1
//   DO_SPACES_BUCKET    nome do bucket
//   DO_SPACES_KEY / DO_SPACES_SECRET
//   DO_SPACES_REQUEST_ATTACHMENTS_PREFIX (opcional, default request-attachments)

const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const endpoint = process.env.DO_SPACES_ENDPOINT || '';
const region = process.env.DO_SPACES_REGION || 'tor1';
const bucket = process.env.DO_SPACES_BUCKET || '';
const accessKeyId = process.env.DO_SPACES_KEY || '';
const secretAccessKey = process.env.DO_SPACES_SECRET || '';
const keyPrefix = (process.env.DO_SPACES_REQUEST_ATTACHMENTS_PREFIX || 'request-attachments')
	.replace(/^\/+|\/+$/g, '');

let client = null;

const isConfigured = () => Boolean(endpoint && bucket && accessKeyId && secretAccessKey);

const getClient = () => {
	if (!client) {
		client = new S3Client({
			endpoint,
			region,
			credentials: { accessKeyId, secretAccessKey },
			// Spaces usa virtual-hosted style (bucket no host), igual a S3.
			// Path style so para teste local com MinIO (DO_SPACES_FORCE_PATH_STYLE=true).
			forcePathStyle: process.env.DO_SPACES_FORCE_PATH_STYLE === 'true',
		});
	}
	return client;
};

const objectKey = (requestId, storedName) => `${keyPrefix}/${requestId}/${storedName}`;

async function putAttachment({ requestId, storedName, body, contentType }) {
	await getClient().send(new PutObjectCommand({
		Bucket: bucket,
		Key: objectKey(requestId, storedName),
		Body: body,
		ContentType: contentType || 'application/octet-stream',
		ACL: 'private',
	}));
}

// Retorna { body (stream), contentLength } para o endpoint de download
// autenticado fazer pipe — o bucket continua privado, sem URL publica.
async function getAttachmentStream({ requestId, storedName }) {
	const output = await getClient().send(new GetObjectCommand({
		Bucket: bucket,
		Key: objectKey(requestId, storedName),
	}));
	return { body: output.Body, contentLength: output.ContentLength };
}

async function deleteAttachment({ requestId, storedName }) {
	await getClient().send(new DeleteObjectCommand({
		Bucket: bucket,
		Key: objectKey(requestId, storedName),
	}));
}

module.exports = {
	isConfigured,
	putAttachment,
	getAttachmentStream,
	deleteAttachment,
};
