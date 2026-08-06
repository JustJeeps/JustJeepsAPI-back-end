// Allowlists de usuario por env: quem pode executar cada operacao sensivel
// (status no Magento, cancelamento de pedido, envio de relatorio...) muda
// quando alguem entra ou sai do time, e isso nao pode exigir deploy de codigo.
// O valor no codigo e apenas o default; producao define em config/deploy.yml.
//
// IMPORTANTE: este modulo precisa continuar "puro" — apenas process.env e
// dados literais (mesma regra do config/cron-jobs.js).

// Aceita "ana,bruno" ou "ana bruno"; normaliza para minusculo e ignora vazios.
// Uma env definida como string vazia cai no default (engano comum de deploy);
// para nao liberar ninguem, defina algo que nao case com usuario real.
function userAllowlist(envVar, fallback) {
	return new Set(
		String(process.env[envVar] || fallback)
			.split(/[,\s]+/)
			.map((username) => username.trim().toLowerCase())
			.filter(Boolean)
	);
}

module.exports = { userAllowlist };
