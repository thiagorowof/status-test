# Página de status — ADI

Página pública de status, com a sonda rodando no GitHub Actions.

O ponto central do desenho: **a sonda e a página vivem fora da Azure**. Uma
página de status hospedada junto do sistema que ela monitora cai junto — e
página de status fora do ar durante uma queda é o pior cenário possível, porque
é exatamente quando todo mundo vai olhar.

## Como funciona

```
GitHub Actions (a cada 30 min, 7h–22h)
        │  node sonda.js
        ▼
docs/status.json  ──►  GitHub Pages  ──►  docs/index.html
```

A sonda escreve um JSON; a página só lê esse JSON e não sabe de onde ele veio.
Trocar de hospedagem depois é copiar arquivos e apontar para o mesmo arquivo.

## Instalação

1. Crie um repositório **público**.

   Público é por custo, não por preferência: repositório público tem minutos de
   Actions ilimitados, privado tem cota mensal, e uma execução a cada 30 minutos
   consome a cota gratuita. É justamente por ser público que **nenhuma URL
   sondada mora neste repositório** — veja *Os endereços* abaixo.

2. Em **Settings → Secrets and variables → Actions → New repository secret**,
   crie os segredos das URLs. Faça isto **antes** da primeira execução: sem
   segredo, a sonda não tem o que verificar.

   | Segredo | Valor |
   |---|---|
   | `STATUS_URL_DEV_WEB` | endereço da aplicação web de dev |
   | `STATUS_URL_DEV_API` | endereço da API de dev, terminando em `/health/ready` |
   | `STATUS_URL_QA_WEB` / `STATUS_URL_QA_API` | idem, homologação — só quando for ligar |
   | `STATUS_URL_PROD_WEB` / `STATUS_URL_PROD_API` | idem, produção — só quando for ligar |

3. Envie estes arquivos para o repositório.

4. Em **Settings → Pages**, escolha:
   - Source: `Deploy from a branch`
   - Branch: `main`, pasta `/docs`

5. Em **Settings → Actions → General → Workflow permissions**, marque
   **Read and write permissions**. Sem isso o workflow não consegue publicar o
   `status.json` de volta no repositório.

6. Rode uma vez na mão: aba **Actions → Sonda de status → Run workflow**.
   Isso valida a configuração sem esperar meia hora.

   Se um componente aparecer como *Não monitorado* com "URL nao configurada", o
   segredo correspondente está faltando ou com nome diferente. O log da execução
   diz qual variável não foi encontrada — e o valor nunca aparece no log, porque
   o GitHub mascara segredo automaticamente.

A página fica em `https://<usuario>.github.io/<repositorio>/`.

**No ar hoje:** https://thiagorowof.github.io/status-test/

## Ambientes

A página mostra os três ambientes. Só **desenvolvimento** está sendo verificado;
QA e produção aparecem como *Não monitorado* até serem ligados.

| Ambiente | Componentes | Situação |
|---|---|---|
| Desenvolvimento | Aplicação web, API | ✅ sendo verificado |
| Homologação | Aplicação web, API | desligado |
| Produção | Aplicação web, API | desligado |

### Os endereços

**Nenhuma URL sondada mora neste repositório.** O `config.json` traz apenas o
nome da variável:

```json
{ "id": "prod-api", "url": "${STATUS_URL_PROD_API}", "tipo": "health" }
```

O valor vem de um segredo do repositório, ligado à variável no
`.github/workflows/sonda.yml`. A substituição acontece só na memória do
processo: o `status.json`, que é commitado a cada execução, carrega id, nome e
estado — nunca URL.

O repositório precisa ser público por causa da cota de Actions, mas quem
monitora não é obrigado a publicar o endereço do que monitora. Este arranjo
resolve os dois.

Segredo ausente deixa o componente sem URL, e componente sem URL não é sondado —
aparece como pendente com "URL nao configurada". A sonda nunca tenta buscar
`https://${VARIAVEL}/` nem reporta queda por configuração faltando. É o que
permite QA e produção ficarem sem segredo enquanto não são ligados.

### Para ligar um ambiente

1. Crie os dois segredos daquele ambiente.
2. Troque `"monitorar": false` por `true` no `config.json`.

Antes de ligar, confirme que o `/health/ready` já está publicado ali. Hoje ele
só existe em desenvolvimento: ligar QA ou produção antes do deploy pintaria a
página de vermelho por causa de uma rota inexistente, não de uma queda real.

Um ambiente com `monitorar: false` **não é sondado e não conta para o estado
geral** — ele aparece na página como pendente, e não como falha. Essa distinção é
o que permite deixar a página pronta antes de ter o que monitorar sem que ela
nasça vermelha, o que ensinaria todo mundo a ignorá-la.

Ambiente desligado **preserva o histórico** que já tinha, e nenhum dia é
registrado enquanto ele estiver desligado — a barra de 90 dias mostra cinza no
período, em vez de verde inventado.

## Configuração

Tudo em `config.json`:

```json
{
  "janela": { "inicio": 7, "fim": 22 },
  "ambientes": [
    {
      "id": "dev",
      "nome": "Desenvolvimento",
      "monitorar": true,
      "componentes": [
        { "id": "dev-api", "nome": "API", "url": "https://.../health/ready", "tipo": "health" }
      ]
    }
  ]
}
```

- **`janela`** — a sonda só verifica entre esses horários, no fuso configurado.
  Consequência: uma queda às 22h05 só aparece às 7h. É uma troca consciente
  entre custo e latência de detecção.
- **ordem dos ambientes** — a página respeita a ordem do arquivo. Quando
  produção passar a ser monitorada, vale movê-la para o topo: é a resposta que
  a maioria de quem abre a página está procurando.
- **`idAnterior`** (opcional) — liga o id antigo de um componente ao novo, para
  o histórico atravessar uma renomeação. Está nos componentes de dev por causa
  da reestruturação em ambientes e pode sair depois de 90 dias.

Tipos de verificação:

- **`health`** — interpreta o corpo do `/health/ready`, o que permite distinguir
  *degradado* (dependência não-crítica fora, sistema atendendo) de *fora*.
- **`conteudo`** — confere o código HTTP **e** se a resposta contém o trecho
  informado em `contem`. É o certo para hospedagem estática: o Static Web Apps
  devolve o index.html para qualquer caminho, então um deploy quebrado que
  publicou uma página vazia também responderia 200. Procurar `<app-root` prova
  que a aplicação está mesmo publicada.
- **`http`** — só o código de resposta.

Uma observação sobre rota com `#`: o fragmento nunca é enviado ao servidor.
Sondar `https://site/#/dashboard` devolve exatamente a mesma resposta que
sondar a raiz — verificado, byte a byte.

O intervalo fica no `cron` de `.github/workflows/sonda.yml`. Ele é em UTC; a
janela de 7h–22h de Brasília corresponde a 10h–01h UTC.

Para rodar na mão fora da janela — testando uma configuração nova, por exemplo:

```bash
STATUS_URL_DEV_WEB="https://..." STATUS_URL_DEV_API="https://.../health/ready" node sonda.js --forcar
```

As URLs precisam vir do ambiente também na sua máquina, pelo mesmo motivo:
elas não estão no repositório. Componente cuja variável você não passar fica
pendente, o que é conveniente para testar um ambiente de cada vez.

## Incidentes

Há dois caminhos, e eles convivem no mesmo arquivo.

### Automático (a sonda abre e fecha sozinha)

Quando um componente falha **duas verificações seguidas**, a sonda abre o
incidente; quando volta a responder, fecha. Nada a fazer.

O limiar é o ponto todo. Publicar na primeira falha transformaria oscilação de
rede de 40 segundos em alarme — e alarme falso ensina o time e o cliente a
ignorar a página. Com o intervalo de 30 minutos, duas falhas seguidas
significam que a queda durou pelo menos meia hora. O primeiro vermelho desta
página, o `HTTP 404` de 05/09, falhou uma vez só: não teria virado incidente,
que é exatamente o filtro pretendido.

Ajuste em `config.json`:

```json
"incidenteAutomatico": { "ativo": true, "verificacoesParaAbrir": 2 }
```

Limitações herdadas da sonda: ela abre incidente por **indisponibilidade**, não
por lentidão — o sistema responder devagar não dispara nada. E só o estado
`fora` conta; `degradado` não abre incidente sozinho.

### Manual (o que a sonda não enxerga)

Lentidão, um bug que atrapalha o trabalho sem derrubar nada, manutenção
programada. Edite `docs/incidentes.json`, commite e faça push — o Pages
republica em um ou dois minutos, sem esperar a sonda.

**A sonda nunca toca no que você escreveu.** Ela só altera entradas com
`"origem": "automatico"`; incidente sem esse campo é texto de gente e não é
reescrito, fechado nem expurgado por processo automático. A consequência é que
o incidente manual fica aberto até você mesmo fechar, acrescentando o `fim`.

Na página, cada um leva sua etiqueta: **Automático** e **Em andamento**. Quem lê
precisa saber se aquilo foi uma máquina que detectou ou uma pessoa que escreveu.

### Formato

```json
{
  "incidentes": [
    {
      "titulo": "Lentidão ao salvar ordens de serviço",
      "inicio": "2026-08-14T13:20:00-03:00",
      "fim": "2026-08-14T15:05:00-03:00",
      "atualizacoes": [
        { "situacao": "Investigando", "texto": "...", "quando": "2026-08-14T13:20:00-03:00" },
        { "situacao": "Resolvido",    "texto": "...", "quando": "2026-08-14T15:05:00-03:00" }
      ]
    }
  ]
}
```

Sem o campo `fim`, o incidente aparece como *em andamento*. `atualizacoes` é
opcional — só `titulo` e `inicio` já bastam, o que serve para manutenção
programada. Não escreva `"origem": "automatico"` à mão: esse campo é a marca de
propriedade da sonda, e usá-lo entrega o seu texto para ela fechar e expurgar.

Os incidentes são ordenados por data de início, do mais recente para o mais
antigo, e filtrados pela mesma janela das barras — `diasDeHistorico`, hoje 90
dias. São exibidos no máximo 20.

Um incidente em aberto **rebaixa a faixa do topo** para "Operando com
limitações", mesmo com a sonda vendo tudo verde. É o caso típico do incidente
manual: o sistema responde, só que devagar, e a sonda não tem como perceber. O
contrário não vale — se a sonda mede queda, "Interrupção em andamento" continua
prevalecendo.

### Testar sem publicar

`fetch` não funciona em `file://`, então a página precisa de um servidor:

```bash
cd docs && python3 -m http.server 8080
```

Abra `http://localhost:8080/`, edite o `incidentes.json` e recarregue.

Para exercitar o caminho automático de ponta a ponta, aponte um componente para
um endereço que não resolve e rode a sonda o número de vezes do limiar:

```bash
STATUS_URL_DEV_API="https://nao-existe.invalid/health/ready" node sonda.js --forcar
```

Uma execução não abre nada; a segunda abre; a terceira não duplica. Passando a
URL boa, a execução seguinte fecha o incidente. Faça isso numa **cópia** do
diretório: a sonda grava em `docs/`.

## Isto não é a telemetria

São dois sistemas que medem coisas diferentes, e vale não confundir:

|  | Página de status | Telemetria |
|---|---|---|
| Onde roda | fora, no GitHub | dentro da aplicação |
| Responde | "o sistema está no ar?" | "que erro o usuário encontrou?" |
| Enxerga | disponibilidade | exceção de JS, 500, stack trace |
| Público | qualquer pessoa | só administrador |

Um erro de JavaScript numa tela **não** deixa o sistema fora do ar: a API
responde, a página carrega, e a sonda mostra verde — corretamente. Esse erro
aparece no painel de telemetria, que é onde ele deve aparecer. O caminho
contrário também vale: se o container cair, a telemetria não tem para onde
enviar nada, e é a sonda externa que percebe.

## Limitações conhecidas

**Latência de detecção.** Workflow agendado do GitHub tem mínimo de 5 minutos e
atrasa sob carga — às vezes 10 ou 15. Para uma página que humanos consultam,
serve. Para acordar alguém em 60 segundos, não.

**Não alcança rede interna.** O GitHub não enxerga IP privado. Sistemas internos
precisariam de uma segunda sonda, rodando na rede, escrevendo no mesmo formato.

**Não recebe heartbeat.** O Pages serve arquivo estático e não aceita POST,
então o container não tem como avisar que está vivo. Com a sonda externa
funcionando, isso importa pouco — o heartbeat serviria para distinguir
"dormindo por falta de uso" de "fora do ar", o que só é ambíguo em ambiente sem
tráfego.

**Sondar dev acorda o container.** O ambiente de desenvolvimento tem
scale-to-zero (cold start medido: 12 segundos), então cada verificação o desperta
e ele fica de pé por alguns minutos. Por isso o intervalo começa em 30 minutos.
Apontando para produção, que tem tráfego o dia todo, esse custo desaparece.

**A dica da barrinha só aparece com o mouse.** Passar o mouse sobre um dia mostra
a contagem e os motivos das falhas daquele dia. Em celular não há hover, então
esse detalhe fica inacessível — quem precisar do dado exato lê o
`docs/status.json`, que traz o mesmo conteúdo no campo `motivos`.

**Motivo é guardado a partir de 06/09/2026.** Antes disso o histórico contava as
falhas mas descartava a causa. Os dias anteriores mostram só a contagem, em vez
de afirmar um motivo que ninguém registrou. A única exceção é a falha de 05/09,
recuperada do histórico do git e preenchida à mão.

**São no máximo 4 motivos distintos por dia**, e o excedente vira `outros`. A
chave vem do texto que o servidor devolve; sem teto, um erro com texto variável
— com timestamp ou id dentro — criaria uma chave nova a cada verificação e
faria o arquivo crescer sem limite justo no dia ruim.

**Verde não garante que a tela abre.** A sonda confirma que a API responde e que
suas dependências estão de pé. Não confirma que a tela de OS carrega. Cobrir
isso exigiria transação sintética — um robô que faz login e percorre um fluxo
real —, que é bem mais caro de construir e manter.
