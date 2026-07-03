# Tutorial: demonstrar a migração TheMembers → Tetra na sua máquina

Passo a passo para rodar a TUI localmente, fazer o dry-run e executar a migração da planilha real sem sustos.

## O que você precisa antes

1. **Bun** instalado (`curl -fsSL https://bun.sh/install | bash`).
2. **Stack Tetra local rodando** com estas branches (até os PRs serem mergeados):
   - `tetra-iam` na `main` (porta 3335)
   - `tetra-products` na `feat/internal-catalog-course-map` (porta 3336) — PR #115
   - `tetra-enrollments` na `feat/internal-progress-completion` (porta 3338) — PR #98
   - Suba com `tetra start` ou o comando de dev de cada serviço.
3. **A planilha** `org-5642-tenant-5776-consumo-2_kxh8jh (1).csv` (peça no canal do time — ela tem dados de alunos e não vai pro Git).
4. O **secret local** do client `tetra-imports-service` do seu IAM local.

## Passo 1 — Clonar e instalar

```bash
git clone https://github.com/IcaroAguiar/scripts.git
cd scripts/student-migration
bun install
```

## Passo 2 — Configurar as credenciais locais

```bash
cp examples/tetra-dev.env.example storage/tetra-dev.env
```

Abra `storage/tetra-dev.env` e troque `CHANGE_ME_IMPORTS_SERVICE_SECRET` pelo secret do seu IAM local. Esse arquivo é gitignorado — nunca commite.

## Passo 3 — Semear os cursos no tenant local (uma vez só)

A planilha referencia 15 cursos em espanhol. Eles precisam existir no tenant `tenant_local_tetra` do seu products local. Se o seu banco ainda não os tem, rode o seed (derivado da própria planilha):

```bash
# de dentro de scripts/student-migration
export TETRA_PRODUCTS_REPO=~/dev/tetra/tetra-services/tetra-products
export DATABASE_URL="$(grep '^DATABASE_URL=' $TETRA_PRODUCTS_REPO/.env | cut -d= -f2- | tr -d '\"')"
bun scripts/seed-local-catalog.ts "<caminho da planilha>.csv"
# saida esperada: "seed concluido: 15 cursos criados, 322 aulas, 0 ja existiam."
```

> Confirmação rápida: `GET http://localhost:3336/internal/catalog/course-map` com token de serviço deve listar 15 produtos. O próprio preflight do passo 5 valida isso pra você.

## Passo 4 — Perfil da migração (dois jeitos)

**Jeito fácil (recomendado): deixe a TUI criar.** No passo 6, escolha
"Criar novo perfil agora" e responda as perguntas (nome, tenant, ambiente,
grupo, data e periodicidade). A TUI valida cada campo, grava o perfil em
`storage/` e segue o fluxo — você nunca toca em JSON.

**Jeito manual (opcional)**: crie `storage/profile.demo.json`:

```json
{
  "version": 2,
  "layout": "themembers-consumo",
  "name": "Demo migracao TheMembers",
  "tenantId": "tenant_local_tetra",
  "environment": "dev",
  "accessGroup": {
    "mode": "create",
    "name": "Demo TheMembers Periodo 2",
    "periodicity": "YEARLY",
    "periodicityValue": 1
  },
  "enrollmentWindow": {
    "accessStartsAt": "2026-01-15",
    "periodicity": "YEARLY",
    "periodicityValue": 1
  },
  "catalogMapPath": "./catalog-map.demo.json"
}
```

## Passo 5 — Dry-run primeiro (SEMPRE)

O dry-run valida tudo sem tocar em nenhuma API de escrita. É ele que garante que a demo não falha. Pela TUI, basta escolher o modo "Dry-run" na primeira passada. Pela linha de comando (se você criou o perfil manualmente ou quer repetir o da TUI):

```bash
bun run migrate -- \
  --input "<caminho da planilha>.csv" \
  --profile ./storage/profile.demo.json \
  --sync-catalog --preflight-dev \
  --env-file ./storage/tetra-dev.env
```

Confira a saída. Você quer ver exatamente isto:

```
consumo preflight: ok=3 warnings=0 failures=0
validated rows: 9558
planned operations: 456        ← membros
blocked rows: 0                ← se não for 0, PARE e leia os motivos no plano
planned enrollments: 1476
planned progress writes: 6910
```

- `blocked rows > 0`? Abra o plano JSON gerado em `storage/` — ele lista o motivo de cada bloqueio (curso/aula não encontrado no catálogo = seed incompleto).
- Preflight com `failures`? A mensagem diz o quê: grupo, rota de catálogo ou produto faltando.

## Passo 6 — A demo pela TUI

```bash
bun run import
```

Na tela, siga a ordem (ENTER confirma, ESC sai):

1. **Planilha**: cole o caminho do CSV (aceita `~`, aspas e espaços).
2. **Perfil**: escolha "Criar novo perfil agora" e responda: nome da migração,
   tenant (`tenant_local_tetra`), ambiente (Local), grupo ("Criar um grupo novo"
   + nome). Se já tiver um perfil salvo, escolha "Usar arquivo de perfil
   existente" e informe o caminho.
3. **Início da matrícula**: digite `2026-01-15` (formato YYYY-MM-DD — a TUI
   avisa na hora se a data for inválida).
4. **Periodicidade**: Anual, multiplicador 1 — a TUI mostra a data de fim computada e os dias restantes, e grava o perfil em `storage/` neste ponto.
5. **Catálogo**: "Sincronizar do tetra-products agora".
6. **Modo**: comece com **Dry-run** para mostrar o plano; depois repita com **Execute dev**.
7. **Env-file**: `./storage/tetra-dev.env` (só no modo dev).
8. **Revisão inline**: mostre a tela do plano — membros, matrículas por curso, progressos e bloqueios. **Nada executa antes desta tela.**
9. Confirme **"Executar dev agora"**. ~3 minutos para 9.558 linhas.

## Passo 7 — O gran finale da demo

Rode o execute **de novo** com a mesma planilha: termina em ~15 segundos com tudo `already_exists` / `alreadyCompleted` e zero duplicação. É a prova de que o processo é idempotente e seguro para reexecutar.

Para mostrar o resultado na interface: abra o front-admin local → **Membros** (456 alunos ativos) e **Grupos de Acesso** (grupo criado com 15 cursos e os membros vinculados).

## Se algo der errado

| Sintoma | Causa provável |
|---|---|
| `401` no sync-catalog/preflight | Secret errado no `tetra-dev.env` ou products/enrollments sem as branches dos PRs |
| `blocked rows` com "course title not found" | Seed dos cursos incompleto no tenant local |
| Preflight `catalog_route failed` | `TETRA_PRODUCTS_URI` ausente no env-file ou products fora do ar |
| Execute falha em matrícula com janela no passado | `accessStartsAt` + periodicidade caem antes de hoje — ajuste a data no perfil |

Regras de ouro: nunca commite a planilha, o `storage/` ou perfis com IDs reais; os alunos migrados **não recebem email** e usam "esqueci minha senha" quando avisados.
