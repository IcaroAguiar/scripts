# Student Migration

CLI local para planejar e executar migracoes em massa de membros da Tetra a
partir de planilhas.

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
