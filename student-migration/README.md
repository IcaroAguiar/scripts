# Student Migration

CLI/TUI local para planejar e executar migracoes em massa da TheMembers para a
Tetra a partir de planilhas. Tres fluxos:

| Fluxo | Entrada | O que faz |
| --- | --- | --- |
| TUI / v1 (`bun run import`) | planilha de membros + perfil JSON | membros em grupos/produtos pre-existentes |
| Consumo / v2 (`--profile` com `layout: themembers-consumo`) | export de consumo TheMembers | membros + matriculas + progresso de aulas |
| Grupos (`--groups`) | export de assinaturas TheMembers + xlsx de cursos | cria grupos de acesso de migracao e vincula cursos |

Todos os fluxos seguem o mesmo trilho de seguranca: **dry-run revisavel ->
gates explicitos -> execute idempotente com ledger SQLite**. Nada chama API sem
`--execute`, e producao sempre exige um approval file.

## Comecando

```bash
bun install
bun run test        # 129 testes
bun run typecheck
cp examples/tetra-dev.env.example storage/tetra-dev.env   # edite com URLs/secret locais; storage/ e gitignorado
```

## TUI (importador guiado)

```bash
bun run import      # abre a TUI "Importar Membros Tetra"
```

Passo a passo:

1. **Planilha**: informe o caminho local do CSV/XLSX. Aceita caminho absoluto,
   relativo, `~`, aspas e nomes com espacos.
2. **Perfil**: escolha um perfil JSON existente ou crie um novo pela propria
   TUI (tenant, ambiente, grupo de acesso existente/criado com periodicidade,
   janela de matricula e catalog map no caso v2). Perfis com IDs reais ficam
   locais e gitignorados em `storage/`.
3. **Modo**: `dry-run`, `execute fake` ou `execute dev`.
4. **Env-file** (opcional): caminho de um env local (ex.:
   `storage/tetra-dev.env`) para os modos que falam com APIs.
5. **Revisao inline do plano**: a TUI mostra o plano redigido (contadores,
   operacoes validas, linhas bloqueadas/duplicadas, grupo/produto resolvidos e
   evidencias de progresso) e o preflight tetra-dev. Os modos de execucao so
   liberam o botao "Executar" depois dessa revisao.
6. Os caminhos de saida (plano JSON, ledger SQLite, relatorio de execute) sao
   derivados do nome da planilha e exibidos na tela.

O modo `execute dev` ainda exige as variaveis locais, o gate explicito e um
perfil de ambiente permitido; em `production` vale a mesma regra do CLI
(approval file compativel com `runId`/`tenantId`/`environment`).

## Layout TheMembers consumo (perfil v2)

Exports reais de consumo da TheMembers (uma linha por aluno+aula, colunas
`student_email`, `course_title`, `module_title`, `lesson_title`, `finished`,
`finished_at`, ...) usam perfis `version: 2` com `layout: "themembers-consumo"`.
O plano agrega as linhas por membro: grupo de acesso (existente ou criado com
periodicidade), uma matricula manual por (membro, curso) presente na planilha
com `accessStartsAt`/`accessEndsAt` computados (America/Sao_Paulo), e uma
escrita de progresso por linha `finished=1` (aula marcada como concluida com
`occurredAt = finished_at`, sem gamificacao). Membros sao criados em silencio
(`notifyCreatedUsers: false`); a senha e aleatoria com troca obrigatoria.

O mapeamento de titulos usa um catalog map local sincronizado da rota interna
`GET /internal/catalog/course-map` do tetra-products (`--sync-catalog` ou o
passo de catalogo na TUI). Curso nao resolvido bloqueia a linha; aula nao
resolvida bloqueia apenas aquele progresso. Rerun e idempotente: matricula
existente vira `already_exists`, progresso ja concluido vira `alreadyCompleted`
e o grupo criado e reutilizado via ledger.

```bash
bun run migrate -- --input ./planilha.csv --profile ./storage/perfil-v2.json --sync-catalog --preflight-dev --env-file ./storage/tetra-dev.env
bun run migrate -- --input ./planilha.csv --profile ./storage/perfil-v2.json --execute --adapter tetra-dev --allow-dev-execute --env-file ./storage/tetra-dev.env
```

Requer tambem `TETRA_PRODUCTS_URI` (ou `PRODUCTS_API_BASE_URL`) no env-file.
Cutover de producao: [docs/PRODUCTION_RUNBOOK.md](./docs/PRODUCTION_RUNBOOK.md).

## Grupos de acesso de migracao (`--groups`)

Fase 1 da migracao TheMembers -> Tetra: cria os grupos de acesso a partir dos
PRODUTOS da TheMembers e vincula os cursos corretos a cada grupo. Membros NAO
sao tocados neste fluxo; o ledger guarda o mapeamento
`themembers_product_id -> access_group_id` (tabela `themembers_product_groups`)
para a fase 2 (matricula dos alunos).

Entradas:

- `--products-csv`: export de assinaturas da TheMembers
  (`user_id;...;product_id;product_name;user_subscription_created_at`). O
  parser tolera o formato defeituoso do export real: encoding windows-1252,
  linha inteira entre aspas com `""` internos, `,,,` finais e nomes com virgula
  quebrados em multiplas celulas pelo Excel (reconstruidos por rejoin).
- `--courses-xlsx`: planilha com 3 colunas (`Tetra Club`, `Pos-Graduacao`,
  `MBA`), cada uma listando os cursos que o grupo daquele tipo deve conter.
  Cabecalhos de secao (detectados pelo reinicio da numeracao em "1."),
  duracoes ("— 2h") e entradas nao-curso ("Documentos para matricula",
  "Gravacoes...", "Links importantes...") sao tratados automaticamente.

Regras de negocio (decisoes de 2026-07-07, codificadas em
`src/group-naming.ts`):

- Escopo: so produtos Tetra Club / Pos-Graduacao / MBA. Qualquer nome com
  "Tetra Club" (que nao seja MBA/Pos) entra como grupo Tetra Club, incluindo
  combos "Formacao X + Tetra Club". O resto vai para o relatorio
  `fora do escopo`.
- Nome do grupo: normalizado (remove sufixos de gateway `- as/- p/- on/...`,
  CNPJ, prefixos, token "Migracao", grafia "TetraClub" -> "Tetra Club") +
  sufixo `- migracao`. Nomes iguais apos a normalizacao consolidam em UM grupo.
- Deduplicacao canonica: variantes de "Tetra Club puro" que diferem so por
  formatacao ("Acesso 4 anos", "COM ACESSO DE 4 ANOS", "estendido para 4
  anos") consolidam no nome canonico `Tetra Club - Acesso N anos - migracao`.
  Qualificadores reais (Lideranca, Corporativo, Trial, Recorrente, nomes de
  empresa) mantem grupo separado. So funde quem tem a MESMA periodicidade.
- Periodicidade: parseada do nome (`18 meses` -> MONTHLY/18, `4 anos` ->
  YEARLY/4, `7 dias` -> DAILY/7, `anual` -> YEARLY/1, numero solto apos
  "Tetra Club" -> anos). Vitalicio e sem mencao viram YEARLY/100 (o dominio do
  enrollments nao tem "sem expiracao"). Nomes com sinais conflitantes ficam
  `ambiguous-periodicity` e nunca executam.
- Exclusoes: "Taxa de Matricula..." e "Ferramentas Tetra Club" nao viram grupo.

Uso (dry-run primeiro, sempre):

```bash
# 1. Dry-run: gera plano + CSVs de revisao em storage/, nao chama API de escrita
bun run migrate -- --groups \
  --products-csv ~/Downloads/alunos-themembers.csv \
  --courses-xlsx ~/Downloads/PRODUTOS_CURSOS.xlsx \
  --tenant <tenant-id> --environment dev \
  --catalog-map storage/catalog-map.json --sync-catalog \
  --env-file storage/tetra-dev.env

# 2. Revisar os artefatos gerados:
#    <slug>-groups-plan.json      plano completo (consumido pelo execute)
#    <slug>-groups-apply.csv      1 linha por grupo que SERA criado
#    <slug>-groups-review.csv     grupo x produto de origem + excluidos/fora de escopo
#    <slug>-groups-ambiguous.csv  so pendencias de decisao humana

# 3. Execute idempotente (dev)
bun run migrate -- --groups ... --execute --adapter tetra-dev --allow-dev-execute

# 4. Producao: o runId e deterministico pelo conteudo do plano; crie o approval
#    com o runId do dry-run e rode com --approval
bun run migrate -- --groups ... --environment production \
  --approval storage/approval-groups.json \
  --execute --adapter tetra-dev --allow-dev-execute
```

Idempotencia: rerun reusa grupos ja criados (ledger por `(tenant, nome)`),
lista produtos ja vinculados antes de anexar e tolera 409. Um rerun limpo
reporta `created: 0, reused: N`. Cursos do xlsx sem match no catalog map
aparecem como `unresolved` no relatorio e nao bloqueiam o restante do grupo.

Requisitos de API: `POST /internal/access-groups` (service token via
`oauth2-secure/service-token`) e `POST /access-groups/:id/products`
(`x-tenant-id`). O sync de catalogo usa `GET /internal/catalog/course-map` do
tetra-products. Gotcha de dev local: se o IAM local for ressemeado, rode
`pnpm db:seed:imports-client` no tetra-iam com o `IMPORTS_OAUTH_CLIENT_SECRET`
do seu env-file para realinhar o client `tetra-imports-service`.

Por padrao, o comando roda em modo `dry-run`: valida a entrada, normaliza os
registros e grava um plano JSON sem chamar APIs externas. Execucao real deve
ficar atras de dry-run aprovado, ledger redigido e travas explicitas de
ambiente.

## Documentos

- [PRD](./docs/PRD.md)
- [Plano tecnico e backlog](./docs/TECHNICAL_PLAN.md)

## Decisoes de V1

- O termo canonico e `Membro`; `Aluno` e tratado como vocabulario do sistema de
  origem.
- Entradas em massa sempre chegam por planilha, com suporte planejado para CSV e
  XLSX.
- Perfis de mapeamento com IDs reais de cliente/tenant/grupo/produto ficam
  locais e gitignorados.
- O trilho de execucao reaproveita APIs existentes: OAuth service-to-service
  onde ja existe contrato e compatibilidade `x-tenant-id` nos endpoints atuais
  que ainda dependem dela.
- Progresso historico nao e gravado na V1; fica apenas em dry-run, ledger e
  relatorio.
- Linhas com grupo, produto, curso ou aula ambiguos ficam bloqueadas para
  revisao.
- Ledgers e relatorios devem ser redigidos, sem nome/email completos.

## Entrada CSV/XLSX

Esta fatia aceita CSV e XLSX com perfil de mapeamento JSON. Clientes reais da
Tetra ficam para as proximas fatias da V1.

O arquivo de exemplo usa cabecalhos semelhantes aos exports analisados:

- `Aluno`
- `E-mail`
- `Telefone`
- `Grupo`
- `Curso`
- `Modulo`
- `Aula`
- `Porcentagem da Aula`
- `Concluida`
- `Data de Acesso`

O perfil em `examples/profile.tetra.fake.json` mapeia esses cabecalhos para o
modelo canonico e usa apenas IDs falsos.

## Comandos

```bash
bun install
bun run import
bun run migrate -- --input ./fixtures/members-progress.csv --profile ./examples/profile.tetra.fake.json
bun run migrate -- --input ./fixtures/members-progress.xlsx --profile ./examples/profile.tetra.fake.json
bun run migrate -- --input ./fixtures/members-progress.csv --profile ./examples/profile.tetra.fake.json --execute --adapter fake
bun run migrate -- --input ./fixtures/members-progress.xlsx --profile ./examples/profile.tetra.fake.json --preflight-dev
bun run migrate -- --input ./fixtures/members-local-smoke.csv --profile ./examples/profile.tetra.local-smoke.json --preflight-dev --env-file ./storage/tetra-dev.env
bun run test
bun run typecheck
```

Quando `--output`, `--ledger` ou `--execute-report` nao forem informados, a
CLI/TUI deriva os caminhos a partir do nome da planilha original. Exemplo:
`/Users/icaroaguiar/Downloads/20260325130201596LTKURS (1).csv` gera:

- `storage/20260325130201596ltkurs-1-plan.json`
- `storage/20260325130201596ltkurs-1-runs.sqlite`
- `storage/20260325130201596ltkurs-1-execute.json`

O plano gerado em `storage/` e redigido: ele guarda hashes, row numbers, IDs
falsos/reais resolvidos e motivos de bloqueio, sem nome/email/telefone completos.
Durante um execute preparado, email e nome ficam apenas em um contexto privado em
memoria para futuros adaptadores reais; esse contexto nao e gravado no plano,
ledger ou relatorio.

`--execute --adapter fake` processa somente as operacoes validas em memoria,
grava um relatorio JSON redigido e registra o resumo no ledger SQLite. Ele nao
chama APIs da Tetra e nao grava progresso historico.

O projeto ja contem clientes Tetra injetaveis e um boundary de adapter
`tetra-dev` testado por contrato para IAM, grupos de acesso e matriculas. A CLI
so permite esse caminho com `--execute --adapter tetra-dev --allow-dev-execute`.
As variaveis locais esperadas sao `TETRA_IAM_URI` ou `IAM_API_BASE_URL`,
`TETRA_ENROLLMENTS_URI` ou `ENROLLMENTS_API_BASE_URL`, `IAM_OAUTH_CLIENT_ID` ou
`TETRA_IAM_CLIENT_ID` ou `IMPORTS_OAUTH_CLIENT_ID`, e
`IAM_OAUTH_CLIENT_SECRET`, `TETRA_IAM_CLIENT_SECRET` ou
`IMPORTS_OAUTH_CLIENT_SECRET`; nao coloque valores reais no repositorio. Quando
`IMPORTS_OAUTH_CLIENT_SECRET` estiver presente sem client id explicito, o loader
usa o client id canonico `tetra-imports-service`. Use
`--preflight-dev` para validar, sem mutacao, que o token de servico, grupo de
acesso e produto estao corretos antes do execute real. A TUI tambem expoe
`execute dev`, sempre depois da revisao inline do plano, aceita um env-file
local opcional e inclui o preflight tetra-dev no painel de revisao. Antes de
chamar IAM, o adapter valida que o grupo de acesso existe e que o produto esta
associado ao grupo, para evitar criar membro quando o alvo da migracao esta
invalido.

Para smoke local, crie um arquivo ignorado em `storage/tetra-dev.env` com as
URLs locais e o secret aprovado do client `tetra-imports-service`; nao coloque
esse arquivo no Git. O fixture `fixtures/members-local-smoke.csv` e o perfil
`examples/profile.tetra.local-smoke.json` usam apenas dados sintéticos:
`tenant_local_tetra`, `smoke-access-group` e `smoke-course-section`.

```bash
cp examples/tetra-dev.env.example storage/tetra-dev.env
# edite storage/tetra-dev.env e substitua CHANGE_ME_IMPORTS_SERVICE_SECRET
```

`bun run import` abre a TUI "Importar Membros Tetra" para escolher o caminho
local da planilha, perfil e modo. Os caminhos de saida aparecem na tela e sao
derivados automaticamente do nome da planilha. O campo da planilha aceita
caminho absoluto, relativo, `~`, aspas e nomes com espacos. A tela exibe o
progresso por fase e, ao gerar o dry-run, mostra o plano redigido dentro da
propria TUI: contadores, operacoes validas, linhas bloqueadas, duplicadas,
grupo/produto resolvidos e evidencias de progresso. Nos modos `execute fake` e
`execute dev`, a execucao so fica disponivel depois dessa revisao inline do
plano; o modo dev ainda depende das variaveis locais, do gate explicito e de um
perfil dev aprovado.

Adaptadores reais continuam bloqueados ate a fatia de clientes Tetra. Em
ambiente `production`, mesmo o caminho fake exige arquivo de aprovacao
compativel com `runId`, `tenantId` e `environment`.
