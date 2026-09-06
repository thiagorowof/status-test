#!/usr/bin/env node
'use strict';

/**
 * Sonda da página de status.
 *
 * Roda pelo GitHub Actions, de fora da Azure e de fora da OCI. Essa é a razão
 * de ser dela: uma sonda hospedada junto do que monitora cai junto, e página de
 * status fora do ar durante uma queda é o pior cenário possível — é exatamente
 * quando todo mundo vai olhar.
 *
 * Escreve `docs/status.json`. A página só lê esse arquivo e não sabe de onde
 * ele veio, então trocar de hospedagem depois é copiar arquivos.
 *
 * Node puro, sem dependência: um monitor que precisa de `npm install` para
 * rodar é mais uma coisa que pode falhar no dia em que ele mais importa.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = __dirname;
const ARQUIVO_CONFIG = path.join(RAIZ, 'config.json');
const ARQUIVO_STATUS = path.join(RAIZ, 'docs', 'status.json');
const ARQUIVO_INCIDENTES = path.join(RAIZ, 'docs', 'incidentes.json');

const cfg = JSON.parse(fs.readFileSync(ARQUIVO_CONFIG, 'utf8'));

/**
 * URL pode vir de variável de ambiente: `"url": "${STATUS_URL_PROD}"`.
 *
 * Este repositório é público — precisa ser, porque repositório privado tem cota
 * de minutos de Actions e uma execução a cada 30 minutos consome a cota
 * gratuita. Endereço de ambiente interno não precisa ir junto: quem monitora
 * não é obrigado a publicar o que monitora.
 *
 * A substituição acontece só na memória do processo. O `status.json`, que é
 * commitado a cada execução, nunca carrega URL — só id, nome e estado.
 *
 * Variável ausente vira string vazia, e componente sem URL não é sondado:
 * aparece como pendente com "URL nao configurada", em vez de a sonda tentar
 * buscar `https://${VARIAVEL}/` e reportar o ambiente como fora do ar.
 */
function resolverVariaveis(texto, avisar) {
  return String(texto || '').replace(/\$\{([A-Za-z0-9_]+)\}/g, (_todo, nome) => {
    const valor = process.env[nome];
    if (!valor) {
      // Só avisa para ambiente ligado. Ambiente desligado não tem segredo por
      // decisão, e um aviso que aparece a cada meia hora por algo deliberado
      // ensina quem lê o log a ignorar os avisos que importam.
      if (avisar) console.warn(`Variável ${nome} não definida — o componente ficará sem URL.`);
      return '';
    }
    return valor;
  });
}

(cfg.ambientes || []).forEach((amb) => {
  const ligado = amb.monitorar !== false;
  (amb.componentes || []).forEach((c) => { c.url = resolverVariaveis(c.url, ligado); });
});

/* ------------------------------------------------------------ janela horária */

/**
 * Hora local no fuso configurado, sem depender de biblioteca e sem depender do
 * fuso da máquina — o runner do GitHub roda em UTC.
 */
function horaLocal() {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: cfg.fusoHorario,
    hour: '2-digit',
    hour12: false,
  }).formatToParts(new Date());
  return Number(partes.find((p) => p.type === 'hour').value);
}

function diaLocal() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.fusoHorario,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function dentroDaJanela() {
  const h = horaLocal();
  return h >= cfg.janela.inicio && h < cfg.janela.fim;
}

/**
 * `--forcar` ignora a janela horária. Serve para rodar na mão — pelo
 * `workflow_dispatch` ou na máquina — sem depender da hora do dia. O agendamento
 * automático nunca passa esse argumento, então a janela continua valendo para o
 * que importa: não desperdiçar execução de madrugada.
 */
const forcado = process.argv.includes('--forcar');

/* ------------------------------------------------------------ verificação */

/**
 * Classifica a resposta.
 *
 * Para componente do tipo `health`, o corpo traz o estado detalhado e o
 * "degradado" vem de lá — o serviço responde, mas com alguma dependência
 * não-crítica fora. Para os demais, só o código HTTP.
 */
async function verificar(componente) {
  const inicio = Date.now();
  const controle = new AbortController();
  const relogio = setTimeout(() => controle.abort(), cfg.timeoutMs);

  try {
    const resposta = await fetch(componente.url, {
      signal: controle.signal,
      headers: { 'User-Agent': 'status-informata/1.0' },
      redirect: 'follow',
    });
    const ms = Date.now() - inicio;

    if (componente.tipo === 'health') {
      let corpo = null;
      try { corpo = await resposta.json(); } catch (_) {}

      // Exige a forma completa da resposta de saúde. Uma checagem frouxa
      // ("tem um campo status?") aceitaria qualquer JSON — inclusive o corpo de
      // rota-não-encontrada, que também traz um `status`. Aí a sonda passaria a
      // classificar por coincidência.
      const respostaDeSaude = corpo && typeof corpo.status === 'string' && Array.isArray(corpo.checks);

      if (respostaDeSaude) {
        return {
          estado: corpo.status === 'ok' ? 'ok' : corpo.status === 'degradado' ? 'degradado' : 'fora',
          ms,
          // Só o nome do que falhou. A página é pública e não deve descrever a
          // infraestrutura de dentro.
          detalhe: corpo.checks
            .filter((c) => c.ok === false)
            .map((c) => c.nome)
            .join(', ') || null,
        };
      }

      // Endpoint de saúde que não responde como endpoint de saúde é problema,
      // mesmo que o HTTP tenha vindo 200.
      return {
        estado: 'fora',
        ms,
        detalhe: resposta.ok ? 'resposta inesperada' : 'HTTP ' + resposta.status,
      };
    }

    /**
     * Conteúdo esperado.
     *
     * Para hospedagem estática, HTTP 200 prova pouco: o Static Web Apps devolve
     * o index.html para qualquer caminho, então um deploy quebrado que publicou
     * uma página vazia também responde 200. Procurar um trecho que só existe na
     * aplicação de verdade (`<app-root`) distingue "está publicado" de "está
     * respondendo".
     */
    if (componente.tipo === 'conteudo') {
      if (!resposta.ok) {
        return { estado: 'fora', ms, detalhe: 'HTTP ' + resposta.status };
      }
      let corpo = '';
      try { corpo = await resposta.text(); } catch (_) {}
      const esperado = componente.contem || '';
      return corpo.includes(esperado)
        ? { estado: 'ok', ms, detalhe: null }
        : { estado: 'fora', ms, detalhe: 'pagina publicada sem o conteudo esperado' };
    }

    return {
      estado: resposta.ok ? 'ok' : 'fora',
      ms,
      detalhe: resposta.ok ? null : 'HTTP ' + resposta.status,
    };
  } catch (erro) {
    return {
      estado: 'fora',
      ms: Date.now() - inicio,
      detalhe: erro.name === 'AbortError' ? 'sem resposta no tempo limite' : 'nao respondeu',
    };
  } finally {
    clearTimeout(relogio);
  }
}

/* ------------------------------------------------------------ histórico */

function carregarAnterior() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_STATUS, 'utf8'));
  } catch (_) {
    return {};
  }
}

/**
 * Achata o status anterior num mapa id → componente.
 *
 * Aceita as duas formas do arquivo: a antiga, com `componentes` na raiz, e a
 * atual, agrupada por ambiente. É o que permite o histórico atravessar a
 * reestruturação em vez de zerar — junto com o `idAnterior` no config, que
 * liga o id antigo ao novo. Passados noventa dias, os dois podem sair.
 */
function indexarAnterior(anterior) {
  const mapa = Object.create(null);
  const guardar = (lista) => {
    (lista || []).forEach((c) => { if (c && c.id) mapa[c.id] = c; });
  };

  guardar(anterior.componentes);
  (anterior.ambientes || []).forEach((a) => guardar(a.componentes));
  return mapa;
}

/**
 * Histórico agregado por dia, não por verificação.
 *
 * Guardar cada checagem faria o arquivo crescer sem limite e a página baixar
 * um histórico inteiro para desenhar noventa barrinhas. Por dia, noventa dias
 * cabem em alguns kilobytes.
 */
/**
 * Motivos do dia, agregados por texto.
 *
 * Sem isto o histórico guardava "1 falha em 3" e jogava fora *qual* falha —
 * e alguém olhando a barrinha vermelha uma semana depois não tinha como
 * descobrir se foi 404, timeout ou dependência fora. O teto de motivos
 * distintos existe porque a chave vem da resposta do servidor: um erro que
 * devolvesse texto variável (com timestamp, com id) criaria uma chave nova a
 * cada verificação e faria o arquivo crescer sem limite justo no dia ruim.
 */
const MAX_MOTIVOS_POR_DIA = 4;

function registrarMotivo(dia, detalhe) {
  const chave = String(detalhe || 'sem detalhe').slice(0, 80);
  dia.motivos = dia.motivos || {};

  if (dia.motivos[chave] === undefined && Object.keys(dia.motivos).length >= MAX_MOTIVOS_POR_DIA) {
    dia.motivos['outros'] = (dia.motivos['outros'] || 0) + 1;
    return;
  }
  dia.motivos[chave] = (dia.motivos[chave] || 0) + 1;
}

function atualizarHistorico(historicoAnterior, estado, detalhe) {
  const hoje = diaLocal();
  const historico = Array.isArray(historicoAnterior) ? historicoAnterior.slice() : [];
  let atual = historico.find((d) => d.dia === hoje);

  if (!atual) {
    atual = { dia: hoje, verificacoes: 0, falhas: 0, degradado: 0 };
    historico.push(atual);
  }

  atual.verificacoes++;
  if (estado === 'fora') atual.falhas++;
  if (estado === 'degradado') atual.degradado++;
  if (estado !== 'ok') registrarMotivo(atual, detalhe);

  historico.sort((a, b) => (a.dia < b.dia ? -1 : 1));
  return historico.slice(-cfg.diasDeHistorico);
}

/* ------------------------------------------------------------ incidentes */

/**
 * Abertura e fechamento automáticos de incidente.
 *
 * A publicação era só manual, e por um motivo real: oscilação de rede de 40
 * segundos vira alarme falso, e alarme falso ensina o time e o cliente a
 * ignorar a página. Mas exigir que alguém escreva o incidente significa que uma
 * queda às 3h da manhã só aparece quando alguém acordar — e aí a página não
 * serve para a única coisa que dela se espera.
 *
 * A saída é o limiar: a sonda só abre incidente depois de N verificações
 * seguidas sem sucesso. Com o intervalo de 30 minutos, o padrão de 2 significa
 * que a queda durou pelo menos meia hora. O primeiro vermelho desta página — o
 * HTTP 404 de 05/09, que era a rota de saúde ainda não publicada — falhou uma
 * vez só e não teria virado incidente. É exatamente o filtro pretendido.
 *
 * Regra que não se quebra: a sonda **só mexe no que ela mesma criou**
 * (`origem: "automatico"`). Incidente escrito por gente é texto de gente —
 * não é reescrito, não é fechado e não é expurgado por um processo automático.
 */

const LIMIAR_PADRAO = 2;

function carregarIncidentes() {
  try {
    const d = JSON.parse(fs.readFileSync(ARQUIVO_INCIDENTES, 'utf8'));
    return Array.isArray(d.incidentes) ? d.incidentes : [];
  } catch (_) {
    return [];
  }
}

const ehAutomatico = (i) => i && i.origem === 'automatico';
const estaAberto = (i) => i && !i.fim;

function atualizarIncidentes(anteriores, ambientes, agora) {
  const opcoes = cfg.incidenteAutomatico || {};
  if (opcoes.ativo === false) return anteriores;

  const limiar = Number(opcoes.verificacoesParaAbrir) || LIMIAR_PADRAO;
  const lista = anteriores.slice();

  ambientes.forEach((amb) => {
    amb.componentes.forEach((c) => {
      const aberto = lista.find((i) => ehAutomatico(i) && i.componente === c.id && estaAberto(i));

      if (!aberto) {
        if (c.estado === 'fora' && c.falhasSeguidas >= limiar) {
          lista.push({
            origem: 'automatico',
            componente: c.id,
            titulo: `${c.nome} indisponível — ${amb.nome}`,
            // O início é quando o estado virou, não quando o limiar foi
            // atingido: a interrupção começou na primeira falha, e datá-la
            // meia hora depois encurtaria a duração registrada.
            inicio: c.desde || agora,
            ultimoMotivo: c.detalhe || null,
            atualizacoes: [{
              situacao: 'Detectado',
              texto: `A verificação automática falhou ${c.falhasSeguidas} vezes seguidas.` +
                     (c.detalhe ? ` Motivo relatado: ${c.detalhe}.` : ''),
              quando: agora,
            }],
          });
          console.log(`   ↳ incidente aberto: ${c.id}`);
        }
        return;
      }

      // Segue fora: só registra atualização quando o motivo muda. Sem isso o
      // incidente ganharia uma linha idêntica a cada meia hora.
      if (c.estado !== 'ok') {
        const motivo = c.detalhe || null;
        if (aberto.ultimoMotivo !== motivo) {
          aberto.ultimoMotivo = motivo;
          aberto.atualizacoes.push({
            situacao: 'Atualização',
            texto: motivo ? `O motivo da falha mudou: ${motivo}.` : 'A falha continua, sem motivo detalhado.',
            quando: agora,
          });
        }
        return;
      }

      aberto.fim = agora;
      aberto.atualizacoes.push({
        situacao: 'Normalizado',
        texto: 'As verificações automáticas voltaram a responder.',
        quando: agora,
      });
      console.log(`   ↳ incidente fechado: ${c.id}`);
    });
  });

  // Expurgo apenas do que a sonda criou e já encerrou, na mesma janela do
  // histórico — para a página não prometer 90 dias e guardar um arquivo eterno.
  const limite = Date.now() - cfg.diasDeHistorico * 86400000;
  const vivos = lista.filter((i) =>
    !ehAutomatico(i) || estaAberto(i) || new Date(i.inicio).getTime() >= limite
  );

  vivos.sort((a, b) => new Date(b.inicio) - new Date(a.inicio));
  return vivos;
}

/* ------------------------------------------------------------ agregação */

const PESO = { ok: 1, degradado: 2, fora: 3 };

/**
 * Pior estado de uma lista, ignorando o que não é monitorado.
 *
 * `pendente` fica de fora da conta de propósito: um ambiente ainda não ligado
 * não é uma queda. Contá-lo como falha pintaria a página inteira de vermelho
 * enquanto QA e produção esperam configuração — e uma página que nasce vermelha
 * ensina todo mundo a ignorá-la. Quando nada está sendo monitorado, o resultado
 * é `pendente`, que a página mostra como ausência de dado e não como problema.
 */
function pior(estados) {
  const reais = estados.filter((e) => PESO[e]);
  if (!reais.length) return 'pendente';
  return reais.reduce((a, b) => (PESO[b] > PESO[a] ? b : a));
}

/* ------------------------------------------------------------ execução */

(async () => {
  if (!forcado && !dentroDaJanela()) {
    console.log(`Fora da janela de ${cfg.janela.inicio}h às ${cfg.janela.fim}h (agora: ${horaLocal()}h). Nada a fazer.`);
    process.exit(0);
  }

  const anteriores = indexarAnterior(carregarAnterior());
  const ambientes = [];

  for (const amb of cfg.ambientes) {
    const componentes = [];

    for (const c of amb.componentes) {
      const antes = anteriores[c.id] || anteriores[c.idAnterior] || {};

      // Ambiente desligado, ou componente ainda sem URL, não é sondado. A
      // diferença entre os dois casos importa para quem configura: o primeiro é
      // decisão, o segundo é configuração faltando.
      let r;
      if (!amb.monitorar) {
        r = { estado: 'pendente', ms: null, detalhe: null };
      } else if (!c.url) {
        r = { estado: 'pendente', ms: null, detalhe: 'URL nao configurada' };
        console.warn(`[${amb.id}] ${c.nome}: monitorar=true mas url vazia — ignorado.`);
      } else {
        r = await verificar(c);
      }

      const naoSondado = r.estado === 'pendente';

      // Falhas consecutivas: é o que separa uma oscilação de uma queda. Zera em
      // qualquer sucesso, e um ambiente desligado congela a contagem em vez de
      // perdê-la.
      const falhasSeguidas = naoSondado
        ? (antes.falhasSeguidas || 0)
        : (r.estado === 'fora' ? (antes.falhasSeguidas || 0) + 1 : 0);

      componentes.push({
        id: c.id,
        nome: c.nome,
        descricao: c.descricao,
        estado: r.estado,
        tempoRespostaMs: r.ms,
        detalhe: r.detalhe,
        falhasSeguidas,
        verificadoEm: naoSondado ? (antes.verificadoEm || null) : new Date().toISOString(),
        // Quando o estado muda, marca o instante. É o que a página usa para dizer
        // "estável há 3 dias" em vez de repetir o horário da última checagem.
        desde: antes.estado === r.estado && antes.desde ? antes.desde : new Date().toISOString(),
        // Sem sondagem, sem registro no histórico. Contar uma verificação que
        // não aconteceu encheria a barra de 90 dias de dias falsamente verdes —
        // e o histórico anterior é preservado para o caso de o ambiente ter sido
        // desligado temporariamente.
        historico: naoSondado ? (antes.historico || []) : atualizarHistorico(antes.historico, r.estado, r.detalhe),
      });

      const tempo = r.ms === null ? '' : ` (${r.ms}ms)`;
      console.log(`[${amb.id}] ${c.nome}: ${r.estado}${tempo}${r.detalhe ? ' — ' + r.detalhe : ''}`);
    }

    ambientes.push({
      id: amb.id,
      nome: amb.nome,
      descricao: amb.descricao,
      monitorar: amb.monitorar !== false,
      geral: pior(componentes.map((c) => c.estado)),
      componentes,
    });
  }

  const geral = pior(ambientes.map((a) => a.geral));
  const agora = new Date().toISOString();

  const saida = {
    titulo: cfg.titulo,
    subtitulo: cfg.subtitulo,
    geral,
    atualizadoEm: agora,
    janela: cfg.janela,
    fusoHorario: cfg.fusoHorario,
    // A página usa isto para filtrar os incidentes na mesma janela das barras.
    // Sem o campo, ela dizia "últimos 90 dias" e mostrava tudo que houvesse.
    diasDeHistorico: cfg.diasDeHistorico,
    ambientes,
  };

  const incidentes = atualizarIncidentes(carregarIncidentes(), ambientes, agora);

  fs.mkdirSync(path.dirname(ARQUIVO_STATUS), { recursive: true });
  fs.writeFileSync(ARQUIVO_STATUS, JSON.stringify(saida, null, 2) + '\n');
  fs.writeFileSync(ARQUIVO_INCIDENTES, JSON.stringify({ incidentes }, null, 2) + '\n');

  const abertos = incidentes.filter(estaAberto).length;
  console.log(`\nEstado geral: ${geral}${abertos ? ` — ${abertos} incidente(s) em aberto` : ''}`);
})();
