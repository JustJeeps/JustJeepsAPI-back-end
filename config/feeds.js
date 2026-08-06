// Registro central dos feeds de vendor armazenados no DO Spaces (landing
// zone). Cada feed lista os arquivos CANONICOS que os seeds esperam — o
// materializer entrega exatamente esses nomes num diretorio de cache local.
//
// IMPORTANTE: este modulo precisa continuar "puro" — apenas process.env e
// dados literais (mesma regra do config/cron-jobs.js), para que possa ser
// carregado por testes e scripts de validacao sem subir o servidor.
//
// staleAfterHours: idade do lote a partir da qual o feed aparece como stale
// (warning no digest/painel; ingest so falha com requireFresh). Feeds de drop
// manual mudam quando o vendor manda planilha nova — thresholds generosos.
// Override por env: FEED_STALE_HOURS_<NOME_UPPER_SNAKE> (ex.
// FEED_STALE_HOURS_KEYSTONE_FTP=48).
//
// maxUploadBytes limita o upload via painel/API (arquivos maiores — caso
// SpecialOrder.csv — chegam por fetch FTP ou CLI, nunca pelo painel).
//
// legacyDir: subdiretorio de prisma/seeds/api-calls onde o feed-sync cria o
// symlink com o nome canonico — os seeds continuam lendo o caminho de sempre
// e o arquivo por tras vem do bucket ('' = raiz de api-calls).
//
// seedCommand: npm script que consome o feed, disparavel pelo botao "Run now"
// do painel (POST /api/ingest/feeds/:feed/run) para conferir o arquivo recem
// subido sem esperar o seed-all. null = sem botao; usar seedCommandNote para
// explicar por que (ex.: script que escreve preco na loja ao vivo, que so deve
// rodar pelo fluxo controlado do seed-all).

const DAY_HOURS = 24;

const FEED_DEFINITIONS = [
	{
		name: 'keystone-ftp',
		label: 'Keystone (FTP)',
		files: ['Inventory.csv', 'SpecialOrder.csv'],
		seedCommand: 'seed-keystone-ftp2',
		legacyDir: 'keystone_files',
		staleAfterHours: 36, // fetch roda 2x/dia; 36h = perdeu 2 fetches
		fetch: 'ftp',
		maxUploadBytes: 600 * 1024 * 1024, // so via CLI na pratica (painel corta em uploadPanelMaxBytes)
	},
	{
		name: 'quadratec-wholesale',
		label: 'Quadratec wholesale (CSV)',
		files: ['quadratec_wholesale.csv'],
		seedCommand: 'seed-quad-inventory',
		workbookBaseName: 'quadratec_wholesale',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'quadratec-pricing',
		label: 'Quadratec pricing sheet (XLSX)',
		files: ['pricingSheet_quad.xlsx'],
		seedCommand: 'seed-quadratec',
		staleAfterHours: 60 * DAY_HOURS,
	},
	{
		name: 'ctp',
		label: 'CTP inventory (CSV)',
		files: ['CTPENT_Inventory.csv'],
		seedCommand: 'seed-ctp',
		workbookBaseName: 'CTPENT_Inventory',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'keyparts',
		label: 'KeyParts price file (XLSX)',
		files: ['KeyParts-price-file.xlsx'],
		seedCommand: 'seed-keyparts',
		staleAfterHours: 90 * DAY_HOURS,
	},
	{
		name: 'warn-map',
		label: 'WARN MAP prices (XLSX)',
		files: ['WARN-MAP.xlsx'],
		seedCommand: null,
		seedCommandNote: 'Updates prices on the live store, so it only runs in the daily sync',
		staleAfterHours: 90 * DAY_HOURS,
	},
	{
		name: 'wheelpros-inventory',
		label: 'WheelPros inventory (3 CSVs)',
		files: ['accessoriesInvPriceData.csv', 'tireInvPriceData.csv', 'wheelInvPriceData.csv'],
		seedCommand: 'seed-wp-inventory',
		staleAfterHours: 30 * DAY_HOURS,
	},
	{
		name: 'omix',
		label: 'Omix price sheet (XLSX)',
		files: ['omix-excel.xlsx'],
		seedCommand: 'seed-omix',
		staleAfterHours: 120 * DAY_HOURS,
	},
	{
		name: 'aev',
		label: 'AEV price file (XLSX)',
		files: ['AEV-price-file.xlsx'],
		seedCommand: 'seed-aev',
		staleAfterHours: 365 * DAY_HOURS,
	},
];

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// Painel/API de upload nunca aceita acima disso, independente do feed —
// arquivos classe SpecialOrder (460MB) entram por fetch FTP ou CLI.
const uploadPanelMaxBytes = Number(process.env.FEED_UPLOAD_PANEL_MAX_BYTES || DEFAULT_MAX_UPLOAD_BYTES);

const envStaleKey = (name) => `FEED_STALE_HOURS_${name.toUpperCase().replace(/-/g, '_')}`;

function getFeedDefinitions() {
	return FEED_DEFINITIONS.map((feed) => {
		const override = Number(process.env[envStaleKey(feed.name)]);
		return {
			...feed,
			legacyDir: feed.legacyDir || '',
			seedCommand: feed.seedCommand || null,
			seedCommandNote: feed.seedCommandNote || null,
			staleAfterHours: Number.isFinite(override) && override > 0 ? override : feed.staleAfterHours,
			maxUploadBytes: Math.min(feed.maxUploadBytes || DEFAULT_MAX_UPLOAD_BYTES, uploadPanelMaxBytes),
		};
	});
}

function getFeedByName(name) {
	return getFeedDefinitions().find((feed) => feed.name === name) || null;
}

// Ponte para o resolver central de planilhas (load-workbook.js): baseName do
// arquivo -> feed correspondente.
function getFeedByWorkbookBaseName(baseName) {
	return getFeedDefinitions().find((feed) => feed.workbookBaseName === baseName) || null;
}

module.exports = {
	getFeedDefinitions,
	getFeedByName,
	getFeedByWorkbookBaseName,
	config: {
		uploadPanelMaxBytes,
	},
};
