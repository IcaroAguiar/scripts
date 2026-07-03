# Course Content Migration

Framework interno para migração rápida de conteúdo de plataformas EAD, começando por The Members.

## Stack

- Bun
- TypeScript
- Playwright headless

## Comandos

```bash
bun install
bun run login
bun run discover
bun run download
bun run upload:drive
bun run migrate
```

## Fluxo

1. Configure `.env` a partir de `.env.example`.
2. Rode `bun run login` para salvar `storage/auth/themembers.json`.
3. Rode `bun run discover` para gerar manifests.
4. Rode `bun run download` para baixar assets com `sha256`.
5. Rode `bun run upload:drive` para preparar a árvore organizada para sincronização com Google Drive.

O core não conhece URLs, seletores ou regras específicas de plataforma. Cada plataforma deve ficar em `src/config/platforms/`.
