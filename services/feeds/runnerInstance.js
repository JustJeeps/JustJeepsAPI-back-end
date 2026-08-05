// Instancia unica do runner de feeds, compartilhada entre a rota que dispara o
// "Run now" (routes/ingest.js) e o agendador de crons de comando (server.js).
//
// Precisa ser a MESMA instancia dos dois lados: o runner recusa comecar durante
// o seed-all (lock file) e o server.js recusa comecar um cron de comando
// enquanto ha run manual ativo (isBusy). Duas instancias deixariam esse par de
// travas cego de um lado e dois seeds do mesmo vendor rodariam juntos sobre a
// mesma staging table.

const { createFeedRunner } = require('../../lib/feeds/feedRunner');

module.exports = createFeedRunner();
