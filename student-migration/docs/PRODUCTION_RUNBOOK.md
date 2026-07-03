# Runbook de producao: migracao TheMembers -> Tetra Latam

> NAO executar sem completar todos os pre-requisitos. Este runbook documenta o
> cutover; nada aqui foi executado em producao ainda.

## Pre-requisitos (uma vez)

1. **PRs mergeados e deployados**:
   - tetra-products #115 (`GET /internal/catalog/course-map`)
   - tetra-enrollments #98 (`POST /internal/progress/lessons/:id/completed`,
     `POST /internal/access-groups`, `POST /internal/enrollments/manual`)
2. **Tenant de destino**: confirmar o tenantId de producao do Tetra Latam e
   registrar no perfil de producao (gitignorado em `storage/`).
3. **Client de servico**: garantir que `tetra-imports-service` existe no IAM de
   producao com secret aprovado; guardar o secret apenas em
   `storage/tetra-prod.env` (gitignorado), nunca no repositorio.
4. **Allowlist**: configurar `TETRA_INTERNAL_ALLOWED_CLIENT_IDS=tetra-imports-service`
   no tetra-products e tetra-enrollments de producao (ECS task definition).
5. **Cursos**: os cursos em espanhol ja existem em producao. Rodar
   `--sync-catalog` contra producao e revisar o relatorio de
   ambiguidade/nao-resolvidos do dry-run ANTES de qualquer execute.

## Env file de producao (storage/tetra-prod.env, gitignorado)

```
TETRA_IAM_URI=<url prod IAM>
TETRA_ENROLLMENTS_URI=<url prod enrollments>
TETRA_PRODUCTS_URI=<url prod products>
IMPORTS_OAUTH_CLIENT_ID=tetra-imports-service
IMPORTS_OAUTH_CLIENT_SECRET=<secret aprovado>
```

## Por planilha (repetir para cada periodo)

1. Criar perfil v2 em `storage/` com: tenant de producao,
   `environment: "production"`, grupo (`create` com periodicidade do periodo ou
   `existing`), `enrollmentWindow.accessStartsAt` = data de inicio do periodo.
2. `bun run import` (TUI) → dry-run → revisar contadores, bloqueios por motivo
   e a janela computada (o fim expirado aparece em destaque; janelas totalmente
   expiradas serao rejeitadas pela API de matricula, por design).
3. Preflight (`--preflight-dev` com o env de producao) → exigir 0 falhas.
4. Gerar o approval file com `runId`, `tenantId` e `environment: "production"`
   (obrigatorio: execute em producao sem approval e bloqueado pela CLI).
5. Execute → conferir relatorio: membros/matriculas/progressos criados e
   `progressFailed = 0`.
6. Rerun da mesma planilha deve dar 100% `already_exists`/`alreadyCompleted`.
7. Comunicar aos alunos o fluxo de senha ("esqueci minha senha"): os membros
   sao criados silenciosamente com senha aleatoria + troca obrigatoria.

## Regras de seguranca

- Nunca commitar planilhas, perfis reais, ledgers, relatorios ou env files.
- Plano/ledger/relatorios sao redigidos (sem nome/email/telefone).
- Bloqueio e por linha: linhas bloqueadas ficam no plano para correcao e rerun.
- O ledger local (`storage/*-runs.sqlite`) guarda os grupos criados por
  (tenant, nome) para reuso em rerun — nao apagar entre reruns do mesmo perfil.

## Riscos conhecidos

- Timezone: datas interpretadas como America/Sao_Paulo (-03:00). A revisao da
  TUI mostra a conversao; confirmar amostra antes do execute.
- Titulos divergentes entre TheMembers e Tetra viram bloqueios progress-only;
  revisar o relatorio de aulas nao resolvidas e corrigir titulo no catalogo ou
  aceitar a perda daquele progresso.
- Volume: ~7k POSTs de progresso por planilha (~3 min no dev local com
  concorrencia 6). Rodar fora de horario de pico na primeira execucao.
