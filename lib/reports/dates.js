// Helpers puros de data por timezone, usados pelos builders de report e por
// vários endpoints/crons. Extraídos VERBATIM de server.js na Fase 4a-0 (sem
// nenhuma mudança de lógica) para serem importados também pelo processo worker.

function getDateStringInTimezone(value = new Date(), timeZone = 'America/Toronto') {
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return '';
	return new Intl.DateTimeFormat('en-CA', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
	}).format(date);
}

function getTrailingDateStringsInTimezone(value = new Date(), days = 7, timeZone = 'America/Toronto') {
	const date = value instanceof Date ? value : new Date(value);
	const dateStrings = [];
	for (let index = days - 1; index >= 0; index -= 1) {
		dateStrings.push(getDateStringInTimezone(new Date(date.getTime() - (index * 24 * 60 * 60 * 1000)), timeZone));
	}
	return dateStrings;
}

module.exports = { getDateStringInTimezone, getTrailingDateStringsInTimezone };
