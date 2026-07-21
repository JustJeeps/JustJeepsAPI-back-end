const path = require('path');

// Raiz do projeto (onde vivem package.json, config/, prisma/, logs/).
//
// Módulos extraídos para lib/** DEVEM resolver paths de arquivo e o `cwd` de
// spawn contra este ROOT — NUNCA contra `__dirname`, que dentro de lib/** passa
// a ser o diretório do módulo e quebraria silenciosamente:
//   - o spawn dos seeds (`cwd` sem package.json → `npm run` falha)
//   - a leitura/escrita dos logs e do summary do seed-all
//   - o `require(path.join(ROOT, 'package.json'))` da validação de cron
//
// Antes da Fase 4a essas resoluções usavam `__dirname` de server.js (== raiz),
// então o comportamento é idêntico contanto que este ROOT aponte para a raiz.
const ROOT = path.resolve(__dirname, '..');

module.exports = { ROOT };
