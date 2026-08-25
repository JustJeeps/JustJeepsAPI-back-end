// Adaptador de I/O fininho: buffer da planilha -> array de arrays (header na
// primeira linha). Toda validacao de conteudo mora em lib/reviews/reviewRows
// (puro); aqui so extracao, com tetos anti-XLSX-bomb — o parse roda em
// memoria no processo da API (container de 2GB).

const XLSX = require('xlsx');
const { parse: parseCsvSync } = require('csv-parse/sync');

const XLSX_MAGIC = [0x50, 0x4b]; // 'PK' — .xlsx e um ZIP
const UTF8_BOM = 0xfeff;

function parseWorkbookBuffer(buffer, fileName, { maxRows = 60000 } = {}) {
	const name = String(fileName || '').toLowerCase();
	let rows;
	if (name.endsWith('.xlsx')) {
		if (buffer.length < 4 || buffer[0] !== XLSX_MAGIC[0] || buffer[1] !== XLSX_MAGIC[1]) {
			throw new Error('Not a valid .xlsx file');
		}
		// sheetRows corta o parse ANTES de materializar uma planilha de 10^6
		// linhas; raw:true evita formatacao por locale (datas viram Date ou
		// serial, numeros ficam numeros — reviewRows normaliza os tres casos).
		const workbook = XLSX.read(buffer, { cellDates: true, sheetRows: maxRows + 2 });
		const sheet = workbook.Sheets[workbook.SheetNames[0]];
		if (!sheet) throw new Error('Spreadsheet has no sheets');
		rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
	} else if (name.endsWith('.csv')) {
		let text = buffer.toString('utf8');
		if (text.charCodeAt(0) === UTF8_BOM) text = text.slice(1);
		rows = parseCsvSync(text, { relax_column_count: true, skip_empty_lines: true });
	} else {
		throw new Error('Unsupported file type (expected .xlsx or .csv)');
	}
	if (rows.length - 1 > maxRows) {
		throw new Error(`Spreadsheet has too many rows (limit ${maxRows})`);
	}
	return rows;
}

module.exports = { parseWorkbookBuffer };
